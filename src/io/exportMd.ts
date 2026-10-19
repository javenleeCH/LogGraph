/**
 * 结论导出：把分析结果写成可直接粘进工单 / 邮件 / 复盘文档的 Markdown。
 *
 * 这一半价值此前是缺的：用户在 logGraph 里定位到根因后，只能截图手抄。
 * 工具的正确终点不是「看到了」，而是「把结论带走、进入别人的工作流」。
 *
 * 本模块只做纯文本拼装（无 IO、无 store 依赖），便于单测与在 Tauri / Web
 * 两端共用；真正写剪贴板 / 存文件由调用方走 copyWithFallback。
 */
import type {
  Filter,
  FilterGroup,
  LogEvent,
  MatchedChain,
  NotViolation,
  SequenceMatchResult,
} from '../types';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import { trueChainCount, trueUncoveredCount, isSequenceTruncated } from '../utils/counts';
import {
  aggregateAnomalyWindows,
  formatAnomalySummary,
  LEVEL_LABEL,
} from '../sequence/anomalyWindows';
import { formatLineLoc } from './lineLoc';

/** 清洗进 Markdown 的文本：压掉换行制表、转义竖线，避免破坏列表 / 表格结构 */
export function mdText(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * 单条事件的引用行：
 * `2026-10-16 12:34:56.789` `app.log:1234` **ERROR** [Thread1] 消息正文
 */
export function formatEventMarkdown(ev: LogEvent): string {
  const parts: string[] = [`\`${formatDateTime(ev.ts)}\``, `\`${formatLineLoc(ev.id, ev.sourceFile)}\``];
  if (ev.level) parts.push(`**${mdText(ev.level)}**`);
  if (ev.thread) parts.push(`[${mdText(ev.thread)}]`);
  const body = mdText(ev.message || ev.raw);
  return `${parts.join(' ')} ${body}`.trim();
}

export interface ChainMdOptions {
  /** 分组名（放进小节标题） */
  groupLabel?: string;
  /** 每步前是否带 [过滤器名] 标签 */
  showFilterLabel?: boolean;
  /** 分桶标签名：链的 thread 字段在 scope='thread' 时是线程、'key' 时是关联键 */
  scopeLabel?: string;
}

/** 一条链 → Markdown 小节（有序列表，一步一行） */
export function formatChainMarkdown(
  chain: MatchedChain,
  filters: readonly Filter[],
  opts: ChainMdOptions = {},
): string {
  const dur = formatDuration(Math.max(0, chain.endTs - chain.startTs));
  const scope = chain.thread
    ? ` · ${opts.scopeLabel ?? '线程'} ${mdText(chain.thread)}`
    : '';
  const lines: string[] = [
    `### 链 #${chain.chainIndex} · ${chain.steps.length} 步 · 时长 ${dur}${scope}`,
    '',
  ];
  chain.steps.forEach((st, i) => {
    const f = filters.find((x) => x.id === st.filterId);
    const tag = opts.showFilterLabel === false || !f ? '' : `**[${mdText(f.label)}]** `;
    lines.push(`${i + 1}. ${tag}${formatEventMarkdown(st.event)}`);
  });
  return lines.join('\n');
}

export interface ChainsMdOptions extends ChainMdOptions {
  /** 文档标题 */
  title?: string;
  /** 分析时间窗 */
  range?: { start: number; end: number } | null;
  /** 该分组的链总数（> 导出条数时标注「节选」） */
  totalChains?: number;
  /** 异常数（一并写进结论里，不然结论不完整） */
  anomalyCount?: number;
}

/** 多条链 → 完整 Markdown 文档（含元信息头） */
export function formatChainsMarkdown(
  chains: readonly MatchedChain[],
  filters: readonly Filter[],
  opts: ChainsMdOptions = {},
): string {
  const out: string[] = [`# ${opts.title ?? 'logGraph 分析结论'}`, ''];
  const meta: string[] = [];
  if (opts.groupLabel) meta.push(`分组：${opts.groupLabel}`);
  const total = opts.totalChains ?? 0;
  meta.push(
    total > chains.length
      ? `链：${chains.length} 条（共 ${total.toLocaleString()} 条，此处节选）`
      : `链：${chains.length} 条`,
  );
  if (opts.anomalyCount) meta.push(`异常：${opts.anomalyCount.toLocaleString()}`);
  if (opts.range) {
    meta.push(`时间窗：${formatDateTime(opts.range.start)} ~ ${formatDateTime(opts.range.end)}`);
  }
  meta.push(`导出时间：${formatDateTime(Date.now())}`);
  for (const m of meta) out.push(`> ${m}`);
  out.push('');
  for (const ch of chains) {
    out.push(formatChainMarkdown(ch, filters, opts), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** 若干条事件 → Markdown 小节（导出上下文 / 选中事件用） */
export function formatEventsMarkdown(
  events: readonly LogEvent[],
  opts: { title?: string; highlightId?: number | null } = {},
): string {
  const out: string[] = [];
  if (opts.title) out.push(`### ${opts.title}`, '');
  for (const ev of events) {
    const mark = opts.highlightId != null && ev.id === opts.highlightId ? ' **←**' : '';
    out.push(`- ${formatEventMarkdown(ev)}${mark}`);
  }
  return out.join('\n');
}

// ===== CEP 序列匹配结果导出 =====

/** 导出为文件时各明细区块的条数上限：链 / NOT 违规 / 未覆盖事件 / 异常窗口共用
 *  （与 exportActions 的 EXPORT_MAX_PER_FILTER=500 同一惯例：再多就不是给人看的了） */
export const SEQUENCE_EXPORT_MAX = 500;

/** 一条 NOT 违规 → 引用行：源事件（A）窗口内出现了禁止的目标事件（B） */
function formatNotViolationMarkdown(v: NotViolation): string {
  return `- ${formatEventMarkdown(v.fromEvent)} **✕** ${formatEventMarkdown(v.toEvent)}`;
}

/** 未覆盖事件 → 骨架行（db 模式原文未随结果回传，只有 id + 时间戳） */
function formatUncoveredSkeletonMarkdown(id: number, ts: number): string {
  return `- \`#${id}\` \`${formatDateTime(ts)}\` 原文未随结果回传（数据驻留模式）`;
}

export interface SequenceGroupMdOptions {
  /** 分桶标签名：链的 thread 字段在 scope='key' 时是关联键（沿用 copyChainMarkdown 的口径） */
  scopeLabel?: string;
}

/** 一个分组的 CEP 结果 → Markdown 小节。
 *  统计全部走真值口径（trueChainCount / trueUncoveredCount），明细全部有上限：
 *  链可能被 CEP_MAX_CHAINS 护栏截断、未覆盖可达百万级，导出是给人看的，不是数据搬运。 */
export function formatSequenceGroupMarkdown(
  group: FilterGroup,
  result: SequenceMatchResult,
  filters: readonly Filter[],
  opts: SequenceGroupMdOptions = {},
): string {
  const out: string[] = [`## ${mdText(group.label)}`, ''];
  // 统计口径：链真值在 totalChains（未截断时 = chains.length）；未覆盖 SoA 全量恒真
  const chainTotal = trueChainCount(result);
  const uncTotal = trueUncoveredCount(result);
  const anomaly = aggregateAnomalyWindows(result.uncovered.ts);
  out.push(
    `> 链：${chainTotal.toLocaleString()} 条${
      isSequenceTruncated(result)
        ? `（链明细按 CEP_MAX_CHAINS 护栏截断，已回传 ${result.chains.length.toLocaleString()} 条）`
        : ''
    }`,
    `> 异常：${uncTotal.toLocaleString()} 条 · ${formatAnomalySummary(anomaly)}`,
    '',
  );

  // 异常窗口：段级摘要（时间范围 + 条数 + 级别），段数也可能上万，同样设上限
  if (anomaly.windows.length > 0) {
    const winShown = anomaly.windows.slice(0, SEQUENCE_EXPORT_MAX);
    out.push(
      `### 异常窗口（${anomaly.windows.length.toLocaleString()} 段${
        anomaly.windows.length > winShown.length
          ? `，此处节选前 ${winShown.length.toLocaleString()} 段`
          : ''
      }）`,
      '',
    );
    for (const w of winShown) {
      out.push(
        `- \`${formatDateTime(w.startTs)}\` ~ \`${formatDateTime(w.endTs)}\` · ${w.count.toLocaleString()} 条 · ${LEVEL_LABEL[w.level]}`,
      );
    }
    out.push('');
  }

  // 匹配链明细
  const chainsShown = result.chains.slice(0, SEQUENCE_EXPORT_MAX);
  out.push(
    `### 匹配链（共 ${chainTotal.toLocaleString()} 条${
      chainTotal > chainsShown.length
        ? `，此处节选前 ${chainsShown.length.toLocaleString()} 条`
        : ''
    }）`,
    '',
  );
  if (chainsShown.length === 0) {
    out.push('无匹配链', '');
  } else {
    for (const ch of chainsShown) {
      out.push(formatChainMarkdown(ch, filters, opts), '');
    }
  }

  // NOT 违规明细（全量回传，无截断；仍设导出上限防极端量级）
  if (result.notViolations.length > 0) {
    const violShown = result.notViolations.slice(0, SEQUENCE_EXPORT_MAX);
    out.push(
      `### NOT 违规（共 ${result.notViolations.length.toLocaleString()} 条${
        result.notViolations.length > violShown.length
          ? `，此处节选前 ${violShown.length.toLocaleString()} 条`
          : ''
      }）`,
      '',
    );
    for (const v of violShown) out.push(formatNotViolationMarkdown(v));
    out.push('');
  }

  // 未覆盖事件明细：wasm 模式 uncoveredFull 与 ids 同序携带原文；db 模式只有骨架
  const uncShown = Math.min(uncTotal, SEQUENCE_EXPORT_MAX);
  out.push(
    `### 未覆盖事件（共 ${uncTotal.toLocaleString()} 条${
      uncTotal > uncShown ? `，此处节选前 ${uncShown.toLocaleString()} 条` : ''
    }）`,
    '',
  );
  if (uncTotal === 0) {
    out.push('全部事件均已匹配', '');
  } else {
    const full = result.uncoveredFull;
    for (let i = 0; i < uncShown; i++) {
      const ev = full?.[i];
      out.push(ev ? `- ${formatEventMarkdown(ev)}` : formatUncoveredSkeletonMarkdown(result.uncovered.ids[i], result.uncovered.ts[i]));
    }
    out.push('');
  }

  return out.join('\n').trimEnd();
}

export interface SequenceResultsMdOptions {
  /** 文档标题 */
  title?: string;
  /** 日志源目录（写进文件头；null/缺省=独立会话/未命名） */
  sourceDir?: string | null;
  /** 生成时间（缺省当前时刻；测试传确定值断言） */
  generatedAt?: number;
}

/** 一到多个分组的 CEP 结果 → 完整 Markdown 文档（文件头 + 每组一节）。
 *  单组导出与全量导出共用本函数：传单元素数组即可。 */
export function formatSequenceResultsMarkdown(
  entries: readonly { group: FilterGroup; result: SequenceMatchResult }[],
  filters: readonly Filter[],
  opts: SequenceResultsMdOptions = {},
): string {
  const out: string[] = [`# ${opts.title ?? 'logGraph CEP 结果导出'}`, ''];
  const meta: string[] = [`导出时间：${formatDateTime(opts.generatedAt ?? Date.now())}`];
  if (opts.sourceDir) meta.push(`源目录：${mdText(opts.sourceDir)}`);
  meta.push(`分组数：${entries.length}`);
  for (const m of meta) out.push(`> ${m}`);
  out.push('');
  for (const e of entries) {
    // scope='key' 时链的 thread 字段承载关联键（traceId…），不是线程
    out.push(
      formatSequenceGroupMarkdown(e.group, e.result, filters, {
        scopeLabel: e.group.sequence?.scope === 'key' ? '关联键' : '线程',
      }),
      '',
    );
  }
  return out.join('\n').trimEnd() + '\n';
}
