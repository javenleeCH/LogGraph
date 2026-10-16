import { describe, expect, it } from 'vitest';
import { findHotspots } from './hotspots';

/** 构造 ts 升序的事件流 */
function lane(...tsList: number[]): { ts: number }[] {
  return tsList.map((ts) => ({ ts })).sort((a, b) => a.ts - b.ts);
}

const RANGE = { start: 0, end: 1000 };

describe('findHotspots', () => {
  it('空输入返回空', () => {
    expect(findHotspots(RANGE, [])).toEqual([]);
    expect(findHotspots(RANGE, [[]])).toEqual([]);
    expect(findHotspots({ start: 0, end: 0 }, [lane(1)])).toEqual([]);
  });

  it('均匀分布时热点倍率接近 1（真的没变化，不该报成突发）', () => {
    const evs = lane(...Array.from({ length: 1000 }, (_, i) => i));
    const spots = findHotspots(RANGE, [evs], { slices: 100, window: 10 });
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) {
      expect(s.ratio).toBeGreaterThan(0.5);
      expect(s.ratio).toBeLessThan(2);
    }
  });

  it('定位到真正的突发时段', () => {
    // 0..1000 均匀铺 200 条，另外在 500 附近塞 300 条突发
    const base = Array.from({ length: 200 }, (_, i) => i * 5);
    const burst = Array.from({ length: 300 }, (_, i) => 500 + i * 0.1);
    const spots = findHotspots(RANGE, [lane(...base, ...burst)], {
      slices: 100,
      window: 10,
      limit: 1,
    });
    expect(spots).toHaveLength(1);
    // 突发区间是 [500, 530)，热点（含细化后）必须与之重叠
    expect(spots[0].start).toBeLessThanOrEqual(530);
    expect(spots[0].end).toBeGreaterThanOrEqual(500);
    expect(spots[0].ratio).toBeGreaterThan(1.5);
  });

  it('多热点互不重叠，且按时间升序返回', () => {
    const base = Array.from({ length: 300 }, (_, i) => i * 3);
    const b1 = Array.from({ length: 200 }, (_, i) => 100 + i * 0.1);
    const b2 = Array.from({ length: 200 }, (_, i) => 600 + i * 0.1);
    const b3 = Array.from({ length: 200 }, (_, i) => 900 + i * 0.1);
    const spots = findHotspots(RANGE, [lane(...base, ...b1, ...b2, ...b3)], {
      slices: 120,
      window: 10,
      limit: 3,
    });
    expect(spots.length).toBeGreaterThan(1);
    for (let i = 1; i < spots.length; i++) {
      expect(spots[i].start).toBeGreaterThanOrEqual(spots[i - 1].end);
    }
  });

  it('多 lane 合并统计', () => {
    const a = lane(...Array.from({ length: 50 }, (_, i) => 200 + i));
    const b = lane(...Array.from({ length: 50 }, (_, i) => 200 + i));
    const spots = findHotspots(RANGE, [a, b], {
      slices: 100,
      window: 10,
      limit: 1,
      refine: false,
    });
    // 两条 lane 各有 50 条挤在 200..250，合并后该时段共 100 条
    expect(spots[0].count).toBe(100);
  });

  describe('二次细化', () => {
    const base = Array.from({ length: 200 }, (_, i) => i * 5);
    const burst = Array.from({ length: 300 }, (_, i) => 500 + i * 0.1);
    const lanes = [lane(...base, ...burst)];

    it('细化后窗口明显收窄，且仍与突发区间重叠', () => {
      const coarse = findHotspots(RANGE, lanes, { slices: 100, window: 10, limit: 1, refine: false });
      const fine = findHotspots(RANGE, lanes, { slices: 100, window: 10, limit: 1 });
      const cw = coarse[0].end - coarse[0].start;
      const fw = fine[0].end - fine[0].start;
      expect(fw).toBeLessThan(cw);
      // 突发区间是 [500, 530)，细窗口必须与之重叠
      expect(fine[0].start).toBeLessThanOrEqual(530);
      expect(fine[0].end).toBeGreaterThanOrEqual(500);
      // 细窗口完全落在粗窗口内
      expect(fine[0].start).toBeGreaterThanOrEqual(coarse[0].start);
      expect(fine[0].end).toBeLessThanOrEqual(coarse[0].end);
    });

    it('倍率沿用粗扫值（表达「比全局常态密多少」）', () => {
      const coarse = findHotspots(RANGE, lanes, { slices: 100, window: 10, limit: 1, refine: false });
      const fine = findHotspots(RANGE, lanes, { slices: 100, window: 10, limit: 1 });
      expect(fine[0].ratio).toBeCloseTo(coarse[0].ratio, 6);
    });

    it('细化后仍互不重叠', () => {
      const b1 = Array.from({ length: 200 }, (_, i) => 100 + i * 0.1);
      const b2 = Array.from({ length: 200 }, (_, i) => 600 + i * 0.1);
      const spots = findHotspots(RANGE, [lane(...base, ...b1, ...b2)], {
        slices: 128,
        window: 10,
        limit: 3,
      });
      for (let i = 1; i < spots.length; i++) {
        expect(spots[i].start).toBeGreaterThanOrEqual(spots[i - 1].end);
      }
    });
  });

  it('limit 生效，且不会返回 0 条的时段', () => {
    const evs = lane(...Array.from({ length: 40 }, (_, i) => i * 25));
    const spots = findHotspots(RANGE, [evs], { slices: 100, window: 5, limit: 2 });
    expect(spots.length).toBeLessThanOrEqual(2);
    for (const s of spots) expect(s.count).toBeGreaterThan(0);
  });
});
