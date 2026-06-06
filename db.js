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

CREATE TABLE IF NOT EXISTS stocktake_batches (
  id TEXT PRIMARY KEY,
  store TEXT NOT NULL,
  status TEXT NOT NULL,
  remark TEXT,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  confirmedBy TEXT,
  confirmedAt TEXT,
  withdrawnBy TEXT,
  withdrawnAt TEXT,
  withdrawRemark TEXT,
  historyJson TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS stocktake_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batchId TEXT NOT NULL,
  product TEXT NOT NULL,
  actualQty INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_items_batch_product ON stocktake_items(batchId, product);

CREATE TABLE IF NOT EXISTS stocktake_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batchId TEXT NOT NULL,
  store TEXT NOT NULL,
  product TEXT NOT NULL,
  bookQty INTEGER NOT NULL,
  lockedQty INTEGER NOT NULL,
  actualQty INTEGER NOT NULL,
  diffQty INTEGER NOT NULL,
  newBookQty INTEGER NOT NULL,
  adjustedBy TEXT NOT NULL,
  adjustedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stocktake_adjustments_batch ON stocktake_adjustments(batchId);

CREATE TABLE IF NOT EXISTS stocktake_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batchId TEXT NOT NULL,
  action TEXT NOT NULL,
  operator TEXT NOT NULL,
  time TEXT NOT NULL,
  remark TEXT
);

CREATE INDEX IF NOT EXISTS idx_stocktake_history_batch ON stocktake_history(batchId);
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
  const [users, stores, products, inventory, allocRows, history, batchRows, itemRows, adjRows, stHistRows] = await Promise.all([
    all('SELECT id, name, role, store FROM users'),
    all('SELECT id, name FROM stores'),
    all('SELECT id, name FROM products'),
    all('SELECT store, product, qty FROM inventory'),
    all('SELECT id, sourceStore, targetStore, product, qty, reason, applicant, status, historyJson FROM allocations'),
    all('SELECT allocationId, status, operator, time, remark FROM history ORDER BY id ASC'),
    all('SELECT id, store, status, remark, createdBy, createdAt, confirmedBy, confirmedAt, withdrawnBy, withdrawnAt, withdrawRemark, historyJson FROM stocktake_batches'),
    all('SELECT id, batchId, product, actualQty FROM stocktake_items ORDER BY id ASC'),
    all('SELECT id, batchId, store, product, bookQty, lockedQty, actualQty, diffQty, newBookQty, adjustedBy, adjustedAt FROM stocktake_adjustments ORDER BY id ASC'),
    all('SELECT id, batchId, action, operator, time, remark FROM stocktake_history ORDER BY id ASC')
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

  const stocktakeBatches = batchRows.map(r => {
    let hist = [];
    try { hist = JSON.parse(r.historyJson || '[]'); } catch (e) { hist = []; }
    return {
      id: r.id,
      store: r.store,
      status: r.status,
      remark: r.remark,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      confirmedBy: r.confirmedBy,
      confirmedAt: r.confirmedAt,
      withdrawnBy: r.withdrawnBy,
      withdrawnAt: r.withdrawnAt,
      withdrawRemark: r.withdrawRemark,
      history: hist
    };
  });

  const stocktakeItems = itemRows.map(r => ({
    id: r.id,
    batchId: r.batchId,
    product: r.product,
    actualQty: r.actualQty
  }));

  const stocktakeAdjustments = adjRows.map(r => ({
    id: r.id,
    batchId: r.batchId,
    store: r.store,
    product: r.product,
    bookQty: r.bookQty,
    lockedQty: r.lockedQty,
    actualQty: r.actualQty,
    diffQty: r.diffQty,
    newBookQty: r.newBookQty,
    adjustedBy: r.adjustedBy,
    adjustedAt: r.adjustedAt
  }));

  const stocktakeHistory = stHistRows.map(r => ({
    id: r.id,
    batchId: r.batchId,
    action: r.action,
    operator: r.operator,
    time: r.time,
    remark: r.remark
  }));

  return { users, stores, products, inventory, allocations, history, stocktakeBatches, stocktakeItems, stocktakeAdjustments, stocktakeHistory };
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

        await run('DELETE FROM stocktake_batches');
        for (const b of data.stocktakeBatches || []) {
          await run(
            'INSERT INTO stocktake_batches (id, store, status, remark, createdBy, createdAt, confirmedBy, confirmedAt, withdrawnBy, withdrawnAt, withdrawRemark, historyJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [b.id, b.store, b.status, b.remark || null, b.createdBy, b.createdAt, b.confirmedBy || null, b.confirmedAt || null, b.withdrawnBy || null, b.withdrawnAt || null, b.withdrawRemark || null, JSON.stringify(b.history || [])]
          );
        }

        await run('DELETE FROM stocktake_items');
        for (const it of data.stocktakeItems || []) {
          await run(
            'INSERT INTO stocktake_items (id, batchId, product, actualQty) VALUES (?, ?, ?, ?)',
            [it.id, it.batchId, it.product, it.actualQty]
          );
        }

        await run('DELETE FROM stocktake_adjustments');
        for (const a of data.stocktakeAdjustments || []) {
          await run(
            'INSERT INTO stocktake_adjustments (id, batchId, store, product, bookQty, lockedQty, actualQty, diffQty, newBookQty, adjustedBy, adjustedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [a.id, a.batchId, a.store, a.product, a.bookQty, a.lockedQty, a.actualQty, a.diffQty, a.newBookQty, a.adjustedBy, a.adjustedAt]
          );
        }

        await run('DELETE FROM stocktake_history');
        for (const h of data.stocktakeHistory || []) {
          await run(
            'INSERT INTO stocktake_history (id, batchId, action, operator, time, remark) VALUES (?, ?, ?, ?, ?, ?)',
            [h.id, h.batchId, h.action, h.operator, h.time, h.remark || null]
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
