const http = require('http');

const BASE = 'http://localhost:3000';

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

(async () => {
  console.log('=== 主流程：提交→复核→审批→出库→审计 ===\n');

  console.log('[1/5] 健康检查');
  let r = await request('GET', '/api/health');
  assert('返回 200', r.status === 200, 200, r.status);
  assert('status=ok', r.body.status === 'ok', 'ok', r.body.status);

  console.log('\n[2/5] 门店B提交调拨申请（雨伞 15）');
  r = await request('POST', '/api/allocations', {
    sourceStore: 'store_a',
    targetStore: 'store_b',
    product: 'p_umbrella',
    qty: 15,
    reason: '暴雨雨伞告急',
    operator: 'u_store_b'
  });
  assert('返回 201', r.status === 201, 201, r.status);
  assert('状态 pending', r.body.status === 'pending', 'pending', r.body.status);
  const allocId = r.body.id;
  console.log('     调拨单ID: ' + allocId);

  const invBefore = await request('GET', '/api/inventory');
  const srcBefore = invBefore.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
  const tgtBefore = invBefore.body.find(i => i.store === 'store_b' && i.product === 'p_umbrella');

  console.log('\n[3/5] 库管复核');
  r = await request('POST', `/api/allocations/${allocId}/review`, { operator: 'u_warehouse' });
  assert('返回 200', r.status === 200, 200, r.status);
  assert('状态 reviewed', r.body.status === 'reviewed', 'reviewed', r.body.status);

  console.log('\n[4/5] 区域经理审批（锁定库存）');
  r = await request('POST', `/api/allocations/${allocId}/approve`, { operator: 'u_manager' });
  assert('返回 200', r.status === 200, 200, r.status);
  assert('状态 approved', r.body.status === 'approved', 'approved', r.body.status);

  const invMid = await request('GET', '/api/inventory');
  const srcMid = invMid.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
  assert('总库存不变（仅锁定）', srcMid.qty === srcBefore.qty, srcBefore.qty, srcMid.qty);
  assert('可用库存 -15', srcMid.availableQty === srcBefore.qty - 15, srcBefore.qty - 15, srcMid.availableQty);

  console.log('\n[5/5] 出库确认');
  r = await request('POST', `/api/allocations/${allocId}/ship`, { operator: 'u_warehouse' });
  assert('返回 200', r.status === 200, 200, r.status);
  assert('状态 shipped', r.body.status === 'shipped', 'shipped', r.body.status);

  const invAfter = await request('GET', '/api/inventory');
  const srcAfter = invAfter.body.find(i => i.store === 'store_a' && i.product === 'p_umbrella');
  const tgtAfter = invAfter.body.find(i => i.store === 'store_b' && i.product === 'p_umbrella');
  assert('门店A总库存 -15', srcAfter.qty === srcBefore.qty - 15, srcBefore.qty - 15, srcAfter.qty);
  assert('门店B总库存 +15', tgtAfter.qty === tgtBefore.qty + 15, tgtBefore.qty + 15, tgtAfter.qty);

  console.log('\n[审计查询]');
  r = await request('GET', '/api/audit?status=shipped');
  assert('按已出库筛选有结果', r.body.length >= 1, '>=1', r.body.length);
  r = await request('GET', '/api/audit?sourceStore=store_a&product=p_umbrella');
  assert('按门店+商品筛选有结果', r.body.length >= 1, '>=1', r.body.length);

  console.log('\n=== 错误场景：申请人自审 ===\n');

  r = await request('POST', '/api/allocations', {
    sourceStore: 'store_c',
    targetStore: 'store_b',
    product: 'p_water',
    qty: 5,
    reason: '测试自审',
    operator: 'u_store_b'
  });
  const selfId = r.body.id;
  console.log('     新建调拨单: ' + selfId);

  const stateBefore = (await request('GET', `/api/allocations/${selfId}`)).body.status;
  const histLenBefore = (await request('GET', '/api/history')).body.length;

  r = await request('POST', `/api/allocations/${selfId}/review`, { operator: 'u_store_b' });
  assert('返回 400', r.status === 400, 400, r.status);
  assert('错误码 SELF_REVIEW', r.body.error === 'SELF_REVIEW', 'SELF_REVIEW', r.body.error);
  assert('含中文提示', typeof r.body.message === 'string' && r.body.message.length > 0, '非空字符串', r.body.message);

  const stateAfter = (await request('GET', `/api/allocations/${selfId}`)).body.status;
  const histLenAfter = (await request('GET', '/api/history')).body.length;

  assert('调拨单状态不变', stateAfter === stateBefore, stateBefore, stateAfter);
  assert('未追加历史记录', histLenAfter === histLenBefore, histLenBefore, histLenAfter);

  console.log('\n=== 总结果 ===');
  console.log(`通过: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
})();
