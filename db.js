// db.js — SafeVoice database setup (FIXED: avoids better-sqlite3 build issues)
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK(status IN ('Pending','Under Review','Resolved')),
      category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Medium'
        CHECK(priority IN ('High','Medium','Low')),
      department TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 10,
      submitter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS votes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, complaint_id)
    );
  `);

  await exec(`
    CREATE TRIGGER IF NOT EXISTS complaints_updated_at
    AFTER UPDATE ON complaints
    FOR EACH ROW
    BEGIN
      UPDATE complaints SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);

  await seed();
}

// ── Seed ───────────────────────────────────────────────────────────────────
async function seed() {
  const row = await get('SELECT COUNT(*) as c FROM users');
  if (row.c > 0) return;

  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  await run(
    'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
    ['student@college.edu', hash('password'), 'student']
  );

  await run(
    'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
    ['admin@college.edu', hash('password'), 'admin']
  );

  const student = await get(
    "SELECT id FROM users WHERE email = 'student@college.edu'"
  );

  const complaints = [
    ['Mess food quality has deteriorated', 'Food quality issue', 'Under Review', 'Food Services', 'High', 'Dining Services', 67, 66],
    ['AC not working in Block A classrooms', 'AC issue', 'Under Review', 'Facilities', 'High', 'Facilities Management', 45, 66],
    ['Library closes too early on weekends', 'Timing issue', 'Pending', 'Library', 'Medium', 'Library Services', 32, 33],
    ['Parking lot lighting issues', 'Safety issue', 'Pending', 'Security', 'High', 'Campus Security', 19, 20],
    ['Hostel hot water not working', 'Water issue', 'Pending', 'Hostel', 'Medium', 'Hostel Management', 28, 25],
    ['Wi-Fi in library reading room', 'Network issue', 'Resolved', 'Library', 'Low', 'IT Services', 41, 100]
  ];

  for (const c of complaints) {
    await run(
      `INSERT INTO complaints 
      (title, description, status, category, priority, department, votes, progress, submitter_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [...c, student.id]
    );
  }

  console.log('Database seeded successfully');
}

init();

module.exports = db;
