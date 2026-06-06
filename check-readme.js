const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, 'README.md');

console.log('=== README 轻量回归检查 ===\n');

const s = fs.statSync(README_PATH);
const c = fs.readFileSync(README_PATH, 'utf8');
const lines = c.split('\n');
console.log(`文件大小: ${s.size} 字节, 行数: ${lines.length}\n`);

const caretLines = lines.filter(l => l.trimEnd().endsWith('^'));
const postLines = lines.filter(l => l.includes('curl.exe') && l.includes('-X POST'));
const badPostNoStop = postLines.filter(l => !l.includes('--%'));
const badPostNoEscape = postLines.filter(l => !l.includes('-d "{\\"'));
const badSingleQuoteJson = postLines.filter(l => l.includes("-d '{"));

const checks = [
  ['文件非空', s.size > 0],
  ['无 CMD ^ 续行符（PowerShell 不兼容）', caretLines.length === 0],
  ['包含启动命令 npm start', c.includes('npm start')],
  ['包含 curl.exe 健康检查', c.includes('curl.exe -s http://localhost:3000/api/health')],
  [`所有 ${postLines.length} 个 POST 示例使用 --% 停止 PowerShell 解析`, badPostNoStop.length === 0],
  [`POST 示例使用 \\" 转义双引号`, badPostNoEscape.length === 0],
  [`POST 示例未使用单引号 JSON（PowerShell 会剥掉双引号）`, badSingleQuoteJson.length === 0],
  ['包含复核 curl', c.includes('/review') && c.includes('u_warehouse')],
  ['包含审批 curl', c.includes('/approve') && c.includes('u_manager')],
  ['包含出库 curl', c.includes('/ship')],
  ['包含审计查询 curl', c.includes('/api/audit')],
  ['包含 SELF_REVIEW 错误说明', c.includes('SELF_REVIEW')],
  ['包含 NOT_REVIEWED 错误说明', c.includes('NOT_REVIEWED')],
  ['包含 INSUFFICIENT_AVAILABLE 错误说明', c.includes('INSUFFICIENT_AVAILABLE')],
  ['包含 WITHDRAWN_CANNOT_SHIP 错误说明', c.includes('WITHDRAWN_CANNOT_SHIP')],
  ['包含数据不变验证说明', c.includes('状态仍为') && c.includes('库存')],
  ['包含 check-readme.js 回归说明', c.includes('node check-readme.js')],
  ['包含 smoke-test.js 验收说明', c.includes('node smoke-test.js')],
  ['包含 verify-flow.js 回归脚本说明', c.includes('node verify-flow.js')],
  ['包含 SQLite 持久化验证步骤', c.includes('allocation.db')]
];

let ok = 0, fail = 0;
for (const [name, pass] of checks) {
  if (pass) { console.log('  ✅ ' + name); ok++; }
  else { console.log('  ❌ ' + name); fail++; }
}

if (caretLines.length > 0) {
  console.log(`\n问题详情：发现 ${caretLines.length} 行包含 CMD ^ 续行符：`);
  caretLines.forEach(l => console.log('    ' + l.trim()));
}
if (badPostNoStop.length > 0) {
  console.log(`\n问题详情：${badPostNoStop.length} 个 POST 示例缺少 --%：`);
  badPostNoStop.forEach(l => console.log('    ' + l.trim()));
}
if (badPostNoEscape.length > 0) {
  console.log(`\n问题详情：${badPostNoEscape.length} 个 POST 示例未用 \\" 转义：`);
  badPostNoEscape.forEach(l => console.log('    ' + l.trim()));
}
if (badSingleQuoteJson.length > 0) {
  console.log(`\n问题详情：${badSingleQuoteJson.length} 个 POST 示例使用单引号 JSON（PowerShell 会剥掉双引号）：`);
  badSingleQuoteJson.forEach(l => console.log('    ' + l.trim()));
}

console.log(`\n结果: ${ok}/${checks.length} 通过`);
if (fail > 0) process.exit(1);
