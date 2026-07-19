const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { getRiskDashboard, generateAiReport, clearCache } = require('../services/geminiRiskAnalysis');

const router = express.Router();

// GET /api/admin/students
// Supports: search (name/email/roll_number), class_name, section, degree_faculty
router.get('/students', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      search = '',
      class_name = '',
      section = '',
      degree_faculty = '',
    } = req.query || {};

    const params = [];
    let sql = `SELECT id, name, roll_number, class_name, section, degree_faculty, email, role
                FROM users
                WHERE role = 'student'`;

    if (class_name) {
      sql += ' AND class_name = ?';
      params.push(class_name);
    }
    if (section) {
      sql += ' AND section = ?';
      params.push(section);
    }
    if (degree_faculty) {
      sql += ' AND degree_faculty = ?';
      params.push(degree_faculty);
    }

    const q = String(search || '').trim();
    if (q) {
      const like = `%${q}%`;
      sql += ' AND (name LIKE ? OR email LIKE ? OR roll_number LIKE ?)';
      params.push(like, like, like);
    }

    sql += ' ORDER BY class_name ASC, section ASC, roll_number ASC';

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])));
    });

    res.json({
      students: rows.map((r) => ({
        id: r.id,
        name: r.name,
        roll_number: r.roll_number,
        class_name: r.class_name,
        section: r.section,
        degree_faculty: r.degree_faculty,
        email: r.email,
      })),
    });
  } catch (err) {
    console.error('Admin list students error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/students/:id/reset-password
// Admin resets a student password.
// Body: { password }
router.post(
  '/students/:id/reset-password',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { password } = req.body || {};

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid student id.' });
      }
      if (!password || typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }
      if (!/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must contain at least one number.' });
      }
      if (!/[^a-zA-Z0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must contain at least one special character.' });
      }

      const student = await new Promise((resolve, reject) => {
        db.get('SELECT id, role FROM users WHERE id = ?', [id], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });

      if (!student || student.role !== 'student') {
        return res.status(404).json({ error: 'Student not found.' });
      }

      const hashed = bcrypt.hashSync(password, 10);

      const info = await new Promise((resolve, reject) => {
        db.run(
          'UPDATE users SET password = ? WHERE id = ?',
          [hashed, id],
          function (err) {
            if (err) reject(err);
            else resolve(this);
          }
        );
      });

      if (info.changes === 0) {
        return res.status(404).json({ error: 'Student not found.' });
      }

      res.json({ message: 'Password reset.' });
    } catch (err) {
      console.error('Admin reset student password error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// PUT /api/admin/students/:id
// Admin updates a student's profile.
// Body: { name, roll_number, class_name, section, degree_faculty, email }
router.put(
  '/students/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const {
        name,
        roll_number,
        class_name,
        section,
        degree_faculty,
        email,
      } = req.body || {};

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid student id.' });
      }

      const student = await new Promise((resolve, reject) => {
        db.get('SELECT id, role FROM users WHERE id = ?', [id], (err, row) =>
          err ? reject(err) : resolve(row)
        );
      });

      if (!student || student.role !== 'student') {
        return res.status(404).json({ error: 'Student not found.' });
      }

      const updates = {};
      if (typeof name === 'string') updates.name = name.trim();
      if (typeof roll_number === 'string') updates.roll_number = roll_number.trim();
      if (typeof class_name === 'string') updates.class_name = class_name.trim();
      if (typeof section === 'string') updates.section = section.trim();
      if (typeof degree_faculty === 'string') updates.degree_faculty = degree_faculty.trim();
      if (typeof email === 'string') updates.email = email.trim();

      const keys = Object.keys(updates);
      if (!keys.length) {
        return res.status(400).json({ error: 'No fields to update.' });
      }

      // Build query dynamically
      const setSql = keys.map((k) => `${k} = ?`).join(', ');
      const params = keys.map((k) => updates[k]);
      params.push(id);

      // Ensure updates do not violate role constraint (we only touch student row)
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE users SET ${setSql} WHERE id = ? AND role = 'student'`,
          params,
          function (err) {
            if (err) reject(err);
            else resolve(this);
          }
        );
      });

      res.json({ message: 'Student updated.' });
    } catch (err) {
      console.error('Admin update student error:', err);
      // Most common issue: duplicate email
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// POST /api/admin/students
// Admin adds a new student.
// Body: { email, password, name, roll_number, class_name, section, degree_faculty }
router.post(
  '/students',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        email,
        password,
        name,
        roll_number,
        class_name,
        section,
        degree_faculty,
      } = req.body || {};

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required.' });
      }
      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const hashed = bcrypt.hashSync(password, 10);

      const info = await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO users (email, password, role, name, roll_number, class_name, section, degree_faculty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            email.trim(),
            hashed,
            'student',
            typeof name === 'string' ? name.trim() : null,
            typeof roll_number === 'string' ? roll_number.trim() : null,
            typeof class_name === 'string' ? class_name.trim() : null,
            typeof section === 'string' ? section.trim() : null,
            typeof degree_faculty === 'string' ? degree_faculty.trim() : null,
          ],
          function (err) {
            if (err) reject(err);
            else resolve(this);
          }
        );
      });

      res.json({ message: 'Student added.', id: info.lastID });
    } catch (err) {
      console.error('Admin add student error:', err);
      // Likely duplicate email
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// DELETE /api/admin/students/:id
// Admin removes a student.
router.delete(
  '/students/:id',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid student id.' });
      }

      const info = await new Promise((resolve, reject) => {
        db.run(
          'DELETE FROM users WHERE id = ? AND role = "student"',
          [id],
          function (err) {
            if (err) reject(err);
            else resolve(this);
          }
        );
      });

      if (info.changes === 0) {
        return res.status(404).json({ error: 'Student not found.' });
      }

      res.json({ message: 'Student removed.' });
    } catch (err) {
      console.error('Admin delete student error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
);

// GET /api/admin/ai-risk-dashboard
router.get('/ai-risk-dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await getRiskDashboard();
    res.json(data);
  } catch (err) {
    console.error('AI risk dashboard error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/ai-report
router.post('/ai-report', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await generateAiReport();
    res.json(data);
  } catch (err) {
    console.error('AI report error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/admin/ai-clear-cache
router.post('/ai-clear-cache', requireAuth, requireAdmin, async (req, res) => {
  clearCache();
  res.json({ message: 'Cache cleared.' });
});

module.exports = router;

