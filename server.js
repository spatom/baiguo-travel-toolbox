const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // 確保原本的 Fetch API 正常運作
const app = express();
const PORT = process.env.PORT || 3000;

// 解析前端傳來的 JSON 與表單資料
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. 靜態檔案與路由分流管理 (大廳與工具箱)
// ==========================================

// 讓系統可以直接讀取 public 資料夾底下的圖片、CSS 樣式或 JS 檔案
app.use(express.static(path.join(__dirname, 'public')));

// 核心路由：輸入主網址 (https://tool.100coco.com/) 送出大廳首頁
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 核心路由：輸入工具一網址 (https://tool.100coco.com/tool1-inquiry) 送出同業詢價轉換器
app.get('/tool1-inquiry', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tool1-inquiry', 'index.html'));
});

// 核心路由：輸入工具二網址 (https://tool.100coco.com/tool2-ai-sales) 送出 AI 金牌銷售員
app.get('/tool2-ai-sales', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tool2-ai-sales', 'index.html'));
});


// ==========================================
// 2. LINE 官方帳號 Push Message API (核心商業邏輯)
// ==========================================

// 這是你原本打通的第一個 B2B 核心工具 API 接收點
app.post('/api/inquiries', async (req, res) => {
    try {
        const { lineId, productUrl, inquiryId } = req.body;

        // 這裡放你的 LINE Channel Access Token
        const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN || '你的_LINE_ACCESS_TOKEN';

        // 準備推播給手機的完美版 LINE 通知內容
        const messageData = {
            to: lineId, // 客戶的 LINE ID
            messages: [
                {
                    type: 'text',
                    text: `🔔 【百果旅遊市集 - 新詢價單通知】\n\n網址分流測試成功！\n流水單號：${inquiryId || '自動生成'}\n真實商品網址：${productUrl}`
                }
            ]
        };

        // 連動 LINE LINE 官方帳號 Push Message API
        const lineResponse = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            },
            body: JSON.stringify(messageData)
        });

        if (lineResponse.ok) {
            res.status(200).json({ success: true, message: 'LINE 即時通知發送成功！' });
        } else {
            const errText = await lineResponse.text();
            res.status(500).json({ success: false, error: 'LINE API 錯誤', details: errText });
        }

    } catch (error) {
        console.error('後端處理詢價單失敗:', error);
        res.status(500).json({ success: false, error: '伺服器內部錯誤' });
    }
});


// ==========================================
// 3. 啟動伺服器
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 百果旅遊市集（100coco）後端引擎已在連接埠 ${PORT} 順利啟動！`);
});