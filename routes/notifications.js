const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT n.*,
                c.id AS complaint_id,
                c.title AS complaint_title,
                s.summary_text AS summary_text
           FROM notifications n
           JOIN complaints c ON c.id = n.complaint_id
           LEFT JOIN admin_summaries s ON s.complaint_id = c.id
          WHERE n.user_id = ?
          ORDER BY n.is_read ASC, n.created_at DESC
        `,
        [req.user.id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const notifications = rows.map(r => ({
      id: r.id,
      title: r.title || 'Update',
      message: r.message || '',
      summary: r.summary_text || null,
      is_read: r.is_read,
      created_at: r.created_at,
      complaint_id: r.complaint_id,
    }));

    res.json({ notifications });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const info = await new Promise((resolve, reject) => {
      db.run(
        `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
        [id, req.user.id],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });

    if (info.changes === 0) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ message: 'Notification marked as read.' });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/notifications/readAll
router.patch('/readAll', requireAuth, async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
        [req.user.id],
        (err) => (err ? reject(err) : resolve())
      );
    });
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;

