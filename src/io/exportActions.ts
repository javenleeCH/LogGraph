/**
 * 导出动作：命令面板与各组件共用同一份实现（避免两处逻辑漂移）。
 *
 * 两类导出，对应两种「带走」：
 * - 结论（Markdown）：把找到的东西带进工单 / 邮件 / 复盘文档；
 * - 规则（JSON）：把怎么用出来的交给同事，或交给 CI 无人值守地跑。
 *
 * 用户反馈一律走 uiStore 的 toast / beginBusy，不写 alert。
 */
import { useLogStore } from '../store/logStore';
import { toast, beginBusy } from '../store/uiStore';
import { copyWithFallback } from '../utils/copyFlow';
import { formatChainsMarkdown, formatEventsMarkdown } from './exportMd';
import { saveTextFile, pickTextFile } from './exportFile';
import { buildCepJson, buildLoggraphJson, parseRuleFile } from './rulesIo';
import { trueChainCount, trueUncoveredCount, fmtCount } from '../utils/counts';
import { formatDateTime } from '../utils/timeFormat';
import type {
  FilterGroup,
  LogEvent,
  MatchedChain,
  SequenceMatchResult,
  NodePos,
} from '../types';

/** 导出为文件时单条过滤器的事件上限（再多就不是给人看的东西了） */
const EXPORT_MAX_PER_FILTER = 500;

/** 在 matches 里定位事件（命中集远小于全量 events，线性扫一遍足够快） */
function findEvent(matches: readonly { events: LogEvent[] }[], id: number): LogEvent | null {
  for (const m of matches) {
    for (const ev of m.events) if (ev.id === id) return ev;
  }
  return null;
}

interface ChainHit {
  group: FilterGroup;
  result: SequenceMatchResult;
  chain: MatchedChain;
}

/** 找到包含该事件的链；chains 按 startTs 升序，可早停 */
function findChainOfEvent(
  groups: readonly FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
  id: number,
): ChainHit | null {
  // 先用 ts 定位候选区间：链按 startTs 升序，起点晚于本事件的链必不包含它
  for (const g of groups) {
    const r = sequenceResults[g.id];
    if (!r) continue;
    for (const ch of r.chains) {
      let has = false;
      for (const st of ch.steps) {
        if (st.event.id === id) {
          has = true;
          break;
        }
      }
      if (has) return { group: g, result: r, chain: ch };
    }
  }
  return null;
}

/** 时间戳戳签名（文件名用）：20261016-2358 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 复制指定链为 Markdown（列表里逐条复制，不必先选中它） */
export async function copyChainMarkdown(
  group: FilterGroup,
  result: SequenceMatchResult,
  chain: MatchedChain,
): Promise<void> {
  const st = useLogStore.getState();
  const md = formatChainsMarkdown([chain], st.filters, {
    title: `${group.label} · 链 #${chain.chainIndex}`,
    groupLabel: group.label,
    totalChains: trueChainCount(result),
    anomalyCount: group.sequence?.anomalyEnabled ? trueUncoveredCount(result) : 0,
    range: st.viewRange,
  });
  await copyWithFallback(md, {
    successTitle: '已复制链（Markdown）',
    successDetail: `链 #${chain.chainIndex} · ${chain.steps.length} 步`,
    fallbackTitle: '手动复制该链',
  });
}

/** 复制选中事件所在的那条链（完整上下文）为 Markdown */
export async function copySelectedChainMarkdown(): Promise<void> {
  const st = useLogStore.getState();
  const id = st.selectedEventId;
  if (id === null) {
    toast.warn('尚未选中任何日志行', '先在时间线上点选链上的任一步');
    return;
  }
  const hit = findChainOfEvent(st.groups, st.sequenceResults, id);
  if (!hit) {
    toast.warn('选中行不属于任何匹配链', '先选中链上的某一步；只要原文可用「复制选中行」');
    return;
  }
  await copyChainMarkdown(hit.group, hit.result, hit.chain);
}

/** 复制选中事件（带文件 / 行号 / 时间）为 Markdown */
export async function copySelectedEventMarkdown(): Promise<void> {
  const st = useLogStore.getState();
  const id = st.selectedEventId;
  if (id === null) {
    toast.warn('尚未选中任何日志行');
    return;
  }
  const ev = findEvent(st.matches, id);
  if (!ev) {
    toast.warn('找不到该行内容', '可能已被过滤或不在这次加载的范围内');
    return;
  }
  const md = formatEventsMarkdown([ev], { highlightId: id });
  await copyWithFallback(md, {
    successTitle: '已复制事件（Markdown）',
    successDetail: `第 ${id + 1} 行`,
    fallbackTitle: '手动复制该事件',
  });
}

/** 把当前时间窗内各过滤器的命中导出成 .md 文件（每条节选，避免导出几十万行） */
export async function exportMatchesMarkdown(): Promise<void> {
  const st = useLogStore.getState();
  if (st.matches.length === 0) {
    toast.warn('没有可导出的命中', '先建一条过滤器并让它匹配到日志');
    return;
  }
  const end = beginBusy('导出命中…');
  try {
    const lines: string[] = ['# logGraph 命中导出', ''];
    const total = st.matches.reduce((s, m) => s + m.events.length, 0);
    const meta = [`导出时间：${formatDateTime(Date.now())}`, `命中合计：${fmtCount(total)}`];
    if (st.viewRange) {
      meta.unshift(
        `时间窗：${formatDateTime(st.viewRange.start)} ~ ${formatDateTime(st.viewRange.end)}`,
      );
    }
    for (const m of meta) lines.push(`> ${m}`);
    lines.push('');
    for (const m of st.matches) {
      const f = st.filters.find((x) => x.id === m.filterId);
      const shown = m.events.slice(0, EXPORT_MAX_PER_FILTER);
      const more = m.events.length - shown.length;
      lines.push(
        `## ${f?.label ?? m.filterId}（${fmtCount(m.events.length)} 条${
          more > 0 ? `，节选前 ${shown.length} 条` : ''
        }）`,
        '',
      );
      lines.push(formatEventsMarkdown(shown), '');
    }
    const path = await saveTextFile(`loggraph-命中-${stamp()}.md`, lines.join('\n'), {
      extensions: ['md'],
    });
    if (path) {
      toast.success(
        '命中已导出',
        `${fmtCount(total)} 条 · 每个过滤器最多 ${EXPORT_MAX_PER_FILTER} 条`,
      );
    }
  } catch (e) {
    toast.error('导出失败', (e as Error).message);
  } finally {
    end();
  }
}

/** 导出规则集：kind='cep' 给 CLI/CI；'loggraph' 给同事 / 备份 */
export async function exportRulesFile(kind: 'loggraph' | 'cep'): Promise<void> {
  const st = useLogStore.getState();
  if (st.filters.length === 0) {
    toast.warn('没有可导出的过滤器', '至少建一条过滤器再导出');
    return;
  }
  const built =
    kind === 'cep'
      ? buildCepJson(st.filters, st.groups)
      : buildLoggraphJson(st.filters, st.groups, st.graphNodes as Record<string, NodePos> | undefined);
  const name = `loggraph-rules-${stamp()}.${kind === 'cep' ? 'cep' : 'loggraph'}.json`;
  const path = await saveTextFile(name, built.json, { extensions: ['json'] });
  if (!path) return; // 用户取消
  if (built.warnings.length > 0) {
    // 静默降级才是真的坑：告诉用户哪几条规则在引擎 v1 里不生效
    toast.warn(
      `已导出，但有 ${built.warnings.length} 项在引擎 v1 会失效`,
      built.warnings.slice(0, 3).join('；') + (built.warnings.length > 3 ? ' …' : ''),
    );
  } else {
    toast.success('规则已导出', `${st.filters.length} 个过滤器 · ${st.groups.length} 个分组`);
  }
}

/** 导入规则集（.loggraph.json / .cep.json 自动识别），替换当前规则 */
export async function importRulesFile(): Promise<void> {
  const picked = await pickTextFile({ extensions: ['json'] });
  if (!picked) return;
  const end = beginBusy('导入规则…');
  try {
    const parsed = parseRuleFile(picked.text);
    useLogStore.getState().applyPersistedFilters({
      filters: parsed.filters,
      groups: parsed.groups,
      graphNodes: parsed.graphNodes,
      savedAt: Date.now(),
    });
    toast.success(
      '规则已导入',
      `${parsed.filters.length} 个过滤器 · ${parsed.groups.length} 个分组（已替换当前规则）`,
    );
    if (parsed.warnings.length > 0) {
      toast.warn(
        `其中 ${parsed.warnings.length} 项 v1 引擎不支持`,
        parsed.warnings.slice(0, 3).join('；') + (parsed.warnings.length > 3 ? ' …' : ''),
      );
    }
  } catch (e) {
    toast.error('导入失败', (e as Error).message);
  } finally {
    end();
  }
}
