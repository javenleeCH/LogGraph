// 在 Node 里直跑 filter-wasm 的 aggregateFilterHits，验证 Web 端聚合与桌面引擎
// （engine/src/filter_agg.rs::aggregate_sub_hits）逐字节一致。
// 用法：node scripts/test-wasm-filter-agg.mjs
import { readFileSync } from 'node:fs';

const m = await import('../src/filters/wasm-filter/pkg/filter_wasm.js');
const bytes = readFileSync(
  new URL('../src/filters/wasm-filter/pkg/filter_wasm_bg.wasm', import.meta.url),
);
await m.default(bytes);
const agg = m.aggregateFilterHits;

let pass = 0;
let fail = 0;
function check(name, gotJson, expectArr) {
  const got = JSON.parse(gotJson);
  const ok = JSON.stringify(got) === JSON.stringify(expectArr);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}\n      got=${gotJson}\n      exp=${JSON.stringify(expectArr)}`);
  }
}
const j = (sets) => JSON.stringify(sets);

// 1. 正向交集 − 排除并集：(1∩2) − {3}
check(
  '交集减并集',
  agg(
    j([
      [{ line: 1, ts: 10 }, { line: 2, ts: 20 }, { line: 3, ts: 30 }],
      [{ line: 2, ts: 20 }, { line: 3, ts: 30 }],
    ]),
    j([[{ line: 3, ts: 30 }]]),
  ),
  [{ line: 2, ts: 20 }],
);

// 2. 仅正向交集（最短基选取）：a(100 行) ∩ b(2 行) → b
check(
  '最短正向为基',
  agg(
    j([
      Array.from({ length: 100 }, (_, i) => ({ line: i, ts: i })),
      [{ line: 5, ts: 5 }, { line: 7, ts: 7 }],
    ]),
    j([]),
  ),
  [{ line: 5, ts: 5 }, { line: 7, ts: 7 }],
);

// 3. 无正向锚 → 空
check('无正向锚为空', agg(j([]), j([[{ line: 1, ts: 10 }]])), []);
check('排除集为空', agg(j([[{ line: 1, ts: 10 }]]), j([])), [{ line: 1, ts: 10 }]);

console.log(`\nfilter-wasm 聚合验证：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
