import { useEffect, useMemo, useRef, useState } from 'react';
import { CEP_MAX_CHAINS, useLogStore } from '../store/logStore';
import { formatTime, formatDateTime, parseDateTime } from '../utils/timeFormat';
import type { Filter, FilterGroup, FilterMatch, LogEvent, SequenceMatchResult } from '../types';
import styles from './CepTimelinePanel.module.css';
import { ChevronLeft, ChevronRight, AlertTriangle } from './Icon';
import { fmtCompact, fmtCount } from '../utils/counts';
import { threadHint, type ThreadHint } from '../sequence/threadHint';
import { explainNoMatch, type Diagnosis } from '../sequence/explain';
import {
  aggregateAnomalyWindows,
  windowAt,
  LEVEL_LABEL,
  type AnomalySummary,
} from '../sequence/anomalyWindows';

interface CepNode {
  eventId: number;
  /** 图标色：链节点=来源 filter 色；异常/违规=红 */
  color: string;
  /** 节点序号（链内第几步，1-based）——图标上显示的数字 */
  stepNo: number;
  /** 悬浮提示：来源 filter 名 */
  filterLabel?: string;
  anomaly?: boolean;
  violation?: boolean;
}

/** CEP 面板一行：一条匹配链 / 一个异常事件 / 一对 NOT 违规 */
interface CepRow {
  /** 行序号（块内按 startTime 排序后 1-based） */
  count: number;
  startTs: number;
  endTs: number;
  /** 行类型（悬浮提示与样式） */
  kind: 'chain' | 'anomaly' | 'violation';
  /** 链号（链行标识；异常/违规为 0） */
  chainIndex: number;
  /** 右侧节点图标：有多少节点就有多少个 */
  nodes: CepNode[];
  /** 异常行专属：所属异常窗口的标注（如「连发 60 条 · 密集爆发」），
   *  让用户看出这几条是一伙的；非异常行为空 */
  note?: string;
}

/** 一个 CEP 规则分组的块 */
interface CepBlock {
  groupId: string;
  label: string;
  color: string;
  chainCount: number;
  anomalyCount: number;
  /** 该组异常高亮开关是否开启（从 group 编辑器迁入的开关，按组控制） */
  anomalyEnabled: boolean;
  /** 引擎/TS 回退仅回传了前 CEP_MAX_CHAINS 条链（真值更多） */
  overLimit: boolean;
  /** 行按 startTs 升序（全量，≤ 三类输入上限之和；渲染时按 limit 渐进切片） */
  rows: CepRow[];
  /** 仅按线程作用域时给出：thread 解析质量提示（无提示=null） */
  threadHint: ThreadHint | null;
  /** 仅零链时给出：「为何没匹配」诊断（无诊断=null）。基于各 filter 的实际
   *  命中反推，不参与匹配语义，故永远不会改变结果 */
  diagnoses: Diagnosis[] | null;
  /** 异常按时间聚合后的窗口（未开异常高亮时=null）。逐个事件报异常在大目录
   *  下是纯噪声，聚成段后段数本身就是信号 */
  anomalySummary: AnomalySummary | null;
  /** 异常事件真值（引擎/TS 回传的 totalUncovered；明细受上限截断） */
  anomalyTrueTotal: number;
}

/**
 * 块头统计的悬浮说明。异常部分刻意报**两件事**：段数（人能理解的规模）与
 * 原始条数（真值，明细可能受上限截断）——只报其中一个都会误导。
 */
function blockStatTitle(b: CepBlock): string {
  const lines = [`${fmtCount(b.chainCount)} 条链`];
  if (b.anomalySummary && b.anomalySummary.windows.length > 0) {
    lines.push(
      `${fmtCount(b.anomalySummary.windows.length)} 段异常窗口（原始 ${fmtCount(b.anomalyTrueTotal)} 条）`,
    );
    const { high, med } = b.anomalySummary.counts;
    if (high > 0) lines.push(`其中 ${fmtCount(high)} 段密集爆发`);
    else if (med > 0) lines.push(`其中 ${fmtCount(med)} 段成簇`);
  }
  if (b.overLimit) lines.push('（明细按上限回传，此处为完整统计）');
  return lines.join('\n');
}

/** 渲染批次：首屏渲染 200 行，滚动到底部（哨兵进入视口）自动续一批。
 *  数据侧上限 CEP_MAX_CHAINS（引擎/TS 回退每类行最多取该数），行对象
 *  全量构建但 DOM 按需增长——大目录宽松规则（数十万链）下全量渲染会
 *  把渲染进程 OOM 拖死。 */
const RENDER_BATCH = 200;

/** 链行：节点=各步 filter 色块 + 链内步序号 */
function chainRow(
  g: FilterGroup,
  chain: SequenceMatchResult['chains'][number],
  filters: Map<string, Filter>,
): CepRow {
  return {
    count: 0,
    startTs: chain.startTs,
    endTs: chain.endTs,
    kind: 'chain',
    chainIndex: chain.chainIndex,
    nodes: chain.steps.map((stp, i) => {
      const f = filters.get(stp.filterId);
      return {
        eventId: stp.event.id,
        color: f?.color ?? g.color,
        stepNo: i + 1,
        filterLabel: f?.label,
      };
    }),
  };
}

/** 从 sequenceResults 构建每分组的行列表（按 startTs 升序，时间纵轴与 filter 视图无关）。
 *  engineOk=false（引擎不可用/加载中）时抑制「为何没匹配」诊断——零链是
 *  "没跑"而非"跑过没匹配上"，此时给出的诊断全是误诊。 */
function buildBlocks(
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
  filters: Map<string, Filter>,
  matches: FilterMatch[],
  cepRange: { start: number; end: number } | null,
  engineOk: boolean,
): CepBlock[] {
  const out: CepBlock[] = [];
  for (const g of groups) {
    const r = sequenceResults[g.id];
    if (!r) continue;
    // 每类行取数据上限（引擎路径已截断；TS 回退无上限，防全量物化行对象）
    const anomalyEnabled = !!g.sequence?.anomalyEnabled;
    // 先聚合异常窗口（必须在逐条标注之前）：聚合只对**未筛选**的事件做，
    // 筛选后的子集会人为造出不存在的段落边界。
    const anomalySummary = anomalyEnabled ? aggregateAnomalyWindows(r.uncoveredEvents) : null;
    const anomalyTrueTotal = anomalyEnabled
      ? (r.totalUncovered ?? r.uncoveredEvents.length)
      : 0;
    const rows: CepRow[] = r.chains.slice(0, CEP_MAX_CHAINS).map((ch) => chainRow(g, ch, filters));
    if (anomalyEnabled) {
      const wins = anomalySummary?.windows ?? [];
      for (const ev of r.uncoveredEvents.slice(0, CEP_MAX_CHAINS)) {
        const w = windowAt(wins, ev.ts);
        rows.push({
          count: 0,
          startTs: ev.ts,
          endTs: ev.ts,
          kind: 'anomaly',
          chainIndex: 0,
          nodes: [{ eventId: ev.id, color: 'var(--anomaly, #cf222e)', stepNo: 1, anomaly: true }],
          note: w ? `连发 ${fmtCount(w.count)} 条 · ${LEVEL_LABEL[w.level]}` : undefined,
        });
      }
    }
    for (const v of r.notViolations.slice(0, CEP_MAX_CHAINS)) {
      const from = v.fromEvent as LogEvent;
      const to = v.toEvent as LogEvent;
      rows.push({
        count: 0,
        startTs: Math.min(from.ts, to.ts),
        endTs: Math.max(from.ts, to.ts),
        kind: 'violation',
        chainIndex: 0,
        nodes: [
          { eventId: from.id, color: 'var(--anomaly, #cf222e)', stepNo: 1, violation: true },
          { eventId: to.id, color: 'var(--anomaly, #cf222e)', stepNo: 2, violation: true },
        ],
      });
    }
    rows.sort((a, b) => a.startTs - b.startTs || a.chainIndex - b.chainIndex);
    // CEP 面板内时间窗筛选：保留与窗口重叠的行（链/违规按区间，点按时刻）
    const inRange = cepRange
      ? rows.filter((row) => row.endTs >= cepRange.start && row.startTs <= cepRange.end)
      : rows;
    // 行序号：块内按 startTime 排序后 1-based
    inRange.forEach((row, i) => {
      row.count = i + 1;
    });
    // 无时间窗筛选时取真值（inRange 受 CEP_MAX_CHAINS 限制），有筛选时取窗内行数
    const chainCount = cepRange
      ? inRange.filter((row) => row.kind === 'chain').length
      : (r.totalChains ?? r.chains.length);
    let anomalyCount = 0;
    if (anomalyEnabled) {
      const filtered = inRange.filter((row) => row.kind === 'anomaly').length;
      anomalyCount = cepRange ? filtered : anomalyTrueTotal;
    }
    const overLimit = (r.totalChains ?? r.chains.length) > CEP_MAX_CHAINS;
    // 诊断只按**总链数**判定，不受面板内时间窗筛选影响——否则筛选掉几行就
    // 弹出「为何没匹配」，纯属误导。
    const totalChains = r.totalChains ?? r.chains.length;
    out.push({
      groupId: g.id,
      label: g.label,
      color: g.color,
      chainCount,
      anomalyCount,
      anomalyEnabled,
      overLimit,
      rows: inRange,
      threadHint: g.sequence?.scope === 'thread' ? threadHint(r) : null,
      // 「为何没匹配」诊断：引擎可用且有序列规则时**始终可点**（不再仅零链时出现）。
      // 零链给完整诊断（含 overtaken hint），有链给 blocker/hint（zero=false 不报 overtaken）。
      diagnoses:
        engineOk && g.sequence ? explainNoMatch(g.sequence, matches, totalChains === 0) : null,
      anomalySummary,
      anomalyTrueTotal,
    });
  }
  return out;
}

function rowTitle(row: CepRow): string {
  if (row.kind === 'chain') return `链 ${row.chainIndex} · ${row.nodes.length} 节点`;
  if (row.kind === 'violation') return `NOT 违规 · A 窗口内出现禁止事件`;
  // 异常行带所属窗口标注——否则密密麻麻的异常列表里看不出哪几条是一伙的
  return row.note ? `异常 · 未被任何链覆盖（${row.note}）` : `异常 · 未被任何链覆盖`;
}

/** CEP 规则筛选结果面板：每行一条匹配链/异常（独立时间纵轴，仅在有结果时显示） */
export function CepTimelinePanel() {
  const groups = useLogStore((s) => s.groups);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const filters = useLogStore((s) => s.filters);
  const matches = useLogStore((s) => s.matches);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const focusEvent = useLogStore((s) => s.focusEvent);
  // 异常高亮开关（从 group 编辑器迁入）：按组控制未覆盖事件标红
  const toggleSequenceAnomaly = useLogStore((s) => s.toggleSequenceAnomaly);
  // CEP 引擎状态（wasm 是唯一 Web 引擎，TS 副本已删除）：失败显式横幅 + 重试
  const cepEngineError = useLogStore((s) => s.cepEngineError);
  const cepEnginePending = useLogStore((s) => s.cepEnginePending);
  const retryCepEngine = useLogStore((s) => s.retryCepEngine);
  // 面板收纳（收纳后留 24px 竖条作展开入口）
  const [collapsed, setCollapsed] = useState(false);
  // 每组渐进渲染上限（groupId → 已加载行数）：首屏 RENDER_BATCH 批，
  // 滚动到块底哨兵自动续一批；数据重建（重算/改规则）时全部复位
  const [limits, setLimits] = useState<Record<string, number>>({});
  // 「为何没匹配」诊断展开态（groupId → 是否展开）
  const [whyOpen, setWhyOpen] = useState<Record<string, boolean>>({});
  // CEP 面板内时间窗筛选（仅本面板生效，不动全局 viewRange）
  const [cepRange, setCepRange] = useState<{ start: number; end: number } | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  const openRange = () => {
    const vr = useLogStore.getState().viewRange;
    setRangeStart(cepRange ? formatDateTime(cepRange.start) : vr ? formatDateTime(vr.start) : '');
    setRangeEnd(cepRange ? formatDateTime(cepRange.end) : vr ? formatDateTime(vr.end) : '');
    setRangeOpen((o) => !o);
  };
  const applyRange = () => {
    const s = parseDateTime(rangeStart);
    const e = parseDateTime(rangeEnd);
    if (s != null && e != null && s <= e) {
      setCepRange({ start: s, end: e });
      setRangeOpen(false);
    }
  };
  const clearRange = () => {
    setCepRange(null);
    setRangeOpen(false);
  };

  // 配置了序列边的组数（结果可能因引擎未跑而为空，但规则本身存在）
  const seqGroupCount = useMemo(
    () => groups.filter((g) => g.sequence && g.sequence.edges.length > 0).length,
    [groups],
  );
  // 引擎挂了且确实有序列规则 → 面板必须活着显示横幅：否则 blocks 为空直接
  // return null，用户看到"什么都没有"，完全无法归因（正是本轮要消灭的盲区）
  const engineDown = cepEngineError !== null && seqGroupCount > 0;
  const enginePending = cepEnginePending && seqGroupCount > 0;

  const blocks = useMemo(() => {
    const filterMap = new Map(filters.map((f) => [f.id, f] as const));
    return buildBlocks(
      groups,
      sequenceResults,
      filterMap,
      matches,
      cepRange,
      cepEngineError === null && !cepEnginePending,
    );
  }, [groups, sequenceResults, filters, matches, cepRange, cepEngineError, cepEnginePending]);

  useEffect(() => {
    setLimits({});
  }, [blocks]);

  if (blocks.length === 0 && !engineDown && !enginePending) return null;

  if (collapsed) {
    return (
      <div className={styles.panelCollapsed}>
        <button
          className={styles.collapseBtn}
          title="展开 CEP 规则面板"
          onClick={() => setCollapsed(false)}
        >
          <ChevronRight size={16} strokeWidth={2.5} />
        </button>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>CEP 规则</span>
        <span className={styles.spacer} />
        <span className={styles.panelCount}>
          {engineDown ? seqGroupCount : blocks.length} 组规则
        </span>
        <button
          className={`${styles.rangeBtn} ${cepRange ? styles.rangeActive : ''}`}
          title="按时间筛选 CEP 结果（仅本面板生效）"
          onClick={openRange}
        >
          ⏱ 时间
        </button>
        {rangeOpen && (
          <div className={styles.rangePop}>
            <div className={styles.rangeRow}>
              <span className={styles.rangeLabel}>起</span>
              <input
                className={styles.rangeInput}
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                placeholder="YYYY-MM-DD HH:mm:ss.SSS"
              />
            </div>
            <div className={styles.rangeRow}>
              <span className={styles.rangeLabel}>止</span>
              <input
                className={styles.rangeInput}
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                placeholder="YYYY-MM-DD HH:mm:ss.SSS"
              />
            </div>
            <div className={styles.rangeActions}>
              <button className="ghost" onClick={clearRange}>清除</button>
              <button className={styles.rangeApply} onClick={applyRange}>应用</button>
            </div>
          </div>
        )}
      </div>
      {/* 引擎不可用横幅：TS 兜底已删除，失败必须显式呈现 + 可重试，
          绝不把"没跑"伪装成"没有匹配" */}
      {engineDown && (
        <div className={styles.engineBanner}>
          <AlertTriangle size={13} />
          <div className={styles.engineBannerBody}>
            <b>CEP 引擎不可用，序列匹配未执行</b>
            <span>{cepEngineError}</span>
          </div>
          <button
            className={styles.engineRetry}
            onClick={retryCepEngine}
            title="重置引擎加载状态并重试"
          >
            重试
          </button>
        </div>
      )}
      {enginePending && !engineDown && (
        <div className={styles.enginePending}>CEP 引擎加载中…</div>
      )}
      <div className={styles.panelBody}>
        {blocks.map((b) => {
          // 渐进渲染：只挂载已加载批次，行号 count 已在全量 rows 上编好
          const limit = limits[b.groupId] ?? RENDER_BATCH;
          const visible = b.rows.slice(0, limit);
          const hidden = b.rows.length - visible.length;
          return (
          <div key={b.groupId} className={styles.block}>
            <div className={styles.blockHeader} style={{ borderLeftColor: b.color }}>
              <span className={styles.blockDot} style={{ background: b.color }} />
              <span className={styles.blockTitle} title={b.label}>{b.label}</span>
              <span className={styles.blockStat} title={blockStatTitle(b)}>
                {fmtCompact(b.chainCount)} 链
                {/* 逐条报异常在大目录下是纯噪声，这里报**段**而不是条 */}
                {b.anomalySummary && b.anomalySummary.windows.length > 0
                  ? ` · ${fmtCompact(b.anomalySummary.windows.length)} 段异常`
                  : ''}
              </span>
              {b.threadHint && (
                <span
                  className={`${styles.threadStat} ${b.threadHint.warn ? styles.threadStatWarn : ''}`}
                  title={b.threadHint.title}
                >
                  {b.threadHint.text}
                </span>
              )}
              <button
                className={`${styles.anomalyToggle} ${b.anomalyEnabled ? styles.anomalyToggleActive : ''}`}
                title={
                  b.anomalyEnabled
                    ? `异常高亮已开启：${fmtCount(b.anomalyTrueTotal)} 个未覆盖事件` +
                      `（聚成 ${fmtCount(b.anomalySummary?.windows.length ?? 0)} 段）标红`
                    : '异常高亮已关闭：点击开启'
                }
                onClick={() => toggleSequenceAnomaly(b.groupId)}
              >
                <AlertTriangle size={13} />
                {/* 徽标也报段数：33 万条挤不进徽标，段数才是有用的信号 */}
                {b.anomalyEnabled && b.anomalySummary && b.anomalySummary.windows.length > 0 && (
                  <span className={styles.anomalyBadge}>
                    {fmtCompact(b.anomalySummary.windows.length)}
                  </span>
                )}
              </button>
              {b.diagnoses && (
                <button
                  className={`${styles.whyToggle} ${whyOpen[b.groupId] ? styles.whyToggleOpen : ''} ${b.diagnoses.length === 0 ? styles.whyToggleNeutral : ''}`}
                  title={b.diagnoses.length > 0 ? '点开看规则为何没匹配上' : '点开运行诊断'}
                  onClick={() => setWhyOpen((p) => ({ ...p, [b.groupId]: !p[b.groupId] }))}
                >
                  <ChevronRight size={12} />
                  {b.diagnoses.length > 0 ? '为何没匹配' : '诊断规则'}
                </button>
              )}
            </div>
            {b.diagnoses && whyOpen[b.groupId] && (
              b.diagnoses.length > 0 ? (
                <ul className={styles.whyList}>
                  {b.diagnoses.map((d, i) => (
                    <li
                      key={i}
                      className={d.severity === 'blocker' ? styles.whyBlocker : styles.whyHint}
                    >
                      <span className={styles.whyText}>{d.text}</span>
                      {d.detail && <span className={styles.whyDetail}>{d.detail}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className={styles.whyEmpty}>
                  {b.chainCount > 0
                    ? '规则匹配正常，未发现问题'
                    : '未匹配出链，但未发现明显配置问题（可放宽间隔、检查作用域或时间窗）'}
                </div>
              )
            )}
            {b.rows.length === 0 ? (
              <div className={styles.blockEmpty}>
                {b.diagnoses && b.diagnoses.length > 0
                  ? '零匹配 —— 展开上方「为何没匹配」看卡点'
                  : '无匹配结果'}
              </div>
            ) : (
              visible.map((row, ri) => (
                <div
                  key={`${row.startTs}-${ri}`}
                  className={`${styles.row} ${row.kind !== 'chain' ? styles.rowAnomaly : ''}`}
                  title={rowTitle(row)}
                >
                  <span className={styles.count}>{row.count}</span>
                  <span className={styles.timeRange}>
                    {formatTime(row.startTs)}
                    {row.endTs > row.startTs ? ` ~ ${formatTime(row.endTs)}` : ''}
                  </span>
                  <span className={styles.nodes}>
                    {row.nodes.map((n) => (
                      <button
                        key={n.eventId}
                        className={[
                          styles.node,
                          n.eventId === selectedEventId ? styles.nodeSelected : '',
                        ].join(' ')}
                        style={{ background: n.color }}
                        title={`${n.filterLabel ? n.filterLabel + ' · ' : ''}${n.anomaly ? '异常' : n.violation ? 'NOT 违规' : '点击跳转'}（事件 #${n.eventId}）`}
                        onClick={() => focusEvent(n.eventId)}
                      >
                        {n.stepNo}
                      </button>
                    ))}
                  </span>
                </div>
              ))
            )}
            {hidden > 0 && (
              <LoadMore
                onLoad={() =>
                  setLimits((p) => ({ ...p, [b.groupId]: (p[b.groupId] ?? RENDER_BATCH) + RENDER_BATCH }))
                }
              />
            )}
            {b.overLimit && (
              <div className={styles.blockMore}>
                引擎仅回传按时间序的前 {CEP_MAX_CHAINS} 条链（共 {b.chainCount}）——收窄规则或时间窗可查看其余
              </div>
            )}
          </div>
          );
        })}
      </div>
      <div className={styles.panelFooter}>
        <button
          className={styles.collapseBtn}
          title="收纳 CEP 面板"
          onClick={() => setCollapsed(true)}
        >
          <ChevronLeft size={16} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

/** 滚动到底自动续批的哨兵：进入视口（IntersectionObserver）即触发 onLoad。
 *  onLoad 用 ref 存最新回调，observer 只挂一次，避免每次渲染重建。 */
function LoadMore({ onLoad }: { onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) onLoadRef.current();
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={styles.blockMore}>
      下滑加载更多…
    </div>
  );
}
