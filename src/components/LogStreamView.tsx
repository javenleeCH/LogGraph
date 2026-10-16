import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { hitTsByLine, useLogStore } from '../store/logStore';
import { LaneHeader } from './LaneHeader';
import { bisectLeft } from '../timeline/correlation';
import { formatTime, formatDuration, chooseTickStep } from '../utils/timeFormat';
import { levelColor as getLevelColor } from '../constants';
import { ChevronLeft, ChevronRight, AlignCenter, Columns, Globe } from './Icon';
import { CepTimelinePanel } from './CepTimelinePanel';
import { WelcomeState, NoFilterState } from './EmptyState';
import type { LogEvent, Filter, FilterGroup, SequenceMatchResult } from '../types';
import styles from './LogStreamView.module.css';
import { fetchLinesByIds } from '../io/dbStore';
const CARD_H = 20; // 单个事件卡片高度
const ROW_PAD = 4; // 行内上下留白
const TIME_COL_WIDTH = 104; // 左侧时间列宽
const MIN_LANE_WIDTH = 120; // 每列最小宽度
const GLOBAL_TICK_H = 80; // 全局模式：每个刻度最小高度
const GLOBAL_CASCADE = 16; // 全局模式：同时间事件级联偏移（略小于卡片高，形成层叠）
const DENSITY_BUCKET_H = 3; // 全局模式密度桶高度（px）
const DENSITY_CARD_THRESHOLD = 3; // 桶内事件数超过此值则只显示密度、不显示卡片
const LINE_TEXT_BATCH = 500; // dbMode 行文本分批拉取批量
const LINE_TEXT_LRU_MAX = 20_000; // dbMode 行文本缓存上限（防长滚动内存膨胀）

/**
 * 二分定位选中事件在该列（ts 有序）中的下标：先二分 ts，再在同 ts 的
 * 少量事件内线性比对 id。避免每列 O(N) 全量扫描（lanes × 百万事件不可接受）。
 */
function lanePosOf(evs: LogEvent[], id: number | null, ts: number | null): number {
  if (id === null || ts === null || evs.length === 0) return -1;
  let lo = 0;
  let hi = evs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (evs[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < evs.length && evs[i].ts === ts; i++) {
    if (evs[i].id === id) return i;
  }
  return -1;
}

/** hex 颜色 -> [r, g, b] */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const num = parseInt(n, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

interface RowData {
  ts: number;
  /** 行高 = 同 ts 最大堆叠数 * CARD_H + 2*ROW_PAD */
  height: number;
  /** 行顶部 Y = 之前所有行高之和 */
  top: number;
}

interface TickMark {
  ts: number;
  y: number;
}

/**
 * 对齐模式行结构：各 lane（ts 升序）k 路游标归并出全局去重时间戳，
 * 行高 = 同 ts 的最大堆叠数。lane 内事件、行内堆叠均按需二分取
 * （runOf / stackPosOf）——不物化 laneByTs / rowOfEvent / cardTopOfEvent
 * 三个百万级 Map，zoom/pan 重建从秒级降到百 ms 级。
 */
function buildRows(
  matches: { filterId: string; events: LogEvent[] }[],
  viewRange: { start: number; end: number } | null,
): {
  rows: RowData[];
  /** 各 lane 在 viewRange 内的事件切片（ts 升序） */
  laneEvents: LogEvent[][];
} {
  if (!viewRange || matches.length === 0) {
    return { rows: [], laneEvents: matches.map(() => []) };
  }
  const laneEvents = matches.map((fm) => {
    const evs = fm.events;
    const s = bisectLeft(evs, viewRange.start);
    // end 含端点：bisectLeft 返回首个 >= end 的下标，直接 slice 会把
    // ts===end 的事件切掉——全局时间戳最大的行在纵轴视图永远不渲染
    // （ts 为整数毫秒，+1 即闭区间）
    const e = bisectLeft(evs, viewRange.end + 1);
    return evs.slice(s, e);
  });
  const k = laneEvents.length;
  const cur = new Int32Array(k);
  const rows: RowData[] = [];
  let top = 0;
  for (;;) {
    let ts = Infinity;
    for (let l = 0; l < k; l++) {
      const le = laneEvents[l];
      const c = cur[l];
      if (c < le.length && le[c].ts < ts) ts = le[c].ts;
    }
    if (ts === Infinity) break;
    let maxCount = 1;
    for (let l = 0; l < k; l++) {
      const le = laneEvents[l];
      let c = cur[l];
      let cnt = 0;
      while (c < le.length && le[c].ts === ts) {
        c++;
        cnt++;
      }
      if (cnt > maxCount) maxCount = cnt;
      cur[l] = c;
    }
    const height = maxCount * CARD_H + ROW_PAD * 2;
    rows.push({ ts, height, top });
    top += height;
  }
  return { rows, laneEvents };
}

const NO_EVENTS: LogEvent[] = [];

/** ts 有序 lane 内取同 ts 连续段（无 → 共享空数组，避免每行分配） */
function runOf(evs: LogEvent[], ts: number): LogEvent[] {
  const s = bisectLeft(evs, ts);
  if (s >= evs.length || evs[s].ts !== ts) return NO_EVENTS;
  let e = s + 1;
  while (e < evs.length && evs[e].ts === ts) e++;
  return evs.slice(s, e);
}

/** 同 ts 堆叠内的位次（选中滚动定位用；-1 = 该事件不在此 lane） */
function stackPosOf(evs: LogEvent[], id: number, ts: number): number {
  const s = bisectLeft(evs, ts);
  for (let i = s; i < evs.length && evs[i].ts === ts; i++) {
    if (evs[i].id === id) return i - s;
  }
  return -1;
}

/** rows 按 ts 严格升序：ts → 行下标（不存在返回 -1） */
function rowIndexOfTs(rows: RowData[], ts: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo < rows.length && rows[lo].ts === ts ? lo : -1;
}

/** 卡片角标（可见卡片渲染时按需合成，不再百万级物化） */
interface ChainMark {
  chainIndex: number;
  color: string;
  anomaly: boolean;
  /** NOT 边违规（红 ⃠） */
  violation?: boolean;
  /** periodic 抖动（黄 ⚡） */
  jitter?: boolean;
}

/** 每 filter 的 CEP 标记索引。旧实现给每个命中物化一个 ChainMark 对象
 *  （百万级命中 = 百万对象 + 百万 Map 条目，GC 压力拖垮交互）：
 *  覆盖关系只存 number（链号），标记对象在可见卡片渲染时合成。 */
interface LaneMarks {
  /** 引用该 filter 的各 group 一层：首个覆盖事件的 layer 胜出（与旧实现的首个 group 胜出一致） */
  layers: { color: string; chainOf: Map<number, number> }[];
  /** 首个开启异常检测的 group 色：未入任何链的事件 → 异常。
 *  （旧实现按"未被该 group 覆盖"判定，多 group 引用同一 filter 且首个
 *  group 无链时会把其它 group 已覆盖的事件误标异常，此处改为未入任何链） */
  anomalyColor: string | null;
  /** 显式覆盖标记（NOT 违规 / 抖动，量 ≤ 链上限） */
  overrides: Map<number, ChainMark>;
  get(id: number): ChainMark | undefined;
}

function buildLaneMarks(
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
  visibleMatches: { filterId: string; events: LogEvent[] }[],
): Map<string, LaneMarks> {
  const m = new Map<string, LaneMarks>();
  const marksOf = (fid: string): LaneMarks => {
    let mk = m.get(fid);
    if (!mk) {
      mk = {
        layers: [],
        anomalyColor: null,
        overrides: new Map(),
        get(id) {
          const ov = this.overrides.get(id);
          if (ov) return ov;
          for (const L of this.layers) {
            const c = L.chainOf.get(id);
            if (c !== undefined) return { chainIndex: c, color: L.color, anomaly: false };
          }
          return this.anomalyColor !== null
            ? { chainIndex: 0, color: this.anomalyColor, anomaly: true }
            : undefined;
        },
      };
      m.set(fid, mk);
    }
    return mk;
  };
  for (const g of groups) {
    const r = sequenceResults[g.id];
    if (!r) continue;
    for (const fid of g.filterIds) {
      const mk = marksOf(fid);
      // 覆盖层：引擎截断（maxChains）时全量标记由 coveredMarks 回传，
      // 否则从 chains 推导（TS 引擎 / 未设上限路径）
      const marks = r.coveredMarks?.[fid];
      const chainOf = new Map<number, number>();
      if (marks) {
        for (const [id, chainIndex] of marks) chainOf.set(id, chainIndex);
      } else {
        for (const ch of r.chains) {
          for (const stp of ch.steps) {
            if (stp.filterId === fid && !chainOf.has(stp.event.id)) {
              chainOf.set(stp.event.id, ch.chainIndex);
            }
          }
        }
      }
      mk.layers.push({ color: g.color, chainOf });
      if (g.sequence?.anomalyEnabled && mk.anomalyColor === null) mk.anomalyColor = g.color;
    }
    // NOT 违规：按边定义的 from/to filter 标记（覆盖链/异常标记）
    for (const edge of g.sequence?.edges ?? []) {
      if ((edge.kind ?? 'seq') !== 'not') continue;
      const vs = r.notViolations.filter((v) => v.edgeId === edge.id);
      if (vs.length === 0) continue;
      const pairs: [string, LogEvent][] = vs.flatMap((v) => [
        [edge.fromFilterId, v.fromEvent as LogEvent],
        [edge.toFilterId, v.toEvent as LogEvent],
      ]);
      for (const [fid, ev] of pairs) {
        const mk = m.get(fid);
        if (!mk) continue;
        mk.overrides.set(ev.id, {
          chainIndex: mk.get(ev.id)?.chainIndex ?? 0,
          color: g.color,
          anomaly: true,
          violation: true,
        });
      }
    }
    // periodic 抖动标记（仅 TS 引擎路径有 heartbeats）
    for (const hb of r.heartbeats) {
      const mk = m.get(hb.filterId);
      if (!mk) continue;
      const evs = visibleMatches.find((mm) => mm.filterId === hb.filterId)?.events ?? [];
      for (const jt of hb.jitters) {
        // 二分定位同 ts 首事件（旧 find 对全 lane 线性扫描）
        const i = bisectLeft(evs, jt.ts);
        if (i < evs.length && evs[i].ts === jt.ts && !mk.overrides.get(evs[i].id)?.violation) {
          mk.overrides.set(evs[i].id, { chainIndex: 0, color: g.color, anomaly: false, jitter: true });
        }
      }
    }
  }
  return m;
}

/** 可见列分段：group 包裹子 filter 列 + 顶层 filter 列 */
interface ColumnSegment {
  kind: 'group' | 'top';
  /** group 段的组对象（top 段为 null） */
  group?: FilterGroup;
  /** 该段内的 filter 列表：
   *  - index: 该 filter 在 visibleFilters 中的全局索引（用于取 laneEvents/matches 等数据，同一 filter 多位置共享）
   *  - slot: 列实例位置（全局递增，不去重；用于取 colWidths，同一 filter 在不同 group 出现时宽度独立） */
  filters: { filter: Filter; index: number; slot: number }[];
}

/**
 * 按 groups 顺序构建列分段：
 * - 每个可见 group 一个 segment（含其子 filter，按 g.filterIds 顺序，跳过已删除 / 不可见的）
 * - 顶层 filter（不被任何 group 引用）一个 segment
 * 不可见 filter（所属 group 全部隐藏的）不出现在任何段中。
 */
function buildVisibleColumns(
  visibleFilters: Filter[],
  groups: FilterGroup[],
): ColumnSegment[] {
  const segments: ColumnSegment[] = [];
  // 列实例计数器：每个出现在界面上的 filter 列实例递增分配一个 slot，
  // 用于 colWidths 索引。同一 filter 被多个 group 引用时各位置 slot 不同 → 宽度独立
  let slotCounter = 0;
  // 不可见 filter 的集合（所属 group 全部隐藏 → 真隐藏）
  const visibleGroupIds = new Set(
    groups.filter((g) => g.visible !== false).map((g) => g.id),
  );
  const isInvisible = (f: Filter) => {
    const owning = groups.filter((g) => g.filterIds.includes(f.id));
    return owning.length > 0 && !owning.some((g) => visibleGroupIds.has(g.id));
  };

  // 全局索引查找
  const globalIdx = (fid: string) => visibleFilters.findIndex((f) => f.id === fid);

  // 1. 按 groups 顺序
  for (const g of groups) {
    if (g.visible === false) continue;
    const cols: { filter: Filter; index: number; slot: number }[] = [];
    for (const fid of g.filterIds) {
      const idx = globalIdx(fid);
      if (idx < 0) continue; // 不在可见 filter 列表里（可能被隐藏或已删除）
      cols.push({ filter: visibleFilters[idx], index: idx, slot: slotCounter++ });
    }
    if (cols.length > 0) {
      segments.push({ kind: 'group', group: g, filters: cols });
    }
  }

  // 2. 顶层 filter（不被任何 group 引用，且可见）
  const referencedByAnyGroup = new Set<string>();
  for (const g of groups) {
    for (const fid of g.filterIds) referencedByAnyGroup.add(fid);
  }
  const topCols: { filter: Filter; index: number; slot: number }[] = [];
  for (let i = 0; i < visibleFilters.length; i++) {
    const f = visibleFilters[i];
    if (referencedByAnyGroup.has(f.id)) continue;
    if (isInvisible(f)) continue;
    topCols.push({ filter: f, index: i, slot: slotCounter++ });
  }
  if (topCols.length > 0) {
    segments.push({ kind: 'top', group: undefined, filters: topCols });
  }

  return segments;
}

type ViewMode = 'aligned' | 'independent' | 'global';

const MODE_LABEL: Record<ViewMode, string> = {
  aligned: '对齐',
  independent: '独立',
  global: '全局',
};

export function LogStreamView() {
  const viewRange = useLogStore((s) => s.viewRange);
  const fullRange = useLogStore((s) => s.fullRange);
  const matches = useLogStore((s) => s.matches);
  const filtersComputing = useLogStore((s) => s.filtersComputing);
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  // 可见 filter（多对多 + 真隐藏语义）：
  // - 不属于任何 group 的 filter → 可见（顶层）
  // - 属于至少一个可见 group 的 filter → 可见
  // - 所属 group 全部隐藏的 filter → 不可见（真隐藏，不回流）
  const visibleFilters = useMemo(() => {
    const visibleGroupIds = new Set(
      groups.filter((g) => g.visible !== false).map((g) => g.id),
    );
    return filters.filter((f) => {
      const owning = groups.filter((g) => g.filterIds.includes(f.id));
      if (owning.length === 0) return true; // 顶层无组 → 可见
      return owning.some((g) => visibleGroupIds.has(g.id));
    });
  }, [filters, groups]);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const correlatedEventIds = useLogStore((s) => s.correlatedEventIds);
  const hoveredEventId = useLogStore((s) => s.hoveredEventId);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const setHovered = useLogStore((s) => s.setHovered);
  const resetView = useLogStore((s) => s.resetView);
  const focusEvent = useLogStore((s) => s.focusEvent);
  // 选中事件的时间戳（列头序号二分定位用；dbMode 走行号命中表）
  const selTs = useMemo(() => {
    if (selectedEventId === null) return null;
    const s = useLogStore.getState();
    return s.dbMode
      ? hitTsByLine(s, selectedEventId)
      : (s.events.find((e) => e.id === selectedEventId)?.ts ?? null);
  }, [selectedEventId]);
  // dbMode（SQLite 驻留）：事件只有骨架（raw=''），需要按视口惰性取行文本
  const dbMode = useLogStore((s) => s.dbMode);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  // 时间轴模式：aligned=按事件时间戳对齐；independent=各列独立；global=固定刻度时间尺
  const [mode, setMode] = useState<ViewMode>('aligned');
  // 纵轴视图 group 左右折叠状态（本地，独立于时间线的 collapsed）
  const [segCollapsed, setSegCollapsed] = useState<Record<string, boolean>>({});
  const toggleSeg = (gid: string) =>
    setSegCollapsed((prev) => ({ ...prev, [gid]: !prev[gid] }));

  // 只取可见 filter 对应的 matches（顺序与 visibleFilters 一致）
  const visibleMatches = useMemo(
    () =>
      visibleFilters
        .map((f) => matches.find((m) => m.filterId === f.id))
        .filter((m): m is NonNullable<typeof m> => !!m),
    [visibleFilters, matches],
  );
  // 可见列分段：group 包裹子 filter + 顶层 filter
  const segments = useMemo(
    () => buildVisibleColumns(visibleFilters, groups),
    [visibleFilters, groups],
  );

  /**
   * 序列链信息（卡片角标用）：filterId → LaneMarks。anomaly 只有在该
   * group 异常开关开启时才标记；结构见 buildLaneMarks。
   */
  const chainInfoByFilter = useMemo(
    () => buildLaneMarks(groups, sequenceResults, visibleMatches),
    [groups, sequenceResults, visibleMatches],
  );
  // 所有 group 标题列总宽（每个固定 28px），需从可用宽度扣除
  const segHeadersW = useMemo(
    () => segments.filter((s) => s.kind === 'group').length * 28,
    [segments],
  );
  // 列实例总数（同一 filter 多处出现各算一个 slot），用于 colWidths 初始化和 resizer 总宽
  const totalSlots = useMemo(
    () => segments.reduce((sum, s) => sum + s.filters.length, 0),
    [segments],
  );
  // 列 resizer 总宽（每列右侧一个 5px）
  const resizersW = useMemo(
    () => totalSlots * 5,
    [totalSlots],
  );
  const { rows, laneEvents } = useMemo(
    () => buildRows(visibleMatches, viewRange),
    [visibleMatches, viewRange],
  );

  const totalHeight =
    rows.length > 0 ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;

  // 列宽：绝对像素数组（每列独立宽度，允许总宽超出容器→横向滚动）
  const measureRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(800);
  // colWidths 为 state（直接像素，按列实例 slot 索引）；
  // 同一 filter 在多个 group 出现时各 slot 独立宽度。拖动列 slot 边界仅改 colWidths[slot]，
  // 后续列宽度不变 → 它们整体位置随 flex 排列自然右移（即"整体平移跟随"）
  const [colWidths, setColWidths] = useState<number[]>([]);
  // dbMode 下列表只持有骨架事件（raw=''），按视口惰性从 cache.db 取行文本（no=全局行号=event.id）
  const [lineText, setLineText] = useState<Map<number, string>>(new Map());
  // 列实例数量变化时重置为等分填充可用宽
  useEffect(() => {
    setColWidths((prev) => {
      const n = totalSlots;
      if (prev.length === n) return prev;
      const w = Math.max(MIN_LANE_WIDTH, Math.floor(viewportW / Math.max(1, n)));
      return new Array(n).fill(w);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalSlots]);
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportW(Math.max(0, el.clientWidth - TIME_COL_WIDTH - segHeadersW - resizersW));
      setViewportH(el.clientHeight);
    });
    ro.observe(el);
    setViewportW(Math.max(0, el.clientWidth - TIME_COL_WIDTH - segHeadersW - resizersW));
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, [segHeadersW, resizersW]);

  // 列拖拽：resizer 在每个 filter 右侧，拖动改该 slot（列实例）宽度（idx=slot），
  // 仅 colWidths[slot] 改变（±dx），后面所有列宽度不变 → 随 flex 排列整体平移跟随，
  // 超出容器宽度则由 .body 的 overflow-x:auto 横向滚动。
  // 同一 filter 在多个 group 出现时各 slot 独立，互不影响。
  const colDrag = useRef<{ idx: number; startX: number; startWidths: number[] } | null>(null);
  const onColResizeDown = useCallback(
    (idx: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      colDrag.current = { idx, startX: e.clientX, startWidths: [...colWidths] };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [colWidths],
  );
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // filter 列拖拽（resizer 在右侧改自身 slot）：拖右 dx>0 → 该 slot 变宽，
      // 后面所有列宽度不变 → 随 flex 排列整体右移平移，resizer 位于 lane 右边界跟随鼠标
      const d = colDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const widths = [...d.startWidths];
      const i = d.idx;
      if (i >= widths.length) return;
      widths[i] = Math.max(MIN_LANE_WIDTH, d.startWidths[i] + dx);
      setColWidths(widths);
    };
    const onUp = () => {
      if (colDrag.current) {
        colDrag.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 对齐模式：虚拟化按行前缀和二分定位可见行
  const overscan = 6;
  const visibleRows = useMemo(() => {
    if (rows.length === 0) return [];
    const minTop = scrollTop - overscan * 2 * CARD_H;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].top < minTop) lo = mid + 1;
      else hi = mid;
    }
    let i = Math.max(0, lo - 1);
    i = Math.max(0, i - overscan);
    const out: RowData[] = [];
    for (; i < rows.length; i++) {
      out.push(rows[i]);
      if (rows[i].top > scrollTop + viewportH + overscan * 2 * CARD_H) break;
    }
    return out;
  }, [rows, scrollTop, viewportH]);

  // 全局模式：固定刻度时间尺，事件按真实时间戳线性映射到 Y
  const globalData = useMemo(() => {
    if (mode !== 'global' || !viewRange) return null;
    const spanMs = viewRange.end - viewRange.start;
    if (spanMs <= 0) return null;
    const tickStep = chooseTickStep(spanMs, 8);
    const tickCount = Math.ceil(spanMs / tickStep) + 1;
    const totalH = Math.max(viewportH, tickCount * GLOBAL_TICK_H);
    const pxPerMs = totalH / spanMs;
    const ticks: TickMark[] = [];
    const first = Math.ceil(viewRange.start / tickStep) * tickStep;
    for (let t = first; t <= viewRange.end; t += tickStep) {
      ticks.push({ ts: t, y: (t - viewRange.start) * pxPerMs });
    }
    return { tickStep, pxPerMs, totalH, ticks };
  }, [mode, viewRange, viewportH]);

  // WASD 快捷键：W/S 缩放时间窗，A/D 平移时间窗
  // WASD 滚动：W/S 上下滚动（同滚轮），A/D 左右滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (!['w', 's', 'a', 'd'].includes(key)) return;
      const el = scrollRef.current;
      if (!el) return;
      e.preventDefault();
      const step = e.shiftKey ? el.clientHeight * 0.8 : 60;
      const hStep = e.shiftKey ? el.clientWidth * 0.6 : 80;
      if (key === 'w') {
        el.scrollBy({ top: -step, behavior: 'auto' });
      } else if (key === 's') {
        el.scrollBy({ top: step, behavior: 'auto' });
      } else if (key === 'a') {
        el.scrollBy({ left: -hStep, behavior: 'auto' });
      } else if (key === 'd') {
        el.scrollBy({ left: hStep, behavior: 'auto' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 选中事件自动滚动
  const lastScrollTarget = useRef<number | null>(null);
  useEffect(() => {
    if (selectedEventId === null) {
      lastScrollTarget.current = null;
      return;
    }
    if (lastScrollTarget.current === selectedEventId) return;
    const el = scrollRef.current;
    if (!el) return;

    // O(log) 定位：事件 ts → 行二分；堆叠位次 → 所在 lane 内二分。
    // 旧实现查 rowOfEvent/cardTopOfEvent 两个全量 Map（百万级条目，
    // buildRows 每次 zoom/pan 重建 = 主线程卡死的根因之一）。
    if (selTs === null) return;
    const rowIdx = rowIndexOfTs(rows, selTs);
    if (rowIdx < 0) return;
    const targetRow = rows[rowIdx];
    // 该事件必须在某个可见 lane 内（隐藏 filter 的事件无卡片，不滚动）
    let lanePos = -1;
    for (const fm of visibleMatches) {
      lanePos = stackPosOf(fm.events, selectedEventId, selTs);
      if (lanePos >= 0) break;
    }
    if (lanePos < 0) return;

    // 目标卡片（对齐模式用堆叠内精确 Y；全局模式用 ts 映射 Y，忽略级联偏移）
    const cardY =
      mode === 'global' && viewRange && globalData
        ? (targetRow.ts - viewRange.start) * globalData.pxPerMs
        : targetRow.top + 2 + lanePos * CARD_H;

    // 卡片已（完全）可见 → 一动不动。按行 top 判定会误伤：高堆叠行或行顶
    // 在视口上沿之外的行，卡片明明可见也被拽到固定位置（"点击后自己跳转"
    // 的根因）；不可见时也只做最小量滚动露出卡片，不再跳到 1/3 视口处。
    if (cardY >= el.scrollTop && cardY + CARD_H <= el.scrollTop + el.clientHeight) {
      lastScrollTarget.current = selectedEventId;
      return;
    }
    const MARGIN = 24;
    if (cardY < el.scrollTop) {
      // 在视口上方：下滚刚好露出（带上边距）
      el.scrollTo({ top: Math.max(0, cardY - MARGIN), behavior: 'smooth' });
    } else {
      // 在视口下方：上滚刚好露出（带下边距）
      el.scrollTo({ top: cardY + CARD_H + MARGIN - el.clientHeight, behavior: 'smooth' });
    }
    lastScrollTarget.current = selectedEventId;
  }, [selectedEventId, selTs, rows, visibleMatches, mode, viewRange, globalData]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    // 直接同步 DOM transform，绕过 React 渲染延迟，与原生滚动同帧
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
  }, []);

  // lane 内事件按 ts 按需二分取（runOf），不预建 laneByTs 索引

  // 当前视口内真正会渲染的事件 id 集合（按视图模式推断），供 dbMode 惰性取文本
  const renderedIds = useMemo(() => {
    if (!dbMode) return [] as number[];
    const ids: number[] = [];
    if (mode === 'aligned') {
      for (const r of visibleRows) {
        for (const le of laneEvents) {
          const evs = runOf(le, r.ts);
          for (let i = 0; i < evs.length; i++) ids.push(evs[i].id);
        }
      }
    } else if (mode === 'global' && viewRange && globalData) {
      const yTop = Math.max(0, scrollTop - 60);
      const yBot = scrollTop + viewportH + 60;
      const tsTop = viewRange.start + yTop / globalData.pxPerMs;
      const tsBot = viewRange.start + yBot / globalData.pxPerMs;
      for (const le of laneEvents) {
        let s = bisectLeft(le, tsTop);
        if (s > 0) s -= 1;
        const e = bisectLeft(le, tsBot) + 1;
        for (let i = Math.max(0, s); i < Math.min(le.length, e); i++) ids.push(le[i].id);
      }
    } else {
      // independent：各列按虚拟滚动切片
      const cardH = CARD_H + 2;
      const overscan = 8;
      const startIdx = Math.max(0, Math.floor(scrollTop / cardH) - overscan);
      const count = Math.ceil(viewportH / cardH) + overscan * 2;
      const endIdx = startIdx + count;
      for (const le of laneEvents) {
        for (let i = startIdx; i < Math.min(le.length, endIdx); i++) ids.push(le[i].id);
      }
    }
    return Array.from(new Set(ids));
  }, [dbMode, mode, visibleRows, laneEvents, viewRange, globalData, scrollTop, viewportH]);

  // dbMode：按视口事件 id 分批取行文本（v3 id 契约，替代旧 min/max 区间——
  // 多文件时间交叠时区间会横跨数百万行）+ LRU 上限防长时间滚动内存膨胀
  useEffect(() => {
    if (!dbMode || renderedIds.length === 0) return;
    const missing = renderedIds.filter((id) => !lineText.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += LINE_TEXT_BATCH) {
        try {
          const got = await fetchLinesByIds(missing.slice(i, i + LINE_TEXT_BATCH));
          if (cancelled) return;
          setLineText((prev) => {
            const next = new Map(prev);
            for (const [k, v] of got) next.set(k, v);
            // LRU：Map 插入序即新旧序，超限删最旧
            if (next.size > LINE_TEXT_LRU_MAX) {
              let over = next.size - LINE_TEXT_LRU_MAX;
              for (const k of next.keys()) {
                if (over <= 0) break;
                if (got.has(k)) continue; // 本批刚取回的不驱逐
                next.delete(k);
                over--;
              }
            }
            return next;
          });
        } catch (err) {
          console.warn('[dbMode] 行文本惰性加载失败:', err);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbMode, renderedIds, lineText]);

  if (!viewRange || !fullRange) {
    return (
      <div ref={measureRef} className={styles.empty}>
        <WelcomeState />
      </div>
    );
  }

  if (visibleFilters.length === 0) {
    return (
      <div ref={measureRef} className={styles.empty}>
        <NoFilterState />
      </div>
    );
  }

  const showTimeCol = mode !== 'independent';

  /** 渲染 filter 右侧竖向 resizer：拖动改该 slot（列实例）宽度，
   *  后面所有列随 flex 排列整体平移跟随。每个 filter 右侧都有一个（含末列），
   *  resizer 位于 lane 右边界，拖动时跟随鼠标，手感直观。 */
  const renderColResizer = (slot: number) => (
    <div
      key={'rs' + slot}
      className={styles.colResizer}
      onMouseDown={(e) => onColResizeDown(slot, e)}
      title="拖拽调节列宽"
    />
  );

  /** 渲染一个分段的子列：filters 为该段的列列表
   *  group 段：左侧竖向标题列（可点击左右折叠）+ 右侧子 filter 列
   *  top 段：无标题列，仅子 filter 列
   *  renderLane 同时接收 li（取数据，同 filter 多位置共享）和 slot（取宽度，独立） */
  const renderSegmentColumns = (
    seg: ColumnSegment,
    renderLane: (f: Filter, li: number, slot: number) => React.ReactNode,
    // true=列头上下文（渲染完整标题：文字/caret/计数/可点击折叠）
    // false=主体上下文（仅渲染 sticky 纯色占位条，纵向滚动时钉在顶部不跟随）
    isHeaderCtx = false,
  ) => {
    const gid = seg.kind === 'group' ? seg.group!.id : '';
    const collapsed = gid ? !!segCollapsed[gid] : false;
    return (
      <div
        key={seg.kind === 'group' ? 'g-' + gid : 'top'}
        className={`${styles.segWrapper} ${collapsed ? styles.segCollapsed : ''}`}
      >
        {seg.kind === 'group' &&
          (() => {
            // 色盲安全 + 高对比：group 色上叠半透明深色层，强制压低亮度，
            // 使白字对比度始终 ≥ 4.5:1，同时保留色相供辨识；不受色觉缺陷影响
            const c = seg.group!.color;
            const bg = `linear-gradient(rgba(0,0,0,0.42), rgba(0,0,0,0.42)), ${c}`;
            const seqRes = sequenceResults[gid];
            return isHeaderCtx ? (
              // 列头：完整标题（可点击折叠），固定宽度整体
              <div
                className={styles.segHeader}
                style={{
                  background: bg,
                  color: '#ffffff',
                  borderRightColor: 'var(--border)',
                }}
                onClick={() => toggleSeg(gid)}
                title={collapsed ? '点击展开子列' : '点击折叠子列'}
              >
                <span className={styles.segDot} style={{ background: c, boxShadow: '0 0 0 1.5px rgba(255,255,255,0.7)' }} />
                <span className={styles.segTitleV} style={{ color: '#ffffff' }}>
                  {seg.group!.label}
                </span>
                {seqRes && seqRes.chains.length > 0 && (
                  <span
                    className={styles.segSeqStat}
                    title={`序列链 ${seqRes.chains.length} 条${seg.group!.sequence?.anomalyEnabled ? ` · 异常 ${seqRes.uncoveredEvents.length} 条` : ''}`}
                  >
                    ⛓{seqRes.chains.length}
                    {seg.group!.sequence?.anomalyEnabled && seqRes.uncoveredEvents.length > 0 && (
                      <span className={styles.segSeqAnomaly}>⚠{seqRes.uncoveredEvents.length}</span>
                    )}
                  </span>
                )}
                <span className={styles.segCount} style={{ color: '#ffffff', background: 'rgba(255,255,255,0.18)' }}>
                  {seg.filters.length}
                </span>
                <span className={styles.segCaret} style={{ color: '#ffffff' }}>
                  {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                </span>
              </div>
            ) : (
              // 主体：sticky 纯色占位条（无文字，钉在可视区顶部），固定宽度整体
              <div
                className={styles.segHeaderBody}
                style={{ background: bg, borderRightColor: 'var(--border)' }}
                aria-hidden="true"
              />
            );
          })()}
        <div className={styles.segCols}>
          {seg.filters.map(({ filter: f, index: li, slot }) => (
            <Fragment key={gid + '-' + slot}>
              {renderLane(f, li, slot)}
              {renderColResizer(slot)}
            </Fragment>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div ref={measureRef} className={styles.wrap}>
      {/* 顶栏 */}
      <div className={styles.header}>
        <span className={styles.headerLabel}>纵轴视图</span>
        <span className={styles.headerInfo}>
          {formatTime(viewRange.start)} → {formatTime(viewRange.end)}
        </span>
        <span className={styles.headerDivider}>|</span>
        <span className={styles.headerInfo}>窗宽 {formatDuration(viewRange.end - viewRange.start)}</span>
        <span className={styles.headerDivider}>|</span>
        <span className={styles.headerInfo}>
          {mode === 'global'
            ? `${globalData?.ticks.length ?? 0} 刻度 · ${visibleFilters.length} 列`
            : `${rows.length} 个时间点 · ${visibleFilters.length} 列`}
        </span>
        <span className={styles.spacer} />
        <span className={styles.hint} title="W/S 上下滚动，A/D 左右滚动">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
        </span>
        <div
          className={styles.modeSwitch}
          title="时间轴模式：对齐=按事件时间戳分行对齐；独立=各列自由排列无时间轴；全局=固定刻度时间尺，按密度着色"
        >
          {(['aligned', 'independent', 'global'] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={styles.modeBtn + (mode === m ? ' ' + styles.modeBtnActive : '')}
              onClick={() => setMode(m)}
            >
              {m === 'aligned' && <AlignCenter size={12} />}
              {m === 'independent' && <Columns size={12} />}
              {m === 'global' && <Globe size={12} />}
              <span>{MODE_LABEL[m]}</span>
            </button>
          ))}
        </div>
        <button className="ghost" onClick={resetView} title="重置为全量">
          全量
        </button>
      </div>

      {/* 主体行：左 CEP 规则结果（独立时间纵轴）+ 右 filter 视图 */}
      <div className={styles.mainRow}>
        <CepTimelinePanel />
        <div className={styles.filterArea}>
      {/* 列头（内层 inner 跟随主体横向滚动，transform 由 ref 同步避免脱轨） */}
      <div className={styles.columnHeader}>
        <div ref={headerInnerRef} className={styles.columnHeaderInner}>
          {showTimeCol && (
            <div className={styles.timeColHeader} style={{ width: TIME_COL_WIDTH }}>
              时间
            </div>
          )}
          {segments.map((seg) =>
            renderSegmentColumns(
              seg,
              (f, li, slot) => (
                <LaneHeader
                  filter={f}
                  width={colWidths[slot] ?? MIN_LANE_WIDTH}
                  events={visibleMatches[li]?.events ?? []}
                  pos={lanePosOf(visibleMatches[li]?.events ?? [], selectedEventId, selTs)}
                  onNav={focusEvent}
                />
              ),
              true,
            ),
          )}
        </div>
      </div>

      {/* 主体 */}
      <div ref={scrollRef} className={styles.body} onScroll={onScroll}>
        {mode === 'global' && globalData ? (
          /* —— 全局时间轴模式：固定刻度时间尺，密度热力 + 稀疏时卡片 —— */
          <div className={styles.gridInner} style={{ height: globalData.totalH }}>
            <div className={styles.timeCol} style={{ width: TIME_COL_WIDTH }}>
              {globalData.ticks
                .filter((t) => t.y >= scrollTop - 40 && t.y <= scrollTop + viewportH + 40)
                .map((t) => (
                  <div
                    key={t.ts}
                    className={styles.tickRow}
                    style={{ top: t.y, height: 'auto' }}
                  >
                    <span className={styles.tickLabel}>{formatTime(t.ts)}</span>
                    <span className={styles.tickLine} />
                  </div>
                ))}
              {globalData.ticks.length === 0 && (
                <div className={filtersComputing ? styles.computingMsg : styles.emptyMsg}>{filtersComputing ? '正在计算过滤…' : '当前时间窗内无刻度'}</div>
              )}
            </div>

            {segments.map((seg) =>
              renderSegmentColumns(seg, (f, li, slot) => (
                <GlobalLane
                  color={f.color}
                  width={colWidths[slot] ?? MIN_LANE_WIDTH}
                  events={laneEvents[li] ?? []}
                  viewRange={viewRange}
                  pxPerMs={globalData.pxPerMs}
                  ticks={globalData.ticks}
                  scrollTop={scrollTop}
                  viewportH={viewportH}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  chainInfo={chainInfoByFilter.get(f.id)}
                  lineText={lineText}
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
              )),
            )}
          </div>
        ) : mode === 'aligned' ? (
          /* —— 对齐模式：按时间戳并集分行，各列同时间行顶部对齐 —— */
          <div className={styles.gridInner} style={{ height: totalHeight }}>
            <div className={styles.timeCol} style={{ width: TIME_COL_WIDTH }}>
              {visibleRows.map((r) => (
                <div
                  key={r.ts}
                  className={styles.tickRow}
                  style={{ top: r.top, height: r.height }}
                >
                  <span className={styles.tickLabel}>{formatTime(r.ts)}</span>
                  <span className={styles.tickLine} />
                </div>
              ))}
              {visibleRows.length === 0 && (
                <div className={filtersComputing ? styles.computingMsg : styles.emptyMsg}>{filtersComputing ? '正在计算过滤…' : '当前时间窗内无匹配事件'}</div>
              )}
            </div>

            {segments.map((seg) =>
              renderSegmentColumns(seg, (f, li, slot) => (
                <LaneColumn
                  color={f.color}
                  width={colWidths[slot] ?? MIN_LANE_WIDTH}
                  visibleRows={visibleRows}
                  laneEvents={laneEvents[li] ?? []}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  chainInfo={chainInfoByFilter.get(f.id)}
                  lineText={lineText}
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
              )),
            )}
          </div>
        ) : (
          /* —— 独立模式：各列各自从上到下顺序排列，不按时间对齐 —— */
          <div className={styles.gridInner}>
            {segments.map((seg) =>
              renderSegmentColumns(seg, (f, li, slot) => (
                <LaneStream
                  color={f.color}
                  width={colWidths[slot] ?? MIN_LANE_WIDTH}
                  events={laneEvents[li] ?? []}
                  scrollTop={scrollTop}
                  viewportH={viewportH}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  chainInfo={chainInfoByFilter.get(f.id)}
                  lineText={lineText}
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
              )),
            )}
          </div>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}


/** 全局时间轴模式：密度热力条（按过滤器色着色、深浅=事件密度）+ 稀疏时叠加卡片 */
interface GlobalLaneProps {
  color: string;
  width: number;
  events: LogEvent[];
  viewRange: { start: number; end: number };
  pxPerMs: number;
  ticks: TickMark[];
  scrollTop: number;
  viewportH: number;
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  chainInfo?: LaneMarks;
  lineText?: Map<number, string>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function GlobalLane({
  color,
  width,
  events,
  viewRange,
  pxPerMs,
  ticks,
  scrollTop,
  viewportH,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  chainInfo,
  lineText,
  onSelect,
  onHover,
}: GlobalLaneProps) {
  const filtersComputing = useLogStore((s) => s.filtersComputing);
  const rgb = useMemo(() => hexToRgb(color), [color]);
  const overscan = 60;
  const yTop = Math.max(0, scrollTop - overscan);
  const yBot = scrollTop + viewportH + overscan;
  const bucketCount = Math.max(0, Math.ceil((yBot - yTop) / DENSITY_BUCKET_H));

  // 密度桶：统计每个纵向像素桶内的事件数
  const { buckets, maxCount } = useMemo(() => {
    const arr = new Array(bucketCount).fill(0);
    const tsTop = viewRange.start + yTop / pxPerMs;
    const tsBot = viewRange.start + yBot / pxPerMs;
    let s = bisectLeft(events, tsTop);
    if (s > 0) s -= 1;
    const e = bisectLeft(events, tsBot) + 1;
    for (let i = Math.max(0, s); i < Math.min(events.length, e); i++) {
      const ev = events[i];
      const y = (ev.ts - viewRange.start) * pxPerMs;
      let bi = Math.floor((y - yTop) / DENSITY_BUCKET_H);
      if (bi < 0) bi = 0;
      else if (bi >= bucketCount) bi = bucketCount - 1;
      arr[bi]++;
    }
    let mx = 1;
    for (const c of arr) if (c > mx) mx = c;
    return { buckets: arr, maxCount: mx };
  }, [events, viewRange, pxPerMs, yTop, yBot, bucketCount]);

  // 稀疏时才叠加独立卡片
  const dense = maxCount > DENSITY_CARD_THRESHOLD;
  const tsTop = viewRange.start + yTop / pxPerMs;
  const tsBot = viewRange.start + yBot / pxPerMs;
  let sIdx = bisectLeft(events, tsTop);
  if (sIdx > 0) sIdx -= 1;
  const eIdx = Math.min(events.length, bisectLeft(events, tsBot) + 1);
  const visibleCards = dense ? [] : events.slice(Math.max(0, sIdx), eIdx);

  // 可见刻度参考线
  const guideTicks = ticks.filter((t) => t.y >= yTop && t.y <= yBot);

  // 选中事件所在桶（高亮）
  let selBucket = -1;
  if (selectedEventId !== null) {
    for (let i = Math.max(0, sIdx); i < Math.min(events.length, eIdx); i++) {
      if (events[i].id === selectedEventId) {
        const y = (events[i].ts - viewRange.start) * pxPerMs;
        selBucket = Math.floor((y - yTop) / DENSITY_BUCKET_H);
        break;
      }
    }
  }

  return (
    <div
      className={styles.lane}
      style={{ width, borderLeftColor: color }}
      onMouseLeave={() => onHover(null)}
    >
      {/* 刻度横向参考线 */}
      {guideTicks.map((t) => (
        <div key={'g' + t.ts} className={styles.guideLine} style={{ top: t.y }} />
      ))}

      {/* 密度热力条：始终渲染，颜色深浅=事件密度，色调=过滤器色 */}
      {buckets.map((c, i) => {
        if (c === 0) return null;
        const alpha = Math.min(0.18 + (c / maxCount) * 0.77, 0.95);
        const isSel = i === selBucket;
        return (
          <div
            key={i}
            className={styles.densityBar + (isSel ? ' ' + styles.densityBarSel : '')}
            style={{
              top: yTop + i * DENSITY_BUCKET_H,
              height: DENSITY_BUCKET_H,
              background: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`,
            }}
            title={`${c} 条事件`}
            onClick={() => {
              // 点击桶：选中该桶内第一个事件
              const by = yTop + i * DENSITY_BUCKET_H;
              const btsTop = viewRange.start + by / pxPerMs;
              const idx = bisectLeft(events, btsTop);
              if (idx < events.length) onSelect(events[idx].id);
            }}
          />
        );
      })}

      {/* 稀疏时叠加独立卡片 */}
      {visibleCards.map((ev) => {
        const y = (ev.ts - viewRange.start) * pxPerMs;
        const idx = 0; // 稀疏时同时间事件极少，不做级联
        const cascade = idx * GLOBAL_CASCADE;
        const isSel = ev.id === selectedEventId;
        const isHover = ev.id === hoveredEventId;
        const isCorr = correlatedEventIds.has(ev.id);
        const levelColor = getLevelColor(ev.level);
        const mark = chainInfo?.get(ev.id);
        const evStyle = {
          top: y + cascade,
          '--ev-border': levelColor ?? color,
          ...(mark ? { '--chain-color': mark.color } : {}),
        } as React.CSSProperties;
        return (
          <div
            key={ev.id}
            className={[
              styles.globalEvent,
              isSel ? styles.globalEventSel : '',
              isHover ? styles.globalEventHover : '',
              isCorr ? styles.globalEventCorr : '',
              mark ? (mark.anomaly ? styles.eventAnomaly : styles.eventChained) : '',
            ].join(' ')}
            style={evStyle}
            onClick={() => onSelect(ev.id)}
            onMouseEnter={() => onHover(ev.id)}
          >
            {mark && (mark.anomaly || mark.chainIndex > 0) && (
              <span
                className={styles.chainTag}
                style={{
                  background: mark.violation
                    ? 'var(--danger)'
                    : mark.jitter
                      ? 'var(--warn)'
                      : mark.color,
                }}
                title={
                  mark.violation
                    ? '违规：NOT 禁止的目标在窗口内出现'
                    : mark.jitter
                      ? '抖动：心跳间隔过密'
                      : mark.anomaly
                        ? '异常：未被任何完整链覆盖'
                        : `链 #${mark.chainIndex}`
                }
              >
                {mark.violation ? '⃠' : mark.jitter ? '⚡' : mark.anomaly ? '⚠' : `#${mark.chainIndex}`}
              </span>
            )}
            {levelColor && (
              <span className={styles.eventLevel} style={{ background: levelColor }}>
                {ev.level}
              </span>
            )}
            <span className={styles.eventRaw} title={lineText?.get(ev.id) ?? ev.raw}>
              {lineText?.get(ev.id) ?? ev.raw}
            </span>
          </div>
        );
      })}

      {maxCount <= 1 && visibleCards.length === 0 && (
        <div className={styles.emptyMsg}>{filtersComputing ? '计算中…' : '无匹配'}</div>
      )}
    </div>
  );
}

/** 独立列模式：不按时间对齐，各列自己顺序排列（带虚拟化） */
interface LaneStreamProps {
  color: string;
  width: number;
  events: LogEvent[];
  scrollTop: number;
  viewportH: number;
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  chainInfo?: LaneMarks;
  lineText?: Map<number, string>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function LaneStream({
  color,
  width,
  events,
  scrollTop,
  viewportH,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  chainInfo,
  lineText,
  onSelect,
  onHover,
}: LaneStreamProps) {
  const filtersComputing = useLogStore((s) => s.filtersComputing);
  const cardH = CARD_H + 2;
  const overscan = 8;
  const startIdx = Math.max(0, Math.floor(scrollTop / cardH) - overscan);
  const count = Math.ceil(viewportH / cardH) + overscan * 2;
  const endIdx = Math.min(events.length, startIdx + count);
  const visible = events.slice(startIdx, endIdx);
  const topPad = startIdx * cardH;
  const bottomPad = (events.length - endIdx) * cardH;
  return (
    <div
      className={styles.lane}
      style={{ width, borderLeftColor: color, position: 'relative' }}
      onMouseLeave={() => onHover(null)}
    >
      <div style={{ height: topPad }} />
      {visible.map((ev) => {
        const isSel = ev.id === selectedEventId;
        const isHover = ev.id === hoveredEventId;
        const isCorr = correlatedEventIds.has(ev.id);
        const levelColor = getLevelColor(ev.level);
        const mark = chainInfo?.get(ev.id);
        return (
          <div
            key={ev.id}
            className={[
              styles.event,
              isSel ? styles.eventSel : '',
              isHover ? styles.eventHover : '',
              isCorr ? styles.eventCorr : '',
              mark ? (mark.anomaly ? styles.eventAnomaly : styles.eventChained) : '',
            ].join(' ')}
            style={{
              height: CARD_H - 2,
              ...(mark ? { '--chain-color': mark.color } : {}),
            }}
            onClick={() => onSelect(ev.id)}
            onMouseEnter={() => onHover(ev.id)}
          >
            {mark && (mark.anomaly || mark.chainIndex > 0) && (
              <span
                className={styles.chainTag}
                style={{
                  background: mark.violation
                    ? 'var(--danger)'
                    : mark.jitter
                      ? 'var(--warn)'
                      : mark.color,
                }}
                title={
                  mark.violation
                    ? '违规：NOT 禁止的目标在窗口内出现'
                    : mark.jitter
                      ? '抖动：心跳间隔过密'
                      : mark.anomaly
                        ? '异常：未被任何完整链覆盖'
                        : `链 #${mark.chainIndex}`
                }
              >
                {mark.violation ? '⃠' : mark.jitter ? '⚡' : mark.anomaly ? '⚠' : `#${mark.chainIndex}`}
              </span>
            )}
            {levelColor && (
              <span className={styles.eventLevel} style={{ background: levelColor }}>
                {ev.level}
              </span>
            )}
            <span className={styles.eventRaw} title={lineText?.get(ev.id) ?? ev.raw}>
              {lineText?.get(ev.id) ?? ev.raw}
            </span>
          </div>
        );
      })}
      {visible.length === 0 && <div className={styles.emptyMsg}>{filtersComputing ? '计算中…' : '无匹配'}</div>}
      <div style={{ height: bottomPad }} />
    </div>
  );
}

interface LaneColumnProps {
  color: string;
  width: number;
  visibleRows: RowData[];
  laneEvents: LogEvent[];
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  chainInfo?: LaneMarks;
  lineText?: Map<number, string>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function LaneColumn({
  color,
  width,
  visibleRows,
  laneEvents,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  chainInfo,
  lineText,
  onSelect,
  onHover,
}: LaneColumnProps) {
  return (
    <div
      className={styles.lane}
      style={{ width, borderLeftColor: color }}
      onMouseLeave={() => onHover(null)}
    >
      {/* 行背景 + 事件 */}
      {visibleRows.map((r) => {
        const evs = runOf(laneEvents, r.ts);
        return (
          <div
            key={r.ts}
            className={styles.laneRow}
            style={{ top: r.top, height: r.height }}
          >
            <div className={styles.laneRowBg + (visibleRows.indexOf(r) % 2 ? ' ' + styles.laneRowAlt : '')} />
            <div className={styles.eventStack}>
              {evs.map((ev) => {
                const isSel = ev.id === selectedEventId;
                const isHover = ev.id === hoveredEventId;
                const isCorr = correlatedEventIds.has(ev.id);
                const levelColor = getLevelColor(ev.level);
                const mark = chainInfo?.get(ev.id);
                return (
                  <div
                    key={ev.id}
                    className={[
                      styles.event,
                      isSel ? styles.eventSel : '',
                      isHover ? styles.eventHover : '',
                      isCorr ? styles.eventCorr : '',
                      mark ? (mark.anomaly ? styles.eventAnomaly : styles.eventChained) : '',
                    ].join(' ')}
                    style={{
                      height: CARD_H - 2,
                      ...(mark ? { '--chain-color': mark.color } : {}),
                    }}
                    onClick={() => onSelect(ev.id)}
                    onMouseEnter={() => onHover(ev.id)}
                  >
                    {mark && (mark.anomaly || mark.chainIndex > 0) && (
                      <span
                        className={styles.chainTag}
                        style={{
                          background: mark.violation
                            ? 'var(--danger)'
                            : mark.jitter
                              ? 'var(--warn)'
                              : mark.color,
                        }}
                        title={
                          mark.violation
                            ? '违规：NOT 禁止的目标在窗口内出现'
                            : mark.jitter
                              ? '抖动：心跳间隔过密'
                              : mark.anomaly
                                ? '异常：未被任何完整链覆盖'
                                : `链 #${mark.chainIndex}`
                        }
                      >
                        {mark.violation ? '⃠' : mark.jitter ? '⚡' : mark.anomaly ? '⚠' : `#${mark.chainIndex}`}
                      </span>
                    )}
                    {levelColor && (
                      <span className={styles.eventLevel} style={{ background: levelColor }}>
                        {ev.level}
                      </span>
                    )}
                            <span className={styles.eventRaw} title={lineText?.get(ev.id) ?? ev.raw}>
                      {lineText?.get(ev.id) ?? ev.raw}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
