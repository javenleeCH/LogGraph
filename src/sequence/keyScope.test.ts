import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { run_sequences_json } from './wasm-cep/pkg/cep_wasm.js';
import type { SequenceMatchResult } from '../types';

/**
 * scope='key'（关联键作用域）——**跑在 wasm 引擎上**。
 *
 * 与桌面 native 同一份 `engine/src/cep.rs`（#[path] 包含编译）。
 * 语义（契约 §3.4）：
 * - 用户正则（须含 1 个捕获组）从事件原文 raw 提取关联键（traceId/requestId…）分桶；
 * - 同键成链、跨键不成链、无键事件落 ∅；
 * - 正则缺省 / 编译失败 / 无捕获组 ⇒ 该组退化为全局（保守，不误分桶）。
 */
beforeAll(async () => {
  const bytes = readFileSync(new URL('./wasm-cep/pkg/cep_wasm_bg.wasm', import.meta.url));
  await init({ module_or_path: bytes });
});

/** 构造最小 SeqEvent（raw 承载关联键） */
function ev(id: number, ts: number, raw: string) {
  return { id, ts, raw, message: raw, thread: null, level: 'INFO', sourceFile: null };
}

function run(
  scope: 'global' | 'thread' | 'key',
  keyPattern: string | undefined,
  store: Record<string, ReturnType<typeof ev>[]>,
): SequenceMatchResult {
  const groups = [
    {
      groupId: 'g',
      filterIds: ['A', 'B'],
      scope,
      ...(keyPattern ? { keyPattern } : {}),
      maxChains: 2000,
      edges: [{ id: 'e1', fromFilterId: 'A', toFilterId: 'B', kind: 'seq', maxGapMs: 1000 }],
    },
  ];
  const resp = JSON.parse(run_sequences_json(JSON.stringify(groups), JSON.stringify(store)));
  expect(resp.fallback).toBe(false);
  return resp.results.g as SequenceMatchResult;
}

describe("scope='key' 关联键分桶（wasm 引擎）", () => {
  it('同键成链、跨键不成链、无键落 ∅', () => {
    const r = run('key', 'traceId=([0-9a-f-]+)', {
      A: [ev(1, 100, 'GET /a traceId=abc-1'), ev(2, 200, 'GET /b traceId=def-2'), ev(3, 300, 'GET /c none')],
      B: [ev(4, 150, 'resp traceId=abc-1'), ev(5, 250, 'resp traceId=zzz-9')],
    });
    expect(r.chains).toHaveLength(1);
    expect(r.chains[0].steps.map((s) => s.event.id)).toEqual([1, 4]);
    // 桶标签 = 关联键（链的 thread 字段承载）
    expect(r.chains[0].thread).toBe('abc-1');
    const unc = r.uncovered.ids;
    expect(unc).toContain(2);
    expect(unc).toContain(3);
    expect(unc).toContain(5);
  });

  it('正则缺省 / 无效 / 无捕获组 ⇒ 退化为全局', () => {
    const store = {
      A: [ev(1, 100, 'traceId=abc-1')],
      B: [ev(2, 150, 'traceId=zzz-9')],
    };
    for (const pattern of [undefined, '([unclosed', 'traceId=[0-9a-f-]+']) {
      const r = run('key', pattern, store);
      expect(r.chains).toHaveLength(1);
      expect(r.chains[0].steps.map((s) => s.event.id)).toEqual([1, 2]);
      expect(r.chains[0].thread).toBeNull();
    }
  });

  it('deny_unknown_fields 契约：keyPattern 是已声明字段（旧 wasm 会整组 fallback）', () => {
    // 若 wasm 二进制未随引擎重建，这里会因未知字段被拒 → fallback=true → 首行断言红
    const r = run('key', 'traceId=(\\w+)', {
      A: [ev(1, 100, 'traceId=t-1')],
      B: [ev(2, 150, 'traceId=t-1')],
    });
    expect(r.chains).toHaveLength(1);
  });

  it('keyStats 随 key 路径回传；退化到全局时字段不出现', () => {
    const store = {
      A: [ev(1, 100, 'traceId=abc-1'), ev(2, 200, 'traceId=def-2'), ev(3, 300, 'none')],
      B: [ev(4, 150, 'traceId=abc-1')],
    };
    const r = run('key', 'traceId=([0-9a-z-]+)', store);
    expect(r.keyStats).toEqual({ totalEvents: 4, withKey: 3, distinctKeys: 2 });
    // 无正则 ⇒ 退化 ⇒ 不出现该字段（与「没走 key 路径」区分）
    const g = run('key', undefined, store);
    expect('keyStats' in g).toBe(false);
    // 非 key 作用域同样不回传
    const t = run('global', 'traceId=([0-9a-z-]+)', store);
    expect('keyStats' in t).toBe(false);
  });
});
