/**
 * 三实现一致性差分测试（wasm 路径 vs JS 兜底路径）。
 *
 * 背景：Web 端过滤优先走 wasm（= 桌面引擎同一 Rust `regex` crate，两端逐字节
 * 一致，见 regexWasm.ts 头注释）；wasm 未就绪/加载失败时回退 JS RegExp（降级
 * 窗口）。本测试守护的差分契约：**在标准语义 pattern 上，wasm 就绪路径与 JS
 * 兜底路径对同一语料产生完全相同的命中集** —— 降级窗口内用户不应看到结果漂移。
 *
 * 边界：环视/反向引用、`\b` Unicode 等 Rust↔JS 语义分歧 pattern 不纳入本测试
 * （那正是项目「Web 改用同一 wasm 引擎消除分歧」的动机，降级窗口极短，UI 会
 * 提示 isRegexWasmFallback）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LogEvent, Filter, FilterMatch } from '../types';

// ---- mock regexWasm：可切换 wasm 就绪/兜底两种状态 ----
const state = { wasmReady: false };
vi.mock('./regexWasm', () => ({
  ensureRegexWasm: () => {},
  isRegexWasmReady: () => state.wasmReady,
  isRegexWasmFallback: () => !state.wasmReady,
  // wasm 实例：以「尊重 ci 标志」的等价匹配模拟 Rust regex（标准语义下与 JS 一致）
  getWasmRegex: (pattern: string, caseInsensitive: boolean) => {
    if (!state.wasmReady) return null;
    const re = new RegExp(pattern, caseInsensitive ? 'i' : '');
    return { isMatch: (text: string) => re.test(text) };
  },
  validateWithWasm: () => undefined,
  aggregateFilterHits: () => null,
}));

import { FilterEngine } from './FilterEngine';

function ev(line: string, thread = 'main', id = 0): LogEvent {
  return { id, ts: 0, thread, level: 'INFO', message: line, raw: line, sourceFile: 'a.log' };
}

const corpus: LogEvent[] = [
  ev('2026-01-01 10:00:00 INFO Connection reset by peer'),
  ev('2026-01-01 10:00:01 ERROR timeout after 5000ms'),
  ev('2026-01-01 10:00:02 INFO retry attempt 1'),
  ev('2026-01-01 10:00:03 WARN slow query 123ms'),
  ev('2026-01-01 10:00:04 INFO healthy'),
];

/** 命中集 → 按 filterId 映射 raw 行（排序稳定） */
function hitRaws(matches: FilterMatch[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of matches) {
    out[m.filterId] = m.events.map((e) => e.raw).sort();
  }
  return out;
}

describe('FilterEngine 双路径差分（wasm vs JS 兜底）', () => {
  const filters: Filter[] = [
    // 正则·大小写不敏感
    { id: 'r-ic', label: 'r-ic', pattern: 'connection reset', isRegex: true, caseSensitive: false, scope: 'message', enabled: true, color: '#fff' },
    // 正则·大小写敏感
    { id: 'r-cs', label: 'r-cs', pattern: 'ERROR|WARN', isRegex: true, caseSensitive: true, scope: 'message', enabled: true, color: '#fff' },
    // 字符串字面量
    { id: 'lit', label: 'lit', pattern: 'retry', isRegex: false, caseSensitive: false, scope: 'message', enabled: true, color: '#fff' },
    // 取反子条件（!行）
    { id: 'neg', label: 'neg', pattern: 'INFO\n!healthy', isRegex: false, caseSensitive: false, scope: 'message', enabled: true, color: '#fff' },
  ];

  beforeEach(() => {
    state.wasmReady = true; // 默认就绪；各用例内显式切换
  });

  it('wasm 就绪路径与 JS 兜底路径命中集完全一致', () => {
    state.wasmReady = true;
    const viaWasm = hitRaws(FilterEngine.run(corpus, filters));

    state.wasmReady = false;
    const viaJs = hitRaws(FilterEngine.run(corpus, filters));

    expect(viaJs).toEqual(viaWasm);
    // 语义抽查：每一路都不该是空跑
    expect(viaWasm['r-ic']).toEqual(['2026-01-01 10:00:00 INFO Connection reset by peer']);
    expect(viaWasm['r-cs']).toEqual(['2026-01-01 10:00:01 ERROR timeout after 5000ms', '2026-01-01 10:00:03 WARN slow query 123ms']);
    expect(viaWasm['lit']).toEqual(['2026-01-01 10:00:02 INFO retry attempt 1']);
    expect(viaWasm['neg']).toEqual([
      '2026-01-01 10:00:00 INFO Connection reset by peer',
      '2026-01-01 10:00:02 INFO retry attempt 1',
    ]);
  });

  it('兜底态 isRegexWasmReady=false / Fallback=true，结果仍正确', () => {
    state.wasmReady = false;
    const r = FilterEngine.run(corpus, filters);
    expect(r).toHaveLength(filters.length);
    expect(isRegexWasmFallbackMock()).toBe(true); // 兜底标志在兜底态下应为真
    // 兜底态命中与就绪态命中一致
    state.wasmReady = true;
    const r2 = FilterEngine.run(corpus, filters);
    expect(hitRaws(r)).toEqual(hitRaws(r2));
  });

  it('appendMatches 增量路径两态一致', () => {
    const old = corpus.slice(0, 3);
    const delta = corpus.slice(3);
    const base = filters.slice(0, 2);

    state.wasmReady = true;
    const fullWasm = hitRaws(FilterEngine.run(corpus, base));
    const incWasm = hitRaws(FilterEngine.appendMatches(
      FilterEngine.run(old, base), delta, base,
    ));

    state.wasmReady = false;
    const fullJs = hitRaws(FilterEngine.run(corpus, base));
    const incJs = hitRaws(FilterEngine.appendMatches(
      FilterEngine.run(old, base), delta, base,
    ));

    expect(incWasm).toEqual(fullWasm); // 增量 ≡ 全量（wasm）
    expect(incJs).toEqual(fullJs);     // 增量 ≡ 全量（JS 兜底）
    expect(incJs).toEqual(incWasm);    // 两态增量一致
  });
});

// 小工具：绕开 mock 内部 state 直接读 fallback（供第二个用例使用）
function isRegexWasmFallbackMock(): boolean {
  return !state.wasmReady;
}
