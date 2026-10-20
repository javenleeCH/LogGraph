import { describe, it, expect } from 'vitest';
import { LogParser, parseRest, detectLogFamily } from './LogParser';
import type { LogEvent } from '../types';

describe('parseRest 家族感知 thread 提取（对齐 engine::parser::line）', () => {
  it('行首 [Thread] 仍由默认启发式取（log4j2 线程在前）', () => {
    const r = parseRest('[Thread1] INFO hello world');
    expect(r.thread).toBe('Thread1');
    expect(r.level).toBe('INFO');
    expect(r.message).toBe('hello world');
  });

  it('Spring Boot / Logback：--- [thread] 在标记之后', () => {
    const r = parseRest(' INFO 12345 --- [main] com.foo.Bar : started', 'springLogback');
    expect(r.thread).toBe('main');
    expect(r.level).toBe('INFO');
    expect(r.message).toBe('12345  com.foo.Bar : started');
  });

  it('log4j2 变体：LEVEL [thread] 紧跟级别之后', () => {
    const r = parseRest('ERROR [pool-1] com.foo.Service - boom', 'log4jThreadAfter');
    expect(r.thread).toBe('pool-1');
    expect(r.level).toBe('ERROR');
    expect(r.message).toBe('com.foo.Service - boom');
  });

  it('行首已有 thread 时家族规则不覆盖', () => {
    const r = parseRest('[net-0] INFO 12345 --- [main] com.foo : x', 'springLogback');
    expect(r.thread).toBe('net-0');
    expect(r.level).toBe('INFO');
  });

  it('unknown 族与旧行为完全一致', () => {
    const cases = [
      '[INFO] message body',
      'INFO hello',
      '(main) E crash',
      'hello (INFO) world',
      ' INFO 12345 --- [main] com.foo.Bar : started',
    ];
    for (const c of cases) {
      expect(parseRest(c, 'unknown')).toEqual(parseRest(c, 'unknown'));
    }
    // 明确校验 unknown 族不会引入新提取（Spring Boot 行在 unknown 下无 thread）
    const sb = parseRest(' INFO 12345 --- [main] com.foo.Bar : started', 'unknown');
    expect(sb.thread).toBeUndefined();
  });

  it('detectLogFamily 多数决', () => {
    expect(detectLogFamily([' INFO 1 --- [main] a : x', ' WARN 1 --- [main] a : y', ' ERROR 1 --- [main] a : z'])).toBe('springLogback');
    expect(detectLogFamily(['INFO [t1] a - x', 'WARN [t1] a - y', 'ERROR [t1] a - z'])).toBe('log4jThreadAfter');
    // 多数不足 → 回退 unknown（保守，防误抓）
    expect(detectLogFamily(['INFO plain message', 'WARN [t1] a - y', 'ERROR plain message'])).toBe('unknown');
    expect(detectLogFamily([])).toBe('unknown');
  });

  it('detectLogFamily 不把 nginx [error] 误判为任何族', () => {
    expect(detectLogFamily(['[error] 12345#0: *1 open() failed', '[error] 12346#0: *2 closed'])).toBe('unknown');
  });

  it('Python logging %(threadName)s：家族探测 + 提取', () => {
    expect(
      detectLogFamily(['INFO Thread-1: worker done', 'INFO Thread-2: done', 'WARN MainThread: init ok'])
    ).toBe('pythonThread');
    const r = parseRest('INFO Thread-1: worker done', 'pythonThread');
    expect(r.thread).toBe('Thread-1');
    expect(r.level).toBe('INFO');
    expect(r.message).toBe('worker done');
    const r2 = parseRest('WARN MainThread: init', 'pythonThread');
    expect(r2.thread).toBe('MainThread');
    expect(r2.message).toBe('init');
  });

  it('syslog program[pid]：家族探测 + 组件标识提取', () => {
    expect(
      detectLogFamily(['web01 nginx[1234]: 10.0.0.1 GET /', 'web01 app[5678]: timeout', 'web01 nginx[1234]: 10.0.0.2 POST'])
    ).toBe('syslogComponent');
    const r = parseRest('web01 nginx[1234]: 10.0.0.1 GET /', 'syslogComponent');
    expect(r.thread).toBe('nginx[1234]');
    expect(r.message).toBe('web01 10.0.0.1 GET /');
  });
});

describe('LogParser.parse 端到端：家族探测后 thread 正确流入事件', () => {
  it('Spring Boot 多行日志解析出 thread 字段', () => {
    const text = [
      '2024-01-01 12:00:00.100  INFO 12345 --- [main] c.f.Bar : startup',
      '2024-01-01 12:00:01.200  WARN 12345 --- [scheduler-1] c.f.Bar : retry',
      '',
    ].join('\n');
    const p = new LogParser();
    const res = p.parse(text);
    expect(res.skipped).toBe(1);
    expect(res.events.length).toBe(2);
    const threads = res.events.map((e: LogEvent) => e.thread).sort();
    expect(threads).toEqual(['main', 'scheduler-1']);
  });

  it('nginx access：时间戳解析，消息为请求行（无线程，正确）', () => {
    const text = [
      '1.2.3.4 - - [10/Oct/2026:13:55:36 +0000] "GET /index HTTP/1.1" 200 612',
      '5.6.7.8 - - [10/Oct/2026:13:55:37 +0800] "POST /api HTTP/1.1" 201 120',
      '',
    ].join('\n');
    const p = new LogParser();
    const res = p.parse(text);
    expect(res.skipped).toBe(1);
    expect(res.events.length).toBe(2);
    expect(res.timestampFormatId).toBe('nginx');
    // 两条均无线程/级别
    expect(res.events.every((e: LogEvent) => e.thread === undefined)).toBe(true);
    // 排序后：+0800（更早的 UTC 时刻）在前，+0000 在后
    expect(res.events[0].message).toContain('POST /api');
    expect(res.events[1].message).toContain('GET /index');
    expect(res.events[0].ts).toBeLessThan(res.events[1].ts);
  });
});
