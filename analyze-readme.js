const fs = require('fs');
const c = fs.readFileSync('README.md', 'utf8');
const lines = c.split('\n');

console.log('=== 查找续行符 ===');
let foundAny = false;
lines.forEach((line, i) => {
  const trimmed = line.trimEnd();
  if (trimmed.endsWith('^')) {
    console.log(`  Line ${i+1} CMD 续行符 ^: [${trimmed}]`);
    foundAny = true;
  }
  if (trimmed.endsWith('\\')) {
    console.log(`  Line ${i+1} Bash 续行符 \\: [${trimmed}]`);
    foundAny = true;
  }
});
if (!foundAny) console.log('  (未发现续行符)');

console.log('\n=== curl.exe 代码块内容 ===');
let inBlock = false, blockStart = 0;
lines.forEach((line, i) => {
  if (line.startsWith('```')) {
    if (!inBlock) { inBlock = true; blockStart = i+1; }
    else inBlock = false;
    return;
  }
  if (inBlock && line.includes('curl.exe')) {
    console.log(`\n  代码块(从 ${blockStart} 行起):`);
    for (let j = i; j < Math.min(i+6, lines.length); j++) {
      if (lines[j].startsWith('```')) break;
      console.log(`    Line ${j+1}: [${lines[j]}]`);
    }
  }
});

console.log('\n=== 尝试在 PowerShell 中复制粘贴一个示例的结果 ===');
console.log('PowerShell 中 ^ 不是续行符（是转义符），\\ 也不是续行符（\` 才是）');
console.log('引号也可能有问题：PowerShell 中 "..." 会展开转义，但 curl.exe 需要字面量 JSON');
