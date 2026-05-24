const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, "baiguo.sqlite");
const LINE_OA_URL = process.env.LINE_OA_URL || "https://line.me/R/ti/p/@baiguo";

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const db = new sqlite3.Database(DATABASE_PATH, (error) => {
  if (error) {
    console.error("SQLite database connection failed:", error.message);
    process.exit(1);
  }

  console.log(`SQLite database connected: ${DATABASE_PATH}`);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function handleRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        id: this.lastID,
        changes: this.changes
      });
    });
  });
}

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_no TEXT NOT NULL UNIQUE,
      product_url TEXT NOT NULL,
      contact TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'baiguo-toolbox',
      status TEXT NOT NULL DEFAULT 'new',
      line_oa_url TEXT,
      webhook_status TEXT NOT NULL DEFAULT 'pending',
      webhook_error TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function generateInquiryNo() {
  return `BG${Date.now()}`;
}

function buildLineOaUrl(inquiryNo) {
  const separator = LINE_OA_URL.includes("?") ? "&" : "?";
  return `${LINE_OA_URL}${separator}inquiry=${encodeURIComponent(inquiryNo)}`;
}

async function createInquiry(payload) {
  const now = new Date().toISOString();
  const inquiryNo = generateInquiryNo();
  const lineOaUrl = buildLineOaUrl(inquiryNo);

  const result = await run(
    `
      INSERT INTO inquiries (
        inquiry_no,
        product_url,
        contact,
        source,
        status,
        line_oa_url,
        webhook_status,
        utm_source,
        utm_medium,
        utm_campaign,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      inquiryNo,
      payload.productUrl,
      payload.contact,
      payload.source || "baiguo-toolbox",
      "new",
      lineOaUrl,
      "pending",
      payload.utmSource || null,
      payload.utmMedium || null,
      payload.utmCampaign || null,
      now,
      now
    ]
  );

  return {
    id: result.id,
    inquiryNo,
    productUrl: payload.productUrl,
    contact: payload.contact,
    source: payload.source || "baiguo-toolbox",
    status: "new",
    lineOaUrl,
    createdAt: now
  };
}

async function updateWebhookStatus(inquiryId, status, errorMessage = null) {
  await run(
    `
      UPDATE inquiries
      SET webhook_status = ?, webhook_error = ?, updated_at = ?
      WHERE id = ?
    `,
    [status, errorMessage, new Date().toISOString(), inquiryId]
  );
}

async function notifyTeam(inquiry) {
  const message = {
    title: "百果工具盒有新客戶詢價！",
    inquiryNo: inquiry.inquiryNo,
    productUrl: inquiry.productUrl,
    contact: inquiry.contact,
    createdAt: inquiry.createdAt
  };

  console.log("[Webhook/LINE Notify simulation]", message);
  await updateWebhookStatus(inquiry.id, "simulated");
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "baiguo-travel-toolbox",
    database: "sqlite"
  });
});

app.post("/api/inquiries", async (req, res) => {
  const {
    productUrl,
    contact,
    source,
    utmSource,
    utmMedium,
    utmCampaign
  } = req.body || {};

  if (!productUrl || !contact) {
    return res.status(400).json({
      ok: false,
      message: "請填寫商品網址與聯絡方式。"
    });
  }

  try {
    const inquiry = await createInquiry({
      productUrl: String(productUrl).trim(),
      contact: String(contact).trim(),
      source,
      utmSource,
      utmMedium,
      utmCampaign
    });

    notifyTeam(inquiry).catch(async (error) => {
      console.error("Webhook notification failed:", error);
      await updateWebhookStatus(inquiry.id, "failed", error.message);
    });

    return res.status(201).json({
      ok: true,
      inquiryId: inquiry.id,
      inquiryNo: inquiry.inquiryNo,
      lineOaUrl: inquiry.lineOaUrl,
      message: "已收到您的需求，百果專員將透過 LINE 官方帳號與您聯繫。"
    });
  } catch (error) {
    console.error("Create inquiry failed:", error);

    return res.status(500).json({
      ok: false,
      message: "系統暫時無法建立詢價單，請稍後再試。"
    });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Baiguo Travel Toolbox server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });

process.on("SIGINT", () => {
  db.close(() => {
    console.log("SQLite database connection closed.");
    process.exit(0);
  });
});
