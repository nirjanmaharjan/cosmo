// routes/users.js
'use strict';
const { Router } = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// GET /api/users/active — count students active in last 5 minutes
router.get('/active', requireAuth, async (_req, res) => {
  try {
    const row = await new Promise((resolve, reject) => {
      db.get(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'student' AND last_active >= datetime('now', '-5 minutes')",
        (err, r) => (err ? reject(err) : resolve(r))
      );
    });
    res.json({ active: row?.count || 0 });
  } catch (err) {
    console.error('Get active users error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
