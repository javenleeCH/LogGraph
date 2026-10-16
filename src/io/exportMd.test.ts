import { describe, expect, it, vi } from 'vitest';

// dbStore 顶层会摸 window / 引 UI 层，与被测的拼装逻辑无关；
// 这里让它报「无文件索引」，走 sourceFile + 全局行号的分支。
vi.mock('./dbStore', () => ({ getDbFiles: () => [] }));

const { formatChainMarkdown, formatChainsMarkdown, formatEventMarkdown, mdText } = await import(
  './exportMd'
);

import type { Filter, LogEvent, MatchedChain } from '../types';

function ev(over: Partial<LogEvent> & { id: number }): LogEvent {
  return {
    ts: Date.UTC(2026, 9, 16, 4, 34, 56, 789),
    raw: 'raw line',
    message: 'msg',
    sourceFile: 'app.log',
    ...over,
  } as LogEvent;
}

function chain(steps: MatchedChain['steps'], over: Partial<MatchedChain> = {}): MatchedChain {
  return {
    chainIndex: 12,
    steps,
    startTs: steps[0].event.ts,
    endTs: steps[steps.length - 1].event.ts,
    ...over,
  };
}

const FILTERS = [
  { id: 'f1', label: '登录' },
  { id: 'f2', label: '鉴权' },
] as Filter[];

describe('mdText', () => {
  it('压掉换行制表，转义竖线（不破坏列表 / 表格）', () => {
    expect(mdText('a\nb\tc')).toBe('a b c');
    expect(mdText('a|b')).toBe('a\\|b');
  });
});

describe('formatEventMarkdown', () => {
  it('带上时间、文件:行号、级别、线程、正文', () => {
    const line = formatEventMarkdown(
      ev({ id: 4, level: 'ERROR', thread: 'Thread1', message: 'token 过期' }),
    );
    expect(line).toContain('app.log#4');
    expect(line).toContain('**ERROR**');
    expect(line).toContain('[Thread1]');
    expect(line).toContain('token 过期');
  });
});

describe('formatChainMarkdown', () => {
  it('一步一行，带过滤器名标签与序号', () => {
    const md = formatChainMarkdown(
      chain([
        { edgeId: null, filterId: 'f1', event: ev({ id: 1, ts: 1000, message: '收到请求' }) },
        { edgeId: 'e1', filterId: 'f2', event: ev({ id: 2, ts: 2500, message: 'token 过期' }) },
      ]),
      FILTERS,
    );
    const lines = md.split('\n');
    expect(lines[0]).toContain('链 #12');
    expect(lines[0]).toContain('2 步');
    expect(lines[0]).toContain('时长 1.5s');
    expect(lines[2]).toContain('**[登录]**');
    expect(lines[2]).toContain('收到请求');
    expect(lines[3]).toContain('**[鉴权]**');
    expect(lines[3]).toContain('token 过期');
  });

  it('按线程匹配出来的链把线程写进标题', () => {
    const md = formatChainMarkdown(
      chain([{ edgeId: null, filterId: 'f1', event: ev({ id: 1 }) }], { thread: 'Thread1' }),
      FILTERS,
    );
    expect(md).toContain('线程 Thread1');
  });

  it('全局匹配出来的链不写线程', () => {
    const md = formatChainMarkdown(
      chain([{ edgeId: null, filterId: 'f1', event: ev({ id: 1 }) }], { thread: null }),
      FILTERS,
    );
    expect(md).not.toContain('线程');
  });

  it('可关闭过滤器名标签', () => {
    const md = formatChainMarkdown(
      chain([{ edgeId: null, filterId: 'f1', event: ev({ id: 1, message: 'm' }) }]),
      FILTERS,
      { showFilterLabel: false },
    );
    expect(md).not.toContain('**[登录]**');
  });
});

describe('formatChainsMarkdown', () => {
  it('文档头带上分组、条数、时间窗', () => {
    const md = formatChainsMarkdown(
      [chain([{ edgeId: null, filterId: 'f1', event: ev({ id: 1, ts: 1000 }) }])],
      FILTERS,
      {
        groupLabel: '会话',
        range: { start: 0, end: 6000 },
        totalChains: 1615,
        anomalyCount: 335780,
      },
    );
    expect(md).toContain('# logGraph 分析结论');
    expect(md).toContain('分组：会话');
    expect(md).toContain('链：1 条（共 1,615 条，此处节选）');
    expect(md).toContain('异常：335,780');
    expect(md).toContain('时间窗：');
  });

  it('没节选时不写「节选」', () => {
    const md = formatChainsMarkdown(
      [chain([{ edgeId: null, filterId: 'f1', event: ev({ id: 1, ts: 1000 }) }])],
      FILTERS,
      { totalChains: 1 },
    );
    expect(md).toContain('链：1 条');
    expect(md).not.toContain('节选');
  });
});
