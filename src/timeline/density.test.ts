import { describe, expect, it } from 'vitest';
import { densityAlpha, fmtRatio } from './density';

describe('densityAlpha（相对常态的对数映射）', () => {
  it('恰好是常态速率时落在中间灰度', () => {
    const mid = densityAlpha(100, 100);
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.56);
  });

  it('倍数越高越亮，单调递增', () => {
    const a = densityAlpha(50, 100);
    const b = densityAlpha(100, 100);
    const c = densityAlpha(400, 100);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('±2 倍频程封顶，不会越过 0..1', () => {
    expect(densityAlpha(10_000, 100)).toBeLessThanOrEqual(0.92);
    expect(densityAlpha(1, 100)).toBeGreaterThanOrEqual(0.08);
    // 超出封顶后不再变化
    expect(densityAlpha(400, 100)).toBeCloseTo(densityAlpha(100_000, 100), 5);
  });

  it('关键回归：均匀分布不再全线饱和', () => {
    // 老实现 cnt/maxCount 在均匀数据下每桶都 ≈ 0.95（实心条）。
    // 新实现里常态桶必须明显低于饱和阈值。
    const buckets = [100, 98, 102, 99, 101];
    for (const c of buckets) {
      expect(densityAlpha(c, 100)).toBeLessThan(0.8);
    }
  });

  it('expected=0 不产生 NaN / Infinity', () => {
    const v = densityAlpha(5, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it('count=0 视为最暗但不为负', () => {
    expect(densityAlpha(0, 100)).toBeGreaterThanOrEqual(0.08);
  });
});

describe('fmtRatio', () => {
  it('小倍率保留一位，大倍率取整', () => {
    expect(fmtRatio(1)).toBe('1.0');
    expect(fmtRatio(3.24)).toBe('3.2');
    expect(fmtRatio(28.6)).toBe('29');
  });
});
