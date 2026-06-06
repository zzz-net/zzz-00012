const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const SNAPSHOT_FILE = path.join(__dirname, 'data', '_snapshot.json');

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function assert(name, condition, expected, actual) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name}`);
    console.log(`     期望: ${JSON.stringify(expected)}`);
    console.log(`     实际: ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

async function step(title, fn) {
  console.log(`\n=== ${title} ===`);
  await fn();
}

(async () => {
  console.log('门店应急调拨 API 验证');

  await step('0. 健康检查', async () => {
    const r = await request('GET', '/api/health');
    assert('返回 200', r.status === 200, 200, r.status);
    assert('status=ok', r.body.status === 'ok', 'ok', r.body.status);
  });

  let allocId;
  await step('1. 提交调拨申请（门店B→门店A 雨伞 15）', async () => {
    const r = await request('POST', '/api/allocations', {
      sourceStore: 'store_a',
      targetStore: 'store_b',
      product: 'p_umbrella',
      qty: 15,
      reason: '突降暴雨，门店B雨伞售罄',
      operator: 'u_store_b'
    });
    assert('返回 201', r.status === 201, 201, r.status);
    assert('状态为 pending', r.body.status === 'pending', 'pending', r.body.status);
    assert('申请人正确', r.body.applicant === 'u_store_b', 'u_store_b', r.body.applicant);
    allocId = r.body.id;
    console.log(`     调拨单 ID: ${allocId}`);
  });

  await step('❌ 错误场景：申请人自审', async () => {
    const r = await request('POST', `/api/allocations/${allocId}/review`, {
      operator: 'u_store_b'
    });
    assert('返回 400', r.status === 400, 400, r.status);
    assert('错误码 SELF_REVIEW', r.body.error === 'SELF_REVIEW', 'SELF_REVIEW', r.body.error);
    const alloc = await request('GET', `/api/allocations/${allocId}`);
    assert('状态未变化，仍为 pending', alloc.body.status === 'pending', 'pending', alloc.body.status);
  });

  await step('2. 库管复核', async () => {
    const r = await request('POST', `/api/allocations/${allocId}/review`, {
      operator: 'u_warehouse'
    });
    assert('返回 200', r.status === 200, 200, r.status);
    assert('状态为 reviewed', r.body.status === 'reviewed', 'reviewed', r.body.status);
  });

  let allocNoReviewId;
  await step('❌ 错误场景：未复核直接审批', async () => {
    const create = await request('POST', '/api/allocations', {
      sourceStore: 'store_c',
      targetStore: 'store_b',
      product: 'p_water',
      qty: 10,
      reason: '测试未复核审批',
      operator: 'u_store_b'
    });
    allocNoReviewId = create.body.id;

    const r = await request('POST', `/api/allocations/${allocNoReviewId}/approve`, {
      operator: 'u_manager'
    });
    assert('返回 400', r.status === 400, 400, r.status);
    assert('错误码 NOT_REVIEWED', r.body.error === 'NOT_REVIEWED', 'NOT_REVIEWED', r.body.error);
    const alloc = await request('GET', `/api/allocations/${allocNoReviewId}`);
    assert('状态未变化，仍为 pending', alloc.body.status === 'pending', 'pending', alloc.body.status);
  });

  await step('3. 区域经理审批（锁定库存）', async () => {
    const invBefore = await request('GET', '/api/inventory');
    const aBefore = invBefore.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');

    const r = await request('POST', `/api/allocations/${allocId}/approve`, {
      operator: 'u_manager'
    });
    assert('返回 200', r.status === 200, 200, r.status);
    assert('状态为 approved', r.body.status === 'approved', 'approved', r.body.status);

    const invAfter = await request('GET', '/api/inventory');
    const aAfter = invAfter.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
    assert('库存已锁定 15 把', aAfter.lockedQty === aBefore.lockedQty + 15, aBefore.lockedQty + 15, aAfter.lockedQty);
    assert('可用库存减少 15', aAfter.availableQty === aBefore.availableQty - 15, aBefore.availableQty - 15, aAfter.availableQty);
    assert('总库存不变', aAfter.qty === aBefore.qty, aBefore.qty, aAfter.qty);
  });

  let allocOccupyId;
  await step('❌ 错误场景：库存被其他已批申请占用', async () => {
    const inv = await request('GET', '/api/inventory');
    const avail = inv.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella').availableQty;
    const total = inv.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella').qty;
    console.log(`     当前总库存: ${total}, 可用: ${avail}`);

    const tooMuchQty = Math.min(avail + 5, total);
    const create = await request('POST', '/api/allocations', {
      sourceStore: 'store_a',
      targetStore: 'store_b',
      product: 'p_umbrella',
      qty: tooMuchQty,
      reason: '超过可用库存的申请',
      operator: 'u_store_b'
    });
    console.log(`     创建申请返回: ${create.status}, id=${create.body.id || 'undefined'}`);
    allocOccupyId = create.body.id;

    const r = await request('POST', `/api/allocations/${allocOccupyId}/review`, {
      operator: 'u_warehouse'
    });
    assert('返回 400', r.status === 400, 400, r.status);
    assert('错误码 INSUFFICIENT_AVAILABLE', r.body.error === 'INSUFFICIENT_AVAILABLE', 'INSUFFICIENT_AVAILABLE', r.body.error);
    const alloc = await request('GET', `/api/allocations/${allocOccupyId}`);
    assert('状态未变化，仍为 pending', alloc.body.status === 'pending', 'pending', alloc.body.status);
  });

  let allocWithdrawId;
  await step('❌ 错误场景：已撤回不能出库', async () => {
    const create = await request('POST', '/api/allocations', {
      sourceStore: 'store_c',
      targetStore: 'store_b',
      product: 'p_mask',
      qty: 10,
      reason: '测试撤回后出库',
      operator: 'u_store_b'
    });
    allocWithdrawId = create.body.id;

    await request('POST', `/api/allocations/${allocWithdrawId}/review`, { operator: 'u_warehouse' });
    await request('POST', `/api/allocations/${allocWithdrawId}/approve`, { operator: 'u_manager' });
    await request('POST', `/api/allocations/${allocWithdrawId}/withdraw`, { operator: 'u_store_b', remark: '不需要了' });

    const r = await request('POST', `/api/allocations/${allocWithdrawId}/ship`, { operator: 'u_warehouse' });
    assert('返回 400', r.status === 400, 400, r.status);
    assert('错误码 WITHDRAWN_CANNOT_SHIP', r.body.error === 'WITHDRAWN_CANNOT_SHIP', 'WITHDRAWN_CANNOT_SHIP', r.body.error);

    const inv = await request('GET', '/api/inventory');
    const src = inv.body.find(i => i.store === 'store_c' && i.product === 'p_mask');
    assert('来源门店库存未扣减', src.qty === 200, 200, src.qty);
  });

  await step('4. 出库确认（真正扣减库存）', async () => {
    const invBefore = await request('GET', '/api/inventory');
    const srcBefore = invBefore.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
    const tgtBefore = invBefore.body.find(i => i.store === 'store_b' && i.product === 'p_umbrella');

    const r = await request('POST', `/api/allocations/${allocId}/ship`, { operator: 'u_warehouse' });
    assert('返回 200', r.status === 200, 200, r.status);
    assert('状态为 shipped', r.body.status === 'shipped', 'shipped', r.body.status);

    const invAfter = await request('GET', '/api/inventory');
    const srcAfter = invAfter.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
    const tgtAfter = invAfter.body.find(i => i.store === 'store_b' && i.product === 'p_umbrella');
    assert('门店A库存减少 15', srcAfter.qty === srcBefore.qty - 15, srcBefore.qty - 15, srcAfter.qty);
    assert('门店B库存增加 15', tgtAfter.qty === tgtBefore.qty + 15, tgtBefore.qty + 15, tgtAfter.qty);
    assert('门店A锁定库存释放', srcAfter.lockedQty === srcBefore.lockedQty - 15, srcBefore.lockedQty - 15, srcAfter.lockedQty);
  });

  await step('5. 审计查询', async () => {
    const r1 = await request('GET', '/api/audit?status=shipped');
    assert('按状态筛选已出库有结果', r1.body.length >= 1, '>=1', r1.body.length);

    const r2 = await request('GET', '/api/audit?sourceStore=store_a');
    assert('按来源门店筛选有结果', r2.body.length >= 1, '>=1', r2.body.length);

    const r3 = await request('GET', '/api/audit?product=p_umbrella');
    assert('按商品筛选有结果', r3.body.length >= 1, '>=1', r3.body.length);

    const r4 = await request('GET', '/api/history?status=approved');
    assert('历史记录按状态筛选有结果', r4.body.length >= 1, '>=1', r4.body.length);

    const r5 = await request('GET', '/api/history?operator=u_manager');
    assert('历史记录按操作人筛选有结果', r5.body.length >= 1, '>=1', r5.body.length);
  });

  await step('6. 保存数据快照用于重启后验证', async () => {
    const inv = await request('GET', '/api/inventory');
    const allocs = await request('GET', '/api/allocations');
    const hist = await request('GET', '/api/history');
    const stocktakeBatches = await request('GET', '/api/stocktake');
    const stocktakeAdj = await request('GET', '/api/stocktake-adjustments');
    const stocktakeHist = await request('GET', '/api/stocktake-history');
    const snapshot = {
      inv: inv.body,
      allocs: allocs.body,
      hist: hist.body,
      stocktakeBatches: stocktakeBatches.body,
      stocktakeAdj: stocktakeAdj.body,
      stocktakeHist: stocktakeHist.body
    };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
    console.log(`     库存记录数: ${inv.body.length}`);
    console.log(`     调拨单数: ${allocs.body.length}`);
    console.log(`     历史记录数: ${hist.body.length}`);
    console.log(`     盘点批次数: ${stocktakeBatches.body.length}`);
    console.log(`     调账记录数: ${stocktakeAdj.body.length}`);
    console.log(`     盘点审计数: ${stocktakeHist.body.length}`);
    console.log('     ✅ 快照已保存到 data/_snapshot.json');
  });

  console.log('\n=== 第一轮验证完成，服务将继续运行 ===');
  console.log('请手动重启服务后运行: node verify-restart.js 进行持久化验证');
})();
