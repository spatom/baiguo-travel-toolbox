const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config();

// 💡 自動相容舊版 Node.js 環境的 fetch 零件
if (typeof globalThis.fetch === 'undefined') {
    globalThis.fetch = require('node-fetch');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let lastAiDiagnostic = {
    status: 'not-tested',
    stage: null,
    httpStatus: null,
    latencyMs: null,
    error: null,
    checkedAt: null
};

const difyConversationMap = new Map();

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'baiguo.sqlite');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS inquiries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inquiry_no TEXT NOT NULL UNIQUE,
            product_url TEXT NOT NULL,
            contact TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'baiguo-toolbox',
            status TEXT NOT NULL DEFAULT 'new',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            utm_source TEXT,
            utm_medium TEXT,
            utm_campaign TEXT,
            line_oa_url TEXT,
            webhook_status TEXT NOT NULL DEFAULT 'pending',
            webhook_error TEXT
        )
    `);
});

function runDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) {
                reject(error);
                return;
            }

            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function createPublicInquiryId() {
    const now = new Date();
    const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `BG${dateStr}-${randomStr}`;
}

function buildLineOaUrl(publicId) {
    const baseUrl = process.env.LINE_OA_URL || 'https://line.me/R/ti/p/';

    if (!baseUrl || baseUrl === '#') {
        return '#';
    }

    try {
        const url = new URL(baseUrl);
        url.searchParams.set('inquiry', publicId);
        return url.toString();
    } catch (error) {
        return baseUrl;
    }
}

function getEnvFlag(name) {
    return Boolean(String(process.env[name] || '').trim());
}

function buildDifyChatUrl() {
    const baseUrl = String(process.env.DIFY_API_BASE_URL || '').trim().replace(/\/+$/, '');

    if (!baseUrl) {
        return null;
    }

    if (baseUrl.endsWith('/chat-messages')) {
        return baseUrl;
    }

    return baseUrl.endsWith('/v1') ? `${baseUrl}/chat-messages` : `${baseUrl}/v1/chat-messages`;
}

function getDifyBaseUrlMode() {
    const baseUrl = String(process.env.DIFY_API_BASE_URL || '').trim().replace(/\/+$/, '');

    if (!baseUrl) {
        return 'missing';
    }

    if (baseUrl.endsWith('/chat-messages')) {
        return 'full-chat-endpoint';
    }

    if (baseUrl.endsWith('/v1')) {
        return 'v1-base-url';
    }

    return 'root-base-url';
}

function getDifyTimeoutMs() {
    const timeoutMs = Number(process.env.DIFY_TIMEOUT_MS || 45000);

    if (!Number.isFinite(timeoutMs)) {
        return 45000;
    }

    return Math.min(Math.max(timeoutMs, 5000), 55000);
}

function sanitizeDiagnosticError(error) {
    return String(error && error.message ? error.message : error || 'unknown error')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [hidden]')
        .replace(/app-[A-Za-z0-9._-]+/g, 'app-[hidden]')
        .slice(0, 300);
}

function updateAiDiagnostic(patch) {
    lastAiDiagnostic = {
        ...lastAiDiagnostic,
        ...patch,
        checkedAt: new Date().toISOString()
    };
}

async function getLineAccessToken() {
    const channelId = String(process.env.LINE_CHANNEL_ID || '').trim();
    const channelSecret = String(process.env.LINE_CHANNEL_SECRET || '').trim();

    if (!channelId || !channelSecret) {
        throw new Error('缺少 LINE_CHANNEL_ID 或 LINE_CHANNEL_SECRET 環境變數');
    }

    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'client_credentials');
    tokenParams.append('client_id', channelId);
    tokenParams.append('client_secret', channelSecret);

    const tokenResponse = await fetch('https://api.line.me/v2/oauth/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`LINE 通行證申請失敗：${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
}

async function askDify(userMessage, userId) {
    const difyUrl = buildDifyChatUrl();
    const difyApiKey = String(process.env.DIFY_API_KEY || '').trim();
    const difyUserId = userId || 'line-user';
    const conversationId = difyConversationMap.get(difyUserId) || '';

    if (!difyUrl || !difyApiKey) {
        updateAiDiagnostic({
            status: 'failed',
            stage: 'config',
            httpStatus: null,
            latencyMs: null,
            error: '缺少 DIFY_API_BASE_URL 或 DIFY_API_KEY 環境變數'
        });
        throw new Error('缺少 DIFY_API_BASE_URL 或 DIFY_API_KEY 環境變數');
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getDifyTimeoutMs());
    let response;

    try {
        response = await fetch(difyUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': `Bearer ${difyApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: {},
                query: userMessage,
                response_mode: 'blocking',
                user: difyUserId,
                conversation_id: conversationId
            })
        });
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const isTimeout = error && error.name === 'AbortError';
        const diagnosticError = isTimeout
            ? `Dify API 超過 ${getDifyTimeoutMs()}ms 未回應`
            : sanitizeDiagnosticError(error);

        updateAiDiagnostic({
            status: 'failed',
            stage: isTimeout ? 'dify-timeout' : 'dify-network',
            httpStatus: null,
            latencyMs,
            error: diagnosticError
        });

        throw new Error(diagnosticError);
    } finally {
        clearTimeout(timeout);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
        const errorText = await response.text();
        const errorMessage = `Dify API 回應失敗 (${response.status})：${errorText}`;

        updateAiDiagnostic({
            status: 'failed',
            stage: 'dify-http',
            httpStatus: response.status,
            latencyMs,
            error: sanitizeDiagnosticError(errorMessage)
        });

        throw new Error(errorMessage);
    }

    const result = await response.json();
    const answer = String(result.answer || result.message || '').trim();
    const nextConversationId = String(result.conversation_id || '').trim();

    if (nextConversationId) {
        difyConversationMap.set(difyUserId, nextConversationId);
    }

    updateAiDiagnostic({
        status: answer ? 'ok' : 'empty-answer',
        stage: 'dify-response',
        httpStatus: response.status,
        latencyMs,
        error: answer ? null : 'Dify 回傳成功，但沒有 answer 文字。',
        hasConversationId: Boolean(nextConversationId || conversationId)
    });

    return answer || '我已收到您的訊息，稍後會再協助您。';
}

async function replyLineMessage(replyToken, text) {
    const accessToken = await getLineAccessToken();

    const replyResponse = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            replyToken,
            messages: [{ type: 'text', text }]
        })
    });

    if (!replyResponse.ok) {
        const errorText = await replyResponse.text();
        throw new Error(`LINE Reply API 回應失敗：${errorText}`);
    }
}

async function createInquiry(payload) {
    const publicId = createPublicInquiryId();
    const createdAt = new Date().toISOString();
    const lineOaUrl = buildLineOaUrl(publicId);

    const result = await runDb(
        `INSERT INTO inquiries (
            inquiry_no,
            product_url,
            contact,
            source,
            status,
            created_at,
            updated_at,
            utm_source,
            utm_medium,
            utm_campaign,
            line_oa_url,
            webhook_status
        ) VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, 'pending')`,
        [
            publicId,
            payload.productUrl,
            payload.contact,
            payload.source || 'baiguo-toolbox',
            createdAt,
            createdAt,
            payload.utmSource || null,
            payload.utmMedium || null,
            payload.utmCampaign || null,
            lineOaUrl
        ]
    );

    return {
        id: result.id,
        publicId,
        productUrl: payload.productUrl,
        contact: payload.contact,
        source: payload.source || 'baiguo-toolbox',
        createdAt,
        lineOaUrl
    };
}

async function updateWebhookStatus(inquiryId, status, errorMessage = null) {
    await runDb(
        `UPDATE inquiries
         SET webhook_status = ?, webhook_error = ?, updated_at = ?
         WHERE id = ?`,
        [status, errorMessage, new Date().toISOString(), inquiryId]
    );
}

// ==========================================
// 🛡️ 【關鍵修正】把手動路由排在最前面！享有最高優先權，不再被實體資料夾攔截
// ==========================================

// 工具一路由（同業詢價轉換器）
app.get(['/tool1-inquiry', '/tool1-inquiry/'], (req, res) => {
    const tool1Path = fs.existsSync(path.join(__dirname, 'public', 'tool1-inquiry', 'index.html'))
        ? path.join(__dirname, 'public', 'tool1-inquiry', 'index.html')
        : path.join(__dirname, 'tool1-inquiry', 'index.html');
    res.sendFile(tool1Path);
});

// 工具二路由（AI 金牌銷售員）
app.get(['/tool2-ai-sales', '/tool2-ai-sales/'], (req, res) => {
    const tool2Path = fs.existsSync(path.join(__dirname, 'public', 'tool2-ai-sales', 'index.html'))
        ? path.join(__dirname, 'public', 'tool2-ai-sales', 'index.html')
        : path.join(__dirname, 'tool2-ai-sales', 'index.html');
    res.sendFile(tool2Path);
});

// 大廳路由
app.get('/', (req, res) => {
    const indexPath = fs.existsSync(path.join(__dirname, 'public', 'index.html')) 
        ? path.join(__dirname, 'public', 'index.html') 
        : path.join(__dirname, 'index.html');
    res.sendFile(indexPath);
});

// 雲端健康檢查：用來確認 Zeabur 上的 Node 程式真的有啟動
app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        service: 'baiguo-travel-toolbox',
        webhookPath: '/callback',
        hasLineChannelId: getEnvFlag('LINE_CHANNEL_ID'),
        hasLineChannelSecret: getEnvFlag('LINE_CHANNEL_SECRET'),
        hasLineUserId: getEnvFlag('LINE_USER_ID'),
        hasLineOaUrl: getEnvFlag('LINE_OA_URL'),
        hasDifyBaseUrl: getEnvFlag('DIFY_API_BASE_URL'),
        hasDifyKey: getEnvFlag('DIFY_API_KEY'),
        difyBaseUrlMode: getDifyBaseUrlMode(),
        difyTimeoutMs: getDifyTimeoutMs(),
        lastAiStatus: lastAiDiagnostic.status,
        lastAiStage: lastAiDiagnostic.stage,
        lastAiHttpStatus: lastAiDiagnostic.httpStatus,
        lastAiLatencyMs: lastAiDiagnostic.latencyMs,
        lastAiError: lastAiDiagnostic.error,
        lastAiCheckedAt: lastAiDiagnostic.checkedAt,
        lastAiHasConversationId: Boolean(lastAiDiagnostic.hasConversationId),
        activeDifyConversations: difyConversationMap.size
    });
});

// ==========================================
// 2. 靜態資源讀取排在後面（只負責拿圖片、CSS、JS，不准攔截路由）
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));


// ==========================================
// 3. 核心 LINE 對接 Webhook 路由
// ==========================================
app.post('/api/inquiries', async (req, res) => {
    const productUrl = String(req.body.productUrl || '').trim();
    const contact = String(req.body.contact || '').trim();
    const source = String(req.body.source || 'baiguo-toolbox').trim();

    if (!productUrl || !contact) {
        return res.status(400).json({
            ok: false,
            message: '請填寫商品網址與聯絡方式。'
        });
    }

    let inquiry;

    try {
        inquiry = await createInquiry({
            productUrl,
            contact,
            source,
            utmSource: req.body.utmSource,
            utmMedium: req.body.utmMedium,
            utmCampaign: req.body.utmCampaign
        });
    } catch (error) {
        console.error('[DB] ❌ 建立詢價單失敗:', error.message);
        return res.status(500).json({
            ok: false,
            message: '詢價單建立失敗，請稍後再試。'
        });
    }

    const timeString = new Date(inquiry.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    console.log(`\n[Webhook] 📥 收到新詢價！單號: ${inquiry.publicId}`);

    res.status(200).json({
        ok: true,
        inquiryId: inquiry.publicId,
        lineOaUrl: inquiry.lineOaUrl
    });

    // 🚀 背景非同步執行 LINE 高級驗證與推播
    (async () => {
        const channelId = process.env.LINE_CHANNEL_ID;
        const channelSecret = process.env.LINE_CHANNEL_SECRET;
        const userId = process.env.LINE_USER_ID;

        if (!channelId || !channelSecret || !userId) {
            console.log(`[LINE] ⚠️ 略過推播：Zeabur 環境變數未填完整。`);
            await updateWebhookStatus(inquiry.id, 'skipped', 'LINE 環境變數未填完整。');
            return;
        }

        try {
            const tokenParams = new URLSearchParams();
            tokenParams.append('grant_type', 'client_credentials');
            tokenParams.append('client_id', channelId);
            tokenParams.append('client_secret', channelSecret);

            const tokenResponse = await fetch('https://api.line.me/v2/oauth/accessToken', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenParams
            });

            if (!tokenResponse.ok) {
                const errJson = await tokenResponse.json();
                console.error(`[LINE] ❌ 申請通行證失敗:`, errJson);
                return;
            }
            
            const tokenData = await tokenResponse.json();
            const realAccessToken = tokenData.access_token;

            const messageText = [
                `🔔【百果旅遊市集 - 新詢價通知】`,
                `-------------------------`,
                `📌 詢價單號: ${inquiry.publicId}`,
                `👤 客戶聯絡: ${contact}`,
                `🔗 商品網址: ${productUrl}`,
                `🌍 來源渠道: ${source}`,
                `-------------------------`,
                `⏰ 收到時間: ${timeString}`,
                `👉 請儘速確認產品庫存並回覆客戶！`
            ].join('\n');

            const pushResponse = await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${realAccessToken}`
                },
                body: JSON.stringify({
                    to: userId,
                    messages: [{ type: 'text', text: messageText }]
                })
            });

            if (pushResponse.ok) {
                console.log(`[LINE] 🟢 詢價通知已成功送達您的手機！`);
                await updateWebhookStatus(inquiry.id, 'sent');
            } else {
                const pushErr = await pushResponse.text();
                console.error(`[LINE] ❌ 發送推播失敗:`, pushErr);
                await updateWebhookStatus(inquiry.id, 'failed', pushErr);
            }
        } catch (error) {
            console.error(`[LINE] ❌ 背景執行異常:`, error.message);
            await updateWebhookStatus(inquiry.id, 'failed', error.message);
        }
    })();
});


// ==========================================
// 🚀 4. 新增：LINE Webhook 接收點（AI 金牌銷售員的鸚鵡測試耳朵）
// ==========================================
async function handleLineWebhook(req, res) {
    try {
        const events = req.body.events;
        
        // 如果沒有事件（例如 LINE 官方的測試連線），直接回傳 OK 結束
        if (!events || events.length === 0) {
            return res.status(200).send('OK');
        }

        const event = events[0];
        
        // 確保這是一則「文字訊息」事件，才進行處理
        if (event.type === 'message' && event.message.type === 'text') {
            const replyToken = event.replyToken;     // LINE 臨時回覆憑證
            const userMessage = event.message.text;  // 客人輸入的文字

            try {
                const aiReply = await askDify(userMessage, event.source && event.source.userId);
                await replyLineMessage(replyToken, aiReply);
                console.log(`[Webhook] ✅ Dify 已回覆 LINE 訊息: "${userMessage}"`);
            } catch (error) {
                console.error('[Webhook] ❌ Dify/LINE 回覆失敗:', error.message);

                try {
                    await replyLineMessage(replyToken, '目前 AI 專員忙線中，我們已收到您的訊息，請稍後再試。');
                } catch (replyError) {
                    console.error('[Webhook] ❌ 備援回覆也失敗:', replyError.message);
                }
            }
        }

        // 必須回覆 LINE 伺服器 200 OK
        res.status(200).send('OK');

    } catch (error) {
        console.error('[Webhook] ❌ 處理失敗:', error.message);
        res.status(200).send('OK'); // 業界標準：即使報錯也回 200，避免 LINE 伺服器連續重發
    }
}

app.post(['/callback', '/webhook', '/api/line', '/line/webhook'], handleLineWebhook);


// 💡 完美對接 Zeabur 雲端規定的連接埠
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 百果旅遊市集後端引擎已在連接埠 ${PORT} 完美啟動！`);
});
