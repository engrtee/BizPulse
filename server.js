/**
 * server.js
 * BizPulse entry point.
 *
 * Starts the Express server, mounts all routes,
 * initialises the database, and schedules the 7pm WAT cron job.
 */

'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { initDb }            = require('./models/db');
const webhookRouter         = require('./routes/webhook');
const authRouter            = require('./routes/auth');
const apiRouter             = require('./routes/api');
const emailRouter           = require('./routes/email');
const { scheduleDailySummary } = require('./jobs/dailySummary');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(cors());

// Raw body needed for WhatsApp webhook signature verification (if you add it in Phase 2)
app.use('/webhook', express.json());

// JSON body for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.use('/webhook',        webhookRouter);
app.use('/api/auth',       authRouter);
app.use('/api',            apiRouter);
app.use('/api/summary',    emailRouter);

// Health check (useful for Render and uptime monitors)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'BizPulse' });
});

// Catch-all: serve the SPA for any non-API, non-webhook route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
async function start() {
  try {
    // Create tables if they don't exist
    await initDb();

    // Start HTTP server
    app.listen(PORT, () => {
      console.log(`\n🚀 BizPulse running at http://localhost:${PORT}`);
      console.log(`   Webhook endpoint: POST http://localhost:${PORT}/webhook`);
      console.log(`   WhatsApp verify:  GET  http://localhost:${PORT}/webhook`);
      console.log(`   Frontend:         http://localhost:${PORT}\n`);
    });

    // Start the 7pm WAT daily summary cron
    scheduleDailySummary();
  } catch (err) {
    console.error('❌ Failed to start BizPulse:', err.message);
    process.exit(1);
  }
}

start();
