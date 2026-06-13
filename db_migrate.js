// db_migrate.js — add missing columns to existing safevoice.db
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'safevoice.db');
const db = new sqlite3.Database(DB_PATH);

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

(async function main() {
  const userCols = await new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(users)", [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
  const has = new Set(userCols.map(r => r.name));

  const add = async (col, sqlType) => {
    if (has.has(col)) return;
    // SQLite ALTER TABLE ADD COLUMN
    await run(`ALTER TABLE users ADD COLUMN ${col} ${sqlType}`);
    console.log('Added users column:', col);
  };

  // expected columns in frontend/admin
  await add('name', 'TEXT');
  await add('roll_number', 'TEXT');
  await add('class_name', 'TEXT');
  await add('section', 'TEXT');
  await add('degree_faculty', 'TEXT');

  // backfill name if missing
  await run(`UPDATE users SET name = COALESCE(name, substr(email, 1, instr(email, '@') - 1));`);

  // complaints table missing columns? ensure required ones exist.
  const complaintCols = await new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(complaints)", [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
  const cHas = new Set(complaintCols.map(r => r.name));

  const addC = async (col, sqlType, def) => {
    if (cHas.has(col)) return;
    await run(`ALTER TABLE complaints ADD COLUMN ${col} ${sqlType}${def ? ' DEFAULT ' + def : ''}`);
    console.log('Added complaints column:', col);
  };

  await addC('updated_at', 'TEXT', "(datetime('now'))");
  await addC('department', 'TEXT', "''");
  await addC('is_sensitive', 'INTEGER', '0');
  await addC('faculty', 'TEXT', "'Others'");
  await addC('category', 'TEXT', "''");

  await run('PRAGMA foreign_keys = ON;');

  console.log('Migration complete');
  db.close();
})().catch(e => {
  console.error('Migration error:', e);
  db.close();
  process.exit(1);
});

