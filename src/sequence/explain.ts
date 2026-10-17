/**
 * 「为何没匹配」解释器。
 *
 * CEP 规则配错时，UI 只显示「0 条链」，用户无从下手——不知道是过滤器写得太
 * 严、maxGap 太小、还是顺序写反了。这里基于**各 filter 的实际命中**反推最
 * 可能的阻塞原因，把「没结果」变成可行动的一句话。
 *
 * 设计要点：
 * - 纯函数、不碰匹配语义（只看命中与配置，不做二次匹配），故永远不会改变结果；
 * - 结论按**确定性**排序：blocker（必然导致零链）优先于 hint（可能有关）；
 * - 每条都给**具体数字**（间隔多少、超了多少），不说空话。
 */
import type { FilterMatch, LogEvent, SequenceConfig, SequenceEdge } from '../types';

export interface Diagnosis {
  /** blocker=必然阻塞；hint=可疑但非必然 */
  severity: 'blocker' | 'hint';
  /** 一句话结论（可直接展示） */
  text: string;
  /** 补充细节（可选的进一步说明） */
  detail?: string;
}

/** 一条边的目标 filter（and/or 用 toFilterIds，其余用 toFilterId） */
function targetsOf(edge: SequenceEdge): string[] {
  if (edge.kind === 'and' || edge.kind === 'or') {
    return edge.toFilterIds?.length ? edge.toFilterIds : [edge.toFilterId];
  }
  return [edge.toFilterId];
}

/** 参与链推进的边（not 是断言、periodic 是心跳，不参与 A→B 推进） */
function isFlowEdge(e: SequenceEdge): boolean {
  return e.kind !== 'not' && e.kind !== 'periodic';
}

/**
 * 事件列表按 ts 升序，返回第一个 ts > t 的下标（>= len 表示其后无事件）。
 * 命中列表由 store 保证 ts 升序。
 */
function upperBound(evs: LogEvent[], t: number): number {
  let lo = 0;
  let hi = evs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (evs[mid].ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 毫秒 → 人类可读时长（去掉无意义的尾随 0：1000ms 显示「1 秒」而非「1.0 秒」） */
function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${Number((ms / 60_000).toFixed(1))} 分钟`;
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(1))} 秒`;
  return `${Math.round(ms)} 毫秒`;
}

/**
 * 诊断一条 group 为何零链（或链太少）。
 * @param seq 序列配置
 * @param matches 各 filter 的实际命中（ts 升序）
 * @param zero 是否零链（false 时只给 hint，不给 blocker）
 */
export function explainNoMatch(
  seq: SequenceConfig,
  matches: FilterMatch[],
  zero: boolean,
): Diagnosis[] {
  const byId = new Map(matches.map((m) => [m.filterId, m.events]));
  const out: Diagnosis[] = [];

  // ---- 1. 过滤器零命中：最确定的阻塞原因 ----
  const used = new Set<string>();
  for (const e of seq.edges) {
    used.add(e.fromFilterId);
    for (const t of targetsOf(e)) used.add(t);
  }
  const empty: string[] = [];
  for (const fid of used) {
    if ((byId.get(fid)?.length ?? 0) === 0) empty.push(fid);
  }
  if (empty.length > 0) {
    out.push({
      severity: 'blocker',
      text:
        empty.length === 1
          ? `过滤器「${empty[0]}」在这批日志里 0 命中`
          : `${empty.length} 个过滤器零命中（${empty.slice(0, 3).join('、')}${empty.length > 3 ? ' …' : ''}）`,
      detail:
        '链必须由这些过滤器的命中串起来，任一为零都必然零链。' +
        '先单独看它的命中数：可能是正则太严、大小写/作用域（raw 与 message）不匹配，' +
        '或这批日志里根本没有这类行。',
    });
    // 零命中已是根因，后面的间隔分析无意义
    return out;
  }

  // ---- 2. 逐边分析：顺序 / 间隔 / 被抢先 ----
  for (const e of seq.edges) {
    if (!isFlowEdge(e)) continue;
    const from = byId.get(e.fromFilterId);
    if (!from) continue;
    const maxGap = e.maxGapMs;
    for (const tid of targetsOf(e)) {
      const to = byId.get(tid);
      if (!to) continue;

      let nearest = Number.POSITIVE_INFINITY;
      let anyAfter = false;
      let overtaken = 0; // 满足间隔但被 A 的后续命中抢先的对数
      for (let i = 0; i < from.length; i++) {
        const a = from[i];
        const j = upperBound(to, a.ts);
        if (j >= to.length) continue;
        anyAfter = true;
        const gap = to[j].ts - a.ts;
        if (gap < nearest) nearest = gap;
        // CEP 语义：B 须早于 A 的下一条命中，否则这一对不成立
        const next = from[i + 1];
        if (gap <= maxGap && next && next.ts <= to[j].ts) overtaken++;
      }

      if (!anyAfter) {
        out.push({
          severity: 'blocker',
          text: `顺序不对：「${tid}」的命中全部早于「${e.fromFilterId}」`,
          detail:
            `「${e.fromFilterId}」最后一条命中之后，再没有「${tid}」的命中了。` +
            `把边的方向反过来（从「${tid}」连到「${e.fromFilterId}」）试试。`,
        });
      } else if (nearest > maxGap) {
        out.push({
          severity: 'blocker',
          text: `间隔超限：「${e.fromFilterId}」→「${tid}」最近的一对也隔了 ${fmtMs(nearest)}`,
          detail: `边设定的窗口是 ${fmtMs(maxGap)}。把 maxGapMs 放宽到 ${fmtMs(nearest)} 以上，` +
            '或确认这两件事本来就应该这么远（那这条链在现实里就不成立）。',
        });
      } else if (overtaken > 0 && zero) {
        out.push({
          severity: 'hint',
          text: `有 ${overtaken} 对满足间隔，但被「${e.fromFilterId}」的后续命中抢先`,
          detail:
            'CEP 要求 B 早于 A 的下一条命中——A 命中太密时，中间的 B 会被跳过。' +
            '可考虑给 A 加条件收敛命中（如 level/msg 过滤），避免它把整个序列打散。',
        });
      }
    }
  }

  // ---- 3. 节点级约束（nodeCounts / nodeConditions）----
  for (const [fid, nc] of Object.entries(seq.nodeCounts ?? {})) {
    const evs = byId.get(fid);
    if (!evs) continue;
    const need = nc.min ?? 1;
    if (evs.length < need) {
      out.push({
        severity: 'blocker',
        text: `节点计数不足：「${fid}」要求至少连续 ${need} 次，实际只有 ${evs.length} 次命中`,
        detail: '把 min 调低，或放宽该过滤器的条件。',
      });
    }
  }
  for (const [fid, cond] of Object.entries(seq.nodeConditions ?? {})) {
    if (!cond?.trim()) continue;
    out.push({
      severity: 'hint',
      text: `节点条件可能过严：「${fid}」附加了条件 ${cond.trim()}`,
      detail:
        '被条件过滤掉的事件不会参与成链（但仍计入异常）。' +
        '可临时去掉条件，先确认基础序列本身能匹配上。',
    });
  }

  // blocker 优先，其次 hint；同类保持原有顺序
  const rank = (d: Diagnosis) => (d.severity === 'blocker' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}
