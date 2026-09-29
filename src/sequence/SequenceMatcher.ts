/**
 * 序列匹配引擎（模式族 v2）：把 group 内声明的 filter 图关联
 * （seq / not / and / or / periodic 边）在事件流上做贪心链匹配与断言。
 *
 * 作用域：
 * - global：全局时间轴（v1 行为）
 * - thread：按 LogEvent.thread 分桶隔离，每桶独立匹配（null thread → '∅' 桶）
 *
 * 边语义（窗口 (tsA, tsA+maxGapMs]，插队规则贯穿所有推进型边）：
 * - seq  A→B：先遇 B 推进；先遇另一 A 断裂（B 缺失）；窗口耗尽断裂
 * - not  A⃠B：先遇 B → 违规；先遇另一 A / 窗口耗尽 → 通过（不消耗事件）
 * - and  A→[B,C…]：全部目标就绪才推进（各自最早未消耗事件）；插队断裂
 * - or   A→[B,C…]：任一就绪即推进（走最早出现的就绪目标）；插队断裂；全缺断裂
 * - periodic A↻A：自环断言，间隔 ∈ [P-δ, P+δ] 正常；> P+δ 缺口；< P-δ 抖动
 *   （不参与贪心推进，独立输出 HeartbeatGroup）
 *
 * 其他类型日志不在扫描视野内，天然不阻断推进。
 * 复杂度：每事件至多消耗一次；每步推进 O(k·logM)（k=目标数，双指针二分起点）。
 */

import type {
  FilterMatch,
  HeartbeatGroup,
  LogEvent,
  MatchedChain,
  NotViolation,
  SequenceConfig,
  SequenceEdge,
  SequenceEdgeStat,
  SequenceMatchResult,
} from '../types';
import { bisectLeft } from '../timeline/correlation';
import { compileExpr } from './expr';

/** 边的有效目标列表（and/or 用 toFilterIds，其余用 toFilterId） */
function targetsOf(edge: SequenceEdge): string[] {
  if ((edge.kind === 'and' || edge.kind === 'or') && edge.toFilterIds?.length) {
    return edge.toFilterIds;
  }
  return [edge.toFilterId];
}

/** 解析出的推进链：有序 seq/and/or/not 边序列（periodic 边独立断言，不入链） */
interface ResolvedChain {
  edges: SequenceEdge[];
}

/**
 * 从边集合解析推进链。
 * - 推进型边（seq/and/or/not）中入度 0 的节点为链起点，沿出边 DFS；
 *   每条出边分支形成独立链；环内无入度 0 起点时从环内节点各尝试一次。
 * - periodic 自环边不参与。
 */
export function resolveChains(edges: SequenceEdge[]): ResolvedChain[] {
  // 推进型边只有 seq/and/or；not（纯断言）与 periodic（自环断言）不参与链
  const flow = edges.filter((e) => (e.kind ?? 'seq') !== 'periodic' && e.kind !== 'not');
  const inDeg = new Map<string, number>();
  const outEdges = new Map<string, SequenceEdge[]>();
  for (const e of flow) {
    for (const t of targetsOf(e)) {
      inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
    }
    let arr = outEdges.get(e.fromFilterId);
    if (!arr) {
      arr = [];
      outEdges.set(e.fromFilterId, arr);
    }
    arr.push(e);
  }

  const chains: ResolvedChain[] = [];
  for (const e of flow) {
    if ((inDeg.get(e.fromFilterId) ?? 0) === 0) {
      dfsChain(e, [e], new Set([e.id]));
    }
  }
  // 环：从环内每个节点各尝试一次
  const visited = new Set<string>();
  for (const e of flow) {
    if ((inDeg.get(e.fromFilterId) ?? 0) > 0 && !visited.has(e.fromFilterId)) {
      visited.add(e.fromFilterId);
      dfsChain(e, [e], new Set([e.id]));
    }
  }

  function dfsChain(e: SequenceEdge, acc: SequenceEdge[], used: Set<string>) {
    const nexts = outEdges.get(e.toFilterId) ?? [];
    let extended = false;
    for (const nx of nexts) {
      if (used.has(nx.id)) continue; // 防环
      used.add(nx.id);
      dfsChain(nx, [...acc, nx], used);
      used.delete(nx.id);
      extended = true;
    }
    if (!extended) chains.push({ edges: acc });
  }

  return chains;
}

/** 在 events（ts 升序）中从 ts>lo 起找第一个未消耗事件的索引（找不到返回 length） */
function nextUnusedIdx(events: LogEvent[], consumed: Set<number>, lo: number): number {
  let i = bisectLeft(events, lo);
  if (i > 0 && events[i - 1].ts > lo) i--;
  while (i < events.length && (events[i].ts <= lo || consumed.has(events[i].id))) i++;
  return i;
}

/** 推进结果：ok=推进成功（movedTo 为消耗的目标事件）；'violation'=NOT 违规；null=断裂 */
type AdvanceResult =
  | { ok: true; movedTo: LogEvent | null }
  | { violation: true; target: LogEvent }
  | null;

/**
 * 单边推进判定（插队规则贯穿）。
 * 归并扫描窗口内 from(A) 与目标事件流：
 * - 目标先到 → seq/and/or 推进；not 违规
 * - 另一 A 实例先到（严格晚于 fromTs，未消耗）→ 推进型断裂（B 缺失）；not 通过
 * - 窗口耗尽 → seq/and/or 断裂；not 通过
 *
 * and：所有目标都须在「A 插队 / 窗口耗尽」之前就绪，各取最早未消耗事件
 * or ：任一就绪即走该目标（多就绪取最早出现者）
 */
function advanceEdge(
  edge: SequenceEdge,
  fromEvents: LogEvent[],
  eventsByTarget: Map<string, LogEvent[]>,
  consumed: Set<number>,
  fromTs: number,
): AdvanceResult {
  const hi = fromTs + edge.maxGapMs;
  const kind = edge.kind ?? 'seq';
  const targets = targetsOf(edge);

  // 各目标流的扫描指针（惰性推进）
  const idx = new Map<string, number>();
  for (const t of targets) {
    const evs = eventsByTarget.get(t) ?? [];
    idx.set(t, nextUnusedIdx(evs, consumed, fromTs));
  }
  let iFrom = nextUnusedIdx(fromEvents, consumed, fromTs);

  const isNot = kind === 'not';
  const earliestReady = (): { fid: string; ev: LogEvent } | null => {
    let best: { fid: string; ev: LogEvent } | null = null;
    for (const t of targets) {
      const evs = eventsByTarget.get(t) ?? [];
      let i = idx.get(t) ?? evs.length;
      while (i < evs.length && (evs[i].ts <= fromTs || consumed.has(evs[i].id))) i++;
      idx.set(t, i);
      if (i < evs.length) {
        const ev = evs[i];
        if (!best || ev.ts < best.ev.ts || (ev.ts === best.ev.ts && t < best.fid)) {
          best = { fid: t, ev };
        }
      }
    }
    return best;
  };

  // NOT：只关心「窗口内（在另一 A 或窗口耗尽之前）是否出现禁止目标」
  if (isNot) {
    while (true) {
      const fromEv = iFrom < fromEvents.length ? fromEvents[iFrom] : null;
      const ready = earliestReady();
      // 目标事件超出窗口或不存在 → 检查是否因另一 A 先到而提前结束
      if (ready && ready.ev.ts <= hi && (!fromEv || ready.ev.ts < fromEv.ts)) {
        return { violation: true, target: ready.ev };
      }
      // 另一 A 先到（或目标超窗）→ 观察期结束，B 未出现 → 通过
      return { ok: true, movedTo: null };
    }
  }

  // 推进型（seq / and / or）
  const andReady = new Map<string, LogEvent>();
  const targetSet = new Set(targets);
  while (true) {
    const fromEv = iFrom < fromEvents.length ? fromEvents[iFrom] : null;
    const fromTsNext = fromEv !== null ? fromEv.ts : Infinity;
    const ready = earliestReady();
    const readyTs = ready !== null ? ready.ev.ts : Infinity;

    if (readyTs > hi && fromTsNext > hi) return null; // 窗口耗尽
    if (readyTs <= hi && readyTs < fromTsNext && ready !== null) {
      // 目标先到
      if (kind === 'and') {
        andReady.set(ready.fid, ready.ev);
        // 消耗指针前移一位（该目标已就绪，继续看其它目标）
        idx.set(ready.fid, (idx.get(ready.fid) ?? 0) + 1);
        if (andReady.size === targetSet.size) {
          // 全部就绪：返回最早的一个作为 movedTo（其余在链产出时统一消耗）
          let first: LogEvent | null = null;
          for (const ev of andReady.values()) {
            if (first === null || ev.ts < first.ts) first = ev;
          }
          return { ok: true, movedTo: first };
        }
        continue; // 继续等其它目标
      }
      // seq / or：单就绪即推进
      return { ok: true, movedTo: ready.ev };
    }
    // 另一 A 实例先到（严格晚于 fromTs，未消耗，且在窗口内）或目标全超窗 → 断裂
    return null;
  }
}

/** periodic 自环断言：间隔三态（正常段 / 缺口 / 抖动） */
function assertHeartbeat(
  edge: SequenceEdge,
  events: LogEvent[],
  thread: string | null,
): HeartbeatGroup {
  const P = edge.periodMs ?? edge.maxGapMs;
  const delta = edge.maxGapMs;
  const g: HeartbeatGroup = {
    filterId: edge.fromFilterId,
    thread,
    segments: [],
    gaps: [],
    jitters: [],
  };
  if (events.length === 0) return g;
  let segStart = events[0].ts;
  let prev = events[0];
  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    const interval = ev.ts - prev.ts;
    if (interval > P + delta) {
      // 缺口：prev 之后期望 prev.ts+P 无心跳
      g.segments.push({ startTs: segStart, endTs: prev.ts });
      g.gaps.push({ afterTs: prev.ts, expectedTs: prev.ts + P });
      segStart = ev.ts;
    } else if (interval < P - delta) {
      // 抖动（不断段，仅记录）
      g.jitters.push({ ts: ev.ts, interval });
    }
    prev = ev;
  }
  g.segments.push({ startTs: segStart, endTs: prev.ts });
  return g;
}

/** 单桶（一个 thread 或全局）内跑链匹配 */
function matchBucket(
  config: SequenceConfig,
  filterIds: string[],
  matchByFilterId: Map<string, LogEvent[]>,
  consumed: Set<number>,
  thread: string | null,
): { chains: MatchedChain[]; edgeStats: Map<string, SequenceEdgeStat>; violations: NotViolation[] } {
  const edgeStats = new Map<string, SequenceEdgeStat>();
  for (const e of config.edges) {
    edgeStats.set(e.id, {
      edgeId: e.id,
      matchedCount: 0,
      missCount: 0,
      lateCount: 0,
      jitterCount: 0,
    });
  }
  const chains: MatchedChain[] = [];
  const violations: NotViolation[] = [];

  // 节点条件编译缓存（fid → 谓词；null=不过滤/非法）
  const condCache = new Map<string, ((ev: LogEvent) => boolean) | null>();
  const eventsOf = (fid: string): LogEvent[] => {
    const evs = filterIds.includes(fid) ? matchByFilterId.get(fid) ?? [] : [];
    const condSrc = config.nodeConditions?.[fid];
    if (!condSrc?.trim()) return evs;
    let pred = condCache.get(fid);
    if (pred === undefined) {
      const compiled = compileExpr(condSrc);
      pred = compiled === null ? null : compiled;
      condCache.set(fid, pred);
    }
    return pred ? evs.filter(pred) : evs;
  };

  // NOT 边：纯断言——对 from 的每个事件独立检查窗口（不消耗事件，不受链影响）
  // 规则：窗口内先遇禁止目标 → 违规；先遇另一 from 实例 → 观察期提前结束，通过；窗口耗尽 → 通过
  for (const edge of config.edges) {
    if (edge.kind !== 'not') continue;
    const fromEvents = eventsOf(edge.fromFilterId);
    const toEvents = eventsOf(edge.toFilterId);
    const noConsumed = new Set<number>();
    for (const fe of fromEvents) {
      const r = advanceEdge(
        edge,
        fromEvents,
        new Map([[edge.toFilterId, toEvents]]),
        noConsumed,
        fe.ts,
      );
      if (r !== null && 'violation' in r) {
        violations.push({ edgeId: edge.id, fromEvent: fe, toEvent: r.target });
        const st = edgeStats.get(edge.id);
        if (st) st.missCount++;
      }
    }
  }

  const resolved = resolveChains(config.edges);
  let chainIndex = 0;
  for (const chain of resolved) {
    const headFid = chain.edges[0].fromFilterId;
    const headEvents = eventsOf(headFid);
    if (headEvents.length === 0) {
      const st = edgeStats.get(chain.edges[0].id);
      if (st) st.missCount++;
      continue;
    }
    for (const e0 of headEvents) {
      if (consumed.has(e0.id)) continue;
      const steps: MatchedChain['steps'] = [
        { edgeId: null, filterId: headFid, event: e0 },
      ];
      let cur = e0;
      let ok = true;
      for (const edge of chain.edges) {
        const kind = edge.kind ?? 'seq';
        const fromEvents = eventsOf(edge.fromFilterId);
        const eventsByTarget = new Map<string, LogEvent[]>();
        for (const t of targetsOf(edge)) eventsByTarget.set(t, eventsOf(t));

        // ---- opt 边：目标在窗口内则消耗（长路径），否则跳过（短路径），均不断裂 ----
        if (kind === 'opt') {
          const rOpt = advanceEdge(
            { ...edge, kind: 'seq' }, // 复用 seq 推进（无插队放宽，插队仍断裂）
            fromEvents,
            eventsByTarget,
            consumed,
            cur.ts,
          );
          const st = edgeStats.get(edge.id);
          if (rOpt !== null && 'ok' in rOpt && rOpt.movedTo) {
            // 可选目标命中：消耗并推进
            if (st) st.matchedCount++;
            steps.push({ edgeId: edge.id, filterId: edge.toFilterId, event: rOpt.movedTo });
            cur = rOpt.movedTo;
          } else if (rOpt === null) {
            // 目标缺失/超窗/插队——opt 容忍插队语义：仅当「目标缺失」跳过；
            // advanceEdge 无法区分缺失与插队，这里统一跳过（opt 的容错优先于插队严格性，
            // 因为跳过后 cur 未动，链的时序基准仍由后续边约束）
            if (st) st.missCount++;
            // 不设 ok=false：跳过此边，cur 不动
          } else {
            // violation（不会发生：seq 无 violation）；防御：跳过
          }
          continue;
        }

        const r = advanceEdge(edge, fromEvents, eventsByTarget, consumed, cur.ts);
        if (r === null) {
          const st = edgeStats.get(edge.id);
          if (st) st.missCount++;
          ok = false;
          break;
        }
        if ('violation' in r) {
          violations.push({ edgeId: edge.id, fromEvent: cur, toEvent: r.target });
          const st = edgeStats.get(edge.id);
          if (st) st.missCount++;
          ok = false;
          break;
        }
        // 推进成功
        const st = edgeStats.get(edge.id);
        if (st) st.matchedCount++;
        if (r.movedTo) {
          // and：消耗全部就绪目标；其余：消耗 movedTo
          if (kind === 'and') {
            // 重新收集窗口内各目标最早未消耗事件（与 advanceEdge 一致）
            for (const t of targetsOf(edge)) {
              const evs = eventsByTarget.get(t) ?? [];
              const i = nextUnusedIdx(evs, consumed, cur.ts);
              if (i < evs.length && evs[i].ts <= cur.ts + edge.maxGapMs) {
                steps.push({ edgeId: edge.id, filterId: t, event: evs[i] });
              }
            }
            cur = r.movedTo; // 链时间推进以最早目标为准（AND 语义下后续边从最早目标起算）
          } else {
            const tFid =
              kind === 'or' || kind === 'seq'
                ? (Object.entries(eventsByTarget).find(
                    ([, evs]) => evs.includes(r.movedTo!),
                  )?.[0] ?? edge.toFilterId)
                : edge.toFilterId;
            steps.push({ edgeId: edge.id, filterId: tFid, event: r.movedTo });
            cur = r.movedTo;
            // ---- nodeCounts：目标节点需连续出现 [min,max] 次 ----
            const nc = config.nodeCounts?.[tFid];
            if (nc && nc.min > 1) {
              const evs = eventsOf(tFid);
              const collected: LogEvent[] = [];
              let lastTs = cur.ts;
              for (const ev of evs) {
                if (ev.ts <= lastTs) continue;
                if (ev.ts - lastTs > edge.maxGapMs) break;
                if (consumed.has(ev.id) || ev.id === cur.id) continue;
                collected.push(ev);
                lastTs = ev.ts;
                if (collected.length >= nc.max - 1) break; // 含首事件共 max 个
              }
              if (collected.length + 1 < nc.min) {
                // 连续数不足 min → 断裂
                const st = edgeStats.get(edge.id);
                if (st) st.missCount++;
                ok = false;
                break;
              }
              for (const ev of collected) {
                steps.push({ edgeId: edge.id, filterId: tFid, event: ev });
              }
              cur = collected.length > 0 ? collected[collected.length - 1] : cur;
            }
          }
        } else {
          // not 通过：不消耗、cur 不动（链继续走后续边，仍以 cur.ts 起算）
        }
      }
      if (!ok) continue;
      chainIndex++;
      for (const s of steps) consumed.add(s.event.id);
      chains.push({
        chainIndex,
        steps,
        startTs: steps[0].event.ts,
        endTs: steps[steps.length - 1].event.ts,
        thread,
      });
    }
  }
  return { chains, edgeStats, violations };
}

/**
 * 对单个 group 运行序列匹配（含作用域分桶 + periodic 断言）。
 */
export function matchGroup(
  config: SequenceConfig,
  filterIds: string[],
  matchByFilterId: Map<string, LogEvent[]>,
): SequenceMatchResult {
  const scope = config.scope ?? 'global';
  const consumed = new Set<number>();
  const allChains: MatchedChain[] = [];
  const violations: NotViolation[] = [];
  const totalStats = new Map<string, SequenceEdgeStat>();
  for (const e of config.edges) {
    totalStats.set(e.id, {
      edgeId: e.id,
      matchedCount: 0,
      missCount: 0,
      lateCount: 0,
      jitterCount: 0,
    });
  }
  const heartbeats: HeartbeatGroup[] = [];

  // periodic 边：独立断言（按作用域分桶）
  const periodicEdges = config.edges.filter((e) => e.kind === 'periodic');
  for (const e of periodicEdges) {
    const evs = matchByFilterId.get(e.fromFilterId) ?? [];
    if (scope === 'thread') {
      const byThread = new Map<string, LogEvent[]>();
      for (const ev of evs) {
        const key = ev.thread ?? '∅';
        let arr = byThread.get(key);
        if (!arr) {
          arr = [];
          byThread.set(key, arr);
        }
        arr.push(ev);
      }
      for (const [t, arr] of byThread) {
        heartbeats.push(assertHeartbeat(e, arr, t === '∅' ? null : t));
        const st = totalStats.get(e.id)!;
        st.lateCount! += heartbeats[heartbeats.length - 1].gaps.length;
        st.jitterCount! += heartbeats[heartbeats.length - 1].jitters.length;
      }
    } else {
      heartbeats.push(assertHeartbeat(e, evs, null));
      const st = totalStats.get(e.id)!;
      st.lateCount! += heartbeats[heartbeats.length - 1].gaps.length;
      st.jitterCount! += heartbeats[heartbeats.length - 1].jitters.length;
    }
  }

  // 推进链匹配（按作用域分桶）
  if (scope === 'thread') {
    // 收集所有涉及的 thread 桶
    const threads = new Set<string>();
    for (const fid of filterIds) {
      for (const ev of matchByFilterId.get(fid) ?? []) threads.add(ev.thread ?? '∅');
    }
    for (const t of threads) {
      const bucketMatch = new Map<string, LogEvent[]>();
      for (const fid of filterIds) {
        bucketMatch.set(
          fid,
          (matchByFilterId.get(fid) ?? []).filter((ev) => (ev.thread ?? '∅') === t),
        );
      }
      const r = matchBucket(config, filterIds, bucketMatch, consumed, t === '∅' ? null : t);
      allChains.push(...r.chains);
      violations.push(...r.violations);
      for (const [id, st] of r.edgeStats) {
        const tot = totalStats.get(id)!;
        tot.matchedCount += st.matchedCount;
        tot.missCount += st.missCount;
      }
    }
  } else {
    const r = matchBucket(config, filterIds, matchByFilterId, consumed, null);
    allChains.push(...r.chains);
    violations.push(...r.violations);
    for (const [id, st] of r.edgeStats) {
      const tot = totalStats.get(id)!;
      tot.matchedCount += st.matchedCount;
      tot.missCount += st.missCount;
    }
  }

  // 链按 startTs 排序重编 chainIndex
  allChains.sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs);
  allChains.forEach((c, i) => (c.chainIndex = i + 1));

  // 未覆盖事件
  const uncovered: LogEvent[] = [];
  for (const fid of filterIds) {
    for (const ev of matchByFilterId.get(fid) ?? []) {
      if (!consumed.has(ev.id)) uncovered.push(ev);
    }
  }
  uncovered.sort((a, b) => a.ts - b.ts || a.id - b.id);

  return {
    groupId: '',
    chains: allChains,
    uncoveredEvents: uncovered,
    edgeStats: Array.from(totalStats.values()),
    notViolations: violations,
    heartbeats,
  };
}

/**
 * 对所有配置了 sequence 的 group 运行匹配。
 * @returns groupId → SequenceMatchResult（未配置 sequence 的 group 不在结果中）
 */
export function runSequenceMatching(
  groups: { id: string; filterIds: string[]; sequence?: SequenceConfig }[],
  matches: FilterMatch[],
): Record<string, SequenceMatchResult> {
  const matchByFilterId = new Map<string, LogEvent[]>();
  for (const fm of matches) matchByFilterId.set(fm.filterId, fm.events);

  const out: Record<string, SequenceMatchResult> = {};
  for (const g of groups) {
    if (!g.sequence || g.sequence.edges.length === 0) continue;
    const r = matchGroup(g.sequence, g.filterIds, matchByFilterId);
    r.groupId = g.id;
    out[g.id] = r;
  }
  return out;
}
