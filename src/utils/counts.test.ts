import { describe, expect, it } from 'vitest';
import {
  fmtCompact,
  fmtCount,
  isSequenceTruncated,
  trueChainCount,
  trueUncoveredCount,
} from './counts';
import type { SequenceMatchResult } from '../types';

/** 构造一个 SequenceMatchResult（只填计数相关字段） */
function result(opts: {
  chains: number;
  uncovered: number;
  totalChains?: number;
  totalUncovered?: number;
}): SequenceMatchResult {
  const mk = (n: number) => Array.from({ length: n }, () => ({} as never));
  return {
    groupId: 'g1',
    chains: mk(opts.chains),
    uncoveredEvents: mk(opts.uncovered),
    edgeStats: [],
    notViolations: [],
    heartbeats: [],
    ...(opts.totalChains !== undefined ? { totalChains: opts.totalChains } : {}),
    ...(opts.totalUncovered !== undefined ? { totalUncovered: opts.totalUncovered } : {}),
  } as SequenceMatchResult;
}

describe('计数真值（引擎截断语义）', () => {
  it('未截断时退回数组长度', () => {
    const r = result({ chains: 10, uncovered: 3 });
    expect(trueChainCount(r)).toBe(10);
    expect(trueUncoveredCount(r)).toBe(3);
    expect(isSequenceTruncated(r)).toBe(false);
  });

  it('截断时取 total*，而不是被引擎上限卡住的 length', () => {
    // 历史 bug 现场：画布头部读了 length 显示「2000 异常」，真值是 335780
    const r = result({
      chains: 1615,
      uncovered: 2000,
      totalChains: 1615,
      totalUncovered: 335780,
    });
    expect(trueChainCount(r)).toBe(1615);
    expect(trueUncoveredCount(r)).toBe(335780);
    expect(isSequenceTruncated(r)).toBe(true);
  });

  it('undefined 结果一律按 0 处理，不抛错', () => {
    expect(trueChainCount(undefined)).toBe(0);
    expect(trueUncoveredCount(undefined)).toBe(0);
    expect(isSequenceTruncated(undefined)).toBe(false);
  });
});

describe('显示格式', () => {
  it('紧凑计数：万以下原样，万以上按万', () => {
    expect(fmtCompact(0)).toBe('0');
    expect(fmtCompact(1200)).toBe('1200');
    expect(fmtCompact(26_8569)).toBe('26.9万');
    expect(fmtCompact(335_780)).toBe('33.6万');
    expect(fmtCompact(1_2000_0000)).toBe('1.2亿');
  });

  it('整数恰好是万时不带 .0', () => {
    expect(fmtCompact(10_000)).toBe('1万');
  });

  it('完整计数带千分位', () => {
    expect(fmtCount(335780)).toBe('335,780');
  });
});
