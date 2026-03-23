# BizPulse

**WhatsApp-native financial operating system for Nigerian SMEs.**

Track daily revenue and expenses by sending a WhatsApp message.
Get an AI-powered business summary every evening automatically.

---

## What It Does

| Feature | How it works |
|---|---|
| **Daily entry via WhatsApp** | Send "made 45k today, spent 10k stock 5k rent" |
| **Instant acknowledgement** | BizPulse replies with revenue, expenses, profit in seconds |
| **Inventory tracking** | "received 50 bags rice at 900 each" / "sold 12 bags" |
| **Stock check** | Send "stock?" to see all current balances |
| **Customer tracking** | "customers 15" or included in daily entries |
| **7pm AI summary email** | Automated daily email with metrics + Gemini recommendations |
| **On-demand summary** | Send "summary" on WhatsApp or click the button in the app |
| **Google Sheets sync** | Every entry written to the user's personal Google Sheet |
| **Web dashboard** | Mobile-first web app for users who prefer typing in a browser |

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | PostgreSQL (pg) |
| AI | Google Gemini 1.5 Flash |
| WhatsApp | Meta Business Cloud API |
| Spreadsheets | Google Sheets API v4 |
| Auth | Google OAuth 2.0 |
| Email | Nodemailer (Gmail) |
| Scheduler | node-cron |
| Frontend | Vanilla HTML/CSS/JS (single file) |

---

## Quick Start

### 1. Prerequisites

- Node.js 18+
- PostgreSQL (local or [Render](https://render.com) free tier)
- A Google Cloud project
- A Gmail account with 2FA enabled
- A Gemini API key

### 2. Clone and install

```bash
cd "c:/Users/USER/Desktop/Development Project/BizPulse"
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in each variable (see the table below).

### 4. Set up PostgreSQL

**Local (using psql):**
```bash
psql -U postgres -c "CREATE DATABASE bizpulse;"
```

The tables are created automatically when the server starts (`initDb()`).

**Render (production):**
1. Create a free PostgreSQL service on [render.com](https://render.com)
2. Copy the **Internal Database URL** into `DATABASE_URL`

### 5. Start the server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

You should see:
```
✅ Database tables ready.
🚀 BizPulse running at http://localhost:3000
   Webhook endpoint: POST http://localhost:3000/webhook
   Frontend:         http://localhost:3000
[Cron] Daily summary job scheduled for 7:00 PM WAT (6:00 PM UTC).
```

---

## Environment Variables

| Variable | Purpose | Where to get it |
|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID | developers.facebook.com → Your App → WhatsApp → API Setup |
| `WHATSAPP_TOKEN` | Bearer token for Cloud API | Same page → "Access Token" |
| `WHATSAPP_VERIFY_TOKEN` | Your custom webhook verify string | Keep `bizpulse_webhook_2026` — paste this exact string in Meta's webhook config |
| `BIZPULSE_NUMBER` | The WhatsApp number users message | Your Meta Business phone number |
| `GOOGLE_CLIENT_ID` | OAuth client ID | console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client ID → Web application |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | Same page |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL | Must exactly match what you register in Google Console: `http://localhost:3000/api/auth/callback` (dev) |
| `GEMINI_API_KEY` | Gemini AI key | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| `DATABASE_URL` | PostgreSQL connection string | Local: `postgresql://postgres:password@localhost:5432/bizpulse` |
| `GMAIL_USER` | Gmail address for sending emails | Your Gmail address |
| `GMAIL_APP_PASSWORD` | App-specific password | myaccount.google.com → Security → 2-Step Verification → App passwords → Mail |
| `BASE_URL` | Public server URL | `http://localhost:3000` in dev, your Render URL in production |
| `PORT` | HTTP port | `3000` |
| `NODE_ENV` | Environment | `development` or `production` |

---

## Google Cloud Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project: **BizPulse**
3. Enable these APIs:
   - Google Sheets API
   - Google Drive API
4. Create OAuth 2.0 credentials:
   - Application type: **Web application**
   - Authorised redirect URIs: `http://localhost:3000/api/auth/callback`
5. Copy **Client ID** and **Client Secret** to `.env`

---

## Meta WhatsApp Setup (when your API access is approved)

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create an app → Business → WhatsApp
3. In **WhatsApp → API Setup**, copy:
   - Phone Number ID → `WHATSAPP_PHONE_NUMBER_ID`
   - Temporary Access Token → `WHATSAPP_TOKEN`
4. In **WhatsApp → Configuration → Webhooks**:
   - Callback URL: `https://your-domain.com/webhook`
   - Verify Token: `bizpulse_webhook_2026` (must match `.env`)
   - Subscribe to: `messages`

> **Note:** For local development, use [ngrok](https://ngrok.com) to expose your local server:
> ```bash
> ngrok http 3000
> # Copy the https URL → use as your webhook callback URL
> ```

---

## WhatsApp Command Reference

| Message | What happens |
|---|---|
| `sales 45000 rent 5000 stock 12000 transport 2000` | Daily entry logged, instant reply sent |
| `made 30k today spent 10k stock 5k rent` | Gemini parses and logs the entry |
| `received 50 bags rice at 900 each` | Adds 50 to rice stock balance |
| `sold 12 bags rice today` | Deducts 12 from rice balance |
| `stock?` | Replies with all current stock levels |
| `customers 15` | Logs 15 customers for today |
| `summary` or `report` | Triggers immediate email summary |
| `help` or `?` | Sends command list |

---

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/register` | Create user account |
| `GET` | `/api/auth/google` | Start Google OAuth flow |
| `GET` | `/api/auth/callback` | OAuth callback (Google redirects here) |
| `GET` | `/api/user?userId=` | Get user profile |
| `PUT` | `/api/user/update` | Update user profile |
| `POST` | `/api/entry` | Submit daily entry from web form |
| `GET` | `/api/summary/latest?userId=` | Get latest summary data |
| `POST` | `/api/summary/send` | Trigger on-demand email |
| `GET` | `/api/inventory?userId=` | Get current stock levels |
| `GET` | `/webhook` | Meta webhook verification |
| `POST` | `/webhook` | Receive WhatsApp messages |
| `GET` | `/health` | Health check |

---

## Folder Structure

```
bizpulse/
├── server.js           Entry point
├── package.json
├── .env                Secrets (git-ignored)
├── .env.example        Template
├── routes/
│   ├── webhook.js      WhatsApp webhook (GET + POST /webhook)
│   ├── auth.js         Google OAuth flow
│   ├── api.js          Frontend REST API
│   └── email.js        On-demand email trigger
├── services/
│   ├── whatsapp.js     Send/format WhatsApp messages
│   ├── gemini.js       AI parsing + recommendations
│   ├── sheets.js       Google Sheets read/write
│   ├── email.js        HTML email builder + sender
│   ├── parser.js       Rule-based message intent detection
│   ├── inventory.js    Stock movement orchestration
│   └── customers.js    Customer count logging
├── models/
│   ├── db.js           PostgreSQL pool + table init
│   ├── user.js         User queries
│   ├── transaction.js  Daily entry queries
│   └── inventory.js    Stock balance queries
├── jobs/
│   └── dailySummary.js 7pm WAT cron job
├── utils/
│   ├── formatter.js    Dates, health score, greeting
│   └── naira.js        ₦ formatting, "k" parser
└── public/
    └── index.html      Complete mobile-first frontend
```

---

## Phase 2 Extension Points

The codebase has `// PHASE 2:` comments at every planned extension point:

| Feature | File | Comment |
|---|---|---|
| Debtor tracking | `services/inventory.js`, `services/customers.js` | Goods given on credit |
| Loan-ready statements | `jobs/dailySummary.js` | Monthly P&L export |
| Advanced health score | `jobs/dailySummary.js`, `utils/formatter.js` | Cash flow, stock turnover |

---

## Deploying to Render (Production)

1. Push code to GitHub
2. Create a new **Web Service** on Render, connect your repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all environment variables in Render's Environment tab
6. Update `GOOGLE_REDIRECT_URI` and `BASE_URL` to your Render URL
7. Update the Google Console redirect URI to your Render URL
8. Update the Meta webhook callback URL to your Render URL

---

## License

MIT — Build on it freely.
