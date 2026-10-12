/**
 * WASM 正则引擎冒烟测试（Node 直接加载，无需浏览器）。
 * 验证与桌面端 Rust regex crate 的行为对齐：
 *   1. 基本匹配 / 大小写不敏感开关
 *   2. 环视断言必须编译失败（桌面同款行为，消除 §1.1 分歧的根）
 *   3. 反向引用必须编译失败
 *   4. `\b` 按 Unicode 词边界解释（与桌面一致）
 *
 * 运行：node scripts/test-wasm-regex.mjs
 */
import { readFileSync } from 'node:fs';
import init, { Regex } from '../src/filters/wasm-filter/pkg/filter_wasm.js';

const bytes = readFileSync(
  new URL('../src/filters/wasm-filter/pkg/filter_wasm_bg.wasm', import.meta.url),
);
await init(bytes);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
};

console.log('[1] 基本匹配');
check('命中（忽略大小写）', new Regex('error|warn', true).isMatch('2026-01-01 ERROR something'));
check('命中（字面小写）', new Regex('error|warn', false).isMatch('2026-01-01 error!'));
check('不命中', !new Regex('error', false).isMatch('all good'));
check('大小写不敏感', new Regex('error', true).isMatch('2026 ERROR here'));
check('默认大小写敏感', !new Regex('error', false).isMatch('2026 ERROR here'));

console.log('[2] 桌面同款拒绝语法（§1.1 核心验证）');
const mustReject = (name, pattern) => {
  try {
    new Regex(pattern, false);
    check(`${name} 编译失败（桌面行为）`, false);
  } catch {
    check(`${name} 编译失败（桌面行为）`, true);
  }
};
mustReject('后顾断言 (?<=a)b', '(?<=a)b');
mustReject('前瞻断言 (?=x)', 'foo(?=bar)');
mustReject('反向引用 (a)\\1', '(a)\\1');

console.log('[3] Unicode 语义（与桌面一致）');
// 中文两侧无 ASCII 词字符，Unicode \b 应命中；JS ASCII \b 则不会 —— 区分点
check('\\b Unicode 词边界（中文）', new Regex('\\b错误\\b', false).isMatch('发生 错误 了'));
check('\\b ASCII 词边界', new Regex('\\berror\\b', false).isMatch('an error occurred'));
check('\\d Unicode 数字', new Regex('\\d+', false).isMatch('值=１２３')); // 全角数字

console.log('[4] find 区间');
const m = new Regex('ERROR', false).find('2026 ERROR here');
check('find 返回区间', m && m.start === 5 && m.end === 10);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
