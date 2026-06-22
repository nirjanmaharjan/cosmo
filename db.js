// db.js — SafeVoice database setup
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'safevoice.db');
const db = new sqlite3.Database(DB_PATH);

// ── Helpers (Promise wrappers for sqlite3) ────────────────────────────────
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── Init DB ───────────────────────────────────────────────────────────────
async function init() {
  await exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','admin')),
      name TEXT,
      roll_number TEXT,
      class_name TEXT,
      section TEXT,
      degree_faculty TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Backfill derived fields for existing rows
    UPDATE users
      SET name = COALESCE(name, substr(email, 1, instr(email, '@') - 1));

    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK(status IN ('Pending','Under Review','Resolved')),
      category TEXT NOT NULL,
      faculty TEXT NOT NULL DEFAULT 'Others'
        CHECK(faculty IN ('Food','Library','Hostel','Infrastructure','Staff','IT','Transport','Administration','Others')),
      priority TEXT NOT NULL DEFAULT 'Medium'
        CHECK(priority IN ('High','Medium','Low')),
      is_sensitive BOOLEAN NOT NULL DEFAULT 0,
      department TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 10,
      submitter_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS votes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, complaint_id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Update',
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'status',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Migration: add new faculty options (IT, Transport, Administration) ──────
  const tbl = await new Promise((r, j) =>
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='complaints'", (e, row) =>
      e ? j(e) : r(row)
    )
  );
  if (tbl && tbl.sql && !tbl.sql.includes("'IT'")) {
    console.log('[db] Migrating complaints table to add new faculty options...');
    await exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      ALTER TABLE complaints RENAME TO complaints__old;
      CREATE TABLE complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending'
          CHECK(status IN ('Pending','Under Review','Resolved')),
        category TEXT NOT NULL,
        faculty TEXT NOT NULL DEFAULT 'Others'
          CHECK(faculty IN ('Food','Library','Hostel','Infrastructure','Staff','IT','Transport','Administration','Others')),
        priority TEXT NOT NULL DEFAULT 'Medium'
          CHECK(priority IN ('High','Medium','Low')),
        is_sensitive BOOLEAN NOT NULL DEFAULT 0,
        department TEXT NOT NULL,
        votes INTEGER NOT NULL DEFAULT 0,
        progress INTEGER NOT NULL DEFAULT 10,
        submitter_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO complaints SELECT * FROM complaints__old;
      DROP TABLE complaints__old;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  await exec(`
    CREATE TRIGGER IF NOT EXISTS complaints_updated_at
    AFTER UPDATE ON complaints
    FOR EACH ROW
    BEGIN
      UPDATE complaints SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);

  // Auto-create notifications and admin summary on status changes
  await exec(`
    CREATE TRIGGER IF NOT EXISTS complaints_status_resolved_notify
    AFTER UPDATE OF status ON complaints
    FOR EACH ROW
    WHEN NEW.status = 'Resolved'
    BEGIN
      INSERT INTO notifications (user_id, complaint_id, title, message, type, is_read, created_at)
      SELECT NEW.submitter_id,
             NEW.id,
             'Complaint resolved',
             'Your complaint has been resolved.',
             'status',
             0,
             datetime('now')
      WHERE NEW.submitter_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.complaint_id = NEW.id
            AND n.user_id = NEW.submitter_id
            AND n.type = 'status'
            AND n.message = 'Your complaint has been resolved.'
        );
    END;
  `);

  await seed();
}

// ── Seed ───────────────────────────────────────────────────────────────────
async function seed() {
  const row = await get('SELECT COUNT(*) as c FROM users');
  if (row?.c > 0) return;

  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  await run(
    'INSERT INTO users (email, password, role, name, roll_number, class_name, section, degree_faculty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['student@college.edu', hash('password'), 'student', 'student', 'R001', 'B.Tech', 'A', 'Engineering']
  );

  await run(
    'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
    ['admin@college.edu', hash('password'), 'admin']
  );

  const { hashId } = require('./utils/anon');
  const student = await get("SELECT id FROM users WHERE email = 'student@college.edu'");

  const complaints = [
    ['Mess food quality has deteriorated', 'Food quality issue', 'Under Review', 'Food', 'Food Services', 'High', 0, 67, 66],
    ['AC not working in Block A classrooms', 'AC issue', 'Under Review', 'Infrastructure', 'Facilities Management', 'High', 0, 45, 66],
    ['Library closes too early on weekends', 'Timing issue', 'Pending', 'Library', 'Library Services', 'Medium', 0, 32, 33],
    ['Parking lot lighting issues', 'Safety issue', 'Pending', 'Infrastructure', 'Campus Security', 'High', 0, 19, 20],
    ['Hostel hot water not working', 'Water issue', 'Pending', 'Hostel', 'Hostel Management', 'Medium', 0, 28, 25],
    ['Wi-Fi in library reading room', 'Network issue', 'Resolved', 'Library', 'IT Services', 'Low', 0, 41, 100]
  ];

  for (const c of complaints) {
    await run(
      `INSERT INTO complaints
        (title, description, status, faculty, category, priority, is_sensitive, department, votes, progress, submitter_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [...c, hashId(student.id)]
    );
  }

  console.log('Database seeded successfully');
}

init();

module.exports = db;

