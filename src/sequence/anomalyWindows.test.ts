import { describe, expect, it } from 'vitest';
import {
  aggregateAnomalyWindows,
  formatAnomalySummary,
  windowAt,
  DEFAULT_ANOMALY_GAP_MS,
} from './anomalyWindows';


describe('aggregateAnomalyWindows', () => {
  it('空输入 → 无段', () => {
    const s = aggregateAnomalyWindows([]);
    expect(s.total).toBe(0);
    expect(s.windows).toHaveLength(0);
    expect(formatAnomalySummary(s)).toBe('无异常');
  });

  it('间隔 <= gapMs 的连续异常合并为一段', () => {
    // 0,100,200 间隔 100ms < 1000ms → 同段
    const s = aggregateAnomalyWindows([0, 100, 200]);
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]).toMatchObject({ startTs: 0, endTs: 200, count: 3 });
    expect(s.total).toBe(3);
  });

  it('间隔 > gapMs 断开成多段', () => {
    // 0,100 | 5000 | 9000 → 3 段
    const s = aggregateAnomalyWindows([0, 100, 5000, 9000]);
    expect(s.windows.map((w) => w.count)).toEqual([2, 1, 1]);
    expect(s.windows[0]).toMatchObject({ startTs: 0, endTs: 100 });
    expect(s.windows[1]).toMatchObject({ startTs: 5000, endTs: 5000 });
  });

  it('恰好等于 gapMs 仍算同一段（闭区间，避免边界抖动）', () => {
    const s = aggregateAnomalyWindows([0, DEFAULT_ANOMALY_GAP_MS]);
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].count).toBe(2);
  });

  it('分级：1 条零散 / 10 条成簇 / 50 条密集', () => {
    const one = aggregateAnomalyWindows([0]);
    expect(one.windows[0].level).toBe('low');
    const ten = aggregateAnomalyWindows(Array.from({ length: 10 }, (_, i) => i));
    expect(ten.windows[0].level).toBe('med');
    const fifty = aggregateAnomalyWindows(Array.from({ length: 50 }, (_, i) => i));
    expect(fifty.windows[0].level).toBe('high');
  });

  it('counts 统计各级别段数', () => {
    // 段1: 60 条(high)  段2: 15 条(med)  段3: 1 条(low)
    const tsList: number[] = [];
    for (let i = 0; i < 60; i++) tsList.push(i);
    for (let i = 0; i < 15; i++) tsList.push(10_000 + i);
    tsList.push(20_000);
    const s = aggregateAnomalyWindows(tsList);
    expect(s.windows).toHaveLength(3);
    expect(s.counts).toEqual({ low: 1, med: 1, high: 1 });
    expect(s.total).toBe(76);
  });

  it('聚合的核心价值：密集爆发从 N 条压成 1 段', () => {
    // 5 秒内 500 条 → 1 段，而不是 500 条噪音
    const tsList = Array.from({ length: 500 }, (_, i) => i * 10);
    const s = aggregateAnomalyWindows(tsList);
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0].count).toBe(500);
    expect(s.windows[0].level).toBe('high');
    expect(formatAnomalySummary(s)).toContain('1 段异常窗口');
    expect(formatAnomalySummary(s)).toContain('1 段密集');
  });

  it('windowAt 定位 ts 所属窗口', () => {
    const s = aggregateAnomalyWindows([0, 100, 5000]);
    expect(s.windows).toHaveLength(2);
    expect(windowAt(s.windows, 0)?.count).toBe(2);
    expect(windowAt(s.windows, 100)?.count).toBe(2);
    expect(windowAt(s.windows, 5000)?.count).toBe(1);
    // 落在段与段之间的空隙 → null
    expect(windowAt(s.windows, 2000)).toBeNull();
  });

  it('windowAt 在空窗口列表上返回 null（不炸）', () => {
    expect(windowAt([], 123)).toBeNull();
  });

  it('gapMs 可配：放大后段数减少', () => {
    const tsList = [0, 500, 1000, 1500];
    const narrow = aggregateAnomalyWindows(tsList, 100);
    expect(narrow.windows).toHaveLength(4);
    const wide = aggregateAnomalyWindows(tsList, 2000);
    expect(wide.windows).toHaveLength(1);
  });
});
