const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, 'README.md');

console.log('=== README 轻量回归检查 ===\n');

const s = fs.statSync(README_PATH);
const c = fs.readFileSync(README_PATH, 'utf8');
console.log(`文件大小: ${s.size} 字节, 字符数: ${c.length}\n`);

const checks = [
  ['文件非空', s.size > 0],
  ['包含启动命令 npm start', c.includes('npm start')],
  ['包含 curl.exe 健康检查', c.includes('curl.exe -s http://localhost:3000/api/health')],
  ['包含提交申请 curl', c.includes('/api/allocations') && c.includes('sourceStore')],
  ['包含复核 curl', c.includes('/review') && c.includes('u_warehouse')],
  ['包含审批 curl', c.includes('/approve') && c.includes('u_manager')],
  ['包含出库 curl', c.includes('/ship')],
  ['包含审计查询 curl', c.includes('/api/audit')],
  ['包含 SELF_REVIEW 错误说明', c.includes('SELF_REVIEW')],
  ['包含 NOT_REVIEWED 错误说明', c.includes('NOT_REVIEWED')],
  ['包含 INSUFFICIENT_AVAILABLE 错误说明', c.includes('INSUFFICIENT_AVAILABLE')],
  ['包含 WITHDRAWN_CANNOT_SHIP 错误说明', c.includes('WITHDRAWN_CANNOT_SHIP')],
  ['包含数据不变验证说明', c.includes('状态仍为') && c.includes('库存')],
  ['包含 verify-flow.js 回归脚本说明', c.includes('node verify-flow.js')],
  ['包含 SQLite 持久化验证步骤', c.includes('allocation.db')]
];

let ok = 0, fail = 0;
for (const [name, pass] of checks) {
  if (pass) { console.log('  ✅ ' + name); ok++; }
  else { console.log('  ❌ ' + name); fail++; }
}

console.log(`\n结果: ${ok}/${checks.length} 通过`);
if (fail > 0) process.exit(1);
