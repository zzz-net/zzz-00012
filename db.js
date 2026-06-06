const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'allocation.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

ensureDataDir();

const db = new sqlite3.Database(DB_FILE);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  store TEXT
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  store TEXT NOT NULL,
  product TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (store, product)
);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  sourceStore TEXT NOT NULL,
  targetStore TEXT NOT NULL,
  product TEXT NOT NULL,
  qty INTEGER NOT NULL,
  reason TEXT NOT NULL,
  applicant TEXT NOT NULL,
  status TEXT NOT NULL,
  historyJson TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocationId TEXT NOT NULL,
  status TEXT NOT NULL,
  operator TEXT NOT NULL,
  time TEXT NOT NULL,
  remark TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_allocation ON history(allocationId);
`;

function initSchema() {
  return new Promise((resolve, reject) => {
    db.exec(SCHEMA_SQL, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
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

async function isEmpty() {
  const row = await get('SELECT COUNT(*) AS cnt FROM users');
  return row.cnt === 0;
}

async function loadAll() {
  const [users, stores, products, inventory, allocRows, history] = await Promise.all([
    all('SELECT id, name, role, store FROM users'),
    all('SELECT id, name FROM stores'),
    all('SELECT id, name FROM products'),
    all('SELECT store, product, qty FROM inventory'),
    all('SELECT id, sourceStore, targetStore, product, qty, reason, applicant, status, historyJson FROM allocations'),
    all('SELECT allocationId, status, operator, time, remark FROM history ORDER BY id ASC')
  ]);

  users.forEach(u => { if (u.store === null) u.store = null; });

  const allocations = allocRows.map(r => {
    let hist = [];
    try { hist = JSON.parse(r.historyJson || '[]'); } catch (e) { hist = []; }
    return {
      id: r.id,
      sourceStore: r.sourceStore,
      targetStore: r.targetStore,
      product: r.product,
      qty: r.qty,
      reason: r.reason,
      applicant: r.applicant,
      status: r.status,
      history: hist
    };
  });

  return { users, stores, products, inventory, allocations, history };
}

async function saveAll(data) {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        await run('BEGIN TRANSACTION');

        await run('DELETE FROM users');
        for (const u of data.users) {
          await run('INSERT INTO users (id, name, role, store) VALUES (?, ?, ?, ?)',
            [u.id, u.name, u.role, u.store || null]);
        }

        await run('DELETE FROM stores');
        for (const s of data.stores) {
          await run('INSERT INTO stores (id, name) VALUES (?, ?)', [s.id, s.name]);
        }

        await run('DELETE FROM products');
        for (const p of data.products) {
          await run('INSERT INTO products (id, name) VALUES (?, ?)', [p.id, p.name]);
        }

        await run('DELETE FROM inventory');
        for (const i of data.inventory) {
          await run('INSERT INTO inventory (store, product, qty) VALUES (?, ?, ?)',
            [i.store, i.product, i.qty]);
        }

        await run('DELETE FROM allocations');
        for (const a of data.allocations) {
          await run(
            'INSERT INTO allocations (id, sourceStore, targetStore, product, qty, reason, applicant, status, historyJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [a.id, a.sourceStore, a.targetStore, a.product, a.qty, a.reason, a.applicant, a.status, JSON.stringify(a.history)]
          );
        }

        await run('DELETE FROM history');
        for (const h of data.history) {
          await run(
            'INSERT INTO history (allocationId, status, operator, time, remark) VALUES (?, ?, ?, ?, ?)',
            [h.allocationId, h.status, h.operator, h.time, h.remark || null]
          );
        }

        await run('COMMIT');
        resolve();
      } catch (err) {
        await run('ROLLBACK');
        reject(err);
      }
    });
  });
}

module.exports = {
  initSchema,
  loadAll,
  saveAll,
  isEmpty,
  DB_FILE,
  DATA_DIR
};
