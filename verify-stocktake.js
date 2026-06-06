const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const SNAPSHOT_FILE = path.join(__dirname, 'data', '_stocktake_snapshot.json');

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

let pass = 0, fail = 0;
function assert(name, condition, expected, actual) {
  if (condition) {
    console.log('  ✅ ' + name); pass++;
  } else {
    console.log('  ❌ ' + name);
    console.log('     期望: ' + JSON.stringify(expected));
    console.log('     实际: ' + JSON.stringify(actual));
    fail++;
  }
}

async function step(title, fn) {
  console.log(`\n=== ${title} ===`);
  await fn();
}

async function checkRestartPersistence() {
  console.log('=== 重启后持久化对比 ===\n');
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

  await step('0. 健康检查', async () => {
    const r = await request('GET', '/api/health');
    assert('返回 200', r.status === 200, 200, r.status);
    assert('status=ok', r.body.status === 'ok', 'ok', r.body.status);
  });

  const batches = await request('GET', '/api/stocktake');
  assert('盘点批次数量一致', batches.body.length === snapshot.batches.length, snapshot.batches.length, batches.body.length);
  for (const exp of snapshot.batches) {
    const act = batches.body.find(b => b.id === exp.id);
    assert(`批次 ${exp.id} 状态一致`, act && act.status === exp.status, exp.status, act ? act.status : null);
  }

  const adjustments = await request('GET', '/api/stocktake-adjustments');
  assert('调账记录数量一致', adjustments.body.length === snapshot.adjustments.length, snapshot.adjustments.length, adjustments.body.length);

  const history = await request('GET', '/api/stocktake-history');
  assert('审计日志数量一致', history.body.length === snapshot.history.length, snapshot.history.length, history.body.length);

  const inventory = await request('GET', '/api/inventory');
  assert('库存记录数量一致', inventory.body.length === snapshot.inventory.length, snapshot.inventory.length, inventory.body.length);
  for (const exp of snapshot.inventory) {
    const act = inventory.body.find(i => i.store === exp.store && i.product === exp.product);
    assert(`库存 [${exp.store}/${exp.product}] 一致`, act && act.qty === exp.qty, exp.qty, act ? act.qty : null);
  }

  console.log('\n=== 持久化验证通过：服务重启后盘点数据完全一致 ===');
  console.log(`\n通过: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

(async () => {
  if (process.argv.includes('--check-restart') && fs.existsSync(SNAPSHOT_FILE)) {
    await checkRestartPersistence();
    return;
  }

  console.log('库存盘点 & 差异调账模块验证');

  await step('0. 健康检查', async () => {
    const r = await request('GET', '/api/health');
    assert('返回 200', r.status === 200, 200, r.status);
    assert('status=ok', r.body.status === 'ok', 'ok', r.body.status);
  });

  let batchId;
  let invBeforeUmbrella, invBeforeWater;

  await step('1. 库管创建盘点批次（门店C）', async () => {
    const r = await request('POST', '/api/stocktake', {
      store: 'store_c',
      remark: '门店C月末盘点-自动化验证',
      operator: 'u_warehouse'
    });
    assert('返回 201', r.status === 201, 201, r.status);
    assert('状态 pending', r.body.status === 'pending', 'pending', r.body.status);
    assert('门店正确', r.body.store === 'store_c', 'store_c', r.body.store);
    assert('创建人正确', r.body.createdBy === 'u_warehouse', 'u_warehouse', r.body.createdBy);
    batchId = r.body.id;
    console.log('     盘点批次ID: ' + batchId);

    const inv = await request('GET', '/api/inventory');
    invBeforeUmbrella = inv.body.find(i => i.store === 'store_c' && i.product === 'p_umbrella');
    invBeforeWater = inv.body.find(i => i.store === 'store_c' && i.product === 'p_water');
    console.log(`     盘点前：雨伞账面 ${invBeforeUmbrella.qty}，矿泉水账面 ${invBeforeWater.qty}`);
  });

  await step('2. 库管录入商品实盘数量', async () => {
    let r = await request('POST', `/api/stocktake/${batchId}/items`, {
      product: 'p_umbrella',
      actualQty: 25,
      operator: 'u_warehouse'
    });
    assert('录入雨伞返回 200', r.status === 200, 200, r.status);
    assert('账面数量计算正确', r.body.bookQty === invBeforeUmbrella.qty, invBeforeUmbrella.qty, r.body.bookQty);
    assert('差异计算正确（实盘25-账面30=-5）', r.body.diffQty === -5, -5, r.body.diffQty);

    r = await request('POST', `/api/stocktake/${batchId}/items`, {
      product: 'p_water',
      actualQty: 160,
      operator: 'u_warehouse'
    });
    assert('录入矿泉水返回 200', r.status === 200, 200, r.status);
    assert('账面数量计算正确', r.body.bookQty === invBeforeWater.qty, invBeforeWater.qty, r.body.bookQty);
    assert('差异计算正确（实盘160-账面150=+10）', r.body.diffQty === 10, 10, r.body.diffQty);

    const detail = await request('GET', `/api/stocktake/${batchId}?operator=u_warehouse`);
    assert('批次详情含 2 条明细', detail.body.itemCount === 2, 2, detail.body.itemCount);
    assert('总差异 = -5 + 10 = 5', detail.body.totalDiff === 5, 5, detail.body.totalDiff);
  });

  await step('❌ 门店用户权限拒绝：不能创建批次', async () => {
    const r = await request('POST', '/api/stocktake', {
      store: 'store_a',
      operator: 'u_store_a'
    });
    assert('返回 403', r.status === 403, 403, r.status);
    assert('错误码 STOCKTAKE_ROLE_FORBIDDEN', r.body.error === 'STOCKTAKE_ROLE_FORBIDDEN', 'STOCKTAKE_ROLE_FORBIDDEN', r.body.error);
  });

  await step('❌ 门店用户权限拒绝：只能查看自己门店', async () => {
    const listA = await request('GET', '/api/stocktake?operator=u_store_a');
    const allStoreA = listA.body.every(b => b.store === 'store_a');
    assert('门店A用户列表只含 store_a', allStoreA, true, allStoreA);

    const viewB = await request('GET', `/api/stocktake/stocktake_001?operator=u_store_a`);
    assert('查看门店B批次返回 403', viewB.status === 403, 403, viewB.status);
    assert('错误码 STOCKTAKE_STORE_FORBIDDEN', viewB.body.error === 'STOCKTAKE_STORE_FORBIDDEN', 'STOCKTAKE_STORE_FORBIDDEN', viewB.body.error);
  });

  let conflictAllocId;
  await step('3. 调拨锁库冲突拦截：阻止可用为负的调账', async () => {
    let r = await request('POST', '/api/allocations', {
      sourceStore: 'store_a',
      targetStore: 'store_b',
      product: 'p_umbrella',
      qty: 25,
      reason: '盘点冲突测试-锁定雨伞',
      operator: 'u_store_b'
    });
    conflictAllocId = r.body.id;
    console.log('     冲突调拨单ID: ' + conflictAllocId);

    await request('POST', `/api/allocations/${conflictAllocId}/review`, { operator: 'u_warehouse' });
    await request('POST', `/api/allocations/${conflictAllocId}/approve`, { operator: 'u_manager' });

    const inv = await request('GET', '/api/inventory');
    const aUmb = inv.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
    console.log(`     门店A雨伞：账面 ${aUmb.qty}，锁定 ${aUmb.lockedQty}，可用 ${aUmb.availableQty}`);

    r = await request('POST', '/api/stocktake', {
      store: 'store_a',
      remark: '冲突测试批次',
      operator: 'u_warehouse'
    });
    const conflictBatchId = r.body.id;

    await request('POST', `/api/stocktake/${conflictBatchId}/items`, {
      product: 'p_umbrella',
      actualQty: 20,
      operator: 'u_warehouse'
    });

    const stateBefore = (await request('GET', `/api/stocktake/${conflictBatchId}?operator=u_warehouse`)).body.status;
    const invBeforeConfirm = await request('GET', '/api/inventory');
    const qtyBefore = invBeforeConfirm.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella').qty;

    r = await request('POST', `/api/stocktake/${conflictBatchId}/confirm`, { operator: 'u_manager' });
    assert('返回 400', r.status === 400, 400, r.status);
    assert('错误码 STOCKTAKE_NEGATIVE_AVAILABLE', r.body.error === 'STOCKTAKE_NEGATIVE_AVAILABLE', 'STOCKTAKE_NEGATIVE_AVAILABLE', r.body.error);
    assert('conflicts 数组非空', Array.isArray(r.body.conflicts) && r.body.conflicts.length > 0, '非空数组', r.body.conflicts);
    assert('冲突商品是 p_umbrella', r.body.conflicts[0].product === 'p_umbrella', 'p_umbrella', r.body.conflicts && r.body.conflicts[0] && r.body.conflicts[0].product);

    const stateAfter = (await request('GET', `/api/stocktake/${conflictBatchId}?operator=u_warehouse`)).body.status;
    const invAfterConfirm = await request('GET', '/api/inventory');
    const qtyAfter = invAfterConfirm.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella').qty;

    assert('批次状态不变（仍 pending）', stateAfter === stateBefore, stateBefore, stateAfter);
    assert('库存账面未变化', qtyAfter === qtyBefore, qtyBefore, qtyAfter);
  });

  await step('4. 区域经理确认调账（成功路径）', async () => {
    const r = await request('POST', `/api/stocktake/${batchId}/confirm`, {
      operator: 'u_manager'
    });
    assert('返回 200', r.status === 200, 200, r.status);
    assert('状态 confirmed', r.body.status === 'confirmed', 'confirmed', r.body.status);
    assert('确认人正确', r.body.confirmedBy === 'u_manager', 'u_manager', r.body.confirmedBy);
    assert('生成调账记录 2 条', r.body.adjustments && r.body.adjustments.length === 2, 2, r.body.adjustments ? r.body.adjustments.length : null);

    const inv = await request('GET', '/api/inventory');
    const afterUmbrella = inv.body.find(i => i.store === 'store_c' && i.product === 'p_umbrella');
    const afterWater = inv.body.find(i => i.store === 'store_c' && i.product === 'p_water');
    assert('雨伞按差异修正（30→25）', afterUmbrella.qty === 25, 25, afterUmbrella.qty);
    assert('矿泉水按差异修正（150→160）', afterWater.qty === 160, 160, afterWater.qty);

    const adj = await request('GET', `/api/stocktake-adjustments?batchId=${batchId}`);
    assert('调账记录可查询', adj.body.length === 2, 2, adj.body.length);
  });

  let withdrawBatchId;
  await step('5. 库管撤销未确认批次', async () => {
    let r = await request('POST', '/api/stocktake', {
      store: 'store_c',
      remark: '撤销测试批次',
      operator: 'u_warehouse'
    });
    withdrawBatchId = r.body.id;

    await request('POST', `/api/stocktake/${withdrawBatchId}/items`, {
      product: 'p_mask',
      actualQty: 190,
      operator: 'u_warehouse'
    });

    const histBefore = (await request('GET', `/api/stocktake-history?batchId=${withdrawBatchId}`)).body.length;

    r = await request('POST', `/api/stocktake/${withdrawBatchId}/withdraw`, {
      operator: 'u_warehouse',
      remark: '录错了，重新盘点'
    });
    assert('返回 200', r.status === 200, 200, r.status);
    assert('状态 withdrawn', r.body.status === 'withdrawn', 'withdrawn', r.body.status);
    assert('撤销人正确', r.body.withdrawnBy === 'u_warehouse', 'u_warehouse', r.body.withdrawnBy);

    const histAfter = (await request('GET', `/api/stocktake-history?batchId=${withdrawBatchId}`)).body.length;
    assert('追加撤销审计日志', histAfter === histBefore + 1, histBefore + 1, histAfter);

    r = await request('POST', `/api/stocktake/${withdrawBatchId}/items`, {
      product: 'p_mask',
      actualQty: 180,
      operator: 'u_warehouse'
    });
    assert('撤销后不能录入明细，返回 400', r.status === 400, 400, r.status);
    assert('错误码 STOCKTAKE_NOT_PENDING', r.body.error === 'STOCKTAKE_NOT_PENDING', 'STOCKTAKE_NOT_PENDING', r.body.error);
  });

  await step('6. 审计日志和追加式历史', async () => {
    const createdHist = await request('GET', `/api/stocktake-history?action=created`);
    assert('created 操作可查询', createdHist.body.length >= 1, '>=1', createdHist.body.length);

    const warehouseHist = await request('GET', `/api/stocktake-history?operator=u_warehouse`);
    assert('库管操作历史可查询', warehouseHist.body.length >= 1, '>=1', warehouseHist.body.length);

    const confirmedHist = await request('GET', `/api/stocktake-history?action=confirmed`);
    assert('confirmed 操作可查询', confirmedHist.body.length >= 1, '>=1', confirmedHist.body.length);

    const batchDetail = await request('GET', `/api/stocktake/${batchId}?operator=u_manager`);
    assert('批次内嵌 history 非空', batchDetail.body.history && batchDetail.body.history.length >= 1, '>=1', batchDetail.body.history ? batchDetail.body.history.length : null);
  });

  await step('7. 保存数据快照用于重启后验证', async () => {
    const batches = await request('GET', '/api/stocktake');
    const adjustments = await request('GET', '/api/stocktake-adjustments');
    const history = await request('GET', '/api/stocktake-history');
    const inventory = await request('GET', '/api/inventory');

    const snapshot = {
      batches: batches.body,
      adjustments: adjustments.body,
      history: history.body,
      inventory: inventory.body
    };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
    console.log(`     盘点批次: ${batches.body.length} 条`);
    console.log(`     调账记录: ${adjustments.body.length} 条`);
    console.log(`     审计日志: ${history.body.length} 条`);
    console.log(`     库存记录: ${inventory.body.length} 条`);
    console.log('     ✅ 快照已保存到 data/_stocktake_snapshot.json');
  });

  console.log('\n=== 总结果 ===');
  console.log(`通过: ${pass}/${pass + fail}`);

  if (fail === 0) {
    console.log('\n第一轮验证完成，请重启服务后再次运行本脚本进行持久化校验。');
    console.log('重启后运行： node verify-stocktake.js --check-restart');
  } else {
    process.exit(1);
  }
})();
