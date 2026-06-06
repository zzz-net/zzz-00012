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
  stocktakeHistory: [],
  safetyStockConfig: [],
  replenishmentSnapshots: [],
  purchaseRequests: [],
  purchaseHistory: []
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

// ===== Replenishment & Purchase / 门店补货建议 & 采购申请模块 =====

const PURCHASE_STATUSES = ['pending', 'approved', 'rejected', 'completed'];

const RECENT_DAYS = 7;

function genReplenishmentSnapshotId() {
  const maxId = db.replenishmentSnapshots.reduce((max, s) => {
    const num = parseInt(s.id.replace('rsnap_', ''), 10);
    return num > max ? num : max;
  }, 0);
  return 'rsnap_' + String(maxId + 1).padStart(3, '0');
}

function genPurchaseRequestId() {
  const maxId = db.purchaseRequests.reduce((max, p) => {
    const num = parseInt(p.id.replace('pur_', ''), 10);
    return num > max ? num : max;
  }, 0);
  return 'pur_' + String(maxId + 1).padStart(3, '0');
}

function addPurchaseHistory(requestId, action, operator, remark) {
  const ids = db.purchaseHistory.map(h => h.id).filter(id => Number.isInteger(id));
  const nextId = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  const record = {
    id: nextId,
    requestId,
    action,
    operator,
    time: nowIso(),
    remark
  };
  db.purchaseHistory.push(record);
  return record;
}

function getRecentOutboundQty(store, product) {
  const now = Date.now();
  const cutoff = now - RECENT_DAYS * 24 * 60 * 60 * 1000;
  return db.allocations
    .filter(a => {
      if (a.sourceStore !== store || a.product !== product) return false;
      if (a.status !== 'shipped') return false;
      const shippedHist = (a.history || []).find(h => h.status === 'shipped');
      if (!shippedHist) return false;
      return new Date(shippedHist.time).getTime() >= cutoff;
    })
    .reduce((sum, a) => sum + a.qty, 0);
}

function getPendingPurchaseQty(store, product, excludeRequestId = null) {
  return db.purchaseRequests
    .filter(p => {
      if (p.store !== store) return false;
      if (!['pending', 'approved'].includes(p.status)) return false;
      if (excludeRequestId && p.id === excludeRequestId) return false;
      const hasProduct = (p.items || []).some(it => it.product === product);
      return hasProduct;
    })
    .reduce((sum, p) => {
      const item = (p.items || []).find(it => it.product === product);
      return sum + (item ? item.requestQty : 0);
    }, 0);
}

function getSafetyStockConfig(store, product) {
  return db.safetyStockConfig.find(c => c.store === store && c.product === product);
}

function requirePurchaseRole(userId, allowedRoles, res) {
  const user = getUser(userId);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    res.status(403).json({ error: 'PURCHASE_ROLE_FORBIDDEN', message: '该用户角色无权限执行此补货采购操作' });
    return null;
  }
  return user;
}

function calcReplenishmentSuggestion(store, product, excludeRequestId = null) {
  const inv = getInventory(store, product);
  const currentQty = inv ? inv.qty : 0;
  const safetyCfg = getSafetyStockConfig(store, product);
  const safetyQty = safetyCfg ? safetyCfg.safetyQty : 0;
  const recentOutbound = getRecentOutboundQty(store, product);
  const pendingPurQty = getPendingPurchaseQty(store, product, excludeRequestId);

  const demandEstimate = Math.max(safetyQty, recentOutbound);
  const effectiveCurrent = currentQty + pendingPurQty;
  const shortage = demandEstimate - effectiveCurrent;
  const suggestQty = shortage > 0 ? shortage : 0;

  return {
    store,
    product,
    currentQty,
    safetyQty,
    recentOutbound,
    pendingPurQty,
    demandEstimate,
    effectiveCurrent,
    shortage,
    suggestQty,
    needReplenish: suggestQty > 0
  };
}

app.get('/api/safety-stock', (req, res) => {
  const { store, product, operator } = req.query;

  const user = getUser(operator);
  if (operator && !user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }
  if (user && user.role === 'store_user') {
    res.status(403).json({ error: 'SAFETY_STOCK_ROLE_FORBIDDEN', message: '门店用户无权限查看安全库存配置' });
    return;
  }

  let result = [...db.safetyStockConfig];
  if (store) result = result.filter(c => c.store === store);
  if (product) result = result.filter(c => c.product === product);

  result = result.map(c => {
    const st = db.stores.find(s => s.id === c.store);
    const prod = db.products.find(p => p.id === c.product);
    const updater = db.users.find(u => u.id === c.updatedBy);
    return {
      ...c,
      storeName: st ? st.name : null,
      productName: prod ? prod.name : null,
      updatedByName: updater ? updater.name : null
    };
  });

  result.sort((a, b) => a.store.localeCompare(b.store) || a.product.localeCompare(b.product));
  res.json(result);
});

app.post('/api/safety-stock', async (req, res) => {
  const { store, product, safetyQty, operator } = req.body;

  if (store === undefined || product === undefined || safetyQty === undefined || !operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：store, product, safetyQty, operator' });
    return;
  }
  if (!Number.isInteger(safetyQty) || safetyQty < 0) {
    res.status(400).json({ error: 'INVALID_SAFETY_QTY', message: '安全库存必须为非负整数' });
    return;
  }

  const user = requirePurchaseRole(operator, ['warehouse'], res);
  if (!user) return;

  if (!db.stores.find(s => s.id === store)) {
    res.status(400).json({ error: 'INVALID_STORE', message: '门店不存在' });
    return;
  }
  if (!db.products.find(p => p.id === product)) {
    res.status(400).json({ error: 'INVALID_PRODUCT', message: '商品不存在' });
    return;
  }

  const now = nowIso();
  let existing = db.safetyStockConfig.find(c => c.store === store && c.product === product);
  if (existing) {
    existing.safetyQty = safetyQty;
    existing.updatedBy = operator;
    existing.updatedAt = now;
  } else {
    existing = { store, product, safetyQty, updatedBy: operator, updatedAt: now };
    db.safetyStockConfig.push(existing);
  }
  await saveAllData();

  const st = db.stores.find(s => s.id === existing.store);
  const prod = db.products.find(p => p.id === existing.product);
  res.json({
    ...existing,
    storeName: st ? st.name : null,
    productName: prod ? prod.name : null
  });
});

app.delete('/api/safety-stock/:store/:product', async (req, res) => {
  const { operator } = req.body || {};
  const { store, product } = req.params;

  if (!operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：operator' });
    return;
  }

  const user = requirePurchaseRole(operator, ['warehouse'], res);
  if (!user) return;

  const idx = db.safetyStockConfig.findIndex(c => c.store === store && c.product === product);
  if (idx === -1) {
    res.status(404).json({ error: 'SAFETY_STOCK_NOT_FOUND', message: '该门店该商品的安全库存配置不存在' });
    return;
  }

  db.safetyStockConfig.splice(idx, 1);
  await saveAllData();
  res.json({ ok: true, store, product });
});

app.get('/api/replenishment/suggestions', (req, res) => {
  const { store, operator, onlyShortage } = req.query;

  const user = getUser(operator);
  if (operator && !user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }

  let targetStores = db.stores.map(s => s.id);
  if (user && user.role === 'store_user') {
    targetStores = [user.store];
  }
  if (store) {
    if (user && user.role === 'store_user' && user.store !== store) {
      res.status(403).json({ error: 'REPLENISH_STORE_FORBIDDEN', message: '门店用户只能查看自己门店的补货建议' });
      return;
    }
    targetStores = [store];
  }

  const suggestions = [];
  for (const st of targetStores) {
    for (const prod of db.products) {
      const sug = calcReplenishmentSuggestion(st, prod.id);
      if (onlyShortage === 'true' && !sug.needReplenish) continue;
      const storeObj = db.stores.find(s => s.id === st);
      const prodObj = db.products.find(p => p.id === prod.id);
      suggestions.push({
        ...sug,
        storeName: storeObj ? storeObj.name : null,
        productName: prodObj ? prodObj.name : null
      });
    }
  }

  suggestions.sort((a, b) =>
    a.store.localeCompare(b.store) || (b.suggestQty - a.suggestQty)
  );
  res.json(suggestions);
});

app.post('/api/replenishment/snapshot', async (req, res) => {
  const { store, operator } = req.body;

  if (!store || !operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：store, operator' });
    return;
  }

  const user = getUser(operator);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }
  if (user.role === 'store_user' && user.store !== store) {
    res.status(403).json({ error: 'REPLENISH_STORE_FORBIDDEN', message: '门店用户只能为自己门店生成补货建议快照' });
    return;
  }

  if (!db.stores.find(s => s.id === store)) {
    res.status(400).json({ error: 'INVALID_STORE', message: '门店不存在' });
    return;
  }

  const items = db.products.map(p => {
    const sug = calcReplenishmentSuggestion(store, p.id);
    return {
      product: p.id,
      productName: p.name,
      currentQty: sug.currentQty,
      safetyQty: sug.safetyQty,
      recentOutbound: sug.recentOutbound,
      pendingPurQty: sug.pendingPurQty,
      demandEstimate: sug.demandEstimate,
      effectiveCurrent: sug.effectiveCurrent,
      suggestQty: sug.suggestQty,
      needReplenish: sug.needReplenish
    };
  });

  const snapId = genReplenishmentSnapshotId();
  const now = nowIso();
  const snapshot = {
    id: snapId,
    store,
    snapshotTime: now,
    items,
    createdBy: operator
  };
  db.replenishmentSnapshots.push(snapshot);
  await saveAllData();

  const storeObj = db.stores.find(s => s.id === store);
  res.status(201).json({
    ...snapshot,
    storeName: storeObj ? storeObj.name : null,
    summary: {
      totalProducts: items.length,
      needReplenishCount: items.filter(i => i.needReplenish).length,
      totalSuggestQty: items.reduce((s, i) => s + i.suggestQty, 0)
    }
  });
});

app.get('/api/replenishment/snapshots', (req, res) => {
  const { store, operator } = req.query;

  const user = getUser(operator);
  if (operator && !user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }

  let result = [...db.replenishmentSnapshots];
  if (user && user.role === 'store_user') {
    result = result.filter(s => s.store === user.store);
  }
  if (store) {
    if (user && user.role === 'store_user' && user.store !== store) {
      res.status(403).json({ error: 'REPLENISH_STORE_FORBIDDEN', message: '门店用户只能查看自己门店的快照' });
      return;
    }
    result = result.filter(s => s.store === store);
  }

  result = result.map(s => {
    const st = db.stores.find(st => st.id === s.store);
    const creator = db.users.find(u => u.id === s.createdBy);
    return {
      id: s.id,
      store: s.store,
      storeName: st ? st.name : null,
      snapshotTime: s.snapshotTime,
      createdBy: s.createdBy,
      createdByName: creator ? creator.name : null,
      itemCount: s.items.length,
      needReplenishCount: (s.items || []).filter(i => i.needReplenish).length,
      totalSuggestQty: (s.items || []).reduce((sum, i) => sum + i.suggestQty, 0)
    };
  });

  result.sort((a, b) => new Date(b.snapshotTime) - new Date(a.snapshotTime));
  res.json(result);
});

app.get('/api/replenishment/snapshots/:id', (req, res) => {
  const snap = db.replenishmentSnapshots.find(s => s.id === req.params.id);
  if (!snap) {
    res.status(404).json({ error: 'SNAPSHOT_NOT_FOUND', message: '补货建议快照不存在' });
    return;
  }

  const operator = req.query.operator;
  const user = operator ? getUser(operator) : null;
  if (user && user.role === 'store_user' && user.store !== snap.store) {
    res.status(403).json({ error: 'REPLENISH_STORE_FORBIDDEN', message: '门店用户只能查看自己门店的快照' });
    return;
  }

  const st = db.stores.find(s => s.id === snap.store);
  const creator = db.users.find(u => u.id === snap.createdBy);
  res.json({
    ...snap,
    storeName: st ? st.name : null,
    createdByName: creator ? creator.name : null
  });
});

app.get('/api/purchase-requests', (req, res) => {
  const { store, operator, status } = req.query;

  const user = getUser(operator);
  if (operator && !user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }

  let result = [...db.purchaseRequests];
  if (user && user.role === 'store_user') {
    result = result.filter(p => p.store === user.store);
  }
  if (store) {
    if (user && user.role === 'store_user' && user.store !== store) {
      res.status(403).json({ error: 'PURCHASE_STORE_FORBIDDEN', message: '门店用户只能查看自己门店的采购申请' });
      return;
    }
    result = result.filter(p => p.store === store);
  }
  if (status) result = result.filter(p => p.status === status);

  result = result.map(p => {
    const st = db.stores.find(s => s.id === p.store);
    const applicant = db.users.find(u => u.id === p.applicant);
    const reviewer = p.reviewer ? db.users.find(u => u.id === p.reviewer) : null;
    const enrichedItems = (p.items || []).map(it => {
      const prod = db.products.find(pr => pr.id === it.product);
      return { ...it, productName: prod ? prod.name : null };
    });
    return {
      id: p.id,
      store: p.store,
      storeName: st ? st.name : null,
      status: p.status,
      remark: p.remark,
      applicant: p.applicant,
      applicantName: applicant ? applicant.name : null,
      appliedAt: p.appliedAt,
      reviewer: p.reviewer,
      reviewerName: reviewer ? reviewer.name : null,
      reviewedAt: p.reviewedAt,
      reviewRemark: p.reviewRemark,
      items: enrichedItems,
      itemCount: enrichedItems.length,
      totalQty: enrichedItems.reduce((s, i) => s + i.requestQty, 0)
    };
  });

  result.sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt));
  res.json(result);
});

app.get('/api/purchase-requests/:id', (req, res) => {
  const pr = db.purchaseRequests.find(p => p.id === req.params.id);
  if (!pr) {
    res.status(404).json({ error: 'PURCHASE_NOT_FOUND', message: '采购申请不存在' });
    return;
  }

  const operator = req.query.operator;
  const user = operator ? getUser(operator) : null;
  if (user && user.role === 'store_user' && user.store !== pr.store) {
    res.status(403).json({ error: 'PURCHASE_STORE_FORBIDDEN', message: '门店用户只能查看自己门店的采购申请' });
    return;
  }

  const st = db.stores.find(s => s.id === pr.store);
  const applicant = db.users.find(u => u.id === pr.applicant);
  const reviewer = pr.reviewer ? db.users.find(u => u.id === pr.reviewer) : null;
  const enrichedItems = (pr.items || []).map(it => {
    const prod = db.products.find(prd => prd.id === it.product);
    return { ...it, productName: prod ? prod.name : null };
  });

  res.json({
    id: pr.id,
    store: pr.store,
    storeName: st ? st.name : null,
    status: pr.status,
    remark: pr.remark,
    applicant: pr.applicant,
    applicantName: applicant ? applicant.name : null,
    appliedAt: pr.appliedAt,
    reviewer: pr.reviewer,
    reviewerName: reviewer ? reviewer.name : null,
    reviewedAt: pr.reviewedAt,
    reviewRemark: pr.reviewRemark,
    items: enrichedItems,
    history: pr.history || []
  });
});

app.post('/api/purchase-requests', async (req, res) => {
  const { store, items, remark, operator, snapshotId } = req.body;

  if (!store || !items || !Array.isArray(items) || items.length === 0 || !operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：store, items(非空数组), operator' });
    return;
  }

  const user = getUser(operator);
  if (!user) {
    res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    return;
  }
  if (!['warehouse', 'store_user'].includes(user.role)) {
    res.status(403).json({ error: 'PURCHASE_ROLE_FORBIDDEN', message: '只有库管或门店用户可以创建采购申请' });
    return;
  }
  if (user.role === 'store_user' && user.store !== store) {
    res.status(403).json({ error: 'PURCHASE_STORE_FORBIDDEN', message: '门店用户只能为自己门店创建采购申请' });
    return;
  }

  if (!db.stores.find(s => s.id === store)) {
    res.status(400).json({ error: 'INVALID_STORE', message: '门店不存在' });
    return;
  }

  const normalizedItems = [];
  const seenProducts = new Set();
  for (const it of items) {
    if (!it.product || it.requestQty === undefined || it.requestQty === null) {
      res.status(400).json({ error: 'MISSING_FIELD', message: 'items 每个元素必须包含 product 和 requestQty' });
      return;
    }
    if (!db.products.find(p => p.id === it.product)) {
      res.status(400).json({ error: 'INVALID_PRODUCT', message: `商品 ${it.product} 不存在` });
      return;
    }
    if (!Number.isInteger(it.requestQty) || it.requestQty <= 0) {
      res.status(400).json({ error: 'INVALID_QTY', message: `商品 ${it.product} 的 requestQty 必须为正整数` });
      return;
    }
    if (seenProducts.has(it.product)) {
      res.status(400).json({ error: 'DUPLICATE_PRODUCT', message: `商品 ${it.product} 重复出现` });
      return;
    }
    seenProducts.add(it.product);
    normalizedItems.push({ product: it.product, requestQty: it.requestQty });
  }

  const conflicts = [];
  for (const it of normalizedItems) {
    const sug = calcReplenishmentSuggestion(store, it.product);
    const availableGap = sug.demandEstimate - sug.effectiveCurrent;
    if (availableGap <= 0) {
      conflicts.push({
        product: it.product,
        pendingPurQty: sug.pendingPurQty,
        effectiveCurrent: sug.effectiveCurrent,
        demandEstimate: sug.demandEstimate,
        requestedQty: it.requestQty,
        message: `商品 ${it.product} 当前有效库存 ${sug.effectiveCurrent} 已满足需求 ${sug.demandEstimate}，无需补货`
      });
    } else if (it.requestQty > availableGap) {
      conflicts.push({
        product: it.product,
        pendingPurQty: sug.pendingPurQty,
        availableGap,
        requestedQty: it.requestQty,
        message: `商品 ${it.product} 未完成采购量 ${sug.pendingPurQty} 已占用补货量，剩余可申请 ${Math.max(0, availableGap)}，请求 ${it.requestQty}`
      });
    }
  }

  if (conflicts.length > 0) {
    res.status(400).json({
      error: 'PURCHASE_CONFLICT',
      message: '创建失败：部分商品存在未完成采购量冲突或无需补货',
      conflicts
    });
    return;
  }

  const prId = genPurchaseRequestId();
  const now = nowIso();
  const pr = {
    id: prId,
    store,
    status: 'pending',
    remark: remark || null,
    applicant: operator,
    appliedAt: now,
    reviewer: null,
    reviewedAt: null,
    reviewRemark: null,
    items: normalizedItems,
    history: []
  };

  const hist = addPurchaseHistory(prId, 'created', operator, remark ? `创建采购申请：${remark}` : '创建采购申请');
  if (snapshotId) {
    addPurchaseHistory(prId, 'snapshot_ref', operator, `基于补货快照 ${snapshotId} 生成`);
  }
  pr.history = [hist];
  if (snapshotId) {
    const refHist = db.purchaseHistory[db.purchaseHistory.length - 1];
    pr.history.push(refHist);
  }
  db.purchaseRequests.push(pr);
  await saveAllData();

  const st = db.stores.find(s => s.id === pr.store);
  const applicant = db.users.find(u => u.id === pr.applicant);
  const enrichedItems = pr.items.map(it => {
    const prod = db.products.find(p => p.id === it.product);
    return { ...it, productName: prod ? prod.name : null };
  });

  res.status(201).json({
    id: pr.id,
    store: pr.store,
    storeName: st ? st.name : null,
    status: pr.status,
    remark: pr.remark,
    applicant: pr.applicant,
    applicantName: applicant ? applicant.name : null,
    appliedAt: pr.appliedAt,
    items: enrichedItems
  });
});

app.post('/api/purchase-requests/:id/approve', async (req, res) => {
  const { operator, remark } = req.body;
  const pr = db.purchaseRequests.find(p => p.id === req.params.id);

  if (!pr) {
    res.status(404).json({ error: 'PURCHASE_NOT_FOUND', message: '采购申请不存在' });
    return;
  }
  if (!operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：operator' });
    return;
  }

  const user = requirePurchaseRole(operator, ['manager'], res);
  if (!user) return;

  if (pr.status !== 'pending') {
    res.status(400).json({
      error: 'PURCHASE_NOT_PENDING',
      message: `采购申请状态为 ${pr.status}，只能审批待审批(pending)的申请`
    });
    return;
  }

  const conflicts = [];
  for (const it of pr.items) {
    const sug = calcReplenishmentSuggestion(pr.store, it.product, pr.id);
    const availableGap = sug.demandEstimate - sug.effectiveCurrent;
    if (availableGap < it.requestQty) {
      conflicts.push({
        product: it.product,
        pendingPurQty: sug.pendingPurQty,
        availableGap,
        requestedQty: it.requestQty,
        message: `商品 ${it.product} 审批时检测到冲突，剩余可申请 ${Math.max(0, availableGap)}，申请量 ${it.requestQty}`
      });
    }
  }
  if (conflicts.length > 0) {
    res.status(400).json({
      error: 'PURCHASE_CONFLICT',
      message: '审批失败：其他未完成采购已占用部分补货量',
      conflicts
    });
    return;
  }

  const now = nowIso();
  pr.status = 'approved';
  pr.reviewer = operator;
  pr.reviewedAt = now;
  pr.reviewRemark = remark || null;

  const hist = addPurchaseHistory(pr.id, 'approved', operator, remark || '区域经理审批通过');
  pr.history.push(hist);
  await saveAllData();

  const st = db.stores.find(s => s.id === pr.store);
  const reviewer = db.users.find(u => u.id === pr.reviewer);
  res.json({
    id: pr.id,
    store: pr.store,
    storeName: st ? st.name : null,
    status: pr.status,
    reviewer: pr.reviewer,
    reviewerName: reviewer ? reviewer.name : null,
    reviewedAt: pr.reviewedAt,
    reviewRemark: pr.reviewRemark
  });
});

app.post('/api/purchase-requests/:id/reject', async (req, res) => {
  const { operator, remark } = req.body;
  const pr = db.purchaseRequests.find(p => p.id === req.params.id);

  if (!pr) {
    res.status(404).json({ error: 'PURCHASE_NOT_FOUND', message: '采购申请不存在' });
    return;
  }
  if (!operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：operator' });
    return;
  }

  const user = requirePurchaseRole(operator, ['manager'], res);
  if (!user) return;

  if (pr.status !== 'pending') {
    res.status(400).json({
      error: 'PURCHASE_NOT_PENDING',
      message: `采购申请状态为 ${pr.status}，只能驳回待审批(pending)的申请`
    });
    return;
  }

  if (!remark || !remark.trim()) {
    res.status(400).json({ error: 'MISSING_REMARK', message: '驳回申请必须填写驳回原因(remark)' });
    return;
  }

  const now = nowIso();
  pr.status = 'rejected';
  pr.reviewer = operator;
  pr.reviewedAt = now;
  pr.reviewRemark = remark;

  const hist = addPurchaseHistory(pr.id, 'rejected', operator, remark);
  pr.history.push(hist);
  await saveAllData();

  const st = db.stores.find(s => s.id === pr.store);
  const reviewer = db.users.find(u => u.id === pr.reviewer);
  res.json({
    id: pr.id,
    store: pr.store,
    storeName: st ? st.name : null,
    status: pr.status,
    reviewer: pr.reviewer,
    reviewerName: reviewer ? reviewer.name : null,
    reviewedAt: pr.reviewedAt,
    reviewRemark: pr.reviewRemark
  });
});

app.post('/api/purchase-requests/:id/complete', async (req, res) => {
  const { operator } = req.body;
  const pr = db.purchaseRequests.find(p => p.id === req.params.id);

  if (!pr) {
    res.status(404).json({ error: 'PURCHASE_NOT_FOUND', message: '采购申请不存在' });
    return;
  }
  if (!operator) {
    res.status(400).json({ error: 'MISSING_FIELD', message: '缺少必填字段：operator' });
    return;
  }

  const user = requirePurchaseRole(operator, ['warehouse'], res);
  if (!user) return;

  if (pr.status !== 'approved') {
    res.status(400).json({
      error: 'PURCHASE_NOT_APPROVED',
      message: `采购申请状态为 ${pr.status}，只能完成已审批(approved)的申请`
    });
    return;
  }

  const now = nowIso();
  pr.status = 'completed';

  for (const it of pr.items) {
    const inv = getInventory(pr.store, it.product);
    if (inv) {
      inv.qty += it.requestQty;
    } else {
      db.inventory.push({ store: pr.store, product: it.product, qty: it.requestQty });
    }
  }

  const hist = addPurchaseHistory(pr.id, 'completed', operator, '采购到货，库存已增加');
  pr.history.push(hist);
  await saveAllData();

  const st = db.stores.find(s => s.id === pr.store);
  res.json({
    id: pr.id,
    store: pr.store,
    storeName: st ? st.name : null,
    status: pr.status
  });
});

app.get('/api/purchase-history', (req, res) => {
  const { requestId, operator, action, store } = req.query;
  let result = [...db.purchaseHistory];

  if (store) {
    const prIds = db.purchaseRequests
      .filter(p => p.store === store)
      .map(p => p.id);
    result = result.filter(h => prIds.includes(h.requestId));
  }

  const operator_user = operator ? getUser(operator) : null;
  if (operator_user && operator_user.role === 'store_user') {
    const prIds = db.purchaseRequests
      .filter(p => p.store === operator_user.store)
      .map(p => p.id);
    result = result.filter(h => prIds.includes(h.requestId));
  }

  if (requestId) result = result.filter(h => h.requestId === requestId);
  if (action) result = result.filter(h => h.action === action);
  if (operator) result = result.filter(h => h.operator === operator);

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
