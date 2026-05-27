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
    // 優先尋找 public/tool1-inquiry/index.html，找不到就找外層的
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

// 💡 完美對接 Zeabur 雲端規定的 3000 連接埠
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 百果旅遊市集後端引擎已在連接埠 ${PORT} 完美啟動！`);
});
