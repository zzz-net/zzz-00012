const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

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
  { store: 'store_b', product: 'p_umbrella', qty: 30 },
  { store: 'store_b', product: 'p_water', qty: 50 },
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
  {
    allocationId: 'alloc_001',
    status: 'pending',
    operator: 'u_store_b',
    time: '2026-06-01T09:00:00Z',
    remark: '提交申请'
  },
  {
    allocationId: 'alloc_001',
    status: 'reviewed',
    operator: 'u_warehouse',
    time: '2026-06-01T09:15:00Z',
    remark: '库存充足，复核通过'
  },
  {
    allocationId: 'alloc_001',
    status: 'approved',
    operator: 'u_manager',
    time: '2026-06-01T09:30:00Z',
    remark: '情况紧急，同意调拨'
  },
  {
    allocationId: 'alloc_001',
    status: 'shipped',
    operator: 'u_store_a',
    time: '2026-06-01T10:00:00Z',
    remark: '已出库并发运'
  }
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function writeJson(fileName, data) {
  const filePath = path.join(DATA_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function initAllData() {
  ensureDataDir();
  writeJson('users.json', SAMPLE_USERS);
  writeJson('stores.json', SAMPLE_STORES);
  writeJson('products.json', SAMPLE_PRODUCTS);
  writeJson('inventory.json', SAMPLE_INVENTORY);
  writeJson('allocations.json', SAMPLE_ALLOCATIONS);
  writeJson('history.json', SAMPLE_HISTORY);
  console.log('数据初始化完成，已写入 data/ 目录');
}

if (require.main === module) {
  initAllData();
}

module.exports = { initAllData, DATA_DIR };
