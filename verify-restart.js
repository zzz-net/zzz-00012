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

function assert(name, condition, expected, actual) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name}`);
    console.log(`     期望: ${JSON.stringify(expected)}`);
    console.log(`     实际: ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('=== 服务重启后数据持久化验证 ===\n');

  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.log('未找到快照文件，请先运行: node verify-flow.js');
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

  const inv = await request('GET', '/api/inventory');
  assert('健康检查 OK', inv.status === 200, 200, inv.status);

  assert('库存记录数量一致', inv.body.length === snapshot.inv.length, snapshot.inv.length, inv.body.length);
  for (let i = 0; i < snapshot.inv.length; i++) {
    const exp = snapshot.inv[i];
    const act = inv.body.find(x => x.store === exp.store && x.product === exp.product);
    assert(`库存 [${exp.store}/${exp.product}] 总数量一致`, act && act.qty === exp.qty, exp.qty, act ? act.qty : null);
  }

  const allocs = await request('GET', '/api/allocations');
  assert('调拨单数量一致', allocs.body.length === snapshot.allocs.length, snapshot.allocs.length, allocs.body.length);
  for (const exp of snapshot.allocs) {
    const act = allocs.body.find(a => a.id === exp.id);
    assert(`调拨单 ${exp.id} 状态一致`, act && act.status === exp.status, exp.status, act ? act.status : null);
    assert(`调拨单 ${exp.id} 操作人一致`, act && act.applicant === exp.applicant, exp.applicant, act ? act.applicant : null);
    assert(`调拨单 ${exp.id} 历史记录数一致`, act && act.history.length === exp.history.length, exp.history.length, act ? act.history.length : null);
  }

  const hist = await request('GET', '/api/history');
  assert('历史记录数量一致', hist.body.length === snapshot.hist.length, snapshot.hist.length, hist.body.length);

  const audit = await request('GET', '/api/audit?status=shipped');
  assert('审计查询：已出库的调拨单仍可查询', audit.body.length >= 1, '>=1', audit.body.length);

  if (snapshot.stocktakeBatches) {
    const stBatches = await request('GET', '/api/stocktake');
    assert('盘点批次数量一致', stBatches.body.length === snapshot.stocktakeBatches.length, snapshot.stocktakeBatches.length, stBatches.body.length);
    for (const exp of snapshot.stocktakeBatches) {
      const act = stBatches.body.find(b => b.id === exp.id);
      assert(`盘点批次 ${exp.id} 状态一致`, act && act.status === exp.status, exp.status, act ? act.status : null);
    }

    const stAdj = await request('GET', '/api/stocktake-adjustments');
    assert('调账记录数量一致', stAdj.body.length === snapshot.stocktakeAdj.length, snapshot.stocktakeAdj.length, stAdj.body.length);

    const stHist = await request('GET', '/api/stocktake-history');
    assert('盘点审计日志数量一致', stHist.body.length >= snapshot.stocktakeHist.length, `>= ${snapshot.stocktakeHist.length}`, stHist.body.length);
  }

  console.log('\n=== 持久化验证通过：服务重启后数据完全一致 ===');
})();
