const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// 1. 靜態檔案路徑
app.use(express.static(path.join(__dirname, 'public')));

// 2. 大廳網頁路徑
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 3. 工具一網頁路徑
app.get('/tool1-inquiry', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tool1-inquiry', 'index.html'));
});

// 4. 工具二網頁路徑
app.get('/tool2-ai-sales', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tool2-ai-sales', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`百果旅遊市集伺服器已在連接埠 ${PORT} 順利啟動！`);
});