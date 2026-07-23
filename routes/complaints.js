// routes/complaints.js
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const { categorizeComplaint, hasSensitiveKeywords } = require('../utils/aiCategorizer');
const { hashId } = require('../utils/anon');
const { clearCache: clearAiCache } = require('../services/geminiRiskAnalysis');

const router = express.Router();

const VALID_CATEGORIES = ['Food Services', 'Facilities', 'Library', 'Hostel', 'Security'];
const VALID_FACULTIES = ['Food', 'Library', 'Hostel', 'Infrastructure', 'Staff', 'IT', 'Transport', 'Administration', 'Others'];
const VALID_STATUSES = ['Pending', 'Under Review', 'Resolved'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

const DEPT_MAP = {
  'Food': 'Dining Services',
  'Library': 'Library Services',
  'Hostel': 'Hostel Management',
  'Infrastructure': 'Facilities Management',
  'Staff': 'HR Services',
  'IT': 'IT Services',
  'Transport': 'Transport Department',
  'Administration': 'Administration Office',
  'Others': 'Administration',
};

function timeAgo(createdAt) {
  const ms = Date.now() - new Date(createdAt + 'Z').getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + ' min' + (minutes !== 1 ? 's' : '') + ' ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' hour' + (hours !== 1 ? 's' : '') + ' ago';
  const days = Math.floor(hours / 24);
  if (days === 0) return 'Today';
  return days + ' day' + (days !== 1 ? 's' : '') + ' ago';
}

function fetchAttachments(complaintId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, filename, original_name, file_type, file_size, created_at FROM attachments WHERE complaint_id = ? ORDER BY created_at ASC',
      [complaintId],
      (err, rows) => {
        if (err) reject(err);
        else {
          resolve(
            (rows || []).map(row => ({
              id: row.id,
              name: row.original_name,
              type: row.file_type,
              size: row.file_size,
              url: `/uploads/complaints/${row.filename}`,
              created_at: row.created_at,
            }))
          );
        }
      }
    );
  });
}

function fetchCommentsCount(complaintId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) AS c FROM comments WHERE complaint_id = ?', [complaintId], (err, row) => {
      if (err) reject(err);
      else resolve(row?.c || 0);
    });
  });
}

function format(row, votedSet = new Set(), attachments = []) {
  return {
    id: row.id,
    title: row.title,
    desc: row.description,
    status: row.status,
    cat: row.category,
    faculty: row.faculty,
    pri: row.priority,
    is_sensitive: row.is_sensitive,
    dept: row.department,
    votes: row.votes,
    progress: row.progress,
    days: timeAgo(row.created_at),
    voted: votedSet.has(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachments,
    comments_count: row.comments_count || 0,
  };
}

// ── GET /api/complaints/admin/sensitive ───────────────────────────────────────
router.get('/admin/sensitive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { faculty, status, sort = 'votes', search } = req.query;

    let sql = 'SELECT *, (SELECT COUNT(*) FROM comments WHERE complaint_id = complaints.id) AS comments_count FROM complaints WHERE is_sensitive = 1 AND status != ?';
    const params = ['Resolved'];

    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?';
      params.push(faculty);
    }
    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC', priority: "CASE WHEN priority='High' THEN 0 WHEN priority='Medium' THEN 1 ELSE 2 END, created_at DESC" };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.votes}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])));
    });

    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      });
    });

    const votedSet = new Set(userVotes.map(v => v.complaint_id));

    const complaints = await Promise.all(
      rows.map(async (r) => {
        const attachments = await fetchAttachments(r.id);
        return format(r, votedSet, attachments);
      })
    );

    res.json({ complaints });
  } catch (err) {
    console.error('Get sensitive complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── POST /api/complaints/admin/ai-scan ─────────────────────────────────────────
router.post('/admin/ai-scan', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const complaints = await new Promise((resolve, reject) => {
      db.all('SELECT id, title, description, is_sensitive, priority FROM complaints', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    let updatedCount = 0;

    for (const c of complaints) {
      const aiResult = await categorizeComplaint(c.title, c.description);
      const isSensitiveVal = aiResult.is_sensitive ? 1 : 0;
      const priorityVal = aiResult.priority || 'Medium';

      let updated = false;
      if (c.is_sensitive !== isSensitiveVal) {
        await new Promise((resolve, reject) => {
          db.run('UPDATE complaints SET is_sensitive = ? WHERE id = ?', [isSensitiveVal, c.id], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        updated = true;
      }
      if (c.priority !== priorityVal) {
        await new Promise((resolve, reject) => {
          db.run('UPDATE complaints SET priority = ? WHERE id = ?', [priorityVal, c.id], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        if (!updated) updated = true;
      }
      if (updated) updatedCount++;
    }

    res.json({
      message: `AI scan completed. ${updatedCount} complaints updated.`,
      updatedCount,
    });
  } catch (err) {
    console.error('AI scan error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/complaints/stats ─────────────────────────────────────────────────
router.get('/stats', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [total, pending, review, resolved, highPri, mediumPri, lowPri, sensitiveCount, byFaculty, bySensitivity] =
      await Promise.all([
        new Promise((resolve, reject) => {
          db.get('SELECT COUNT(*) AS c FROM complaints', (err, row) => {
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
          db.get("SELECT COUNT(*) AS c FROM complaints WHERE priority = 'High' AND status != 'Resolved'", (err, row) => {
            if (err) reject(err);
            else resolve(row?.c || 0);
          });
        }),
        new Promise((resolve, reject) => {
          db.get("SELECT COUNT(*) AS c FROM complaints WHERE priority = 'Medium' AND status != 'Resolved'", (err, row) => {
            if (err) reject(err);
            else resolve(row?.c || 0);
          });
        }),
        new Promise((resolve, reject) => {
          db.get("SELECT COUNT(*) AS c FROM complaints WHERE priority = 'Low' AND status != 'Resolved'", (err, row) => {
            if (err) reject(err);
            else resolve(row?.c || 0);
          });
        }),
        new Promise((resolve, reject) => {
          db.get("SELECT COUNT(*) AS c FROM complaints WHERE is_sensitive = 1 AND status != 'Resolved'", (err, row) => {
            if (err) reject(err);
            else resolve(row?.c || 0);
          });
        }),
        new Promise((resolve, reject) => {
          db.all(`
            SELECT faculty, COUNT(*) AS count
            FROM complaints
            GROUP BY faculty
            ORDER BY count DESC
          `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          });
        }),
        new Promise((resolve, reject) => {
          db.all(`
            SELECT is_sensitive, COUNT(*) AS count
            FROM complaints
            GROUP BY is_sensitive
          `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          });
        }),
      ]);

    res.json({
      total,
      pending,
      review,
      resolved,
      highPri,
      mediumPri,
      lowPri,
      sensitiveCount,
      byFaculty,
      bySensitivity,
    });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/complaints/my ─────────────────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    // Student track-page currently supports `faculty`.
    // UI home filter sends `category` values (Food Services | Facilities | Library | Hostel | Security).
    // Map `category` -> DB faculty so the student track list can filter properly too.
    const { status, faculty: facultyRaw, sort = 'new', search, category, priority } = req.query;

    let faculty = null;
    if (facultyRaw && VALID_FACULTIES.includes(facultyRaw)) {
      faculty = facultyRaw;
    } else if (category && VALID_CATEGORIES.includes(category)) {
      const catToFaculty = {
        'Food Services': 'Food',
        'Facilities': 'Infrastructure',
        'Library': 'Library',
        'Hostel': 'Hostel',
        'Security': 'Staff',
      };
      const facVal = catToFaculty[category];
      if (facVal) faculty = facVal;
    }

    let sql = 'SELECT *, (SELECT COUNT(*) FROM comments WHERE complaint_id = complaints.id) AS comments_count FROM complaints WHERE submitter_id = ?';
    const params = [hashId(req.user.id)];

    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?';
      params.push(faculty);
    }

    if (category && VALID_CATEGORIES.includes(category)) {
      const catToFaculty = {
        'Food Services': 'Food',
        'Facilities': 'Infrastructure',
        'Library': 'Library',
        'Hostel': 'Hostel',
        'Security': 'Staff',
      };
      const facVal = catToFaculty[category];
      if (facVal) {
        sql += ' AND faculty = ?';
        params.push(facVal);
      }
    }

    if (priority && VALID_PRIORITIES.includes(priority)) {
      sql += ' AND priority = ?';
      params.push(priority);
    }

    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
    }
    if (priority && VALID_PRIORITIES.includes(priority)) {
      sql += ' AND priority = ?';
      params.push(priority);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC', priority: "CASE WHEN priority='High' THEN 0 WHEN priority='Medium' THEN 1 ELSE 2 END, created_at DESC" };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.votes}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])));
    });

    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      });
    });

    const votedSet = new Set(userVotes.map(v => v.complaint_id));

    const complaints = await Promise.all(
      rows.map(async (r) => {
        const attachments = await fetchAttachments(r.id);
        return format(r, votedSet, attachments);
      })
    );

    res.json({ complaints });
  } catch (err) {
    console.error('Get my complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/complaints ───────────────────────────────────────────────────────
// Important: home-page filters
// - category dropdown => query param `category` (DB column: complaints.category)
// - faculty filter (admin) => query param `faculty` (DB column: complaints.faculty)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, faculty, category, priority, sort = 'votes', search, all } = req.query;

    let sql = 'SELECT *, (SELECT COUNT(*) FROM comments WHERE complaint_id = complaints.id) AS comments_count FROM complaints WHERE 1=1';
    const params = [];

    // All users (including admins) only see non-sensitive complaints in the regular feed
    // unless sensitive=1 is explicitly requested by an admin
    if (all === '1' && req.query.sensitive === '1' && req.user.role === 'admin') {
      // Admin loading all complaints (e.g. live status) – include sensitive
    } else {
      sql += ' AND is_sensitive = 0';
    }
    // Filter out resolved complaints (they go to resolved page) unless ?all=1
    if (all !== '1') {
      sql += ' AND status != ?';
      params.push('Resolved');
    }

    if (status && VALID_STATUSES.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?';
      params.push(faculty);
    }

    if (priority && VALID_PRIORITIES.includes(priority)) {
      sql += ' AND priority = ?';
      params.push(priority);
    }

    // Home “Categories” dropdown sends query param `category` values like:
    // Food Services | Facilities | Library | Hostel | Security
    // But DB columns historically mix `category` and `faculty`.
    // To make filtering reliable, map UI category -> DB faculty and filter by `faculty`.
    if (category && VALID_CATEGORIES.includes(category)) {
      const catToFaculty = {
        'Food Services': 'Food',
        'Facilities': 'Infrastructure',
        'Library': 'Library',
        'Hostel': 'Hostel',
        'Security': 'Staff',
      };
      const facVal = catToFaculty[category];
      if (facVal) {
        sql += ' AND faculty = ?';
        params.push(facVal);
      }
    }

    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC', priority: "CASE WHEN priority='High' THEN 0 WHEN priority='Medium' THEN 1 ELSE 2 END, created_at DESC" };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.votes}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])));
    });

    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      });
    });

    const votedSet = new Set(userVotes.map(v => v.complaint_id));

    // Defense-in-depth: filter complaints with sensitive keywords even if is_sensitive flag is 0
    const filteredRows = (all === '1' && req.query.sensitive === '1' && req.user.role === 'admin') ? rows : rows.filter(r => !hasSensitiveKeywords(r.title, r.description));

    const complaints = await Promise.all(
      filteredRows.map(async (r) => {
        const attachments = await fetchAttachments(r.id);
        return format(r, votedSet, attachments);
      })
    );

    res.json({ complaints });
  } catch (err) {
    console.error('Get complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/complaints/:id ─────────────────────────────────────────────────
// GET /api/complaints/resolved/public — non-sensitive resolved for all users
router.get('/resolved/public', requireAuth, async (req, res) => {
  try {
    const { faculty, priority, category, sort = 'new', search } = req.query;

    let sql = "SELECT *, (SELECT COUNT(*) FROM comments WHERE complaint_id = complaints.id) AS comments_count FROM complaints WHERE status = ? AND is_sensitive = 0";
    const params = ['Resolved'];

    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?';
      params.push(faculty);
    }

    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC', priority: "CASE WHEN priority='High' THEN 0 WHEN priority='Medium' THEN 1 ELSE 2 END, created_at DESC" };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.new}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])));
    });

    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      });
    });

    const votedSet = new Set(userVotes.map(v => v.complaint_id));

    const complaints = await Promise.all(
      rows.map(async (r) => {
        const attachments = await fetchAttachments(r.id);
        return format(r, votedSet, attachments);
      })
    );

    res.json({ complaints });
  } catch (err) {
    console.error('Get public resolved complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/complaints/resolved (admin — all resolved complaints)
router.get('/resolved', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { faculty, sort = 'new', search } = req.query;

    let sql = 'SELECT *, (SELECT COUNT(*) FROM comments WHERE complaint_id = complaints.id) AS comments_count FROM complaints WHERE status = ?';
    const params = ['Resolved'];

    if (faculty && VALID_FACULTIES.includes(faculty)) {
      sql += ' AND faculty = ?';
      params.push(faculty);
    }

    if (search) {
      const like = `%${search}%`;
      sql += ' AND (title LIKE ? OR description LIKE ?)';
      params.push(like, like);
    }

    const orderMap = { votes: 'votes DESC', new: 'created_at DESC', old: 'created_at ASC', priority: "CASE WHEN priority='High' THEN 0 WHEN priority='Medium' THEN 1 ELSE 2 END, created_at DESC" };
    sql += ` ORDER BY ${orderMap[sort] || orderMap.new}`;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])));
    });

    const userVotes = await new Promise((resolve, reject) => {
      db.all('SELECT complaint_id FROM votes WHERE user_id = ?', [req.user.id], (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      });
    });

    const votedSet = new Set(userVotes.map(v => v.complaint_id));

    const complaints = await Promise.all(
      rows.map(async (r) => {
        const attachments = await fetchAttachments(r.id);
        return format(r, votedSet, attachments);
      })
    );

    res.json({ complaints });
  } catch (err) {
    console.error('Get resolved complaints error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/complaints/chat-list — complaints with chat history
router.get('/chat-list', requireAuth, async (req, res) => {
  try {
    const viewerHash = hashId(req.user.id);
    const otherRole = req.user.role === 'admin' ? 'student' : 'admin';
    let sql, params;
    if (req.user.role === 'admin') {
      sql = `SELECT DISTINCT c.id, c.title, c.description, c.status, c.created_at, c.category AS cat,
               (SELECT COUNT(*) FROM anonymous_chat WHERE complaint_id = c.id) AS chat_count,
               (SELECT MAX(created_at) FROM anonymous_chat WHERE complaint_id = c.id) AS last_msg_at,
               (SELECT message FROM anonymous_chat WHERE complaint_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_msg,
               COALESCE((SELECT COUNT(*) FROM anonymous_chat ac2
                 WHERE ac2.complaint_id = c.id
                   AND ac2.sender_role = ?
                   AND (cr.last_read_at IS NULL OR ac2.created_at > cr.last_read_at)), 0) AS unread_count
             FROM complaints c
             INNER JOIN anonymous_chat ac ON ac.complaint_id = c.id
             LEFT JOIN chat_read_status cr ON cr.complaint_id = c.id AND cr.user_hash = ?
             ORDER BY last_msg_at DESC`;
      params = [otherRole, viewerHash];
    } else {
      sql = `SELECT DISTINCT c.id, c.title, c.description, c.status, c.created_at, c.category AS cat,
               (SELECT COUNT(*) FROM anonymous_chat WHERE complaint_id = c.id) AS chat_count,
               (SELECT MAX(created_at) FROM anonymous_chat WHERE complaint_id = c.id) AS last_msg_at,
               (SELECT message FROM anonymous_chat WHERE complaint_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_msg,
               COALESCE((SELECT COUNT(*) FROM anonymous_chat ac2
                 WHERE ac2.complaint_id = c.id
                   AND ac2.sender_role = ?
                   AND (cr.last_read_at IS NULL OR ac2.created_at > cr.last_read_at)), 0) AS unread_count
             FROM complaints c
             INNER JOIN anonymous_chat ac ON ac.complaint_id = c.id
             LEFT JOIN chat_read_status cr ON cr.complaint_id = c.id AND cr.user_hash = ?
             WHERE c.submitter_id = ?
             ORDER BY last_msg_at DESC`;
      params = [otherRole, viewerHash, viewerHash];
    }
    const rows = await new Promise((r, j) => db.all(sql, params, (e, rows) => e ? j(e) : r(rows || [])));
    res.json({ complaints: rows });
  } catch (err) {
    console.error('Chat list error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [req.params.id], (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });

    if (!row) return res.status(404).json({ error: 'Complaint not found.' });

    const viewerHash = req.user.id ? hashId(req.user.id) : null;

    if (req.user?.role !== 'admin' && row.submitter_id !== viewerHash) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (req.user?.role !== 'admin' && row.submitter_id !== viewerHash && row.is_sensitive) {
      return res.status(403).json({ error: 'Sensitive complaints are for admin only.' });
    }

    const voted = await new Promise((resolve, reject) => {
      db.get('SELECT 1 FROM votes WHERE user_id = ? AND complaint_id = ?', [req.user.id, row.id], (err, r) => {
        if (err) reject(err);
        else resolve(!!r);
      });
    });

    const attachments = await fetchAttachments(row.id);

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

// POST /api/complaints
const upload = require('../middleware/upload');
router.post('/', requireAuth, upload.array('photos', 10), async (req, res) => {
  try {
    const { title, description, faculty, category } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });
    if (!description?.trim()) return res.status(400).json({ error: 'Description is required.' });

    const catToFaculty = {
      'Food Services': 'Food',
      'Facilities': 'Infrastructure',
      'Library': 'Library',
      'Hostel': 'Hostel',
      'Security': 'Staff',
      'IT Services': 'IT',
      'Transport': 'Transport',
      'Administration': 'Administration',
    };

    let fac = faculty;
    if ((!fac || !VALID_FACULTIES.includes(fac)) && category && catToFaculty[category]) {
      fac = catToFaculty[category];
    }

    const aiResult = await categorizeComplaint(title, description);
    const aiFac = aiResult.faculty;

    const finalFac = fac && VALID_FACULTIES.includes(fac)
      ? fac
      : (VALID_FACULTIES.includes(aiFac) ? aiFac : 'Others');

    const finalPri = VALID_PRIORITIES.includes(aiResult.priority) ? aiResult.priority : 'Medium';

    const sens = aiResult.is_sensitive;

    const dept = DEPT_MAP[finalFac] || 'Administration';

    const facultyToCategory = {
      Food: 'Food Services',
      Infrastructure: 'Facilities',
      Library: 'Library',
      Hostel: 'Hostel',
      Staff: 'Security',
      IT: 'IT Services',
      Transport: 'Transport',
      Administration: 'Administration',
      Others: 'Other',
    };

    const cat = facultyToCategory[finalFac] || 'Facilities';

    const info = await new Promise((resolve, reject) => {
      db.run(
        `
        INSERT INTO complaints (title, description, status, category, faculty, priority, is_sensitive, department, submitter_id)
        VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?, ?)
        `,
        [title.trim(), description.trim(), cat, finalFac, finalPri, sens ? 1 : 0, dept, hashId(req.user.id)],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });

    const files = req.files || [];
    if (files.length) {
      await Promise.all(
        files.map(f => {
          return new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO attachments (complaint_id, filename, original_name, file_type, file_size)
               VALUES (?, ?, ?, ?, ?)`,
              [info.lastID, f.filename, f.originalname, f.mimetype, f.size || 0],
              (err) => (err ? reject(err) : resolve())
            );
          });
        })
      );
    }

    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [info.lastID], (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });

    const attachments = await fetchAttachments(info.lastID);
    clearAiCache();
    res.status(201).json({ complaint: format(row, new Set(), attachments) });
  } catch (err) {
    console.error('Create complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// PATCH /api/complaints/:id/status
router.patch('/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body || {};

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid complaint id.' });
    if (!status) return res.status(400).json({ error: 'Missing required field: status.' });
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}.` });
    }

    const progressMap = { Pending: 20, 'Under Review': 66, Resolved: 100 };

    const info = await new Promise((resolve, reject) => {
      db.run(
        `UPDATE complaints SET status = ?, progress = ? WHERE id = ?`,
        [status, progressMap[status], id],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });

    if (info.changes === 0) return res.status(404).json({ error: 'Complaint not found.' });

    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [id], (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });

    clearAiCache();
    res.json({ complaint: format(row) });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});


// POST /api/complaints/:id/vote
router.post('/:id/vote', requireAuth, async (req, res) => {
  try {
    const complaintId = parseInt(req.params.id, 10);
    const userId = req.user.id;

    const complaint = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM complaints WHERE id = ?', [complaintId], (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });

    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    if (req.user?.role !== 'admin' && complaint.is_sensitive) {
      return res.status(403).json({ error: 'Cannot vote on sensitive complaints.' });
    }

    const existing = await new Promise((resolve, reject) => {
      db.get(
        'SELECT 1 FROM votes WHERE user_id = ? AND complaint_id = ?',
        [userId, complaintId],
        (err, r) => {
          if (err) reject(err);
          else resolve(!!r);
        }
      );
    });

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

      const updated = await new Promise((resolve, reject) => {
        db.get('SELECT votes FROM complaints WHERE id = ?', [complaintId], (err, r) => {
          if (err) reject(err);
          else resolve(r);
        });
      });

      return res.json({ voted: false, votes: updated.votes });
    }

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

    const updated = await new Promise((resolve, reject) => {
      db.get('SELECT votes FROM complaints WHERE id = ?', [complaintId], (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });

    res.json({ voted: true, votes: updated.votes });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/complaints/:id (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const attachments = await new Promise((resolve, reject) => {
      db.all('SELECT filename FROM attachments WHERE complaint_id = ?', [req.params.id], (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      });
    });

    const uploadsDir = path.join(__dirname, '../public/uploads/complaints');
    for (const att of attachments) {
      try {
        fs.unlinkSync(path.join(uploadsDir, att.filename));
      } catch (err) {
        console.warn(`Failed to delete file ${att.filename}:`, err.message);
      }
    }

    const info = await new Promise((resolve, reject) => {
      db.run('DELETE FROM complaints WHERE id = ?', [req.params.id], function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    if (info.changes === 0) return res.status(404).json({ error: 'Complaint not found.' });
    clearAiCache();
    res.json({ message: 'Complaint deleted.' });
  } catch (err) {
    console.error('Delete complaint error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/complaints/describe-image — AI describe image using Gemini (direct REST)
router.post('/describe-image', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      fs.unlink(req.file.path, () => {});
      return res.json({ title: 'Complaint with photo', description: 'Photo attached by user. Please describe the issue in the text fields above.' });
    }

    const imagePath = req.file.path;
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const mimeType = req.file.mimetype;

    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{
        parts: [
          { text: 'Analyze this image for a college complaint. First give a short 5-10 word title on a line starting with TITLE:, then give a 2-3 sentence description on a line starting with DESC:. Example:\nTITLE: Broken desk in library\nDESC: The wooden desk on the second floor has a large crack across the surface.' },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]
      }]
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[describe-image] HTTP', resp.status, JSON.stringify(data));
      fs.unlink(imagePath, () => {});
      return res.json({ title: 'Complaint with photo', description: 'Photo attached by user. Please describe the issue in the text fields above.' });
    }

    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ') || '';
    let title = 'Complaint with photo';
    let description = 'Could not generate description.';
    const tm = raw.match(/TITLE:\s*(.+)/i);
    const dm = raw.match(/DESC:\s*(.+)/i);
    if (tm) title = tm[1].trim();
    if (dm) description = dm[1].trim();

    // Clean up uploaded temp file
    fs.unlink(imagePath, () => {});

    res.json({ title, description });
  } catch (err) {
    console.error('Describe image error:', err);
    res.status(500).json({ error: 'Failed to analyze image.' });
  }
});

// ── Mark chat as read ──────────────────────────────────────────────────────
router.post('/:id/chat/read', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

    const row = await new Promise((r, j) => db.get('SELECT * FROM complaints WHERE id = ?', [id], (e, row) => e ? j(e) : r(row)));
    if (!row) return res.status(404).json({ error: 'Not found.' });

    const viewerHash = hashId(req.user.id);
    if (req.user.role !== 'admin' && row.submitter_id !== viewerHash) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    await new Promise((r, j) => db.run(
      'INSERT INTO chat_read_status (user_hash, complaint_id, last_read_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(user_hash, complaint_id) DO UPDATE SET last_read_at = datetime(\'now\')',
      [viewerHash, id],
      e => e ? j(e) : r()
    ));
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Anonymous Chat ───────────────────────────────────────────────────────────
// GET /api/complaints/:id/chat — get chat messages
router.get('/:id/chat', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

    const row = await new Promise((r, j) => db.get('SELECT * FROM complaints WHERE id = ?', [id], (e, row) => e ? j(e) : r(row)));
    if (!row) return res.status(404).json({ error: 'Not found.' });

    const viewerHash = req.user.id ? require('../utils/anon').hashId(req.user.id) : null;
    if (req.user.role !== 'admin' && row.submitter_id !== viewerHash) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const msgs = await new Promise((r, j) => db.all('SELECT * FROM anonymous_chat WHERE complaint_id = ? ORDER BY created_at ASC', [id], (e, rows) => e ? j(e) : r(rows || [])));
    res.json({ messages: msgs.map(m => ({
      id: m.id,
      message: m.message,
      sender_role: m.sender_role,
      created_at: m.created_at,
      is_mine: (req.user.role === 'admin' && m.sender_role === 'admin') || (req.user.role !== 'admin' && m.sender_role === 'student')
    })) });
  } catch (err) {
    console.error('Get chat error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/complaints/:id/chat — send chat message
router.post('/:id/chat', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id.' });

    const { message } = req.body || {};
    const txt = message?.trim();
    if (!txt) return res.status(400).json({ error: 'Message is required.' });

    const row = await new Promise((r, j) => db.get('SELECT * FROM complaints WHERE id = ?', [id], (e, row) => e ? j(e) : r(row)));
    if (!row) return res.status(404).json({ error: 'Not found.' });

    const viewerHash = req.user.id ? require('../utils/anon').hashId(req.user.id) : null;
    if (req.user.role !== 'admin' && row.submitter_id !== viewerHash) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const senderRole = req.user.role === 'admin' ? 'admin' : 'student';
    await new Promise((r, j) => db.run('INSERT INTO anonymous_chat (complaint_id, sender_role, message) VALUES (?, ?, ?)', [id, senderRole, txt], e => e ? j(e) : r()));

    res.status(201).json({ message: 'Sent.' });
  } catch (err) {
    console.error('Send chat error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;




