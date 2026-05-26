// routes/complaints.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { categorizeComplaint } = require('../utils/aiCategorizer');

const router = express.Router();

const VALID_CATEGORIES = ['Food Services', 'Facilities', 'Library', 'Hostel', 'Security'];
const VALID_FACULTIES  = ['Food', 'Library', 'Hostel', 'Infrastructure', 'Staff', 'Others'];
const VALID_STATUSES   = ['Pending', 'Under Review', 'Resolved'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

const DEPT_MAP = {
  'Food':           'Dining Services',
  'Library':        'Library Services',
  'Hostel':         'Hostel Management',
  'Infrastructure': 'Facilities Management',
  'Staff':          'HR Services',
  'Others':         'Administration',
};

// Helper: days since created_at
function daysSince(createdAt) {
  const ms = Date.now() - new Date(createdAt + 'Z').getTime();
  return Math.floor(ms / 86_400_000);
}

// Helper: fetch attachments for a complaint
function fetchAttachments(complaintId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, filename, original_name, file_type, file_size, created_at FROM attachments WHERE complaint_id = ? ORDER BY created_at ASC',
      [complaintId],
      (err, rows) => {
        if (err) reject(err);
        else {
          resolve((rows || []).map(row => ({
            id: row.id,
            name: row.original_name,
            type: row.file_type,
            size: row.file_size,
            url: `/uploads/complaints/${row.filename}`,
            created_at: row.created_at,
          })));
        }
      }
    );
  });
}

// Helper: format a raw db row for the frontend
function format(row, votedSet = new Set(), attachments = []) {
  return {
    id:           row.id,
    title:        row.title,
    desc:         row.description,
    status:       row.status,
    cat:          row.category,
    faculty:      row.faculty,
    pri:          row.priority,
    is_sensitive: row.is_sensitive,
    dept:         row.department,
    votes:        row.votes,
    progress:     row.progress,
    days:         daysSince(row.created_at),
    voted:        votedSet.has(row.id),
    created_at:   row.created_at,
    updated_at:   row.updated_at,
    attachments:  attachments,
  };
}


// ── GET /api/complaints/admin/sensitive ───────────────────────────────────────
// Admin only — view all sensitive complaints
router.get('/admin/sensitive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { faculty, sort = 'votes', search } = req.query;

    let sql = 'SELECT * FROM complaints WHERE is_sensitive = 1';
    const params = [];

    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?'; params.push(faculty);
    }
    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC' };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.votes}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    const votedSet = new Set(userVotes.map(v => v.complaint_id));

    // Fetch attachments for each complaint
    const complaints = await Promise.all(rows.map(async (r) => {
      const attachments = await fetchAttachments(r.id);
      return format(r, votedSet, attachments);
    }));

    res.json({ complaints });
  } catch (err) {
    console.error('Get sensitive complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// ── GET /api/complaints/stats ─────────────────────────────────────────────────
// Summary counts for admin dashboard
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [total, pending, review, resolved, highPri, byCategory, bySensitivity] = await Promise.all([
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
          SELECT faculty, COUNT(*) AS count
          FROM complaints GROUP BY faculty ORDER BY count DESC
        `, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      }),
      new Promise((resolve, reject) => {
        db.all(`
          SELECT is_sensitive, COUNT(*) AS count
          FROM complaints GROUP BY is_sensitive
        `, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      })
    ]);

    res.json({ total, pending, review, resolved, highPri, byFaculty: byCategory, bySensitivity });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// ── GET /api/complaints/my ─────────────────────────────────────────────────────
// TRACK STATUS PAGE: Show only the authenticated user's own complaints
// Query params: status, faculty, sort (votes|new|old), search
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { status, faculty, sort = 'votes', search } = req.query;

    let sql = 'SELECT * FROM complaints WHERE submitter_id = ?';
    const params = [req.user.id];

    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?'; params.push(status);
    }
    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?'; params.push(faculty);
    }
    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
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

    // Fetch attachments for each complaint
    const complaints = await Promise.all(rows.map(async (r) => {
      const attachments = await fetchAttachments(r.id);
      return format(r, votedSet, attachments);
    }));

    res.json({ complaints });
  } catch (err) {
    console.error('Get my complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// ── GET /api/complaints ───────────────────────────────────────────────────────
// HOME PAGE: Show all public complaints to everyone (non-sensitive only)
// Admins see all complaints. Query params: status, faculty, sort (votes|new|old), search
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, faculty, sort = 'votes', search } = req.query;

    let sql = 'SELECT * FROM complaints WHERE 1=1';
    const params = [];

    // Non-admins see only public complaints; admins see all
    if (req.user?.role !== 'admin') {
      sql += ' AND is_sensitive = 0';
    }

    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?'; params.push(status);
    }
    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?'; params.push(faculty);
    }
    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
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

    // Fetch attachments for each complaint
    const complaints = await Promise.all(rows.map(async (r) => {
      const attachments = await fetchAttachments(r.id);
      return format(r, votedSet, attachments);
    }));

    res.json({ complaints });
  } catch (err) {
    console.error('Get complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


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

    // Restrict access: only owner or admin can view; non-admin can't view sensitive complaints
    if (req.user?.role !== 'admin' && row.submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (req.user?.role !== 'admin' && row.is_sensitive) {
      return res.status(403).json({ error: 'Sensitive complaints are for admin only.' });
    }

    const voted = await new Promise((resolve, reject) => {
      db.get('SELECT 1 FROM votes WHERE user_id = ? AND complaint_id = ?', [req.user.id, row.id], (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      });
    });

    // Fetch attachments
    const attachments = await fetchAttachments(row.id);

    res.json({ complaint: format(row, voted ? new Set([row.id]) : new Set(), attachments) });
  } catch (err) {
    console.error('Get complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// ── POST /api/complaints ──────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, description, faculty, priority } = req.body;

    if (!title?.trim())       return res.status(400).json({ error: 'Title is required.' });
    if (!description?.trim()) return res.status(400).json({ error: 'Description is required.' });

    let fac = faculty;
    let pri = priority;
    let sens = false;

    // Always use AI to categorize complaints for consistent priority and sensitivity detection
    const aiResult = await categorizeComplaint(title, description);
    
    // Use provided faculty/priority if valid, otherwise use AI categorization
    fac = (faculty && VALID_FACULTIES.includes(faculty)) ? faculty : aiResult.faculty;
    pri = (priority && VALID_PRIORITIES.includes(priority)) ? priority : aiResult.priority;
    sens = aiResult.is_sensitive;

    // Validate faculty and priority (redundant but safe)
    if (!VALID_FACULTIES.includes(fac)) {
      fac = 'Others';
    }
    if (!VALID_PRIORITIES.includes(pri)) {
      pri = 'Medium';
    }

    const dept = DEPT_MAP[fac] || 'Administration';
    const cat = VALID_CATEGORIES[Math.floor(Math.random() * VALID_CATEGORIES.length)]; // Legacy category

    const info = await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO complaints (title, description, status, category, faculty, priority, is_sensitive, department, submitter_id)
        VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?, ?)
      `, [title.trim(), description.trim(), cat, fac, pri, sens ? 1 : 0, dept, req.user.id], function (err) {
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
    res.status(201).json({ complaint: format(row, new Set(), []) });
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

    // Non-admins can't vote on sensitive complaints
    if (req.user?.role !== 'admin' && complaint.is_sensitive) {
      return res.status(403).json({ error: 'Cannot vote on sensitive complaints.' });
    }

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
    // First, get all attachments and delete files
    const attachments = await new Promise((resolve, reject) => {
      db.all('SELECT filename FROM attachments WHERE complaint_id = ?', [req.params.id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Delete files from filesystem
    const uploadsDir = path.join(__dirname, '../public/uploads/complaints');
    for (const att of attachments) {
      try {
        fs.unlinkSync(path.join(uploadsDir, att.filename));
      } catch (err) {
        console.warn(`Failed to delete file ${att.filename}:`, err.message);
      }
    }

    // Delete from database (attachments cascade delete, votes cascade delete)
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

// ── POST /api/complaints/:id/attachments ──────────────────────────────────────
// Upload attachment to a complaint
router.post('/:id/attachments', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id, 10);

    // Check if complaint exists and user has permission
    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [complaintId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    // Only owner and admin can upload
    if (req.user?.role !== 'admin' && complaint.submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // File must be present
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // Check total file size for complaint (200MB limit)
    const totalSize = await new Promise((resolve, reject) => {
      db.get(
        'SELECT SUM(file_size) as total FROM attachments WHERE complaint_id = ?',
        [complaintId],
        (err, row) => {
          if (err) reject(err);
          else resolve((row?.total || 0) + req.file.size);
        }
      );
    });

    if (totalSize > 200 * 1024 * 1024) {
      // Delete uploaded file and respond with error
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Total attachment size exceeds 200MB limit.' });
    }

    // Insert attachment record
    const attachResult = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO attachments (complaint_id, filename, original_name, file_type, file_size) VALUES (?, ?, ?, ?, ?)',
        [complaintId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });

    res.status(201).json({
      attachment: {
        id: attachResult.lastID,
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
        url: `/uploads/complaints/${req.file.filename}`,
      }
    });
  } catch (err) {
    // Clean up uploaded file on error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        console.warn('Failed to cleanup file:', e.message);
      }
    }
    console.error('Upload attachment error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── DELETE /api/complaints/:id/attachments/:attachmentId ───────────────────────
// Delete specific attachment
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id, 10);
    const attachmentId = parseInt(req.params.attachmentId, 10);

    // Check if complaint exists and user has permission
    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [complaintId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    // Only owner and admin can delete
    if (req.user?.role !== 'admin' && complaint.submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Get attachment
    const attachment = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM attachments WHERE id = ? AND complaint_id = ?', [attachmentId, complaintId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

    // Delete file from filesystem
    const filePath = path.join(__dirname, '../public/uploads/complaints', attachment.filename);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn(`Failed to delete file ${attachment.filename}:`, err.message);
    }

    // Delete from database
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM attachments WHERE id = ?', [attachmentId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ message: 'Attachment deleted.' });
  } catch (err) {
    console.error('Delete attachment error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
