/**
 * WASM CEP 引擎冒烟测试（Node 直接加载，无需浏览器）。
 * 验证 Web 端 wasm 构建与桌面 native 引擎跑的是同一份 engine/src/cep.rs：
 *   1. seq 边在窗口内成链、未覆盖事件正确
 *   2. not 边在窗口内出现禁止目标 → 违规
 *   3. scope=thread 按桶隔离（不同 thread 不成链）
 *   4. nodeConditions 二次过滤生效
 *
 * 运行：node scripts/test-wasm-cep.mjs
 */
import { readFileSync } from 'node:fs';
import init, { run_sequences_json } from '../src/sequence/wasm-cep/pkg/cep_wasm.js';

const bytes = readFileSync(
  new URL('../src/sequence/wasm-cep/pkg/cep_wasm_bg.wasm', import.meta.url),
);
await init({ module_or_path: bytes });

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

const run = (groups, store) =>
  JSON.parse(run_sequences_json(JSON.stringify(groups), JSON.stringify(store)));

const ev = (id, ts, thread, msg) => ({ id, ts, raw: msg, message: msg, thread, level: 'INFO', sourceFile: null });

console.log('[1] seq 边窗口内成链');
{
  const groups = [
    {
      groupId: 'g1', filterIds: ['A', 'B'], scope: 'global', maxChains: 2000,
      edges: [{ id: 'e1', fromFilterId: 'A', toFilterId: 'B', kind: 'seq', maxGapMs: 1000 }],
    },
  ];
  const store = { A: [ev(1, 100, null, 'A')], B: [ev(2, 150, null, 'B')] };
  const r = run(groups, store);
  check('未回退', r.fallback === false);
  const res = r.results.g1;
  // 陈旧产物守卫：旧版 wasm 无 SoA 形状（uncovered.ids），直接崩 TypeError 不可读
  if (!res?.uncovered?.ids) {
    console.error(
      '\n✗ wasm 产物为旧版结果形状（无 uncovered.ids SoA 字段）。\n' +
        '  src/sequence/wasm-cep/pkg 下的二进制落后于 engine/src/cep.rs —— 请先运行：\n' +
        '  npm run build:wasm:cep\n' +
        '  重建成功后再重跑本脚本。（若构建报 rustc/cargo 错误，请把错误贴回来）',
    );
    process.exit(1);
  }
  check('成 1 条链', res && res.chains.length === 1);
  check('链含 2 步', res && res.chains[0].steps.length === 2);
  check('未覆盖事件为 0', res.uncovered.ids.length === 0);
  check('threadStats 已产出', res && res.threadStats && res.threadStats.totalEvents === 2);
}

console.log('[2] not 边违规检测');
{
  const groups = [
    {
      groupId: 'g2', filterIds: ['A', 'B'], scope: 'global', maxChains: 2000,
      edges: [{ id: 'eN', fromFilterId: 'A', toFilterId: 'B', kind: 'not', maxGapMs: 1000 }],
    },
  ];
  const store = { A: [ev(1, 100, null, 'A')], B: [ev(2, 120, null, 'B')] };
  const r = run(groups, store);
  const res = r.results.g2;
  check('检出 1 处违规', res && res.notViolations.length === 1);
}

console.log('[3] scope=thread 按桶隔离');
{
  const groups = [
    {
      groupId: 'g3', filterIds: ['A', 'B'], scope: 'thread', maxChains: 2000,
      edges: [{ id: 'e1', fromFilterId: 'A', toFilterId: 'B', kind: 'seq', maxGapMs: 1000 }],
    },
  ];
  // t1 桶内 A(100)->B(150) 成链；t2 的 A(200) 无配对 B → 不成链
  const store = { A: [ev(1, 100, 't1', 'A'), ev(2, 200, 't2', 'A')], B: [ev(3, 150, 't1', 'B')] };
  const r = run(groups, store);
  const res = r.results.g3;
  check('仅 t1 桶成 1 条链', res && res.chains.length === 1);
  check('链归属 t1', res && res.chains[0].thread === 't1');
}

console.log('[4] nodeConditions 二次过滤');
{
  const groups = [
    {
      groupId: 'g4', filterIds: ['A', 'B'], scope: 'global', maxChains: 2000,
      nodeConditions: { B: "level == 'E'" },
      edges: [{ id: 'e1', fromFilterId: 'A', toFilterId: 'B', kind: 'seq', maxGapMs: 1000 }],
    },
  ];
  // B 有两条：level=E(参与) 与 level=W(被过滤)
  const store = {
    A: [ev(1, 100, null, 'A')],
    B: [ev(2, 150, null, 'B'), ev(3, 160, null, 'B2')],
  };
  store.B[0].level = 'E';
  store.B[1].level = 'W';
  const r = run(groups, store);
  const res = r.results.g4;
  check('仅 level=E 的 B 参与成链', res && res.chains.length === 1);
  check('level=W 的 B 计入未覆盖', res && res.uncovered.ids.includes(3));
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
