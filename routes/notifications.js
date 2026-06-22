const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { hashId } = require('../utils/anon');

const router = express.Router();

// GET /api/notifications/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT n.*,
                c.id AS complaint_id,
                c.title AS complaint_title,
                c.description AS complaint_description,
                c.status AS complaint_status,
                c.category AS complaint_category,
                c.faculty AS complaint_faculty,
                c.priority AS complaint_priority,
                c.department AS complaint_department,
                c.votes AS complaint_votes,
                c.progress AS complaint_progress,
                NULL AS summary_text
           FROM notifications n
           JOIN complaints c ON c.id = n.complaint_id


          WHERE n.user_id = ?
          ORDER BY n.is_read ASC, n.created_at DESC
        `,
        [hashId(req.user.id)],
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
      complaint: r.complaint_id ? {
        id: r.complaint_id,
        title: r.complaint_title || null,
        description: r.complaint_description || null,
        status: r.complaint_status || null,
        category: r.complaint_category || null,
        faculty: r.complaint_faculty || null,
        priority: r.complaint_priority || null,
        department: r.complaint_department || null,
        votes: r.complaint_votes || 0,
        progress: r.complaint_progress || 0,
      } : null,
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
        [id, hashId(req.user.id)],
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
        [hashId(req.user.id)],
        (err) => (err ? reject(err) : resolve())
      );
    });
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/notifications/admin/unread-count?type=escalation|status|admin_note
router.get('/admin/unread-count', requireAuth, requireAdmin, async (req, res) => {
  try {
    const type = (req.query.type || '').trim();
    const params = [];
    let sql = 'SELECT COUNT(*) AS c FROM notifications n WHERE n.is_read = 0';

    if (type) {
      sql += ' AND n.type = ?';
      params.push(type);
    }

    const row = await new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    res.json({ unreadCount: row?.c || 0 });
  } catch (err) {
    console.error('Admin unread count error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;


