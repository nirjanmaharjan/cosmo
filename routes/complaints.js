// routes/complaints.js
const express = require('express');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { categorizeComplaint } = require('../utils/aiCategorizer');

const router = express.Router();

const VALID_CATEGORIES = ['Food Services', 'Facilities', 'Library', 'Hostel', 'Security'];
const VALID_STATUSES   = ['Pending', 'Under Review', 'Resolved'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

const DEPT_MAP = {
  'Food Services': 'Dining Services',
  'Facilities':    'Facilities Management',
  'Library':       'Library Services',
  'Hostel':        'Hostel Management',
  'Security':      'Campus Security',
};

// Helper: days since created_at
function daysSince(createdAt) {
  const ms = Date.now() - new Date(createdAt + 'Z').getTime();
  return Math.floor(ms / 86_400_000);
}

// Helper: format a raw db row for the frontend
function format(row, votedSet = new Set()) {
  return {
    id:          row.id,
    title:       row.title,
    desc:        row.description,
    status:      row.status,
    cat:         row.category,
    pri:         row.priority,
    dept:        row.department,
    votes:       row.votes,
    progress:    row.progress,
    days:        daysSince(row.created_at),
    voted:       votedSet.has(row.id),
    created_at:  row.created_at,
    updated_at:  row.updated_at,
  };
}

// ── GET /api/complaints/:id ───────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [req.params.id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!row) return res.status(404).json({ error: 'Complaint not found.' });

    // Restrict access to owner or admin
    if (req.user?.role !== 'admin' && row.submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const voted = await new Promise((resolve, reject) => {
      db.get('SELECT 1 FROM votes WHERE user_id = ? AND complaint_id = ?', [req.user.id, row.id], (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });
    res.json({ complaint: format(row, voted ? new Set([row.id]) : new Set()) });
  } catch (err) {
    console.error('Get complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});
});

// ── GET /api/complaints/stats ─────────────────────────────────────────────────
// Summary counts for admin dashboard
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [total, pending, review, resolved, highPri, byCategory] = await Promise.all([
      new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) AS c FROM complaints", (err, row) => {
          if (err) reject(err);
          else resolve(row?.c || 0);
        });
      }),
      new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) AS c FROM complaints WHERE status = 'Pending'", (err, row) => {
          if (err) reject(err);
          else resolve(row?.c || 0);
        });
      }),
      new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) AS c FROM complaints WHERE status = 'Under Review'", (err, row) => {
          if (err) reject(err);
          else resolve(row?.c || 0);
        });
      }),
      new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) AS c FROM complaints WHERE status = 'Resolved'", (err, row) => {
          if (err) reject(err);
          else resolve(row?.c || 0);
        });
      }),
      new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) AS c FROM complaints WHERE priority = 'High'", (err, row) => {
          if (err) reject(err);
          else resolve(row?.c || 0);
        });
      }),
      new Promise((resolve, reject) => {
        db.all(`
          SELECT category, COUNT(*) AS count
          FROM complaints GROUP BY category ORDER BY count DESC
        `, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      })
    ]);

    res.json({ total, pending, review, resolved, highPri, byCategory });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/complaints ───────────────────────────────────────────────────────
// Query params: status, category, sort (votes|new|old), search
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, category, sort = 'votes', search } = req.query;

    let sql = 'SELECT * FROM complaints WHERE 1=1';
    const params = [];

    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?'; params.push(status);
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      sql += ' AND category = ?'; params.push(category);
    }
    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ? OR category LIKE ?)';
      params.push(like, like, like);
    }

    // Restrict to user's own complaints unless admin
    if (req.user?.role !== 'admin') {
      sql += ' AND submitter_id = ?'; params.push(req.user.id);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC' };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.votes}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Fetch which complaints this user has voted on
    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    const votedSet  = new Set(userVotes.map(v => v.complaint_id));

    res.json({ complaints: rows.map(r => format(r, votedSet)) });
  } catch (err) {
    console.error('Get complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }

// ── POST /api/complaints ──────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, description, category, priority } = req.body;

    if (!title?.trim())       return res.status(400).json({ error: 'Title is required.' });
    if (!description?.trim()) return res.status(400).json({ error: 'Description is required.' });

    let cat = category;
    let pri = priority;

    // Use AI to categorize if not provided
    if (!cat || !pri) {
      const aiResult = await categorizeComplaint(title, description);
      cat = cat || aiResult.category;
      pri = pri || aiResult.priority;
    }

    // Validate category and priority
    if (!VALID_CATEGORIES.includes(cat)) {
      cat = VALID_CATEGORIES[Math.floor(Math.random() * VALID_CATEGORIES.length)];
    }
    if (!VALID_PRIORITIES.includes(pri)) {
      pri = 'Medium';
    }

    const dept = DEPT_MAP[cat] || 'Administration';

    const info = await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO complaints (title, description, status, category, priority, department, submitter_id)
        VALUES (?, ?, 'Pending', ?, ?, ?, ?)
      `, [title.trim(), description.trim(), cat, pri, dept, req.user.id], function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [info.lastID], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    res.status(201).json({ complaint: format(row) });
  } catch (err) {
    console.error('Create complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── PATCH /api/complaints/:id/status ─────────────────────────────────────────
// Admin only — update status (and auto-adjust progress)
router.patch('/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}.` });
    }

    const progressMap = { 'Pending': 20, 'Under Review': 66, 'Resolved': 100 };

    const info = await new Promise((resolve, reject) => {
      db.run(`
        UPDATE complaints SET status = ?, progress = ? WHERE id = ?
      `, [status, progressMap[status], req.params.id], function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    if (info.changes === 0) return res.status(404).json({ error: 'Complaint not found.' });

    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [req.params.id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    res.json({ complaint: format(row) });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /api/complaints/:id/vote ─────────────────────────────────────────────
// Toggle upvote; returns updated vote count and voted state
router.post('/:id/vote', requireAuth, async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id, 10);
    const userId      = req.user.id;

    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [complaintId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT 1 FROM votes WHERE user_id = ? AND complaint_id = ?', [userId, complaintId], (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });

    let voted;
    if (existing) {
      await new Promise((resolve, reject) => {
        db.run('DELETE FROM votes WHERE user_id = ? AND complaint_id = ?', [userId, complaintId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise((resolve, reject) => {
        db.run('UPDATE complaints SET votes = votes - 1 WHERE id = ?', [complaintId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      voted = false;
    } else {
      await new Promise((resolve, reject) => {
        db.run('INSERT INTO votes (user_id, complaint_id) VALUES (?, ?)', [userId, complaintId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise((resolve, reject) => {
        db.run('UPDATE complaints SET votes = votes + 1 WHERE id = ?', [complaintId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      voted = true;
    }

    const updated = await new Promise((resolve, reject) => {
      db.get('SELECT votes FROM complaints WHERE id = ?', [complaintId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    res.json({ voted, votes: updated.votes });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── DELETE /api/complaints/:id ────────────────────────────────────────────────
// Admin only
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const info = await new Promise((resolve, reject) => {
      db.run('DELETE FROM complaints WHERE id = ?', [req.params.id], function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
    if (info.changes === 0) return res.status(404).json({ error: 'Complaint not found.' });
    res.json({ message: 'Complaint deleted.' });
  } catch (err) {
    console.error('Delete complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
