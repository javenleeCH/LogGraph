import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CEP_MAX_CHAINS, useLogStore } from '../store/logStore';
import { formatTime, formatDateTime, parseDateTime } from '../utils/timeFormat';
import type { FilterGroup, FilterMatch, LogEvent, SequenceMatchResult } from '../types';
import styles from './CepTimelinePanel.module.css';
import { ChevronLeft, ChevronRight, AlertTriangle } from './Icon';
import { fmtCompact, fmtCount } from '../utils/counts';
import { threadHint, type ThreadHint } from '../sequence/threadHint';
import { keyHint, type KeyHint } from '../sequence/keyHint';
import { explainNoMatch, explainAnomalies, type Diagnosis } from '../sequence/explain';
import {
  aggregateAnomalyWindows,
  windowAt,
  LEVEL_LABEL,
  type AnomalySummary,
} from '../sequence/anomalyWindows';

// ---- 虚拟滚动布局常量（与 CepTimelinePanel.module.css 定高声明一一对应） ----
/** 单行高度（.row） */
const ROW_H = 26;
/** 块头高度（.blockHeader） */
const HEADER_H = 28;
/** 空态行高度（.blockEmpty） */
const EMPTY_H = 32;
/** 块底护栏提示行高度（.blockMore） */
const HINT_H = 26;
/** 「为何没匹配」展开区高度（.whyList/.whyEmpty，内部滚动） */
const WHY_H = 96;
/** .block 的 border-bottom(1) + padding-bottom(4) */
const BLOCK_TAIL = 5;
/** 滚动占位的浏览器高度上限（Chromium 布局钳制 ~33.55M px）：全量行高之和
 *  超过它会被引擎钳断 → 尾部行永远滚不到，占位高度必须压进上限 */
const MAX_SCROLL_PX = 33_000_000;
/** 行窗口上下冗余行数（OVERSCAN，缓解边界抖动；溢出块外的由 .block overflow 裁掉） */
const ROW_BUF = 2;
/** 行类型编码（并列时间戳排序：异常 → 违规 → 链） */
const KIND_ANOMALY = 0;
const KIND_VIOLATION = 1;
const KIND_CHAIN = 2;

type MatchedChain = SequenceMatchResult['chains'][number];
type NotViolation = SequenceMatchResult['notViolations'][number];

/**
 * 一个 CEP 规则分组的虚拟块：只保存**引用与索引**，不物化行对象。
 * 百万级异常（SoA 全量回传）下物化 CepRow[] 会把渲染进程拖死；
 * rowKind/rowRef 两个 typed array 每行仅 ~5B，滚到哪才构造哪行的 DOM。
 */
interface VBlock {
  groupId: string;
  label: string;
  color: string;
  chainCount: number;
  anomalyCount: number;
  /** 该组异常高亮开关是否开启（从 group 编辑器迁入的开关，按组控制） */
  anomalyEnabled: boolean;
  /** 链明细超护栏（totalChains > CEP_MAX_CHAINS） */
  overLimit: boolean;
  /** 仅按线程作用域时给出：thread 解析质量提示（无提示=null） */
  threadHint: ThreadHint | null;
  /** 仅关联键作用域时给出：key 提取质量提示（无提示=null） */
  keyHint: KeyHint | null;
  /** 引擎可用且有序列规则时给出：「为何没匹配」诊断（无诊断=null） */
  diagnoses: Diagnosis[] | null;
  /** 异常按时间聚合后的窗口（未开异常高亮时=null）。**在未筛选事件上聚合**：
   *  筛选后的子集会人为造出不存在的段落边界 */
  anomalySummary: AnomalySummary | null;
  /** 异常事件真值（SoA 全量回传，恒为真值） */
  anomalyTrueTotal: number;
  /** 未覆盖 SoA 引用（恒为引擎回传原值，不受异常高亮开关影响）——诊断归因用 */
  uncSoa: { ids: number[]; ts: number[] };
  /** 未覆盖总数（真值，不受异常高亮开关影响）——诊断入口的判定用 */
  uncTotal: number;
  /** 链渲染引用（cepRange 时为窗内子集，保持 startTs 升序） */
  chains: MatchedChain[];
  /** SoA 引用（anomalyEnabled 时非空） */
  unc: { ids: number[]; ts: number[] } | null;
  /** NOT 违规渲染引用（按区间起点稳定排序） */
  violations: NotViolation[];
  /** 与 violations 同序的区间起点（含 cepRange 筛选） */
  violStart: Float64Array;
  /** 合并行流：行类型 + 该类型数组内的下标 */
  rowKind: Uint8Array;
  rowRef: Uint32Array;
  rowCount: number;
}

/**
 * 块头统计的悬浮说明。异常部分刻意报**两件事**：段数（人能理解的规模）与
 * 原始条数（真值）——只报其中一个都会误导。
 */
function blockStatTitle(b: VBlock): string {
  const lines = [`${fmtCount(b.chainCount)} 条链`];
  if (b.anomalySummary && b.anomalySummary.windows.length > 0) {
    lines.push(
      `${fmtCount(b.anomalySummary.windows.length)} 段异常窗口（原始 ${fmtCount(b.anomalyTrueTotal)} 条）`,
    );
    const { high, med } = b.anomalySummary.counts;
    if (high > 0) lines.push(`其中 ${fmtCount(high)} 段密集爆发`);
    else if (med > 0) lines.push(`其中 ${fmtCount(med)} 段成簇`);
  }
  if (b.overLimit) lines.push('（链明细按护栏上限回传，此处为完整统计）');
  return lines.join('\n');
}

/** 构建单个分组的虚拟块。engineOk=false（引擎不可用/加载中）时抑制
 *  「为何没匹配」诊断——零链是"没跑"而非"跑过没匹配上"，此时给出的
 *  诊断全是误诊。 */
function buildVBlock(
  g: FilterGroup,
  r: SequenceMatchResult,
  matches: FilterMatch[],
  cepRange: { start: number; end: number } | null,
  engineOk: boolean,
): VBlock {
  const anomalyEnabled = !!g.sequence?.anomalyEnabled;
  const totalChains = r.totalChains ?? r.chains.length;
  // 异常窗口聚合：必须先于逐条标注、且在**未筛选**事件上做
  const anomalySummary = anomalyEnabled ? aggregateAnomalyWindows(r.uncovered.ts) : null;
  const anomalyTrueTotal = anomalyEnabled ? r.uncovered.ids.length : 0;

  // 链：cepRange 时按区间重叠过滤（保持 startTs 升序）
  const chains = cepRange
    ? r.chains.filter((c) => c.startTs <= cepRange.end && c.endTs >= cepRange.start)
    : r.chains;
  const chainCount = cepRange ? chains.length : totalChains;

  // NOT 违规：区间 [min(from,to), max(from,to)]，按起点稳定排序
  const violations = cepRange
    ? r.notViolations.filter((v) => {
        const a = (v.fromEvent as LogEvent).ts;
        const b = (v.toEvent as LogEvent).ts;
        return Math.min(a, b) <= cepRange.end && Math.max(a, b) >= cepRange.start;
      })
    : r.notViolations;
  // NOT 违规：按区间起点稳定排序（带下标，避免比较器里反查）
  const order = violations
    .map((v, i) => ({
      i,
      start: Math.min((v.fromEvent as LogEvent).ts, (v.toEvent as LogEvent).ts),
    }))
    .sort((a, b) => a.start - b.start || a.i - b.i);
  const violList = order.map((o) => violations[o.i]);
  const violStart = Float64Array.from(order, (o) => o.start);

  // 异常流：SoA 已按 (ts,id) 升序；cepRange 时统计窗内条数（流内只含窗内行）
  const unc = anomalyEnabled ? r.uncovered : null;
  let uncInRange = 0;
  if (unc && cepRange) {
    for (let i = 0; i < unc.ts.length; i++) {
      if (unc.ts[i] >= cepRange.start && unc.ts[i] <= cepRange.end) uncInRange++;
    }
  }

  // 三路归并（并列时间戳按 异常→违规→链 定序）填 rowKind/rowRef；
  // 三条输入流各自升序，ui 沿 SoA 推进时跳过窗外行
  const nChain = chains.length;
  const nViol = violList.length;
  const nUnc = unc ? (cepRange ? uncInRange : unc.ids.length) : 0;
  const rowKind = new Uint8Array(nChain + nViol + nUnc);
  const rowRef = new Uint32Array(nChain + nViol + nUnc);
  let ci = 0;
  let vi = 0;
  let ui = 0;
  let n = 0;
  for (;;) {
    while (unc && ui < unc.ids.length && cepRange && (unc.ts[ui] < cepRange.start || unc.ts[ui] > cepRange.end)) ui++;
    const hasC = ci < nChain;
    const hasV = vi < nViol;
    const hasU = !!unc && ui < unc.ids.length;
    if (!hasC && !hasV && !hasU) break;
    const minTs = Math.min(
      hasC ? chains[ci].startTs : Infinity,
      hasV ? violStart[vi] : Infinity,
      hasU ? unc!.ts[ui] : Infinity,
    );
    if (hasU && unc!.ts[ui] === minTs) {
      rowKind[n] = KIND_ANOMALY;
      rowRef[n] = ui;
      ui++;
    } else if (hasV && violStart[vi] === minTs) {
      rowKind[n] = KIND_VIOLATION;
      rowRef[n] = vi;
      vi++;
    } else {
      rowKind[n] = KIND_CHAIN;
      rowRef[n] = ci;
      ci++;
    }
    n++;
  }

  return {
    groupId: g.id,
    label: g.label,
    color: g.color,
    chainCount,
    anomalyCount: cepRange ? uncInRange : anomalyTrueTotal,
    anomalyEnabled,
    overLimit: totalChains > CEP_MAX_CHAINS,
    threadHint: g.sequence?.scope === 'thread' ? threadHint(r) : null,
    keyHint: g.sequence?.scope === 'key' ? keyHint(r) : null,
    // 「为何没匹配」诊断：引擎可用且有序列规则时**始终可点**。零链给完整
    // 诊断（含 overtaken hint），有链给 blocker/hint。诊断只按总链数判定，
    // 不受面板内时间窗筛选影响——否则筛选掉几行就弹出诊断，纯属误导。
    diagnoses: engineOk && g.sequence ? explainNoMatch(g.sequence, matches, totalChains === 0) : null,
    anomalySummary,
    anomalyTrueTotal,
    uncSoa: r.uncovered,
    uncTotal: r.uncovered.ids.length,
    chains,
    unc,
    violations: violList,
    violStart,
    rowKind,
    rowRef,
    rowCount: n,
  };
}

/** 从 sequenceResults 构建每分组的虚拟块（时间纵轴与 filter 视图无关） */
function buildVBlocks(
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
  matches: FilterMatch[],
  cepRange: { start: number; end: number } | null,
  engineOk: boolean,
): VBlock[] {
  const out: VBlock[] = [];
  for (const g of groups) {
    const r = sequenceResults[g.id];
    if (!r) continue;
    out.push(buildVBlock(g, r, matches, cepRange, engineOk));
  }
  return out;
}

/** 虚拟布局段：一个块在滚动坐标系中的落位 */
interface Seg {
  b: VBlock;
  top: number;
  h: number;
  /** 行区起始 y（块内相对，= HEADER_H + (why?WHY_H:0)） */
  rowsTop: number;
  /** 行区高度（rowCount*ROW_H；0 行时用 EMPTY_H 占位） */
  rowsH: number;
  hasWhy: boolean;
  hasHint: boolean;
}

/** CEP 规则筛选结果面板：每行一条匹配链/异常（独立时间纵轴，仅在有结果时显示）。
 *  虚拟滚动：DOM 行数只随视口大小变化，滚动条长度反映全量行数。 */
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
  // 「为何没匹配」诊断展开态（groupId → 是否展开）
  const [whyOpen, setWhyOpen] = useState<Record<string, boolean>>({});
  // CEP 面板内时间窗筛选（仅本面板生效，不动全局 viewRange）
  const [cepRange, setCepRange] = useState<{ start: number; end: number } | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  // 虚拟滚动状态
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);

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

  // filter 色板查询（构建块与渲染行共用）
  const filterMap = useMemo(
    () => new Map(filters.map((f) => [f.id, f] as const)),
    [filters],
  );
  const vblocks = useMemo(
    () =>
      buildVBlocks(
        groups,
        sequenceResults,
        matches,
        cepRange,
        cepEngineError === null && !cepEnginePending,
      ),
    [groups, sequenceResults, matches, cepRange, cepEngineError, cepEnginePending],
  );

  // 异常归因诊断：explainAnomalies 是 O(参与过滤器命中总数) 的扫描，只在
  // 用户展开某组诊断时才算那一组（平时零开销）。归因看的是引擎回传的
  // uncovered 真值，不受异常高亮开关影响——高亮关着也不该说「未发现问题」。
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g] as const)), [groups]);
  const anomalyDiag = useMemo(() => {
    const out: Record<string, Diagnosis[]> = {};
    for (const b of vblocks) {
      if (!whyOpen[b.groupId] || b.uncTotal === 0) continue;
      const g = groupById.get(b.groupId);
      if (!g) continue;
      out[b.groupId] = explainAnomalies(g.filterIds, b.uncSoa, matches);
    }
    return out;
  }, [vblocks, whyOpen, matches, groupById]);

  // 数据重建（重算/改规则/改时间窗）或滚动区重挂（收纳再展开）时复位滚动
  useEffect(() => {
    setScrollTop(0);
    bodyEl?.scrollTo(0, 0);
  }, [vblocks, bodyEl]);

  // 视口尺寸跟随。bodyEl 用回调 ref 存 state：首渲染结果未出时面板提前
  // return null，挂在 ref 上的 effect([]) 会空跑（元素尚未挂载）且永不重跑
  // → viewH 永久停在初始值 600。依赖 bodyEl 才能在真正挂载后测量。
  useEffect(() => {
    if (!bodyEl) return;
    setViewH(bodyEl.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setViewH(e.contentRect.height);
    });
    ro.observe(bodyEl);
    return () => ro.disconnect();
  }, [bodyEl]);

  // 布局：前缀和求各块落位（whyOpen / overLimit 影响块高）
  const { segs, totalH } = useMemo(() => {
    const segList: Seg[] = [];
    let top = 0;
    for (const b of vblocks) {
      const hasWhy = whyOpen[b.groupId] && !!b.diagnoses;
      const hasHint = b.overLimit;
      const rowsH = b.rowCount > 0 ? b.rowCount * ROW_H : EMPTY_H;
      const rowsTop = HEADER_H + (hasWhy ? WHY_H : 0);
      const h = rowsTop + rowsH + (hasHint ? HINT_H : 0) + BLOCK_TAIL;
      segList.push({ b, top, h, rowsTop, rowsH, hasWhy, hasHint });
      top += h;
    }
    return { segs: segList, totalH: top };
  }, [vblocks, whyOpen]);

  if (vblocks.length === 0 && !engineDown && !enginePending) return null;

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

  // 浏览器滚动高度上限（Chromium ~33.55M px）：329 万行 × 26px ≈ 8554 万 px
  // 远超上限，超限的占位高度会被布局引擎钳制 → 尾部行永远滚不到。把占位
  // 高度压进上限，物理滚动量按「滚动分数 × 逻辑可滚动量」仿射映射回逻辑
  // 偏移（虚拟列表通例）：物理满滚时逻辑恰好到底，首尾行恒可达；压缩比
  // 下滚动步长等比放大，属预期手感。
  const physTotal = Math.min(totalH, MAX_SCROLL_PX);
  const physScrollMax = Math.max(0, physTotal - viewH);
  const viewTop =
    physScrollMax > 0 ? (scrollTop / physScrollMax) * Math.max(0, totalH - viewH) : 0;
  const viewBottom = viewTop + viewH;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>CEP 规则</span>
        <span className={styles.spacer} />
        <span className={styles.panelCount}>
          {engineDown ? seqGroupCount : vblocks.length} 组规则
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
      <div
        className={styles.panelBody}
        ref={setBodyEl}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {/* 视口钉层：sticky 停在滚动区可视顶部，块按「逻辑位置 − 逻辑滚动量」
            绝对定位落位，overflow hidden 裁掉窗外内容（含 OVERSCAN 冗余行） */}
        <div className={styles.viewport} style={{ height: viewH }}>
          {segs
            .filter(
              (seg) => seg.top < viewBottom && seg.top + seg.h > viewTop,
            )
            .map((seg) => {
              const b = seg.b;
              // 块头钉层（手动 sticky）：块顶滚出视口后块头贴住视口顶、随
              // 块尾离开——异常/诊断按钮在任意滚动位置都可达，展开的诊断
              // 内容同样钉在块头下方（CSS sticky 在绝对定位布局下失效）
              const hy = Math.max(0, Math.min(viewTop - seg.top, seg.h - HEADER_H));
              // 诊断内容 = 配置诊断（为何没匹配）+ 异常归因（哪些过滤器的
              // 命中没进链，展开时才计算）
              const diag = [...(b.diagnoses ?? []), ...(anomalyDiag[b.groupId] ?? [])];
              // 行窗口：视口映射到块内行号区间，上下各冗余 ROW_BUF 行
              const first = Math.max(
                0,
                Math.floor((viewTop - seg.top - seg.rowsTop) / ROW_H) - ROW_BUF,
              );
              const last = Math.min(
                b.rowCount,
                Math.ceil((viewBottom - seg.top - seg.rowsTop) / ROW_H) + ROW_BUF,
              );
              const rows: ReactNode[] = [];
              for (let i = first; i < last; i++) {
                const kind = b.rowKind[i];
                const ref = b.rowRef[i];
                if (kind === KIND_CHAIN) {
                  const ch = b.chains[ref];
                  rows.push(
                    <div
                      key={`c${ref}`}
                      className={styles.row}
                      title={`链 ${ch.chainIndex} · ${ch.steps.length} 节点`}
                    >
                      <span className={styles.count}>{i + 1}</span>
                      <span className={styles.timeRange}>
                        {formatTime(ch.startTs)}
                        {ch.endTs > ch.startTs ? ` ~ ${formatTime(ch.endTs)}` : ''}
                      </span>
                      <span className={styles.nodes}>
                        {ch.steps.map((stp, si) => {
                          const f = filterMap.get(stp.filterId);
                          return (
                            <button
                              key={`${stp.event.id}-${si}`}
                              className={`${styles.node} ${
                                stp.event.id === selectedEventId ? styles.nodeSelected : ''
                              }`}
                              style={{ background: f?.color ?? b.color }}
                              title={`${f?.label ? f.label + ' · ' : ''}点击跳转（事件 #${stp.event.id}）`}
                              onClick={() => focusEvent(stp.event.id)}
                            >
                              {si + 1}
                            </button>
                          );
                        })}
                      </span>
                    </div>,
                  );
                } else if (kind === KIND_VIOLATION) {
                  const v = b.violations[ref];
                  const from = v.fromEvent as LogEvent;
                  const to = v.toEvent as LogEvent;
                  rows.push(
                    <div
                      key={`v${ref}`}
                      className={`${styles.row} ${styles.rowAnomaly}`}
                      title="NOT 违规 · A 窗口内出现禁止事件"
                    >
                      <span className={styles.count}>{i + 1}</span>
                      <span className={styles.timeRange}>
                        {formatTime(Math.min(from.ts, to.ts))}
                        {to.ts !== from.ts ? ` ~ ${formatTime(Math.max(from.ts, to.ts))}` : ''}
                      </span>
                      <span className={styles.nodes}>
                        {[
                          { ev: from, no: 1 },
                          { ev: to, no: 2 },
                        ].map(({ ev, no }) => (
                          <button
                            key={`${ev.id}-${no}`}
                            className={`${styles.node} ${
                              ev.id === selectedEventId ? styles.nodeSelected : ''
                            }`}
                            style={{ background: 'var(--anomaly, #cf222e)' }}
                            title={`NOT 违规 · 点击跳转（事件 #${ev.id}）`}
                            onClick={() => focusEvent(ev.id)}
                          >
                            {no}
                          </button>
                        ))}
                      </span>
                    </div>,
                  );
                } else {
                  const id = b.unc!.ids[ref];
                  const ts = b.unc!.ts[ref];
                  const w = windowAt(b.anomalySummary?.windows ?? [], ts);
                  const note = w ? `连发 ${fmtCount(w.count)} 条 · ${LEVEL_LABEL[w.level]}` : undefined;
                  rows.push(
                    <div
                      key={`u${ref}`}
                      className={`${styles.row} ${styles.rowAnomaly}`}
                      title={note ? `异常 · 未被任何链覆盖（${note}）` : '异常 · 未被任何链覆盖'}
                    >
                      <span className={styles.count}>{i + 1}</span>
                      <span className={styles.timeRange}>{formatTime(ts)}</span>
                      <span className={styles.nodes}>
                        <button
                          className={`${styles.node} ${
                            id === selectedEventId ? styles.nodeSelected : ''
                          }`}
                          style={{ background: 'var(--anomaly, #cf222e)' }}
                          title={`异常 · 点击跳转（事件 #${id}）`}
                          onClick={() => focusEvent(id)}
                        >
                          1
                        </button>
                      </span>
                    </div>,
                  );
                }
              }
              return (
                <div
                  key={b.groupId}
                  className={styles.block}
                  style={{ position: 'absolute', top: seg.top - viewTop, height: seg.h, left: 0, right: 0 }}
                >
                  <div className={styles.blockHeader} style={{ top: hy, borderLeftColor: b.color }}>
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
                    {b.keyHint && (
                      <span
                        className={`${styles.threadStat} ${b.keyHint.warn ? styles.threadStatWarn : ''}`}
                        title={b.keyHint.title}
                      >
                        {b.keyHint.text}
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
                        className={`${styles.whyToggle} ${whyOpen[b.groupId] ? styles.whyToggleOpen : ''} ${
                          b.diagnoses.length === 0 && b.uncTotal === 0 ? styles.whyToggleNeutral : ''
                        }`}
                        title={
                          b.diagnoses.length > 0
                            ? '点开看规则为何没匹配上'
                            : b.uncTotal > 0
                              ? '点开看异常归因：哪些过滤器的命中没进链'
                              : '点开运行诊断'
                        }
                        onClick={() => setWhyOpen((p) => ({ ...p, [b.groupId]: !p[b.groupId] }))}
                      >
                        <ChevronRight size={12} />
                        {b.diagnoses.length > 0 ? '为何没匹配' : b.uncTotal > 0 ? '诊断异常' : '诊断规则'}
                      </button>
                    )}
                  </div>
                  {seg.hasWhy && (
                    <div className={styles.whyPane} style={{ top: hy + HEADER_H }}>
                      {diag.length > 0 ? (
                        <ul className={styles.whyList}>
                          {diag.map((d, i) => (
                            <li
                              key={i}
                              className={
                                d.severity === 'blocker'
                                  ? styles.whyBlocker
                                  : d.severity === 'anomaly'
                                    ? styles.whyAnomaly
                                    : styles.whyHint
                              }
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
                      )}
                    </div>
                  )}
                  {b.rowCount === 0 ? (
                    <div
                      className={styles.blockEmpty}
                      style={{ position: 'absolute', top: seg.rowsTop, left: 0, right: 0 }}
                    >
                      {b.diagnoses && b.diagnoses.length > 0
                        ? '零匹配 —— 展开上方「为何没匹配」看卡点'
                        : '无匹配结果'}
                    </div>
                  ) : (
                    <div
                      style={{
                        position: 'absolute',
                        top: seg.rowsTop + first * ROW_H,
                        left: 0,
                        right: 0,
                      }}
                    >
                      {rows}
                    </div>
                  )}
                  {seg.hasHint && (
                    <div
                      className={styles.blockMore}
                      style={{
                        position: 'absolute',
                        top: seg.rowsTop + seg.rowsH,
                        left: 0,
                        right: 0,
                      }}
                    >
                      引擎仅回传按时间序的前 {fmtCount(CEP_MAX_CHAINS)} 条链（共 {fmtCount(b.chainCount)}）——收窄规则或时间窗可查看其余
                    </div>
                  )}
                </div>
              );
            })}
        </div>
        {/* 滚动占位：高度=全量行高之和（超浏览器上限时按比例压缩，见
            MAX_SCROLL_PX），滚动条长度尽可能反映真实数据量；物理滚动量经
            scale 映射回逻辑偏移，尾部行始终可达 */}
        <div style={{ height: Math.max(0, physTotal - viewH) }} />
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
