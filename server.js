const express = require('express');
const { ensureInitialized } = require('./init-data');
const { loadAll, saveAll } = require('./db');

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

let db = {
  users: [],
  stores: [],
  products: [],
  inventory: [],
  allocations: [],
  history: [],
  stocktakeBatches: [],
  stocktakeItems: [],
  stocktakeAdjustments: [],
  stocktakeHistory: []
};

async function loadAllData() {
  db = await loadAll();
}

async function saveAllData() {
  await saveAll(db);
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

function genStocktakeId() {
  const maxId = db.stocktakeBatches.reduce((max, b) => {
    const num = parseInt(b.id.replace('stocktake_', ''), 10);
    return num > max ? num : max;
  }, 0);
  return 'stocktake_' + String(maxId + 1).padStart(3, '0');
}

function getStocktakeBatch(batchId) {
  return db.stocktakeBatches.find(b => b.id === batchId);
}

function getStocktakeItems(batchId) {
  return db.stocktakeItems.filter(i => i.batchId === batchId);
}

function addStocktakeHistory(batchId, action, operator, remark) {
  const record = {
    batchId,
    action,
    operator,
    time: nowIso(),
    remark
  };
  db.stocktakeHistory.push(record);
  return record;
}

function enrichStocktakeItem(item, store) {
  const inv = getInventory(store, item.product);
  const bookQty = inv ? inv.qty : 0;
  const lockedQty = getLockedQty(store, item.product);
  const diffQty = item.actualQty - bookQty;
  const availableAfter = item.actualQty - lockedQty;
  return {
    id: item.id,
    batchId: item.batchId,
    product: item.product,
    actualQty: item.actualQty,
    bookQty,
    lockedQty,
    availableAfter,
    diffQty
  };
}

function requireStocktakeRole(userId, allowedRoles, res) {
  const user = getUser(userId);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ error: 'STOCKTAKE_ROLE_FORBIDDEN', message: '该用户角色无权限执行此盘点操作' });
    return null;
  }
  return user;
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

app.post('/api/allocations', async (req, res) => {
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
  await saveAllData();

  res.status(201).json(alloc);
});

app.post('/api/allocations/:id/review', async (req, res) => {
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
  await saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/reject', async (req, res) => {
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
  await saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/approve', async (req, res) => {
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
  await saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/ship', async (req, res) => {
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
  await saveAllData();

  res.json(alloc);
});

app.post('/api/allocations/:id/withdraw', async (req, res) => {
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
  await saveAllData();

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

// ===== Stocktake / 库存盘点模块 =====

const STOCKTAKE_STATUSES = ['pending', 'confirmed', 'withdrawn'];

app.get('/api/stocktake', (req, res) => {
  const { operator, store, status } = req.query;
  const user = getUser(operator);

  let batches = [...db.stocktakeBatches];

  if (user) {
    if (user.role === 'store_user') {
      batches = batches.filter(b => b.store === user.store);
    }
  }

  if (store) {
    batches = batches.filter(b => b.store === store);
  }
  if (status) {
    batches = batches.filter(b => b.status === status);
  }

  const result = batches.map(b => {
    const st = db.stores.find(s => s.id === b.store);
    const creator = db.users.find(u => u.id === b.createdBy);
    const confirmer = b.confirmedBy ? db.users.find(u => u.id === b.confirmedBy) : null;
    const items = getStocktakeItems(b.id).map(i => enrichStocktakeItem(i, b.store));
    const totalDiff = items.reduce((sum, i) => sum + i.diffQty, 0);
    return {
      id: b.id,
      store: b.store,
      storeName: st ? st.name : null,
      status: b.status,
      remark: b.remark,
      itemCount: items.length,
      totalDiff,
      items,
      createdBy: b.createdBy,
      createdByName: creator ? creator.name : null,
      createdAt: b.createdAt,
      confirmedBy: b.confirmedBy,
      confirmedByName: confirmer ? confirmer.name : null,
      confirmedAt: b.confirmedAt,
      withdrawnBy: b.withdrawnBy,
      withdrawnAt: b.withdrawnAt,
      withdrawRemark: b.withdrawRemark,
      history: b.history
    };
  });

  result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(result);
});

app.get('/api/stocktake/:id', (req, res) => {
  const batch = getStocktakeBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'STOCKTAKE_NOT_FOUND', message: '盘点批次不存在' });
    return;
  }

  const operator = req.query.operator;
  const user = operator ? getUser(operator) : null;
  if (user && user.role === 'store_user' && user.store !== batch.store) {
    res.status(403).json({ error: 'STOCKTAKE_STORE_FORBIDDEN', message: '门店用户只能查看自己门店的盘点结果' });
    return;
  }

  const st = db.stores.find(s => s.id === batch.store);
  const creator = db.users.find(u => u.id === batch.createdBy);
  const confirmer = batch.confirmedBy ? db.users.find(u => u.id === batch.confirmedBy) : null;
  const items = getStocktakeItems(batch.id).map(i => enrichStocktakeItem(i, batch.store));
  const adjustments = db.stocktakeAdjustments.filter(a => a.batchId === batch.id);
  const totalDiff = items.reduce((sum, i) => sum + i.diffQty, 0);

  res.json({
    id: batch.id,
    store: batch.store,
    storeName: st ? st.name : null,
    status: batch.status,
    remark: batch.remark,
    itemCount: items.length,
    totalDiff,
    items,
    adjustments,
    createdBy: batch.createdBy,
    createdByName: creator ? creator.name : null,
    createdAt: batch.createdAt,
    confirmedBy: batch.confirmedBy,
    confirmedByName: confirmer ? confirmer.name : null,
    confirmedAt: batch.confirmedAt,
    withdrawnBy: batch.withdrawnBy,
    withdrawnAt: batch.withdrawnAt,
    withdrawRemark: batch.withdrawRemark,
    history: batch.history
  });
});

app.post('/api/stocktake', async (req, res) => {
  const { store, remark, operator } = req.body;

  if (!store || !operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：store, operator' });
    return;
  }

  const user = requireStocktakeRole(operator, ['warehouse'], res);
  if (!user) return;

  if (!db.stores.find(s => s.id === store)) {
    res.status(400).json({ error: 'INVALID_STORE', message: '门店不存在' });
    return;
  }

  const batchId = genStocktakeId();
  const now = nowIso();
  const batch = {
    id: batchId,
    store,
    status: 'pending',
    remark: remark || null,
    createdBy: operator,
    createdAt: now,
    confirmedBy: null,
    confirmedAt: null,
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawRemark: null,
    history: []
  };

  const hist = addStocktakeHistory(batchId, 'created', operator, remark ? `创建盘点批次：${remark}` : '创建盘点批次');
  batch.history.push(hist);
  db.stocktakeBatches.push(batch);
  await saveAllData();

  res.status(201).json(batch);
});

app.post('/api/stocktake/:id/items', async (req, res) => {
  const { product, actualQty, operator } = req.body;

  if (!product || actualQty === undefined || actualQty === null || !operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：product, actualQty, operator' });
    return;
  }

  if (!Number.isInteger(actualQty) || actualQty < 0) {
    res.status(400).json({ error: 'INVALID_QTY', message: '实盘数量必须为非负整数' });
    return;
  }

  const user = requireStocktakeRole(operator, ['warehouse'], res);
  if (!user) return;

  const batch = getStocktakeBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'STOCKTAKE_NOT_FOUND', message: '盘点批次不存在' });
    return;
  }
  if (batch.status !== 'pending') {
    res.status(400).json({ error: 'STOCKTAKE_NOT_PENDING', message: `盘点批次状态为 ${batch.status}，不能修改明细` });
    return;
  }

  if (!db.products.find(p => p.id === product)) {
    res.status(400).json({ error: 'INVALID_PRODUCT', message: '商品不存在' });
    return;
  }

  let existing = db.stocktakeItems.find(i => i.batchId === batch.id && i.product === product);
  if (existing) {
    existing.actualQty = actualQty;
    const hist = addStocktakeHistory(batch.id, 'item_update', operator, `更新商品 ${product} 实盘为 ${actualQty}`);
    batch.history.push(hist);
  } else {
    const newItem = {
      id: db.stocktakeItems.length > 0 ? Math.max(...db.stocktakeItems.map(i => i.id)) + 1 : 1,
      batchId: batch.id,
      product,
      actualQty
    };
    db.stocktakeItems.push(newItem);
    existing = newItem;
    const hist = addStocktakeHistory(batch.id, 'item_add', operator, `录入商品 ${product} 实盘 ${actualQty}`);
    batch.history.push(hist);
  }

  await saveAllData();
  res.json(enrichStocktakeItem(existing, batch.store));
});

app.post('/api/stocktake/:id/confirm', async (req, res) => {
  const { operator } = req.body;

  if (!operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：operator' });
    return;
  }

  const user = requireStocktakeRole(operator, ['manager'], res);
  if (!user) return;

  const batch = getStocktakeBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'STOCKTAKE_NOT_FOUND', message: '盘点批次不存在' });
    return;
  }
  if (batch.status !== 'pending') {
    res.status(400).json({ error: 'STOCKTAKE_NOT_PENDING', message: `盘点批次状态为 ${batch.status}，不能重复确认` });
    return;
  }

  const items = getStocktakeItems(batch.id);
  if (items.length === 0) {
    res.status(400).json({ error: 'STOCKTAKE_EMPTY', message: '盘点批次没有录入任何明细，无法确认' });
    return;
  }

  const conflicts = [];
  for (const item of items) {
    const inv = getInventory(batch.store, item.product);
    const bookQty = inv ? inv.qty : 0;
    const lockedQty = getLockedQty(batch.store, item.product);
    const diffQty = item.actualQty - bookQty;
    const newBookQty = item.actualQty;
    const newAvailable = newBookQty - lockedQty;
    if (newAvailable < 0) {
      conflicts.push({
        product: item.product,
        lockedQty,
        newBookQty,
        newAvailable,
        message: `商品 ${item.product} 调账后账面 ${newBookQty}，已锁定 ${lockedQty}，可用为负 (${newAvailable})`
      });
    }
  }

  if (conflicts.length > 0) {
    res.status(400).json({
      error: 'STOCKTAKE_NEGATIVE_AVAILABLE',
      message: '确认失败：部分商品调账后会导致已审批未出库的调拨出现可用库存为负数',
      conflicts
    });
    return;
  }

  const now = nowIso();
  for (const item of items) {
    const inv = getInventory(batch.store, item.product);
    const bookQty = inv ? inv.qty : 0;
    const lockedQty = getLockedQty(batch.store, item.product);
    const diffQty = item.actualQty - bookQty;
    const newBookQty = item.actualQty;

    if (inv) {
      inv.qty = newBookQty;
    } else {
      db.inventory.push({ store: batch.store, product: item.product, qty: newBookQty });
    }

    db.stocktakeAdjustments.push({
      id: db.stocktakeAdjustments.length > 0 ? Math.max(...db.stocktakeAdjustments.map(a => a.id)) + 1 : 1,
      batchId: batch.id,
      store: batch.store,
      product: item.product,
      bookQty,
      lockedQty,
      actualQty: item.actualQty,
      diffQty,
      newBookQty,
      adjustedBy: operator,
      adjustedAt: now
    });
  }

  batch.status = 'confirmed';
  batch.confirmedBy = operator;
  batch.confirmedAt = now;
  const hist = addStocktakeHistory(batch.id, 'confirmed', operator, '区域经理确认，差异已调账');
  batch.history.push(hist);
  await saveAllData();

  res.json({
    id: batch.id,
    store: batch.store,
    status: batch.status,
    confirmedBy: batch.confirmedBy,
    confirmedAt: batch.confirmedAt,
    items: items.map(i => enrichStocktakeItem(i, batch.store)),
    adjustments: db.stocktakeAdjustments.filter(a => a.batchId === batch.id)
  });
});

app.post('/api/stocktake/:id/withdraw', async (req, res) => {
  const { operator, remark } = req.body;

  if (!operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：operator' });
    return;
  }

  const user = requireStocktakeRole(operator, ['warehouse'], res);
  if (!user) return;

  const batch = getStocktakeBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'STOCKTAKE_NOT_FOUND', message: '盘点批次不存在' });
    return;
  }
  if (batch.status !== 'pending') {
    res.status(400).json({ error: 'STOCKTAKE_NOT_PENDING', message: `盘点批次状态为 ${batch.status}，只能撤销未确认的批次` });
    return;
  }

  const now = nowIso();
  batch.status = 'withdrawn';
  batch.withdrawnBy = operator;
  batch.withdrawnAt = now;
  batch.withdrawRemark = remark || null;
  const hist = addStocktakeHistory(batch.id, 'withdrawn', operator, remark || '库管撤销盘点批次');
  batch.history.push(hist);
  await saveAllData();

  res.json(batch);
});

app.get('/api/stocktake-adjustments', (req, res) => {
  const { store, product, batchId } = req.query;
  let result = [...db.stocktakeAdjustments];

  if (store) result = result.filter(a => a.store === store);
  if (product) result = result.filter(a => a.product === product);
  if (batchId) result = result.filter(a => a.batchId === batchId);

  result.sort((a, b) => new Date(b.adjustedAt) - new Date(a.adjustedAt));
  res.json(result);
});

app.get('/api/stocktake-history', (req, res) => {
  const { batchId, operator, action } = req.query;
  let result = [...db.stocktakeHistory];

  if (batchId) result = result.filter(h => h.batchId === batchId);
  if (operator) result = result.filter(h => h.operator === operator);
  if (action) result = result.filter(h => h.action === action);

  result.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(result);
});

(async () => {
  await ensureInitialized();
  await loadAllData();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`门店应急调拨 API 已启动: http://localhost:${PORT}`);
    console.log('数据库: SQLite (data/allocation.db)');
    console.log('健康检查: GET /api/health');
  });
})();

module.exports = app;
