---
name: baiguo-travel-toolbox
description: Use when working on the Baiguo Travel Toolbox project, especially building or modifying the lightweight travel tools platform, the custom travel product booking and price-difference sharing tool, LINE OA handoff flows, Express APIs, SQLite persistence, Tailwind UI, Vanilla JavaScript interactions, Zeabur deployment readiness, or Cloudflare-friendly production behavior.
---

# Baiguo Travel Toolbox

## Project Role

Act as the chief architect for `百果旅遊工具盒 (Baiguo Travel Toolbox)`: a lightweight, high-quality travel utility platform for Taiwan travel consumers. Preserve the MVP business loop: users submit third-party travel product URLs plus LINE/mobile contact, the system stores the inquiry, notifies the team, and guides the user into LINE OA for human follow-up.

## Core Stack

Use this stack unless the user explicitly changes direction:

- Frontend: `HTML5`、`Tailwind CSS`、`Vanilla JavaScript`
- Backend: `Node.js` + `Express`
- Database: `SQLite` first, with schema choices that can migrate to `PostgreSQL`
- Deployment target: `Zeabur Free Plan`
- DNS/security layer: `Cloudflare`
- Do not use WordPress.
- Do not introduce React、Vue、Next.js、large UI kits、heavy state libraries, or unnecessary build complexity for MVP work.

## Product Structure

Keep the app shaped like a tool hub:

- `index.html` is the tool lobby.
- The lobby presents travel tools as grid cards.
- The first flagship tool is `旅遊產品客製化代訂與價差共享工具`.
- Future tools such as travel accounting or itinerary wheels must be addable without entangling the first tool's logic.
- Prefer isolated modules or clearly named sections for each tool.

## UI And UX Rules

Build a clean, premium, Raymon-style tool collection feel:

- Background: `#F9FAFB` or white.
- Text: dark, high-contrast, easy to read.
- Cards: subtle gray border, large radius, usually `rounded-2xl`.
- Motion: use smooth hover states such as `hover:shadow-lg`、`hover:-translate-y-1`、`transition-all duration-300`.
- Layout: use responsive grid for the lobby.
- Avoid decorative clutter, marketing-heavy hero pages, and overly complex visual systems.

Required first-tool fields:

- Product URL input placeholder: `請貼上雄獅、可樂、山富 或各大旅行社行程網址...`
- Contact input placeholder: `請留下您的 LINE ID 或手機號碼`
- Primary CTA text: `獲取同業折扣價`

## Submission Flow

The CTA must never dead-end or simply refresh the page.

On submit:

1. Validate that product URL and contact are present.
2. Submit data through JavaScript without page reload.
3. Store the inquiry on the backend.
4. Trigger or stub a team notification webhook.
5. Show a polished success modal.
6. Provide a prominent green LINE OA button.

Success modal copy should preserve this meaning:

`已收到您的需求！百果專員正透過 B2B 後台為您爭取同業差價，請點擊下方按鈕加入我們的 LINE 官方帳號接收您的專屬報價。`

The LINE OA URL must be configurable through environment variables or a single config constant. Preserve room for tracking parameters such as inquiry ID.

## Backend Contract

Use Express routes with clear JSON behavior.

Preferred MVP endpoint:

```js
POST /api/inquiries
{
  "productUrl": "https://example.com/product",
  "contact": "user-line-id-or-phone",
  "source": "baiguo-toolbox"
}
```

Successful response:

```js
{
  "ok": true,
  "inquiryId": 123,
  "lineOaUrl": "https://line.me/R/ti/p/..."
}
```

Validation error response:

```js
{
  "ok": false,
  "message": "請填寫商品網址與聯絡方式。"
}
```

## Database Rules

Create an `inquiries` table that supports future operations and PostgreSQL migration.

Minimum fields:

- `id`
- `product_url`
- `contact`
- `source`
- `status`
- `created_at`
- `updated_at`
- `utm_source`
- `utm_medium`
- `utm_campaign`
- `line_oa_url`
- `webhook_status`
- `webhook_error`

Default `status` should be `new`.

Always store the inquiry before attempting webhook notification. If webhook fails, keep the inquiry and record the failure status instead of dropping the user request.

## Webhook And LINE OA Rules

Implement webhook logic as a replaceable service function.

Required behavior:

- Read webhook URL from environment variables.
- Send a concise team notification: `百果工具盒有新客戶詢價！`
- Include inquiry ID, contact, product URL, and timestamp.
- Keep LINE Messaging API / LINE OA handoff parameters easy to extend later.
- Do not hardcode private tokens, secrets, or production LINE URLs in source code.

## Code Style

Use small, readable functions.

Frontend pattern:

```js
async function submitInquiry(payload) {
  const response = await fetch("/api/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.message || "送出失敗，請稍後再試。");
  }

  return result;
}
```

Backend pattern:

```js
app.post("/api/inquiries", async (req, res) => {
  const { productUrl, contact, source } = req.body;

  if (!productUrl || !contact) {
    return res.status(400).json({
      ok: false,
      message: "請填寫商品網址與聯絡方式。"
    });
  }

  const inquiry = await createInquiry({
    productUrl,
    contact,
    source: source || "baiguo-toolbox"
  });

  notifyTeam(inquiry).catch((error) => {
    console.error("Webhook notification failed:", error);
  });

  res.json({
    ok: true,
    inquiryId: inquiry.id,
    lineOaUrl: buildLineOaUrl(inquiry.id)
  });
});
```

## Logic Constraints

- Do not build a full e-commerce cart, payment system, or product catalog unless explicitly requested.
- The user finds the product elsewhere; Baiguo stores the request and handles follow-up.
- The platform earns through B2B price difference and service handling, not automated checkout.
- Keep MVP fast, maintainable, and inexpensive.
- Prefer configuration through `.env`.
- Keep user-facing Traditional Chinese copy polished and clear.
- When adding new tools, isolate their UI, state, and backend routes.
- Before finishing UI work, run the local app and verify the submit flow, modal behavior, responsive layout, and no-refresh behavior.
