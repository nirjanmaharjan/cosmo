// routes/complaints.js
const express = require('express');
const path = require('path');

const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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
    const { status, faculty, category, sort = 'votes', search } = req.query;

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

    // Enrich with staff/escalation flags derived from notifications (no schema changes)
    const staffRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT message
         FROM notifications
         WHERE complaint_id = ? AND type = 'staff_assignment'
         ORDER BY created_at DESC
         LIMIT 1`,
        [row.id],
        (err, r) => (err ? reject(err) : resolve(r))
      );
    });

    const escalatedRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT 1 as ok
         FROM notifications
         WHERE complaint_id = ? AND type = 'escalation'
         ORDER BY created_at DESC
         LIMIT 1`,
        [row.id],
        (err, r) => (err ? reject(err) : resolve(r))
      );
    });

    const formatted = format(row, voted ? new Set([row.id]) : new Set(), attachments);
    formatted.staff = staffRow?.message || null;
    formatted.escalated = !!escalatedRow;

    res.json({ complaint: formatted });
  } catch (err) {
    console.error('Get complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});




// ── POST /api/complaints ──────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    // Frontend currently sends `category` (Food Services/Facilities/...) not `faculty`.
    // Accept both, and map category -> faculty when faculty isn't provided.
    const { title, description, faculty, category, priority } = req.body;


    if (!title?.trim())       return res.status(400).json({ error: 'Title is required.' });
    if (!description?.trim()) return res.status(400).json({ error: 'Description is required.' });

    // Map category->faculty if only category is provided
    const catToFaculty = {
      'Food Services': 'Food',
      'Facilities': 'Infrastructure',
      'Library': 'Library',
      'Hostel': 'Hostel',
      'Security': 'Staff',
    };

    let fac = faculty;
    if ((!fac || !VALID_FACULTIES.includes(fac)) && category && catToFaculty[category]) {
      fac = catToFaculty[category];
    }

    let pri = priority;
    let sens = false;


    // Always use AI to categorize complaints for consistent priority and sensitivity detection
    const aiResult = await categorizeComplaint(title, description);
    
    // Preserve mapped faculty (from request category) when present.
    // Use AI for sensitivity detection, and only override priority when caller didn't provide a valid one.
    // If AI fails or returns something unexpected, keep/make a best-effort faculty.
    const aiFac = aiResult.faculty;
    const finalFac = (fac && VALID_FACULTIES.includes(fac))
      ? fac
      : (VALID_FACULTIES.includes(aiFac) ? aiFac : 'Others');

    fac = finalFac;
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

    // Store a stable `category` value in DB so frontend category filters match AI output.
    // Frontend expects: Food Services | Facilities | Library | Hostel | Security
    const facultyToCategory = {
      Food: 'Food Services',
      Infrastructure: 'Facilities',
      Library: 'Library',
      Hostel: 'Hostel',
      Staff: 'Security',
      Others: 'Facilities',
    };

    const cat = facultyToCategory[fac] || 'Facilities';


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
    const id = Number(req.params.id);
    const { status } = req.body || {};

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid complaint id.' });
    }

    if (!status) {
      return res.status(400).json({ error: 'Missing required field: status.' });
    }

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}.` });
    }

    const progressMap = { 'Pending': 20, 'Under Review': 66, 'Resolved': 100 };
    if (typeof progressMap[status] !== 'number') {
      return res.status(400).json({ error: 'Invalid status progress mapping.' });
    }

    const info = await new Promise((resolve, reject) => {
      db.run(
        `
        UPDATE complaints SET status = ?, progress = ? WHERE id = ?
      `,
        [status, progressMap[status], id],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });






    if (info.changes === 0) return res.status(404).json({ error: 'Complaint not found.' });

    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    res.json({ complaint: format(row) });
  } catch (err) {
    console.error('Update status error:', {
      id: req.params?.id,
      status: req.body?.status,
      err: err?.message,
      stack: err?.stack,
    });
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

// (Attachments feature removed: no endpoints for listing/uploading/deleting files.)

// ─────────────────────────────────────────────────────────────────────────────
// Admin Notes + Complaint Timeline + Staff Assignment + Escalation badge
// Implemented using existing `notifications` table only (no schema changes).
// Notification `type` conventions:
// - admin_note: internal admin notes (message contains note text)
// - timeline_event: generic timeline events (message contains event text)
// - staff_assignment: staff assignment events (message contains staff identifier/name)
// - escalation: escalation events (message contains reason/text)
//
// Admin Notes

router.get('/:id/admin/notes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, message, created_at, title, type, is_read
         FROM notifications
         WHERE complaint_id = ? AND type = 'admin_note'
         ORDER BY created_at ASC`,
        [id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    res.json({ notes: rows.map(r => ({ id: r.id, text: r.message, created_at: r.created_at })) });
  } catch (err) {
    console.error('Get admin notes error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/:id/admin/notes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { note } = req.body || {};
    if (!note?.trim()) return res.status(400).json({ error: 'Missing note.' });

    // Validate complaint exists
    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM complaints WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    // Store note as notification event for the admin (user_id = admin)
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO notifications (user_id, complaint_id, title, message, type, is_read)
         VALUES (?, ?, ?, ?, 'admin_note', 0)`,
        [req.user.id, id, 'Admin note', note.trim()],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.status(201).json({ message: 'Admin note added.' });
  } catch (err) {
    console.error('Add admin note error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Timeline (admin + owner)
router.get('/:id/timeline', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    if (req.user?.role !== 'admin' && complaint.submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (req.user?.role !== 'admin' && complaint.is_sensitive) {
      return res.status(403).json({ error: 'Sensitive complaints are for admin only.' });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, message, type, created_at, user_id
         FROM notifications
         WHERE complaint_id = ?
           AND type IN ('status_event','timeline_event','admin_note','staff_assignment','escalation','status')
         ORDER BY created_at ASC`,
        [id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    res.json({ timeline: rows.map(r => ({ id: r.id, type: r.type, title: r.title, message: r.message, created_at: r.created_at })) });
  } catch (err) {
    console.error('Get timeline error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Staff assignment display
router.get('/:id/staff', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    if (req.user?.role !== 'admin' && complaint.submitter_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT message, created_at
         FROM notifications
         WHERE complaint_id = ? AND type = 'staff_assignment'
         ORDER BY created_at DESC
         LIMIT 1`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    res.json({ staff: row?.message || null });
  } catch (err) {
    console.error('Get staff error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/:id/staff', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { staff } = req.body || {};
    if (!staff?.trim()) return res.status(400).json({ error: 'Missing staff.' });

    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM complaints WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO notifications (user_id, complaint_id, title, message, type, is_read)
         VALUES (?, ?, 'Staff assignment', ?, 'staff_assignment', 0)`,
        [req.user.id, id, staff.trim()],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.status(201).json({ message: 'Staff assigned.' });
  } catch (err) {
    console.error('Assign staff error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Escalation badge
router.get('/:id/escalated', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT 1 as ok
         FROM notifications
         WHERE complaint_id = ? AND type = 'escalation'
         ORDER BY created_at DESC
         LIMIT 1`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });
    res.json({ escalated: !!row });
  } catch (err) {
    console.error('Get escalated error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/:id/escalation', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reason } = req.body || {};
    if (!reason?.trim()) return res.status(400).json({ error: 'Missing reason.' });

    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM complaints WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
    });
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO notifications (user_id, complaint_id, title, message, type, is_read)
         VALUES (?, ?, 'Escalation', ?, 'escalation', 0)`,
        [req.user.id, id, reason.trim()],
        (err) => (err ? reject(err) : resolve())
      );
    });

    res.status(201).json({ message: 'Complaint escalated.' });
  } catch (err) {
    console.error('Escalation error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;

