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

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS anonymous_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('student','admin')),
      message TEXT NOT NULL,
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

  // ── Trigger: notify admins when a sensitive complaint is created ──────────
  await exec(`
    CREATE TRIGGER IF NOT EXISTS complaint_sensitive_admin_notify
    AFTER INSERT ON complaints
    FOR EACH ROW
    WHEN NEW.is_sensitive = 1
    BEGIN
      INSERT INTO notifications (user_id, complaint_id, title, message, type, is_read, created_at)
      SELECT 'admin',
             NEW.id,
             'Sensitive complaint',
             'A new sensitive complaint "' || NEW.title || '" has been submitted.',
             'sensitive',
             0,
             datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.complaint_id = NEW.id AND n.user_id = 'admin' AND n.type = 'sensitive'
      );
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

  // ── Migration: add last_active to users ──────────────────────────────────
  const userTbl = await new Promise((r, j) =>
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'", (e, row) =>
      e ? j(e) : r(row)
    )
  );
    if (userTbl && userTbl.sql && !userTbl.sql.includes('last_active')) {
    console.log('[db] Migrating users table — adding last_active...');
    await exec("ALTER TABLE users ADD COLUMN last_active TEXT");
  }

  // ── Migration: create anonymous_chat table ─────────────────────────────────
  await exec(`
    CREATE TABLE IF NOT EXISTS anonymous_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('student','admin')),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Migration: create chat_read_status table ───────────────────────────────
  await exec(`
    CREATE TABLE IF NOT EXISTS chat_read_status (
      user_hash TEXT NOT NULL,
      complaint_id INTEGER NOT NULL,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_hash, complaint_id)
    )
  `);

  await seed();
}

// ── Seed ───────────────────────────────────────────────────────────────────
async function seed() {
  const row = await get('SELECT COUNT(*) as c FROM users');
  if (row?.c > 0) return;

  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  const studentsData = [
    ['riya@college.edu', hash('password'), 'student', 'Riya Sharma', 'R001', 'B.Tech CSE', 'A', 'Engineering'],
    ['arjun@college.edu', hash('password'), 'student', 'Arjun Patel', 'R002', 'B.Tech CSE', 'B', 'Engineering'],
    ['priya@college.edu', hash('password'), 'student', 'Priya Singh', 'R003', 'BBA', 'A', 'Management'],
    ['rahul@college.edu', hash('password'), 'student', 'Rahul Verma', 'R004', 'B.Sc Physics', 'A', 'Science'],
    ['ananya@college.edu', hash('password'), 'student', 'Ananya Gupta', 'R005', 'BA English', 'B', 'Arts'],
    ['vikram@college.edu', hash('password'), 'student', 'Vikram Joshi', 'R006', 'B.Tech ECE', 'A', 'Engineering'],
  ];

  for (const s of studentsData) {
    await run(
      'INSERT INTO users (email, password, role, name, roll_number, class_name, section, degree_faculty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      s
    );
  }

  await run(
    'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
    ['admin@college.edu', hash('password'), 'admin']
  );

  const { hashId } = require('./utils/anon');
  const allStudents = await new Promise((resolve, reject) => {
    db.all("SELECT id FROM users WHERE role = 'student'", (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  // Helper to create a date string months/days ago
  function dateAgo(months, days) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    d.setDate(d.getDate() - days);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }

  function pickStudent() {
    return hashId(allStudents[Math.floor(Math.random() * allStudents.length)].id);
  }

  const complaints = [
    // ── Food (6) ──
    ['Mess food quality has deteriorated','Food quality is very poor and unhygienic','Under Review','Food','Food Services','High',0,'Dining Services',67,66,8,2],
    ['Canteen prices increased suddenly','No notice about price hike in canteen items','Pending','Food','Food Services','Medium',0,'Dining Services',23,10,7,5],
    ['Spoiled food served in hostel mess','Found insects in dal served for dinner','Pending','Food','Food Services','High',1,'Dining Services',89,15,6,3],
    ['Canteen hygiene needs improvement','Dirty tables and unwashed utensils','Resolved','Food','Food Services','Medium',0,'Dining Services',45,100,3,10],
    ['Vegetarian options very limited','Only 2 veg items in a week','Pending','Food','Food Services','Low',0,'Dining Services',12,10,5,7],
    ['Water dispenser not working in canteen','No drinking water available near dining area','Under Review','Food','Food Services','Medium',0,'Dining Services',34,40,4,1],

    // ── Library (5) ──
    ['Library closes too early on weekends','Weekend timings are inconvenient for students','Pending','Library','Library Services','Medium',0,'Library Services',32,10,1,4],
    ['Not enough copies of reference books','Only 2 copies for 200 students batch','Under Review','Library','Library Services','High',0,'Library Services',78,30,3,6],
    ['Silence zone not enforced','Groups of students talking loudly','Pending','Library','Library Services','Low',0,'Library Services',56,10,5,2],
    ['Digital library subscription needed','Journals and papers not accessible online','Resolved','Library','Library Services','Medium',0,'IT Services',41,100,2,9],
    ['Book return process too slow','Waiting 15 min just to return a book','Pending','Library','Library Services','Low',0,'Library Services',18,10,6,8],

    // ── Hostel (6) ──
    ['Hostel hot water not working','No hot water in winters for past week','Pending','Hostel','Hostel Management','High',0,'Hostel Management',28,25,1,3],
    ['Hostel room window broken','Window glass shattered since 2 weeks','Pending','Hostel','Hostel Management','Medium',0,'Hostel Management',67,10,4,1],
    ['Ragging incident in boys hostel','Senior students harassing freshers','Under Review','Hostel','Hostel Management','High',1,'Hostel Management',95,50,6,5],
    ['Hostel wifi extremely slow','Cannot even load web pages at night','Resolved','Hostel','Hostel Management','Medium',0,'Hostel Management',44,100,2,7],
    ['No drinking water on 3rd floor','Water cooler broken for a month','Pending','Hostel','Hostel Management','Medium',0,'Hostel Management',31,10,5,9],
    ['Hostel gate closing too early','10pm curfew is impractical for interns','Under Review','Hostel','Hostel Management','Low',0,'Hostel Management',22,60,3,11],

    // ── Infrastructure (6) ──
    ['AC not working in Block A classrooms','Temperature reaches 35C inside','Under Review','Infrastructure','Facilities Management','High',0,'Facilities Management',45,66,1,2],
    ['Parking lot lighting issues','Poor lighting creates safety concerns','Pending','Infrastructure','Campus Security','High',0,'Campus Security',19,20,2,6],
    ['Broken bench in main auditorium','Several seats are damaged','Pending','Infrastructure','Facilities Management','Low',0,'Facilities Management',15,10,4,4],
    ['CCTV cameras not working in parking','No surveillance in parking area','Under Review','Infrastructure','Campus Security','High',1,'Campus Security',73,45,6,1],
    ['Lift in Block B not operational','Stuck since 3 weeks','Resolved','Infrastructure','Facilities Management','Medium',0,'Facilities Management',58,100,3,8],
    ['Water logging near admin block','Stagnant water causing mosquito breeding','Pending','Infrastructure','Facilities Management','Medium',0,'Facilities Management',38,10,5,10],

    // ── Staff (3) ──
    ['Faculty member uses abusive language','Unprofessional behaviour in classroom','Pending','Staff','Staff','High',1,'HR Services',91,10,1,9],
    ['Not enough lab assistants','Labs often left unattended','Under Review','Staff','Staff','Medium',0,'HR Services',34,50,4,7],
    ['Attendance system needs improvement','Manual attendance takes 15 min of lecture','Resolved','Staff','Staff','Low',0,'HR Services',27,100,2,5],

    // ── IT (4) ──
    ['Wi-Fi frequently disconnects','Network drops every 10 minutes','Pending','IT','IT Services','High',0,'IT Services',82,10,3,2],
    ['Campus app login not working','App crashes on login screen','Under Review','IT','IT Services','Medium',0,'IT Services',55,35,6,4],
    ['Slow internet in computer lab','Lab machines have 2G-like speeds','Resolved','IT','IT Services','Medium',0,'IT Services',63,100,1,11],
    ['Email server down for 2 days','Official communication disrupted','Pending','IT','IT Services','High',0,'IT Services',47,10,4,6],

    // ── Transport (3) ──
    ['Bus driver overspeeds regularly','Students feel unsafe in college bus','Pending','Transport','Transport','High',1,'Transport Department',96,10,2,3],
    ['Bus timing not updated on app','Schedule mismatch causing delays','Under Review','Transport','Transport','Medium',0,'Transport Department',39,55,5,8],
    ['No night shuttle for hostel students','Hostellers have no transport for emergencies','Pending','Transport','Transport','Medium',0,'Transport Department',72,10,6,1],

    // ── Administration (3) ──
    ['Scholarship disbursement delayed','Pending since 4 months','Under Review','Administration','Administration','High',0,'Administration',61,70,3,12],
    ['Exam form submission glitch','Portal closed early without notice','Resolved','Administration','Administration','Medium',0,'Administration',43,100,1,10],
    ['Fee receipt not generated','Paid fees but no receipt for 2 weeks','Pending','Administration','Administration','Low',0,'Administration',25,10,4,7],
  ];

  for (const c of complaints) {
    // c = [title, desc, status, faculty, category, priority, is_sensitive, department, votes, progress, studentIdx, monthsAgo]
    const title = c[0], desc = c[1], status = c[2], faculty = c[3], category = c[4],
         priority = c[5], is_sensitive = c[6], department = c[7], votes = c[8],
         progress = c[9], studentIdx = c[10], monthsAgo = c[11];
    const submitterHash = hashId(allStudents[studentIdx % allStudents.length].id);
    const daysOffset = Math.floor(Math.random() * 25);
    const createdAt = dateAgo(monthsAgo, daysOffset);
    const updatedAgo = Math.max(0, monthsAgo - Math.floor(Math.random() * 2));
    const updatedAt = dateAgo(updatedAgo, Math.floor(Math.random() * 10));
    await run(
      `INSERT INTO complaints
        (title, description, status, faculty, category, priority, is_sensitive, department, votes, progress, submitter_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, desc, status, faculty, category, priority, is_sensitive, department, votes, progress, submitterHash, createdAt, updatedAt]
    );
  }

  console.log('Database seeded successfully');
}

init();

module.exports = db;

