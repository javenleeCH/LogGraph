/**
 * 跨行 filter 聚合的单一事实来源验证。
 *
 * 目标：证明前端 `splitSubConditions` / `aggregateSubHits` 与桌面引擎
 * `engine/src/filter_agg.rs` 语义一致（逐字对齐）。wasm 在 vitest 环境不可达，
 * 故此处走 JS 兜底路径（`aggregateSubHitsJs`），它必须与 wasm（已用
 * `scripts/test-wasm-filter-agg.mjs` 在 Node 直跑验证）算得相同结果。
 *
 * 与 `engine/src/filter_agg.rs` 单元测试、Rust `split_sub_conditions_matches_frontend`
 * 用例保持同一组输入，三端结果必须一致。
 */
import { describe, it, expect } from 'vitest';
import { splitSubConditions } from '../filters/FilterEngine';
import { aggregateSubHits, type DbFilterHits } from './dbStore';

const hits = (lines: number[], ts: number[]): DbFilterHits => ({
  lines: Uint32Array.from(lines),
  ts: Float64Array.from(ts),
});

describe('splitSubConditions（与引擎 filter_agg.rs 一致）', () => {
  it('单行直通', () => {
    expect(splitSubConditions('abc')).toEqual([{ source: 'abc', negate: false }]);
  });
  it('换行 AND', () => {
    expect(splitSubConditions('abc\ndef')).toEqual([
      { source: 'abc', negate: false },
      { source: 'def', negate: false },
    ]);
  });
  it('! 前缀 → 排除', () => {
    expect(splitSubConditions('abc\n!def')).toEqual([
      { source: 'abc', negate: false },
      { source: 'def', negate: true },
    ]);
  });
  it('首尾空白 + 空行跳过', () => {
    expect(splitSubConditions('  abc  \n\n  def\n')).toEqual([
      { source: 'abc', negate: false },
      { source: 'def', negate: false },
    ]);
  });
  it('! 后空白也 trim；纯 ! 行丢弃', () => {
    expect(splitSubConditions('abc\n!   def')).toEqual([
      { source: 'abc', negate: false },
      { source: 'def', negate: true },
    ]);
    expect(splitSubConditions('abc\n!')).toEqual([{ source: 'abc', negate: false }]);
  });
  it('全空白 → 空', () => {
    expect(splitSubConditions('\n  \n')).toEqual([]);
  });
});

describe('aggregateSubHits（正向交集 − 排除并集）', () => {
  it('交集减并集：(1∩2) − {3}', () => {
    const pos = [hits([1, 2, 3], [10, 20, 30]), hits([2, 3], [20, 30])];
    const neg = [hits([3], [30])];
    const out = aggregateSubHits(pos, neg);
    expect(Array.from(out.lines)).toEqual([2]);
    expect(Array.from(out.ts)).toEqual([20]);
  });

  it('仅正向交集，以最短正向为基', () => {
    const a = hits(Array.from({ length: 100 }, (_, i) => i), Array.from({ length: 100 }, (_, i) => i));
    const b = hits([5, 7], [5, 7]);
    const out = aggregateSubHits([a, b], []);
    expect(Array.from(out.lines)).toEqual([5, 7]);
  });

  it('无正向锚 → 空', () => {
    expect(aggregateSubHits([], [hits([1], [10])]).lines.length).toBe(0);
  });

  it('排除集为空时返回正向全集', () => {
    const out = aggregateSubHits([hits([1], [10])], []);
    expect(Array.from(out.lines)).toEqual([1]);
  });
});
