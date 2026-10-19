import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { run_sequences_json } from './wasm-cep/pkg/cep_wasm.js';
import { threadHint } from './threadHint';
import type { SequenceMatchResult, ThreadStats } from '../types';

/**
 * thread 解析质量统计（可观测性）——**跑在 wasm 引擎上**。
 *
 * TS 序列引擎副本（SequenceMatcher.ts）已删除，这些用例直跑
 * `engine/src/cep.rs` 的 wasm 构建（与桌面 native 同一份源）。
 * 加载方式仿 scripts/test-wasm-cep.mjs：Node 读字节后显式 init，
 * 绕开浏览器才有的 fetch 路径。
 */
beforeAll(async () => {
  const bytes = readFileSync(new URL('./wasm-cep/pkg/cep_wasm_bg.wasm', import.meta.url));
  // 对象形式传参（wasm-bindgen ≥0.2.12x 的新签名；直接传字节已弃用告警）
  await init({ module_or_path: bytes });
});

/** 构造最小 SeqEvent（只填 CEP 匹配需要的字段；其余 serde default） */
function ev(id: number, ts: number, thread?: string) {
  return { id, ts, raw: `line-${id}`, message: `msg-${id}`, thread, level: 'INFO', sourceFile: null };
}

/** 用 wasm 引擎跑 A→B(seq, 1000ms) 单组，返回该组结果 */
function run(scope: 'global' | 'thread' | 'key', store: Record<string, ReturnType<typeof ev>[]>) {
  const groups = [
    {
      groupId: 'g',
      filterIds: ['A', 'B'],
      scope,
      maxChains: 2000,
      edges: [{ id: 'e1', fromFilterId: 'A', toFilterId: 'B', kind: 'seq', maxGapMs: 1000 }],
    },
  ];
  const resp = JSON.parse(run_sequences_json(JSON.stringify(groups), JSON.stringify(store)));
  // 引擎恒支持（is_supported 恒 true）；若回退说明契约被破坏，用例应红
  expect(resp.fallback).toBe(false);
  return resp.results.g as SequenceMatchResult;
}

describe('thread 解析质量统计（可观测性，wasm 引擎）', () => {
  it('global 作用域也产出统计——切到按线程之前就该知道有没有 thread', () => {
    const r = run('global', {
      A: [ev(1, 100, 't1'), ev(2, 200, 't1'), ev(3, 300, 't2')],
      B: [ev(4, 400)],
    });
    expect(r.threadStats).toEqual({
      totalEvents: 4,
      withThread: 3,
      distinctThreads: 2, // t1 出现两次只算一个
    });
  });

  it('解析不出 thread 时按线程作用域退化成全局（跨「线程」照样成链）', () => {
    // 这是实测里最常见的情况：Spring Boot / Logback / nginx 等格式
    // 一行 thread 都解析不出，分桶只剩 ∅ —— 行为等同没开分桶
    const r = run('thread', {
      A: [ev(1, 100)],
      B: [ev(2, 150)],
    });
    expect(r.chains).toHaveLength(1);
    expect(r.chains[0].thread).toBeNull();
    expect(r.threadStats).toEqual({ totalEvents: 2, withThread: 0, distinctThreads: 0 });
  });

  it('每个事件一个桶时成链为零——统计给出疑似误抓的指纹', () => {
    // 行首方括号里放 traceId/requestId 的格式会被当成 thread，流被拆碎
    const r = run('thread', {
      A: [ev(1, 100, 'req-1'), ev(2, 200, 'req-2')],
      B: [ev(3, 150, 'req-3'), ev(4, 250, 'req-4')],
    });
    // 每个事件一个桶 ⇒ A→B 永远凑不齐 ⇒ 零链（这就是误抓的代价）
    expect(r.chains).toHaveLength(0);
    expect(r.threadStats).toEqual({ totalEvents: 4, withThread: 4, distinctThreads: 4 });
  });

  it('按线程分桶正常时，链只在同线程内成立', () => {
    const r = run('thread', {
      A: [ev(1, 100, 't1'), ev(2, 200, 't2')],
      B: [ev(3, 150, 't1')],
    });
    expect(r.chains).toHaveLength(1);
    expect(r.chains[0].thread).toBe('t1');
    expect(r.threadStats).toEqual({ totalEvents: 3, withThread: 3, distinctThreads: 2 });
  });
});

function resultWith(stats: ThreadStats | undefined): SequenceMatchResult {
  return {
    groupId: 'g',
    chains: [],
    uncovered: { ids: [], ts: [] },
    edgeStats: [],
    notViolations: [],
    heartbeats: [],
    ...(stats ? { threadStats: stats } : {}),
  } as SequenceMatchResult;
}

describe('thread 提示文案', () => {
  it('无统计或没有参与事件时不给提示', () => {
    expect(threadHint(resultWith(undefined))).toBeNull();
    expect(threadHint(resultWith({ totalEvents: 0, withThread: 0, distinctThreads: 0 }))).toBeNull();
  });

  it('覆盖率为 0 → 告警，并说明此刻等同全局', () => {
    const h = threadHint(resultWith({ totalEvents: 1200, withThread: 0, distinctThreads: 0 }));
    expect(h?.warn).toBe(true);
    expect(h?.text).toContain('无 thread');
    expect(h?.title).toContain('等同于全局');
    // 提示要说清"为什么会这样"，否则用户只会一脸茫然
    expect(h?.title).toContain('位置启发式');
  });

  it('基数比接近 1 → 告警为疑似误抓（比漏解析危险）', () => {
    const h = threadHint(resultWith({ totalEvents: 500, withThread: 480, distinctThreads: 470 }));
    expect(h?.warn).toBe(true);
    expect(h?.text).toContain('线程');
    expect(h?.title).toContain('漏报');
  });

  it('小样本下每条一个线程不算误抓（3 条日志 3 个线程是合理的）', () => {
    const h = threadHint(resultWith({ totalEvents: 3, withThread: 3, distinctThreads: 3 }));
    expect(h?.warn).toBe(false);
  });

  it('正常覆盖 → 非告警，显示覆盖率与线程数', () => {
    const h = threadHint(resultWith({ totalEvents: 1000, withThread: 870, distinctThreads: 12 }));
    expect(h?.warn).toBe(false);
    expect(h?.text).toBe('🧵 87% · 12 线程');
  });
});
