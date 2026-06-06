const { initSchema, saveAll, isEmpty, DATA_DIR } = require('./db');

const SAMPLE_USERS = [
  { id: 'u_store_a', name: '门店A店员张三', role: 'store_user', store: 'store_a' },
  { id: 'u_store_b', name: '门店B店员李四', role: 'store_user', store: 'store_b' },
  { id: 'u_warehouse', name: '库管王五', role: 'warehouse', store: null },
  { id: 'u_manager', name: '区域经理赵六', role: 'manager', store: null }
];

const SAMPLE_STORES = [
  { id: 'store_a', name: '门店A（望京店）' },
  { id: 'store_b', name: '门店B（国贸店）' },
  { id: 'store_c', name: '门店C（三里屯店）' }
];

const SAMPLE_PRODUCTS = [
  { id: 'p_umbrella', name: '应急雨伞' },
  { id: 'p_water', name: '瓶装矿泉水' },
  { id: 'p_mask', name: '防护口罩' },
  { id: 'p_firstaid', name: '急救包' }
];

const SAMPLE_INVENTORY = [
  { store: 'store_a', product: 'p_umbrella', qty: 30 },
  { store: 'store_a', product: 'p_water', qty: 200 },
  { store: 'store_a', product: 'p_mask', qty: 300 },
  { store: 'store_a', product: 'p_firstaid', qty: 20 },
  { store: 'store_b', product: 'p_umbrella', qty: 28 },
  { store: 'store_b', product: 'p_water', qty: 48 },
  { store: 'store_b', product: 'p_mask', qty: 80 },
  { store: 'store_b', product: 'p_firstaid', qty: 5 },
  { store: 'store_c', product: 'p_umbrella', qty: 30 },
  { store: 'store_c', product: 'p_water', qty: 150 },
  { store: 'store_c', product: 'p_mask', qty: 200 },
  { store: 'store_c', product: 'p_firstaid', qty: 15 }
];

const SAMPLE_ALLOCATIONS = [
  {
    id: 'alloc_001',
    sourceStore: 'store_a',
    targetStore: 'store_b',
    product: 'p_umbrella',
    qty: 20,
    reason: '门店B所在区域突降暴雨，雨伞告急',
    applicant: 'u_store_b',
    status: 'shipped',
    history: [
      { status: 'pending', operator: 'u_store_b', time: '2026-06-01T09:00:00Z', remark: '提交申请' },
      { status: 'reviewed', operator: 'u_warehouse', time: '2026-06-01T09:15:00Z', remark: '库存充足，复核通过' },
      { status: 'approved', operator: 'u_manager', time: '2026-06-01T09:30:00Z', remark: '情况紧急，同意调拨' },
      { status: 'shipped', operator: 'u_store_a', time: '2026-06-01T10:00:00Z', remark: '已出库并发运' }
    ]
  }
];

const SAMPLE_HISTORY = [
  { allocationId: 'alloc_001', status: 'pending', operator: 'u_store_b', time: '2026-06-01T09:00:00Z', remark: '提交申请' },
  { allocationId: 'alloc_001', status: 'reviewed', operator: 'u_warehouse', time: '2026-06-01T09:15:00Z', remark: '库存充足，复核通过' },
  { allocationId: 'alloc_001', status: 'approved', operator: 'u_manager', time: '2026-06-01T09:30:00Z', remark: '情况紧急，同意调拨' },
  { allocationId: 'alloc_001', status: 'shipped', operator: 'u_store_a', time: '2026-06-01T10:00:00Z', remark: '已出库并发运' }
];

const SAMPLE_STOCKTAKE_BATCHES = [
  {
    id: 'stocktake_001',
    store: 'store_b',
    status: 'confirmed',
    remark: '门店B月末常规盘点',
    createdBy: 'u_warehouse',
    createdAt: '2026-06-02T09:00:00Z',
    confirmedBy: 'u_manager',
    confirmedAt: '2026-06-02T14:00:00Z',
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawRemark: null,
    history: [
      { action: 'created', operator: 'u_warehouse', time: '2026-06-02T09:00:00Z', remark: '创建盘点批次：门店B月末盘点' },
      { action: 'confirmed', operator: 'u_manager', time: '2026-06-02T14:00:00Z', remark: '区域经理确认，差异已调账' }
    ]
  }
];

const SAMPLE_STOCKTAKE_ITEMS = [
  { id: 1, batchId: 'stocktake_001', product: 'p_umbrella', actualQty: 28 },
  { id: 2, batchId: 'stocktake_001', product: 'p_water', actualQty: 48 }
];

const SAMPLE_STOCKTAKE_ADJUSTMENTS = [
  {
    id: 1, batchId: 'stocktake_001', store: 'store_b', product: 'p_umbrella',
    bookQty: 30, lockedQty: 0, actualQty: 28, diffQty: -2, newBookQty: 28,
    adjustedBy: 'u_manager', adjustedAt: '2026-06-02T14:00:00Z'
  },
  {
    id: 2, batchId: 'stocktake_001', store: 'store_b', product: 'p_water',
    bookQty: 50, lockedQty: 0, actualQty: 48, diffQty: -2, newBookQty: 48,
    adjustedBy: 'u_manager', adjustedAt: '2026-06-02T14:00:00Z'
  }
];

const SAMPLE_STOCKTAKE_HISTORY = [
  { id: 1, batchId: 'stocktake_001', action: 'created', operator: 'u_warehouse', time: '2026-06-02T09:00:00Z', remark: '创建盘点批次：门店B月末盘点' },
  { id: 2, batchId: 'stocktake_001', action: 'item_add', operator: 'u_warehouse', time: '2026-06-02T09:30:00Z', remark: '录入商品 p_umbrella 实盘 28' },
  { id: 3, batchId: 'stocktake_001', action: 'item_add', operator: 'u_warehouse', time: '2026-06-02T09:31:00Z', remark: '录入商品 p_water 实盘 48' },
  { id: 4, batchId: 'stocktake_001', action: 'confirmed', operator: 'u_manager', time: '2026-06-02T14:00:00Z', remark: '区域经理确认，差异已调账' }
];

const SAMPLE_SAFETY_STOCK_CONFIG = [
  { store: 'store_a', product: 'p_umbrella', safetyQty: 40, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_a', product: 'p_water', safetyQty: 250, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_a', product: 'p_mask', safetyQty: 200, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_a', product: 'p_firstaid', safetyQty: 30, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_b', product: 'p_umbrella', safetyQty: 35, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_b', product: 'p_water', safetyQty: 100, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_b', product: 'p_mask', safetyQty: 100, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_b', product: 'p_firstaid', safetyQty: 10, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_c', product: 'p_umbrella', safetyQty: 40, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_c', product: 'p_water', safetyQty: 200, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_c', product: 'p_mask', safetyQty: 150, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' },
  { store: 'store_c', product: 'p_firstaid', safetyQty: 20, updatedBy: 'u_warehouse', updatedAt: '2026-06-03T10:00:00Z' }
];

async function initAllData() {
  await initSchema();
  const data = {
    users: SAMPLE_USERS,
    stores: SAMPLE_STORES,
    products: SAMPLE_PRODUCTS,
    inventory: SAMPLE_INVENTORY,
    allocations: SAMPLE_ALLOCATIONS,
    history: SAMPLE_HISTORY,
    stocktakeBatches: SAMPLE_STOCKTAKE_BATCHES,
    stocktakeItems: SAMPLE_STOCKTAKE_ITEMS,
    stocktakeAdjustments: SAMPLE_STOCKTAKE_ADJUSTMENTS,
    stocktakeHistory: SAMPLE_STOCKTAKE_HISTORY,
    safetyStockConfig: SAMPLE_SAFETY_STOCK_CONFIG,
    replenishmentSnapshots: [],
    purchaseRequests: [],
    purchaseHistory: []
  };
  await saveAll(data);
  console.log('SQLite 数据初始化完成');
  return data;
}

async function ensureInitialized() {
  await initSchema();
  const empty = await isEmpty();
  if (empty) {
    return await initAllData();
  }
  return null;
}

if (require.main === module) {
  initAllData().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { initAllData, ensureInitialized, DATA_DIR };
