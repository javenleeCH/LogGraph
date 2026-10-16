/**
 * 结论导出：把分析结果写成可直接粘进工单 / 邮件 / 复盘文档的 Markdown。
 *
 * 这一半价值此前是缺的：用户在 logGraph 里定位到根因后，只能截图手抄。
 * 工具的正确终点不是「看到了」，而是「把结论带走、进入别人的工作流」。
 *
 * 本模块只做纯文本拼装（无 IO、无 store 依赖），便于单测与在 Tauri / Web
 * 两端共用；真正写剪贴板 / 存文件由调用方走 copyWithFallback。
 */
import type { Filter, LogEvent, MatchedChain } from '../types';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
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
}

/** 一条链 → Markdown 小节（有序列表，一步一行） */
export function formatChainMarkdown(
  chain: MatchedChain,
  filters: readonly Filter[],
  opts: ChainMdOptions = {},
): string {
  const dur = formatDuration(Math.max(0, chain.endTs - chain.startTs));
  const scope = chain.thread ? ` · 线程 ${mdText(chain.thread)}` : '';
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
