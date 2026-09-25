import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_STATEMENTS, MIGRATIONS, SEED_ITEMS } from './schema.js';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of SCHEMA_STATEMENTS) db.exec(sql);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch { /* 欄位已存在 */ }
  }
  seed(db);
  return db;
}

function seed(db) {
  const hasEvent = db.prepare('SELECT 1 FROM event WHERE id = 1').get();
  if (hasEvent) return;

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO event (id) VALUES (1)').run();
    const insItem = db.prepare(
      'INSERT INTO items (category, name, need, unit, sort) VALUES (?, ?, ?, ?, ?)'
    );
    const insVenue = db.prepare(
      'INSERT INTO contributions (item_id, person_id, qty, note) VALUES (?, NULL, ?, ?)'
    );
    SEED_ITEMS.forEach(([cat, name, need, unit, byVenue], i) => {
      const { lastInsertRowid } = insItem.run(cat, name, need, unit, i);
      if (byVenue > 0) insVenue.run(lastInsertRowid, byVenue, '場地自帶');
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
