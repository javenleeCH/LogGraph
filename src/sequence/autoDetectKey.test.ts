import { describe, it, expect } from 'vitest';
import type { LogEvent } from '../types';
import {
  detectCorrelationKey,
  pickAutoKey,
  CONFIDENT_THRESHOLD,
  MIN_COVERAGE,
} from './autoDetectKey';

/** 从 raw 原文构造事件（ts 用序号占位） */
function ev(raw: string, id = 0): LogEvent {
  return { id, ts: id, raw, message: raw, thread: undefined };
}

const traceLines = [
  '2024-01-15 10:00:00.000 [nio-1] INFO  GET /api/orders traceId=4bf92f35 duration=42ms',
  '2024-01-15 10:00:00.050 [nio-1] ERROR response sent traceId=4bf92f35 status=502',
  '2024-01-15 10:00:00.400 [nio-3] ERROR response sent traceId=f00dcafe status=500',
  '2024-01-15 10:00:05.000 [nio-2] INFO  GET /api/orders traceId=a1b2c3d4 duration=610ms',
  '2024-01-15 10:00:10.000 [nio-1] INFO  GET /api/orders traceId=e5f6a7b8 duration=15ms',
  '2024-01-15 10:00:10.400 [nio-1] ERROR response sent traceId=e5f6a7b8 status=401',
];

describe('detectCorrelationKey', () => {
  it('识别 traceId=<hex> 为高置信候选，并生成含 1 捕获组的 keyPattern', () => {
    const res = detectCorrelationKey(traceLines.map((r, i) => ev(r, i)));
    const top = res[0];
    expect(top).toBeDefined();
    expect(top!.fieldName).toBe('traceId');
    expect(top!.coverage).toBe(1); // 全部命中
    expect(top!.distinctKeys).toBeGreaterThanOrEqual(3);
    expect(top!.confidence).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD);
    // keyPattern 恰好 1 个捕获组，且能回抽到 traceId 值
    expect(top!.keyPattern).toBe('traceId=([^\\s,"\']+)');
    const m = /traceId=([^\s,"']+)/.exec(traceLines[0]);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('4bf92f35');
  });

  it('识别 UUID 形态的 requestId', () => {
    const lines = [
      'req requestId=550e8400-e29b-41d4-a716-446655440000 status=200',
      'req requestId=6ba7b810-9dad-11d1-80b4-00c04fd430c8 status=500',
      'req requestId=6ba7b811-9dad-11d1-80b4-00c04fd430c9 status=200',
    ];
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    expect(res[0].fieldName).toBe('requestId');
    expect(res[0].confidence).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD);
  });

  it('识别 X-Request-Id 头形态（冒号分隔）', () => {
    const lines = [
      'X-Request-Id: 7f3c9a1b2d4e5f6a7b8c9d0e1f2a3b4c level=INFO',
      'X-Request-Id: 7f3c9a1b2d4e5f6a7b8c9d0e1f2a3b4d level=ERROR',
      'X-Request-Id: 7f3c9a1b2d4e5f6a7b8c9d0e1f2a3b4e level=INFO',
    ];
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    expect(res[0].fieldName).toBe('X-Request-Id');
  });

  it('多字段时按置信度排序，覆盖率高的排前面', () => {
    // traceId 全覆盖，requestId 只覆盖 1/3
    const lines = [
      'a traceId=aaaaaaaa requestId=11111111',
      'b traceId=bbbbbbbb requestId=22222222',
      'c traceId=cccccccc',
    ];
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    expect(res[0].fieldName).toBe('traceId'); // 覆盖率 1 > 2/3
  });

  it('所有事件同一个键（常量）⇒ 不可信（键基数=1）', () => {
    const lines = [
      'a traceId=deadbeef',
      'b traceId=deadbeef',
      'c traceId=deadbeef',
    ];
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    // 常量：distinct=1 ⇒ distinctFactor=0 ⇒ confidence 0，低于门槛
    const t = res.find((c) => c.fieldName === 'traceId');
    expect(t).toBeDefined();
    expect(t!.distinctKeys).toBe(1);
    expect(t!.confidence).toBeLessThan(CONFIDENT_THRESHOLD);
  });

  it('每个事件一个键（过细）⇒ 置信度被压到门槛下', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `row traceId=deadbeef${i.toString(16)}`);
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    const t = res.find((c) => c.fieldName === 'traceId');
    expect(t).toBeDefined();
    expect(t!.distinctKeys).toBe(lines.length); // 每事件一键
    expect(t!.confidence).toBeLessThan(CONFIDENT_THRESHOLD);
  });

  it('覆盖率低于门槛 ⇒ 被过滤', () => {
    // 12 条事件里只有 1 条带 traceId（< 20%）
    const lines = ['x traceId=aaaaaaaa'];
    for (let i = 0; i < 10; i++) lines.push(`plain${i} no key here`);
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    expect(res.find((c) => c.fieldName === 'traceId')).toBeUndefined();
    expect(1 / lines.length).toBeLessThan(MIN_COVERAGE);
  });

  it('白名单外的字段（user=）不被当作关联键', () => {
    const lines = [
      'a user=u1001',
      'b user=u1002',
      'c user=u1003',
      'd user=u1004',
    ];
    const res = detectCorrelationKey(lines.map((r, i) => ev(r, i)));
    expect(res.find((c) => c.fieldName === 'user')).toBeUndefined();
  });

  it('空事件 ⇒ 空结果', () => {
    expect(detectCorrelationKey([])).toEqual([]);
  });
});

describe('pickAutoKey', () => {
  const events = traceLines.map((r, i) => ev(r, i));

  it('已配手写 scope=key 规则 ⇒ 不兜底介入（返回 null）', () => {
    const groups = [{ sequence: { scope: 'key', keyPattern: 'traceId=([0-9a-f]{8})' } }];
    expect(pickAutoKey(groups, events)).toBeNull();
  });

  it('无手写 key 规则且有高置信候选 ⇒ 返回候选', () => {
    const groups = [{ sequence: { scope: 'global' } }];
    const auto = pickAutoKey(groups, events);
    expect(auto).not.toBeNull();
    expect(auto!.fieldName).toBe('traceId');
    expect(auto!.confidence).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD);
  });

  it('无高置信候选 ⇒ 返回 null', () => {
    const constEvents = ['a traceId=deadbeef', 'b traceId=deadbeef', 'c traceId=deadbeef'].map(
      (r, i) => ev(r, i),
    );
    expect(pickAutoKey([], constEvents)).toBeNull();
  });
});
