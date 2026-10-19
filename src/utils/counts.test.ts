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
}): SequenceMatchResult {
  const mkChains = Array.from({ length: opts.chains }, () => ({} as never));
  const ids = Array.from({ length: opts.uncovered }, (_, i) => i);
  const ts = Array.from({ length: opts.uncovered }, () => 0);
  return {
    groupId: 'g1',
    chains: mkChains,
    uncovered: { ids, ts },
    edgeStats: [],
    notViolations: [],
    heartbeats: [],
    ...(opts.totalChains !== undefined ? { totalChains: opts.totalChains } : {}),
  } as SequenceMatchResult;
}

describe('计数真值（链护栏截断语义）', () => {
  it('未截断时退回数组长度', () => {
    const r = result({ chains: 10, uncovered: 3 });
    expect(trueChainCount(r)).toBe(10);
    expect(trueUncoveredCount(r)).toBe(3);
    expect(isSequenceTruncated(r)).toBe(false);
  });

  it('链截断时取 totalChains；uncovered 为 SoA 全量、恒为真值', () => {
    // 历史 bug 现场：画布头部读了 length 显示「2000 异常」，真值是 335780。
    // SoA 回传后异常不再有截断语义——ids.length 即全量
    const r = result({ chains: 1615, uncovered: 335_780, totalChains: 1615 });
    expect(trueChainCount(r)).toBe(1615);
    expect(trueUncoveredCount(r)).toBe(335_780);
    expect(isSequenceTruncated(r)).toBe(false);
  });

  it('链超护栏（totalChains > chains.length）才判截断', () => {
    const r = result({ chains: 100_000, uncovered: 5, totalChains: 250_000 });
    expect(isSequenceTruncated(r)).toBe(true);
    expect(trueChainCount(r)).toBe(250_000);
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
