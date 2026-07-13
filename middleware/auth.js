// middleware/auth.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const db = require('../db');

/**
 * requireAuth — verifies Bearer JWT, attaches req.user = { id, email, role }
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);

    req.user = {
      id: payload.userId ?? payload.id ?? payload.sub,
      email: payload.email,
      role: payload.role,
    };

    if (!req.user.id || !req.user.role) {
      return res.status(401).json({ error: 'Invalid token payload.' });
    }

    db.run("UPDATE users SET last_active = datetime('now') WHERE id = ?", [req.user.id], () => {});
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired.' });
  }
}

/**
 * requireAdmin — must come after requireAuth
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
