import { describe, it, expect } from 'vitest';
import { FilterEngine } from './FilterEngine';
import { isPureAppend, mergeEventsByTs } from '../store/eventMerge';
import type { Filter, LogEvent } from '../types';

function ev(id: number, ts: number, raw: string): LogEvent {
  return { id, ts, raw, message: raw };
}

/** 非正则字面量过滤器：不依赖 wasm regex，结果与引擎路径无关，便于等价性断言 */
function f(id: string, pattern: string): Filter {
  return {
    id,
    label: id,
    color: '#4ea2ff',
    pattern,
    isRegex: false,
    caseSensitive: false,
    enabled: true,
    scope: 'raw',
  };
}

describe('FilterEngine.appendMatches（tail 增量 vs 全量重算等价性）', () => {
  it('纯追加：增量结果与全量重算逐项一致（顺序 + 命中集）', () => {
    const old = [ev(0, 100, 'ERROR a'), ev(1, 200, 'INFO b'), ev(2, 300, 'ERROR c')];
    const added = [ev(3, 400, 'ERROR d'), ev(4, 500, 'INFO e')];
    expect(isPureAppend(old, added)).toBe(true);

    const filters = [f('f1', 'ERROR'), f('f2', 'INFO')];
    const before = FilterEngine.run(old, filters);
    const incremental = FilterEngine.appendMatches(before, added, filters);
    const full = FilterEngine.run(mergeEventsByTs(old, added), filters);

    expect(incremental.map((m) => m.filterId)).toEqual(full.map((m) => m.filterId));
    expect(incremental.map((m) => m.events.map((e) => e.id))).toEqual(
      full.map((m) => m.events.map((e) => e.id)),
    );
  });

  it('新增段无命中 → 命中集原样保留', () => {
    const old = [ev(0, 100, 'ERROR a')];
    const added = [ev(1, 200, 'TRACE z')];
    const filters = [f('f1', 'ERROR')];
    const before = FilterEngine.run(old, filters);
    const after = FilterEngine.appendMatches(before, added, filters);
    expect(after[0].events.map((e) => e.id)).toEqual([0]);
  });

  it('空 pattern 的过滤器：命中集恒空且不抛错', () => {
    const old = [ev(0, 100, 'ERROR a')];
    const added = [ev(1, 200, 'ERROR b')];
    const filters = [f('f1', 'ERROR'), f('f2', '   ')];
    const before = FilterEngine.run(old, filters);
    const after = FilterEngine.appendMatches(before, added, filters);
    expect(after[1].events).toEqual([]);
    expect(after[0].events.map((e) => e.id)).toEqual([0, 1]);
  });

  it('新增段为空 → 直接复用旧命中集', () => {
    const old = [ev(0, 100, 'ERROR a')];
    const filters = [f('f1', 'ERROR')];
    const before = FilterEngine.run(old, filters);
    const after = FilterEngine.appendMatches(before, [], filters);
    expect(after[0].events).toBe(before[0].events); // 同一引用，零分配
  });

  it('非纯追加（时钟回拨）时判定为 false ⇒ 调用方必须回退全量', () => {
    const old = [ev(0, 300, 'x')];
    const added = [ev(1, 100, 'y')];
    expect(isPureAppend(old, added)).toBe(false);
  });
});
