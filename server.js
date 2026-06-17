/**
 * server.js
 * BizPulse entry point.
 *
 * Starts the Express server, mounts all routes,
 * initialises the database, and schedules the 7pm WAT cron job.
 */

'use strict';

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const rateLimit    = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const { initDb }               = require('./models/db');
const webhookRouter            = require('./routes/webhook');
const apiRouter                = require('./routes/api');
const emailRouter              = require('./routes/email');
const adminRouter              = require('./routes/admin');
// Requiring these modules starts their internal cron schedules immediately
require('./jobs/dailySummary');
require('./jobs/morningCoaching');
require('./jobs/retentionNudge');
require('./src/agent/digest');   // 8pm Kemi digest + 15-min stock_intelligence_mv refresh + 3am history cleanup

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(cors({
  origin:      process.env.FRONTEND_URL || true,
  credentials: true,
}));

app.use(cookieParser());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests.',
});

app.use('/api',    apiLimiter);
app.use('/admin',  adminLimiter);
app.use('/webhook', webhookLimiter);

// Raw body captured for WhatsApp webhook signature verification
app.use('/webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// JSON body for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.use('/webhook',        webhookRouter);
app.use('/api',            apiRouter);
app.use('/api/summary',    emailRouter);
app.use('/admin',          adminRouter);

// Health check (useful for Render and uptime monitors)
// Handles both GET and POST for cron monitoring services
app.all('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'BizPulse' });
});

// Legal pages — public, no auth required, served before the SPA catch-all
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// Catch-all: serve the SPA for any non-API, non-webhook route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// Global JSON error handler
// Must have exactly 4 params for Express to recognise it as an error handler.
// Ensures every unhandled server error returns JSON — never an HTML error page.
// ─────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message || err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'An unexpected server error occurred. Please try again.' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
async function start() {
  try {
    // Fail fast on missing critical keys
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set — Kemi agent will not work. Add it to Render env vars.');
    }

    // Create tables if they don't exist
    await initDb();

    // Migrate old inventory → new products table (idempotent, non-blocking)
    require('./scripts/migrate-old-inventory').run().catch(e =>
      console.warn('[Startup] Inventory migration skipped:', e.message)
    );

    // Start HTTP server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 BizPulse running at http://localhost:${PORT}`);
      console.log(`   Webhook endpoint: POST http://localhost:${PORT}/webhook`);
      console.log(`   WhatsApp verify:  GET  http://localhost:${PORT}/webhook`);
      console.log(`   Frontend:         http://localhost:${PORT}\n`);
    });

    // Cron jobs are already scheduled — they started when the modules were required above
  } catch (err) {
    console.error('❌ Failed to start BizPulse:', err.message);
    process.exit(1);
  }
}

start();
