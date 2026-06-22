'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { hashId } = require('../utils/anon');

const router = express.Router();

async function getComplaintOrNull(complaintId) {
  const row = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM complaints WHERE id = ?', [complaintId], (err, r) => {
      if (err) reject(err);
      else resolve(r || null);
    });
  });
  return row;
}

function canStudentViewComplaint(complaintRow, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (complaintRow?.submitter_id === hashId(user.id)) return true;
  return !complaintRow?.is_sensitive;
}

// GET /api/comments/:complaintId
// Returns: { comments: [{id, message, created_at, author}] }
router.get('/:complaintId', requireAuth, async (req, res) => {
  try {
    const complaintId = Number(req.params.complaintId);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({ error: 'Invalid complaint id.' });
    }

    const complaint = await getComplaintOrNull(complaintId);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    if (!canStudentViewComplaint(complaint, req.user)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT c.id,
                c.message,
                c.created_at,
                c.user_id,
                u.name AS author_name
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.complaint_id = ?
         ORDER BY c.created_at ASC`,
        [complaintId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    res.json({
      comments: rows.map(r => ({
        id: r.id,
        message: r.message,
        text: r.message, // compatibility with normalizeCommentList()
        created_at: r.created_at,
        author: r.author_name || 'Community',
        user_id: r.user_id,
      })),
    });
  } catch (err) {
    console.error('Get comments error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/comments/:complaintId/comments
// Admin only; UI sends { comment: txt }
router.post('/:complaintId/comments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const complaintId = Number(req.params.complaintId);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({ error: 'Invalid complaint id.' });
    }

    const { comment } = req.body || {};
    const txt = comment?.trim();
    if (!txt) return res.status(400).json({ error: 'Missing comment.' });

    const complaint = await getComplaintOrNull(complaintId);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO comments (complaint_id, user_id, message)
         VALUES (?, ?, ?)`,
        [complaintId, req.user.id, txt],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.status(201).json({ message: 'Comment added.' });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
