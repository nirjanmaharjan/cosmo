// server.js — SafeVoice API server
'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { PORT, CORS_ORIGIN } = require('./config');

// Initialise DB (runs migrations & seed on first start)
require('./db');

const authRouter       = require('./routes/auth');
const complaintsRouter = require('./routes/complaints');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve uploaded files as static content
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Serve the frontend HTML as a static file (optional convenience)
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',       authRouter);
app.use('/api/complaints', complaintsRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 404 for unknown API routes
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route not found.' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SafeVoice API running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
