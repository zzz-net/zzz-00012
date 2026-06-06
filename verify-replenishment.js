const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const SNAPSHOT_FILE = path.join(__dirname, 'data', '_replenishment_snapshot.json');

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

  const safety = await request('GET', '/api/safety-stock?operator=u_warehouse');
  assert('安全库存配置数量一致', safety.body.length === snapshot.safetyStock.length, snapshot.safetyStock.length, safety.body.length);

  const snaps = await request('GET', '/api/replenishment/snapshots?operator=u_warehouse');
  assert('补货建议快照数量一致', snaps.body.length === snapshot.snapshots.length, snapshot.snapshots.length, snaps.body.length);
  for (const exp of snapshot.snapshots) {
    const act = snaps.body.find(s => s.id === exp.id);
    assert(`快照 ${exp.id} 门店一致`, act && act.store === exp.store, exp.store, act ? act.store : null);
  }

  const prs = await request('GET', '/api/purchase-requests?operator=u_warehouse');
  assert('采购申请数量一致', prs.body.length === snapshot.purchaseRequests.length, snapshot.purchaseRequests.length, prs.body.length);
  for (const exp of snapshot.purchaseRequests) {
    const act = prs.body.find(p => p.id === exp.id);
    assert(`采购申请 ${exp.id} 状态一致`, act && act.status === exp.status, exp.status, act ? act.status : null);
  }

  const hist = await request('GET', '/api/purchase-history?operator=u_warehouse');
  assert('采购操作日志数量一致', hist.body.length === snapshot.purchaseHistory.length, snapshot.purchaseHistory.length, hist.body.length);

  console.log('\n=== 持久化验证通过：服务重启后补货采购数据完全一致 ===');
  console.log(`\n通过: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

(async () => {
  if (process.argv.includes('--check-restart') && fs.existsSync(SNAPSHOT_FILE)) {
    await checkRestartPersistence();
    return;
  }

  console.log('门店补货建议 & 采购申请模块验证');

  await step('0. 健康检查', async () => {
    const r = await request('GET', '/api/health');
    assert('返回 200', r.status === 200, 200, r.status);
    assert('status=ok', r.body.status === 'ok', 'ok', r.body.status);
  });

  await step('1. 安全库存配置 - 库管查询', async () => {
    const r = await request('GET', '/api/safety-stock?operator=u_warehouse');
    assert('返回 200', r.status === 200, 200, r.status);
    assert('返回 12 条配置（3门店 × 4商品）', r.body.length === 12, 12, r.body.length);

    const waterB = r.body.find(c => c.store === 'store_b' && c.product === 'p_water');
    assert('门店B矿泉水安全库存=100', waterB && waterB.safetyQty === 100, 100, waterB ? waterB.safetyQty : null);
  });

  await step('❌ 安全库存配置 - 门店用户权限拒绝', async () => {
    const r = await request('GET', '/api/safety-stock?operator=u_store_a');
    assert('返回 403', r.status === 403, 403, r.status);
    assert('错误码 SAFETY_STOCK_ROLE_FORBIDDEN', r.body.error === 'SAFETY_STOCK_ROLE_FORBIDDEN', 'SAFETY_STOCK_ROLE_FORBIDDEN', r.body.error);
  });

  await step('2. 安全库存配置 - 库管新增/修改', async () => {
    let r = await request('POST', '/api/safety-stock', {
      store: 'store_b',
      product: 'p_water',
      safetyQty: 120,
      operator: 'u_warehouse'
    });
    assert('修改返回 200', r.status === 200, 200, r.status);
    assert('门店B矿泉水安全库存更新为 120', r.body.safetyQty === 120, 120, r.body.safetyQty);
    assert('更新人为 u_warehouse', r.body.updatedBy === 'u_warehouse', 'u_warehouse', r.body.updatedBy);

    r = await request('GET', '/api/safety-stock?operator=u_warehouse&store=store_b&product=p_water');
    assert('查询确认已更新', r.body.length === 1 && r.body[0].safetyQty === 120, true, r.body.length === 1 ? r.body[0].safetyQty : null);

    const hist = await request('GET', '/api/purchase-history?action=safety_stock_updated');
    assert('配置变更已写入追加式日志', hist.body.length >= 1, '>=1', hist.body.length);
    if (hist.body.length >= 1) {
      const last = hist.body[hist.body.length - 1];
      assert('日志操作人为 u_warehouse', last.operator === 'u_warehouse', 'u_warehouse', last.operator);
      assert('日志含修改说明', last.remark && last.remark.includes('安全库存') && last.remark.includes('100') && last.remark.includes('120'), true, last.remark);
    }
  });

  await step('3. 补货建议计算 - 门店B所有商品', async () => {
    const r = await request('GET', '/api/replenishment/suggestions?store=store_b&operator=u_warehouse');
    assert('返回 200', r.status === 200, 200, r.status);
    assert('返回 4 条建议（4个商品）', r.body.length === 4, 4, r.body.length);

    const water = r.body.find(s => s.product === 'p_water');
    console.log(`     门店B矿泉水：当前库存=${water.currentQty}，安全线=${water.safetyQty}，近7日出库=${water.recentOutbound}，建议补货=${water.suggestQty}`);
    assert('矿泉水返回字段完整', water.currentQty !== undefined && water.safetyQty !== undefined && water.suggestQty !== undefined, true, { currentQty: water.currentQty, safetyQty: water.safetyQty, suggestQty: water.suggestQty });
    assert('needReplenish 字段存在且为布尔值', typeof water.needReplenish === 'boolean', true, typeof water.needReplenish);
  });

  await step('❌ 补货建议 - 门店用户权限隔离', async () => {
    const listA = await request('GET', '/api/replenishment/suggestions?operator=u_store_a');
    const allStoreA = listA.body.every(s => s.store === 'store_a');
    assert('门店A用户列表只含 store_a', allStoreA, true, listA.body.map(s => s.store));

    const viewB = await request('GET', '/api/replenishment/suggestions?store=store_b&operator=u_store_a');
    assert('门店A用户看门店B建议返回 403', viewB.status === 403, 403, viewB.status);
    assert('错误码 REPLENISH_STORE_FORBIDDEN', viewB.body.error === 'REPLENISH_STORE_FORBIDDEN', 'REPLENISH_STORE_FORBIDDEN', viewB.body.error);
  });

  let snapId;
  await step('4. 生成补货建议快照（门店B）', async () => {
    const r = await request('POST', '/api/replenishment/snapshot', {
      store: 'store_b',
      operator: 'u_warehouse'
    });
    assert('返回 201', r.status === 201, 201, r.status);
    assert('快照ID存在', !!r.body.id, true, !!r.body.id);
    assert('门店正确', r.body.store === 'store_b', 'store_b', r.body.store);
    assert('summary 含汇总信息', r.body.summary && r.body.summary.totalProducts === 4, 4, r.body.summary ? r.body.summary.totalProducts : null);
    snapId = r.body.id;
    console.log('     快照ID: ' + snapId);

    const detail = await request('GET', `/api/replenishment/snapshots/${snapId}?operator=u_warehouse`);
    assert('快照详情返回 200', detail.status === 200, 200, detail.status);
    assert('快照详情含 4 条商品', detail.body.items.length === 4, 4, detail.body.items.length);
  });

  let rejectPrId;
  await step('5. 创建采购申请 + 区域经理驳回', async () => {
    let r = await request('POST', '/api/purchase-requests', {
      store: 'store_b',
      items: [
        { product: 'p_water', requestQty: 50 },
        { product: 'p_firstaid', requestQty: 5 }
      ],
      remark: '驳回测试-门店B备货',
      operator: 'u_store_b'
    });
    assert('创建返回 201', r.status === 201, 201, r.status);
    assert('状态为 pending', r.body.status === 'pending', 'pending', r.body.status);
    assert('申请人正确', r.body.applicant === 'u_store_b', 'u_store_b', r.body.applicant);
    assert('含 2 个商品', r.body.items.length === 2, 2, r.body.items.length);
    rejectPrId = r.body.id;
    console.log('     驳回测试采购申请ID: ' + rejectPrId);

    r = await request('POST', `/api/purchase-requests/${rejectPrId}/reject`, {
      operator: 'u_manager'
    });
    assert('驳回缺原因返回 400', r.status === 400, 400, r.status);
    assert('错误码 MISSING_REMARK', r.body.error === 'MISSING_REMARK', 'MISSING_REMARK', r.body.error);

    r = await request('POST', `/api/purchase-requests/${rejectPrId}/reject`, {
      operator: 'u_manager',
      remark: '采购量过大，请核实后重新提交'
    });
    assert('驳回返回 200', r.status === 200, 200, r.status);
    assert('状态为 rejected', r.body.status === 'rejected', 'rejected', r.body.status);
    assert('审批人为 u_manager', r.body.reviewer === 'u_manager', 'u_manager', r.body.reviewer);
    assert('驳回原因已保存', r.body.reviewRemark === '采购量过大，请核实后重新提交', true, r.body.reviewRemark);

    const detail = await request('GET', `/api/purchase-requests/${rejectPrId}?operator=u_manager`);
    assert('详情含操作历史数组', Array.isArray(detail.body.history) && detail.body.history.length >= 2, '>=2 条', detail.body.history ? detail.body.history.length : null);

    const hist = await request('GET', `/api/purchase-history?requestId=${rejectPrId}`);
    assert('追加日志含 rejected 动作', hist.body.some(h => h.action === 'rejected'), true, hist.body.map(h => h.action));
    assert('追加日志含驳回原因', hist.body.some(h => h.action === 'rejected' && h.remark && h.remark.includes('采购量过大')), true, hist.body.filter(h => h.action === 'rejected').map(h => h.remark));
  });

  let approvePrId;
  let waterBefore, firstaidBefore;
  await step('6. 创建采购申请 + 区域经理审批通过 + 库管完成入库', async () => {
    const inv = await request('GET', '/api/inventory');
    waterBefore = inv.body.find(i => i.store === 'store_b' && i.product === 'p_water').qty;
    firstaidBefore = inv.body.find(i => i.store === 'store_b' && i.product === 'p_firstaid').qty;
    console.log(`     入库前：门店B矿泉水 ${waterBefore}，急救包 ${firstaidBefore}`);

    let r = await request('POST', '/api/purchase-requests', {
      store: 'store_b',
      items: [
        { product: 'p_water', requestQty: 30 },
        { product: 'p_firstaid', requestQty: 5 }
      ],
      remark: '审批测试-门店B正常备货',
      operator: 'u_store_b',
      snapshotId: snapId
    });
    assert('创建返回 201', r.status === 201, 201, r.status);
    approvePrId = r.body.id;
    console.log('     审批测试采购申请ID: ' + approvePrId);

    r = await request('POST', `/api/purchase-requests/${approvePrId}/approve`, {
      operator: 'u_manager',
      remark: '同意采购'
    });
    assert('审批返回 200', r.status === 200, 200, r.status);
    assert('状态为 approved', r.body.status === 'approved', 'approved', r.body.status);

    r = await request('POST', `/api/purchase-requests/${approvePrId}/complete`, {
      operator: 'u_warehouse'
    });
    assert('完成返回 200', r.status === 200, 200, r.status);
    assert('状态为 completed', r.body.status === 'completed', 'completed', r.body.status);

    const invAfter = await request('GET', '/api/inventory');
    const waterAfter = invAfter.body.find(i => i.store === 'store_b' && i.product === 'p_water').qty;
    const firstaidAfter = invAfter.body.find(i => i.store === 'store_b' && i.product === 'p_firstaid').qty;
    console.log(`     入库后：门店B矿泉水 ${waterAfter}，急救包 ${firstaidAfter}`);
    assert(`矿泉水按申请量增加 ${waterBefore}+30=${waterBefore + 30}`, waterAfter === waterBefore + 30, waterBefore + 30, waterAfter);
    assert(`急救包按申请量增加 ${firstaidBefore}+5=${firstaidBefore + 5}`, firstaidAfter === firstaidBefore + 5, firstaidBefore + 5, firstaidAfter);
  });

  await step('❌ 采购申请 - 门店用户权限隔离', async () => {
    const listA = await request('GET', '/api/purchase-requests?operator=u_store_a');
    const allStoreA = listA.body.every(p => p.store === 'store_a');
    assert('门店A用户列表只含 store_a', allStoreA, true, listA.body.map(p => p.store));

    const viewB = await request('GET', `/api/purchase-requests/${approvePrId}?operator=u_store_a`);
    assert('门店A用户看门店B申请详情返回 403', viewB.status === 403, 403, viewB.status);
    assert('错误码 PURCHASE_STORE_FORBIDDEN', viewB.body.error === 'PURCHASE_STORE_FORBIDDEN', 'PURCHASE_STORE_FORBIDDEN', viewB.body.error);

    const createForB = await request('POST', '/api/purchase-requests', {
      store: 'store_b',
      items: [{ product: 'p_water', requestQty: 10 }],
      operator: 'u_store_a'
    });
    assert('门店A用户为门店B创建申请返回 403', createForB.status === 403, 403, createForB.status);
    assert('错误码 PURCHASE_STORE_FORBIDDEN', createForB.body.error === 'PURCHASE_STORE_FORBIDDEN', 'PURCHASE_STORE_FORBIDDEN', createForB.body.error);
  });

  await step('7. 冲突拦截：同一门店同一商品未完成采购量不能重复占用', async () => {
    const sug = await request('GET', '/api/replenishment/suggestions?store=store_c&operator=u_warehouse');
    const waterSug = sug.body.find(s => s.product === 'p_water');
    console.log(`     门店C矿泉水：当前库存=${waterSug.currentQty}，安全线=${waterSug.safetyQty}，建议补货=${waterSug.suggestQty}`);
    const firstQty = waterSug.suggestQty;
    const secondQty = 10;

    let r = await request('POST', '/api/purchase-requests', {
      store: 'store_c',
      items: [{ product: 'p_water', requestQty: firstQty }],
      remark: '冲突测试-第一笔占满补货量',
      operator: 'u_warehouse'
    });
    assert('第一笔创建成功（201）', r.status === 201, 201, r.status);
    const firstPrId = r.body.id;
    console.log('     冲突测试第一笔申请ID: ' + firstPrId + '，申请量=' + firstQty);

    const prsBefore = (await request('GET', '/api/purchase-requests?operator=u_warehouse')).body.length;

    r = await request('POST', '/api/purchase-requests', {
      store: 'store_c',
      items: [{ product: 'p_water', requestQty: secondQty }],
      remark: '冲突测试-第二笔应该被拦截',
      operator: 'u_warehouse'
    });
    assert('第二笔冲突创建返回 400', r.status === 400, 400, r.status);
    assert('错误码 PURCHASE_CONFLICT', r.body.error === 'PURCHASE_CONFLICT', 'PURCHASE_CONFLICT', r.body.error);
    assert('conflicts 数组非空', Array.isArray(r.body.conflicts) && r.body.conflicts.length > 0, '非空数组', r.body.conflicts);
    if (Array.isArray(r.body.conflicts) && r.body.conflicts.length > 0) {
      assert('冲突商品是 p_water', r.body.conflicts[0].product === 'p_water', 'p_water', r.body.conflicts[0].product);
      assert('conflicts 包含 message 说明', typeof r.body.conflicts[0].message === 'string' && r.body.conflicts[0].message.length > 0, true, r.body.conflicts[0].message);
    }

    const prsAfter = (await request('GET', '/api/purchase-requests?operator=u_warehouse')).body.length;
    assert('冲突申请未写入数据库', prsAfter === prsBefore, prsBefore, prsAfter);
  });

  await step('8. 采购操作日志 - 追加式查询', async () => {
    const allHist = await request('GET', '/api/purchase-history');
    assert('日志总数 >= 5', allHist.body.length >= 5, '>=5', allHist.body.length);
    console.log('     日志总数: ' + allHist.body.length + ' 条');

    const createdHist = await request('GET', '/api/purchase-history?action=created');
    assert('created 操作可查询（至少3次创建）', createdHist.body.length >= 3, '>=3', createdHist.body.length);

    const rejectedHist = await request('GET', '/api/purchase-history?action=rejected');
    assert('rejected 操作可查询', rejectedHist.body.length >= 1, '>=1', rejectedHist.body.length);

    const managerHist = await request('GET', '/api/purchase-history?operator=u_manager');
    assert('区域经理操作历史可查询（驳回+审批）', managerHist.body.length >= 2, '>=2', managerHist.body.length);

    const byStore = await request('GET', '/api/purchase-history?store=store_b');
    assert('按门店筛选日志返回门店B的记录（至少5条）', byStore.body.length >= 5, '>=5', byStore.body.length);

    const safetyUpdateHist = await request('GET', '/api/purchase-history?action=safety_stock_updated');
    assert('safety_stock_updated 操作可查询（配置变更日志）', safetyUpdateHist.body.length >= 1, '>=1', safetyUpdateHist.body.length);
  });

  await step('9. 保存数据快照用于重启后验证', async () => {
    const safety = await request('GET', '/api/safety-stock?operator=u_warehouse');
    const snaps = await request('GET', '/api/replenishment/snapshots?operator=u_warehouse');
    const prs = await request('GET', '/api/purchase-requests?operator=u_warehouse');
    const hist = await request('GET', '/api/purchase-history?operator=u_warehouse');

    const snapshot = {
      safetyStock: safety.body,
      snapshots: snaps.body,
      purchaseRequests: prs.body,
      purchaseHistory: hist.body
    };
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
    console.log(`     安全库存配置: ${safety.body.length} 条`);
    console.log(`     补货建议快照: ${snaps.body.length} 条`);
    console.log(`     采购申请: ${prs.body.length} 条`);
    console.log(`     采购操作日志: ${hist.body.length} 条`);
    console.log('     ✅ 快照已保存到 data/_replenishment_snapshot.json');
  });

  console.log('\n=== 总结果 ===');
  console.log(`通过: ${pass}/${pass + fail}`);

  if (fail === 0) {
    console.log('\n第一轮验证完成，请重启服务后再次运行本脚本进行持久化校验。');
    console.log('重启后运行： node verify-replenishment.js --check-restart');
  } else {
    process.exit(1);
  }
})();
