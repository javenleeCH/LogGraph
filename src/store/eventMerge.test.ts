import { describe, it, expect } from 'vitest';
import { mergeEventsByTs } from './eventMerge';
import type { LogEvent } from '../types';

function ev(id: number, ts: number): LogEvent {
  return { id, ts, raw: `r${id}`, message: `m${id}` };
}

describe('mergeEventsByTs（实时 tail 增量合并）', () => {
  it('两段皆空 → 空', () => {
    expect(mergeEventsByTs([], [])).toEqual([]);
  });

  it('一段为空 → 另一段内容原样', () => {
    const a = [ev(0, 1), ev(1, 2)];
    expect(mergeEventsByTs(a, [])).toEqual(a);
    expect(mergeEventsByTs([], a)).toEqual(a);
  });

  it('正常追加（a 全早于 b）→ 直接拼接保持升序', () => {
    const a = [ev(0, 100), ev(1, 200)];
    const b = [ev(2, 300), ev(3, 400)];
    const m = mergeEventsByTs(a, b);
    expect(m.map((e) => e.ts)).toEqual([100, 200, 300, 400]);
    expect(m.map((e) => e.id)).toEqual([0, 1, 2, 3]);
  });

  it('交错 → 正确按 ts 合并', () => {
    const a = [ev(0, 10), ev(1, 30), ev(2, 50)];
    const b = [ev(3, 20), ev(4, 40), ev(5, 60)];
    const m = mergeEventsByTs(a, b);
    expect(m.map((e) => e.ts)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(m.map((e) => e.id)).toEqual([0, 3, 1, 4, 2, 5]);
  });

  it('尾部乱序（b 早于 a 的最大 ts，时钟回拨）→ 仍合并为升序', () => {
    const a = [ev(0, 100), ev(1, 200)];
    const b = [ev(2, 150), ev(3, 250)];
    const m = mergeEventsByTs(a, b);
    expect(m.map((e) => e.ts)).toEqual([100, 150, 200, 250]);
    expect(m.map((e) => e.id)).toEqual([0, 2, 1, 3]);
  });

  it('同 ts → 左侧（旧事件）优先，保持稳定', () => {
    const a = [ev(0, 100), ev(1, 100)];
    const b = [ev(2, 100)];
    const m = mergeEventsByTs(a, b);
    expect(m.map((e) => e.id)).toEqual([0, 1, 2]);
  });

  it('不重编 id（id 来自 rawLines 行号，合并时保持原值）', () => {
    const a = [ev(7, 10)];
    const b = [ev(3, 20)];
    const m = mergeEventsByTs(a, b);
    expect(m.map((e) => e.id)).toEqual([7, 3]);
  });
});
