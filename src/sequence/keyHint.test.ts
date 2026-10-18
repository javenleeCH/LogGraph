import { describe, expect, it } from 'vitest';
import { keyHint } from './keyHint';
import type { KeyStats, SequenceMatchResult } from '../types';

/** 最小 SeqResult：只填 keyHint 需要的字段 */
function res(keyStats: KeyStats | undefined): SequenceMatchResult {
  return {
    groupId: 'g',
    chains: [],
    uncoveredEvents: [],
    edgeStats: [],
    notViolations: [],
    heartbeats: [],
    keyStats,
  } as SequenceMatchResult;
}

describe('keyHint（scope=key 关联键提取质量）', () => {
  it('无 keyStats（未走 key 路径）⇒ 无提示', () => {
    expect(keyHint(res(undefined))).toBeNull();
  });

  it('totalEvents=0 ⇒ 无提示', () => {
    expect(keyHint(res({ totalEvents: 0, withKey: 0, distinctKeys: 0 }))).toBeNull();
  });

  it('withKey=0 ⇒ 告警：正则没命中任何事件，已静默按全局匹配', () => {
    const h = keyHint(res({ totalEvents: 50, withKey: 0, distinctKeys: 0 }));
    expect(h?.warn).toBe(true);
    expect(h?.text).toContain('无关联键');
    expect(h?.title).toContain('全局');
  });

  it('distinctKeys/withKey ≈ 1 且样本足够 ⇒ 告警：键太细，桶拆碎全漏', () => {
    const h = keyHint(res({ totalEvents: 100, withKey: 95, distinctKeys: 92 }));
    expect(h?.warn).toBe(true);
    expect(h?.text).toContain('92');
  });

  it('小样本下 distinct≈withKey 不告警（可能是真的每请求几条）', () => {
    const h = keyHint(res({ totalEvents: 6, withKey: 6, distinctKeys: 6 }));
    expect(h?.warn).toBe(false);
    expect(h?.text).toContain('🔑');
  });

  it('健康覆盖 ⇒ 中性提示（带覆盖率与键数）', () => {
    const h = keyHint(res({ totalEvents: 800, withKey: 795, distinctKeys: 412 }));
    expect(h?.warn).toBe(false);
    expect(h?.text).toContain('99%');
    expect(h?.text).toContain('412');
    expect(h?.title).toContain('未命中');
  });
});
