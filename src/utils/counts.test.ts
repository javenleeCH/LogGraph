import { describe, expect, it } from 'vitest';
import {
  fmtCompact,
  fmtCount,
  isSequenceTruncated,
  trueChainCount,
  trueUncoveredCount,
  makeUncoveredLookup,
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

describe('未覆盖事件二分命中（makeUncoveredLookup）', () => {
  // SoA 按 (ts, id) 升序；同 ts 时按 id 排序是二分正确性的前提
  const soa = {
    ids: [7, 3, 9, 1, 5],
    ts: [100, 200, 200, 300, 300],
  };
  const hit = makeUncoveredLookup({ uncovered: soa });

  it('命中已存在的事件（含首尾）', () => {
    expect(hit({ id: 7, ts: 100 })).toBe(true);
    expect(hit({ id: 5, ts: 300 })).toBe(true);
  });

  it('同 ts 不同 id 不误命中（并列定序）', () => {
    expect(hit({ id: 4, ts: 200 })).toBe(false);
    expect(hit({ id: 3, ts: 200 })).toBe(true);
    expect(hit({ id: 9, ts: 200 })).toBe(true);
  });

  it('ts 落在区间内但无该事件时 miss', () => {
    expect(hit({ id: 8, ts: 250 })).toBe(false);
    expect(hit({ id: 7, ts: 300 })).toBe(false);
  });

  it('空 SoA 恒 miss', () => {
    const miss = makeUncoveredLookup({ uncovered: { ids: [], ts: [] } });
    expect(miss({ id: 1, ts: 1 })).toBe(false);
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
