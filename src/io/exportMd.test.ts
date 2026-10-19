import { describe, expect, it, vi } from 'vitest';

// dbStore 顶层会摸 window / 引 UI 层，与被测的拼装逻辑无关；
// 这里让它报「无文件索引」，走 sourceFile + 全局行号的分支。
vi.mock('./dbStore', () => ({ getDbFiles: () => [] }));

const {
  formatChainMarkdown,
  formatChainsMarkdown,
  formatEventMarkdown,
  formatSequenceGroupMarkdown,
  formatSequenceResultsMarkdown,
  mdText,
  SEQUENCE_EXPORT_MAX,
} = await import('./exportMd');

import type {
  Filter,
  FilterGroup,
  LogEvent,
  MatchedChain,
  SequenceMatchResult,
} from '../types';

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

// ===== CEP 序列匹配结果导出 =====

function seqResult(over: Partial<SequenceMatchResult> = {}): SequenceMatchResult {
  return {
    groupId: 'g1',
    chains: [],
    uncovered: { ids: [], ts: [] },
    edgeStats: [],
    notViolations: [],
    heartbeats: [],
    ...over,
  } as SequenceMatchResult;
}

const GROUP = {
  id: 'g1',
  label: '会话链',
  color: '#f00',
  filterIds: ['f1', 'f2'],
} as FilterGroup;

describe('formatSequenceGroupMarkdown', () => {
  it('统计走真值：截断时标注 totalChains，不把回传条数当真值', () => {
    const result = seqResult({
      chains: [chain([{ edgeId: null, filterId: 'f1', event: ev({ id: 1, ts: 1000 }) }])],
      totalChains: 100000,
    });
    const md = formatSequenceGroupMarkdown(GROUP, result, FILTERS);
    expect(md).toContain('## 会话链');
    expect(md).toContain('链：100,000 条（链明细按 CEP_MAX_CHAINS 护栏截断，已回传 1 条）');
    expect(md).toContain('### 匹配链（共 100,000 条，此处节选前 1 条）');
    // 未覆盖为空 → 骨架性占位，不误报
    expect(md).toContain('异常：0 条 · 无异常');
    expect(md).toContain('全部事件均已匹配');
  });

  it('异常窗口段级摘要：时间范围 + 条数 + 级别', () => {
    const result = seqResult({
      uncovered: {
        ids: [1, 2],
        ts: [Date.UTC(2026, 9, 16, 4, 34, 56, 0), Date.UTC(2026, 9, 16, 4, 34, 56, 500)],
      },
    });
    const md = formatSequenceGroupMarkdown(GROUP, result, FILTERS);
    expect(md).toContain('异常：2 条 · 1 段异常窗口（共 2 条）');
    expect(md).toContain('### 异常窗口（1 段）');
    expect(md).toContain('2 条 · 零散');
    expect(md).toContain('### 未覆盖事件（共 2 条）');
    // 无 uncoveredFull → 骨架行，不假装有原文
    expect(md).toContain('`#1`');
    expect(md).toContain('原文未随结果回传（数据驻留模式）');
  });

  it('uncoveredFull 与 ids 同序时带原文；NOT 违规逐条列出', () => {
    const result = seqResult({
      uncovered: { ids: [7, 8], ts: [1000, 2000] },
      uncoveredFull: [
        ev({ id: 7, ts: 1000, raw: 'orphan a', level: 'WARN' }),
        ev({ id: 8, ts: 2000, raw: 'orphan b', level: 'ERROR' }),
      ],
      notViolations: [
        {
          edgeId: 'e1',
          fromEvent: ev({ id: 1, ts: 1000 }),
          toEvent: ev({ id: 2, ts: 1500, raw: 'forbidden' }),
        },
      ],
    });
    const md = formatSequenceGroupMarkdown(GROUP, result, FILTERS);
    expect(md).toContain('orphan a');
    expect(md).toContain('orphan b');
    expect(md).toContain('### NOT 违规（共 1 条）');
    expect(md).toContain('forbidden');
    expect(md).toContain('✕');
  });

  it('链/未覆盖明细均截断到 SEQUENCE_EXPORT_MAX，并标注节选', () => {
    const chains = Array.from({ length: SEQUENCE_EXPORT_MAX + 3 }, (_, i) =>
      chain([{ edgeId: null, filterId: 'f1', event: ev({ id: i, ts: 1000 + i }) }], {
        chainIndex: i,
      }),
    );
    const ids = Array.from({ length: SEQUENCE_EXPORT_MAX + 5 }, (_, i) => i);
    const ts = ids.map((i) => 1000 + i * 10);
    const md = formatSequenceGroupMarkdown(
      GROUP,
      seqResult({ chains, uncovered: { ids, ts } }),
      FILTERS,
    );
    expect(md).toContain(
      `### 匹配链（共 ${chains.length.toLocaleString()} 条，此处节选前 500 条）`,
    );
    expect(md).toContain(
      `### 未覆盖事件（共 ${ids.length.toLocaleString()} 条，此处节选前 500 条）`,
    );
    // 截断后不出现第 501 条链 / 第 501 个未覆盖 id
    expect(md).not.toContain(`### 链 #${SEQUENCE_EXPORT_MAX}`);
    expect(md).not.toContain(`#${SEQUENCE_EXPORT_MAX}`);
  });
});

describe('formatSequenceResultsMarkdown', () => {
  it('文件头带导出时间 / 源目录 / 分组数，每组一节', () => {
    const md = formatSequenceResultsMarkdown(
      [
        { group: GROUP, result: seqResult() },
        { group: { ...GROUP, id: 'g2', label: '另一组' }, result: seqResult({ groupId: 'g2' }) },
      ],
      FILTERS,
      { sourceDir: 'D:/logs/prod', generatedAt: Date.UTC(2026, 9, 17, 2, 0, 0) },
    );
    expect(md).toContain('# logGraph CEP 结果导出');
    expect(md).toContain('导出时间：');
    expect(md).toContain('源目录：D:/logs/prod');
    expect(md).toContain('分组数：2');
    expect(md).toContain('## 会话链');
    expect(md).toContain('## 另一组');
  });

  it('单组导出可自定义标题；无源目录时不写该行', () => {
    const md = formatSequenceResultsMarkdown(
      [{ group: GROUP, result: seqResult() }],
      FILTERS,
      { title: 'logGraph CEP 结果 · 会话链', generatedAt: 0 },
    );
    expect(md).toContain('# logGraph CEP 结果 · 会话链');
    expect(md).not.toContain('源目录');
  });
});
