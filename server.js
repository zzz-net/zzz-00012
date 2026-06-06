const express = require('express');
const fs = require('fs');
const path = require('path');
const { initAllData, DATA_DIR } = require('./init-data');

const app = express();
app.use(express.json());

const VALID_STATUSES = ['pending', 'reviewed', 'approved', 'shipped', 'rejected', 'withdrawn'];
const STATUS_FLOW = {
  pending: ['reviewed', 'rejected', 'withdrawn'],
  reviewed: ['approved', 'rejected', 'withdrawn'],
  approved: ['shipped', 'withdrawn'],
  shipped: [],
  rejected: [],
  withdrawn: []
};

let db = {};

function loadJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(fileName, data) {
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadAllData() {
  const required = ['users.json', 'stores.json', 'products.json', 'inventory.json', 'allocations.json', 'history.json'];
  const allExist = required.every(f => fs.existsSync(path.join(DATA_DIR, f)));
  if (!allExist) {
    initAllData();
  }
  db.users = loadJson('users.json');
  db.stores = loadJson('stores.json');
  db.products = loadJson('products.json');
  db.inventory = loadJson('inventory.json');
  db.allocations = loadJson('allocations.json');
  db.history = loadJson('history.json');
}

function saveAllData() {
  saveJson('users.json', db.users);
  saveJson('stores.json', db.stores);
  saveJson('products.json', db.products);
  saveJson('inventory.json', db.inventory);
  saveJson('allocations.json', db.allocations);
  saveJson('history.json', db.history);
}

function getUser(userId) {
  return db.users.find(u => u.id === userId);
}

function getInventory(store, product) {
  return db.inventory.find(i => i.store === store && i.product === product);
}

function getLockedQty(store, product) {
  return db.allocations
    .filter(a => a.sourceStore === store && a.product === product && a.status === 'approved')
    .reduce((sum, a) => sum + a.qty, 0);
}

function getAvailableQty(store, product) {
  const inv = getInventory(store, product);
  if (!inv) return 0;
  return inv.qty - getLockedQty(store, product);
}

function genAllocationId() {
  const maxId = db.allocations.reduce((max, a) => {
    const num = parseInt(a.id.replace('alloc_', ''), 10);
    return num > max ? num : max;
  }, 0);
  return 'alloc_' + String(maxId + 1).padStart(3, '0');
}

function nowIso() {
  return new Date().toISOString();
}

function addHistory(allocationId, status, operator, remark) {
  const record = {
    allocationId,
    status,
    operator,
    time: nowIso(),
    remark
  };
  db.history.push(record);
  return record;
}

function requireRole(userId, allowedRoles, res) {
  const user = getUser(userId);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ error: 'ROLE_FORBIDDEN', message: '该用户角色无权限执行此操作' });
    return null;
  }
  return user;
}

function validateStatusTransition(current, next, res) {
  const allowed = STATUS_FLOW[current] || [];
  if (!allowed.includes(next)) {
    res.status(400).json({
      error: 'INVALID_STATUS_TRANSITION',
      message: `无法从"${current}"状态变更为"${next}"`
    });
    return false;
  }
  return true;
}

loadAllData();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: nowIso() });
});

app.get('/api/users', (req, res) => {
  res.json(db.users);
});

app.get('/api/stores', (req, res) => {
  res.json(db.stores);
});

app.get('/api/products', (req, res) => {
  res.json(db.products);
});

app.get('/api/inventory', (req, res) => {
  const result = db.inventory.map(inv => {
    const locked = getLockedQty(inv.store, inv.product);
    return {
      ...inv,
      lockedQty: locked,
      availableQty: inv.qty - locked
    };
  });
  res.json(result);
});

app.get('/api/allocations', (req, res) => {
  res.json(db.allocations);
});

app.get('/api/allocations/:id', (req, res) => {
  const alloc = db.allocations.find(a => a.id === req.params.id);
  if (!alloc) {
    res.status(404).json({ error: 'NOT_FOUND', message: '调拨单不存在' });
    return;
  }
  res.json(alloc);
});

app.post('/api/allocations', (req, res) => {
  const { sourceStore, targetStore, product, qty, reason, operator } = req.body;

  if (!sourceStore || !targetStore || !product || !qty || !reason || !operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：sourceStore, targetStore, product, qty, reason, operator' });
    return;
  }

  if (!db.stores.find(s => s.id === sourceStore)) {
    res.status(400).json({ error: 'INVALID_STORE', message: '来源门店不存在' });
    return;
  }
  if (!db.stores.find(s => s.id === targetStore)) {
    res.status(400).json({ error: 'INVALID_STORE', message: '目标门店不存在' });
    return;
  }
  if (sourceStore === targetStore) {
    res.status(400).json({ error: 'SAME_STORE', message: '来源门店和目标门店不能相同' });
    return;
  }
  if (!db.products.find(p => p.id === product)) {
    res.status(400).json({ error: 'INVALID_PRODUCT', message: '商品不存在' });
    return;
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    res.status(400).json({ error: 'INVALID_QTY', message: '数量必须为正整数' });
    return;
  }

  const user = requireRole(operator, ['store_user'], res);
  if (!user) return;

  if (user.store && user.store !== targetStore) {
    res.status(403).json({ error: 'STORE_FORBIDDEN', message: '只能为本门店申请调拨' });
    return;
  }

  const sourceInv = getInventory(sourceStore, product);
  if (!sourceInv || sourceInv.qty < qty) {
    res.status(400).json({ error: 'INSUFFICIENT_INVENTORY', message: '来源门店该商品总库存不足' });
    return;
  }

  const allocId = genAllocationId();
  const alloc = {
    id: allocId,
    sourceStore,
    targetStore,
    product,
    qty,
    reason,
    applicant: operator,
    status: 'pending',
    history: []
  };
  const hist = addHistory(allocId, 'pending', operator, '提交调拨申请');
  alloc.history.push(hist);
  db.allocations.push(alloc);
  saveAllData();

  res.status(201).json(alloc);
});

app.post('/api/allocations/:id/review', (req, res) => {
  const { operator } = req.body;
  const alloc = db.allocations.find(a => a.id === req.params.id);
  if (!alloc) {
    res.status(404).json({ error: 'NOT_FOUND', message: '调拨单不存在' });
    return;
  }

  const user = getUser(operator);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }

  if (alloc.applicant === operator) {
    res.status(400).json({ error: 'SELF_REVIEW', message: '申请人不能复核自己的申请' });
    return;
  }

  if (user.role !== 'warehouse') {
    res.status(403).json({ error: 'ROLE_FORBIDDEN', message: '该用户角色无权限执行此操作' });
    return;
  }

  if (!validateStatusTransition(alloc.status, 'reviewed', res)) return;

  const available = getAvailableQty(alloc.sourceStore, alloc.product);
  if (available < alloc.qty) {
    res.status(400).json({
      error: 'INSUFFICIENT_AVAILABLE',
      message: `来源门店可用库存不足，当前可用 ${available}，需要 ${alloc.qty}`
    });
    return;
  }

  alloc.status = 'reviewed';
  const hist = addHistory(alloc.id, 'reviewed', operator, '库存复核通过');
  alloc.history.push(hist);
  saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/reject', (req, res) => {
  const { operator, remark } = req.body;
  const alloc = db.allocations.find(a => a.id === req.params.id);
  if (!alloc) {
    res.status(404).json({ error: 'NOT_FOUND', message: '调拨单不存在' });
    return;
  }

  const user = getUser(operator);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }

  if (alloc.applicant === operator) {
    res.status(400).json({ error: 'SELF_REVIEW', message: '申请人不能驳回自己的申请' });
    return;
  }

  if (!['warehouse', 'manager'].includes(user.role)) {
    res.status(403).json({ error: 'ROLE_FORBIDDEN', message: '该用户角色无权限执行此操作' });
    return;
  }

  if (!validateStatusTransition(alloc.status, 'rejected', res)) return;

  alloc.status = 'rejected';
  const hist = addHistory(alloc.id, 'rejected', operator, remark || '申请被驳回');
  alloc.history.push(hist);
  saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/approve', (req, res) => {
  const { operator } = req.body;
  const alloc = db.allocations.find(a => a.id === req.params.id);
  if (!alloc) {
    res.status(404).json({ error: 'NOT_FOUND', message: '调拨单不存在' });
    return;
  }

  const user = requireRole(operator, ['manager'], res);
  if (!user) return;

  if (alloc.status !== 'reviewed') {
    res.status(400).json({
      error: 'NOT_REVIEWED',
      message: '未复核的申请不能直接审批，必须先由库管复核'
    });
    return;
  }

  if (!validateStatusTransition(alloc.status, 'approved', res)) return;

  const available = getAvailableQty(alloc.sourceStore, alloc.product);
  if (available < alloc.qty) {
    res.status(400).json({
      error: 'INSUFFICIENT_AVAILABLE',
      message: `库存已被其他已批申请占用，当前可用 ${available}，需要 ${alloc.qty}`
    });
    return;
  }

  alloc.status = 'approved';
  const hist = addHistory(alloc.id, 'approved', operator, '区域经理审批通过，库存已锁定');
  alloc.history.push(hist);
  saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/ship', (req, res) => {
  const { operator } = req.body;
  const alloc = db.allocations.find(a => a.id === req.params.id);
  if (!alloc) {
    res.status(404).json({ error: 'NOT_FOUND', message: '调拨单不存在' });
    return;
  }

  if (alloc.status === 'withdrawn') {
    res.status(400).json({ error: 'WITHDRAWN_CANNOT_SHIP', message: '已撤回的调拨单不能出库' });
    return;
  }

  const user = getUser(operator);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }
  const canShip = user.role === 'warehouse' || (user.role === 'store_user' && user.store === alloc.sourceStore);
  if (!canShip) {
    res.status(403).json({ error: 'ROLE_FORBIDDEN', message: '只有库管或来源门店人员可以执行出库' });
    return;
  }

  if (!validateStatusTransition(alloc.status, 'shipped', res)) return;

  const sourceInv = getInventory(alloc.sourceStore, alloc.product);
  if (!sourceInv || sourceInv.qty < alloc.qty) {
    res.status(400).json({ error: 'INSUFFICIENT_INVENTORY', message: '来源门店库存不足，无法出库' });
    return;
  }

  sourceInv.qty -= alloc.qty;

  const targetInv = getInventory(alloc.targetStore, alloc.product);
  if (targetInv) {
    targetInv.qty += alloc.qty;
  } else {
    db.inventory.push({ store: alloc.targetStore, product: alloc.product, qty: alloc.qty });
  }

  alloc.status = 'shipped';
  const hist = addHistory(alloc.id, 'shipped', operator, '出库确认，库存已扣减');
  alloc.history.push(hist);
  saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/withdraw', (req, res) => {
  const { operator, remark } = req.body;
  const alloc = db.allocations.find(a => a.id === req.params.id);
  if (!alloc) {
    res.status(404).json({ error: 'NOT_FOUND', message: '调拨单不存在' });
    return;
  }

  const user = getUser(operator);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }
  const canWithdraw = user.role === 'manager' || alloc.applicant === operator;
  if (!canWithdraw) {
    res.status(403).json({ error: 'ROLE_FORBIDDEN', message: '只有申请人或区域经理可以撤回' });
    return;
  }

  if (!validateStatusTransition(alloc.status, 'withdrawn', res)) return;

  alloc.status = 'withdrawn';
  const hist = addHistory(alloc.id, 'withdrawn', operator, remark || '申请已撤回');
  alloc.history.push(hist);
  saveAllData();

  res.json(alloc);
});

app.get('/api/history', (req, res) => {
  const { sourceStore, targetStore, product, status, operator } = req.query;
  let result = [...db.history];

  if (sourceStore || targetStore || product) {
    const allocIds = db.allocations
      .filter(a => {
        if (sourceStore && a.sourceStore !== sourceStore) return false;
        if (targetStore && a.targetStore !== targetStore) return false;
        if (product && a.product !== product) return false;
        return true;
      })
      .map(a => a.id);
    result = result.filter(h => allocIds.includes(h.allocationId));
  }

  if (status) {
    result = result.filter(h => h.status === status);
  }
  if (operator) {
    result = result.filter(h => h.operator === operator);
  }

  result.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(result);
});

app.get('/api/audit', (req, res) => {
  const { sourceStore, targetStore, product, status } = req.query;
  let allocs = [...db.allocations];

  if (sourceStore) allocs = allocs.filter(a => a.sourceStore === sourceStore);
  if (targetStore) allocs = allocs.filter(a => a.targetStore === targetStore);
  if (product) allocs = allocs.filter(a => a.product === product);
  if (status) allocs = allocs.filter(a => a.status === status);

  const result = allocs.map(a => {
    const src = db.stores.find(s => s.id === a.sourceStore);
    const tgt = db.stores.find(s => s.id === a.targetStore);
    const prod = db.products.find(p => p.id === a.product);
    const applicant = db.users.find(u => u.id === a.applicant);
    return {
      id: a.id,
      sourceStore: a.sourceStore,
      sourceStoreName: src ? src.name : null,
      targetStore: a.targetStore,
      targetStoreName: tgt ? tgt.name : null,
      product: a.product,
      productName: prod ? prod.name : null,
      qty: a.qty,
      reason: a.reason,
      applicant: a.applicant,
      applicantName: applicant ? applicant.name : null,
      status: a.status,
      history: a.history
    };
  });

  result.sort((a, b) => {
    const ta = a.history.length > 0 ? a.history[0].time : '';
    const tb = b.history.length > 0 ? b.history[0].time : '';
    return new Date(tb) - new Date(ta);
  });

  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`门店应急调拨 API 已启动: http://localhost:${PORT}`);
  console.log('健康检查: GET /api/health');
});

module.exports = app;
