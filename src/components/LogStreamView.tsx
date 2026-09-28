import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLogStore } from '../store/logStore';
import { bisectLeft } from '../timeline/correlation';
import { formatTime, formatDuration, chooseTickStep } from '../utils/timeFormat';
import { levelColor as getLevelColor } from '../constants';
import { ChevronLeft, ChevronRight, AlignCenter, Columns, Globe } from './Icon';
import type { LogEvent, Filter } from '../types';
import styles from './LogStreamView.module.css';

const CARD_H = 20; // 单个事件卡片高度
const ROW_PAD = 4; // 行内上下留白
const TIME_COL_WIDTH = 104; // 左侧时间列宽
const MIN_LANE_WIDTH = 120; // 每列最小宽度
const GLOBAL_TICK_H = 80; // 全局模式：每个刻度最小高度
const GLOBAL_CASCADE = 16; // 全局模式：同时间事件级联偏移（略小于卡片高，形成层叠）
const DENSITY_BUCKET_H = 3; // 全局模式密度桶高度（px）
const DENSITY_CARD_THRESHOLD = 3; // 桶内事件数超过此值则只显示密度、不显示卡片

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
  /** 各列在该时间戳的事件数（用于计算行高） */
  counts: number[];
  /** 行高 = max(counts) * CARD_H + 2*ROW_PAD */
  height: number;
  /** 行顶部 Y = 之前所有行高之和 */
  top: number;
}

interface TickMark {
  ts: number;
  y: number;
}

/**
 * 从所有匹配项的事件中收集去重时间戳（升序），并按列分组。
 */
function buildRows(
  matches: { filterId: string; events: LogEvent[] }[],
  viewRange: { start: number; end: number } | null,
): { rows: RowData[]; laneEvents: LogEvent[][] } {
  if (!viewRange || matches.length === 0) {
    return { rows: [], laneEvents: matches.map(() => []) };
  }
  // 收集每个 lane 在 viewRange 内的事件
  const laneEvents: LogEvent[][] = matches.map((fm) => {
    const evs = fm.events;
    const s = bisectLeft(evs, viewRange.start);
    const e = bisectLeft(evs, viewRange.end);
    return evs.slice(s, e);
  });
  // 收集去重时间戳
  const tsSet = new Set<number>();
  for (const le of laneEvents) {
    for (const ev of le) tsSet.add(ev.ts);
  }
  const tsList = Array.from(tsSet).sort((a, b) => a - b);
  // 每个 lane 的事件按 ts 建索引（因可能同 ts 多事件，用 Map<ts, LogEvent[]>）
  const laneByTs: Map<number, LogEvent[]>[] = laneEvents.map((le) => {
    const m = new Map<number, LogEvent[]>();
    for (const ev of le) {
      let arr = m.get(ev.ts);
      if (!arr) {
        arr = [];
        m.set(ev.ts, arr);
      }
      arr.push(ev);
    }
    return m;
  });
  // 构建行
  const rows: RowData[] = [];
  let top = 0;
  for (const ts of tsList) {
    const counts = laneByTs.map((m) => m.get(ts)?.length ?? 0);
    const maxCount = Math.max(1, ...counts);
    const height = maxCount * CARD_H + ROW_PAD * 2;
    rows.push({ ts, counts, height, top });
    top += height;
  }
  return { rows, laneEvents };
}

/** 可见列分段：group 包裹子 filter 列 + 顶层 filter 列 */
interface ColumnSegment {
  kind: 'group' | 'top';
  /** group 段的组对象（top 段为 null） */
  group?: import('../types').FilterGroup;
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
  groups: import('../types').FilterGroup[],
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
   * 序列链信息（卡片角标用）：filterId → (eventId → { chainIndex, color, anomaly })
   * anomaly 只有在该 group 异常开关开启时才标记。
   */
  const chainInfoByFilter = useMemo(() => {
    const m = new Map<
      string,
      Map<number, { chainIndex: number; color: string; anomaly: boolean; violation?: boolean; jitter?: boolean }>
    >();
    for (const g of groups) {
      const r = sequenceResults[g.id];
      if (!r) continue;
      for (const fid of g.filterIds) {
        let info = m.get(fid);
        if (!info) {
          info = new Map();
          m.set(fid, info);
        }
        for (const ch of r.chains) {
          for (const stp of ch.steps) {
            if (stp.filterId !== fid) continue;
            if (!info.has(stp.event.id)) {
              info.set(stp.event.id, { chainIndex: ch.chainIndex, color: g.color, anomaly: false });
            }
          }
        }
        if (g.sequence?.anomalyEnabled) {
          // 未覆盖事件 = 异常（仅标在该 filter 自己的卡片上）
          const filterEvents = visibleMatches.find((mm) => mm.filterId === fid)?.events ?? [];
          const covered = new Set(
            r.chains.flatMap((ch) => ch.steps.filter((s2) => s2.filterId === fid).map((s2) => s2.event.id)),
          );
          for (const ev of filterEvents) {
            if (!covered.has(ev.id) && !info.has(ev.id)) {
              info.set(ev.id, { chainIndex: 0, color: g.color, anomaly: true });
            }
          }
        }
      }
      // NOT 违规：按边定义的 from/to filter 标记（覆盖 chainInfo）
      for (const edge of g.sequence?.edges ?? []) {
        if ((edge.kind ?? 'seq') !== 'not') continue;
        const vs = r.notViolations.filter((v) => v.edgeId === edge.id);
        if (vs.length === 0) continue;
        const fromInfo = m.get(edge.fromFilterId);
        const toInfo = m.get(edge.toFilterId);
        if (fromInfo) {
          for (const v of vs) {
            const prev = fromInfo.get(v.fromEvent.id);
            fromInfo.set(v.fromEvent.id, {
              chainIndex: prev?.chainIndex ?? 0,
              color: g.color,
              anomaly: true,
              violation: true,
            });
          }
        }
        if (toInfo) {
          for (const v of vs) {
            const prev = toInfo.get(v.toEvent.id);
            toInfo.set(v.toEvent.id, {
              chainIndex: prev?.chainIndex ?? 0,
              color: g.color,
              anomaly: true,
              violation: true,
            });
          }
        }
      }
      // periodic 抖动标记
      for (const hb of r.heartbeats) {
        const info = m.get(hb.filterId);
        if (!info) continue;
        const filterEvents = visibleMatches.find((mm) => mm.filterId === hb.filterId)?.events ?? [];
        for (const jt of hb.jitters) {
          const ev = filterEvents.find((e) => e.ts === jt.ts);
          if (ev && !info.get(ev.id)?.violation) {
            info.set(ev.id, { chainIndex: 0, color: g.color, anomaly: false, jitter: true });
          }
        }
      }
    }
    return m;
  }, [groups, sequenceResults, visibleMatches]);
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

    // 全局模式：按事件真实 ts 定位
    if (mode === 'global' && viewRange && globalData) {
      let targetTs: number | null = null;
      for (const le of laneEvents) {
        const ev = le.find((e) => e.id === selectedEventId);
        if (ev) {
          targetTs = ev.ts;
          break;
        }
      }
      if (targetTs === null) return;
      const y = (targetTs - viewRange.start) * globalData.pxPerMs;
      if (y < el.scrollTop || y > el.scrollTop + el.clientHeight) {
        el.scrollTo({ top: y - el.clientHeight / 3, behavior: 'smooth' });
      }
      lastScrollTarget.current = selectedEventId;
      return;
    }

    // 对齐模式：按行定位
    let targetRow: RowData | undefined;
    for (const r of rows) {
      for (let li = 0; li < laneEvents.length; li++) {
        if (laneEvents[li].some((e) => e.id === selectedEventId && e.ts === r.ts)) {
          targetRow = r;
          break;
        }
      }
      if (targetRow) break;
    }
    if (!targetRow) return;
    const y = targetRow.top;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: y - el.clientHeight / 3, behavior: 'smooth' });
    }
    lastScrollTarget.current = selectedEventId;
  }, [selectedEventId, rows, laneEvents, mode, viewRange, globalData]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    // 直接同步 DOM transform，绕过 React 渲染延迟，与原生滚动同帧
    if (headerInnerRef.current) {
      headerInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
  }, []);

  // 每个 lane 按 ts 分组（供对齐模式渲染）
  const laneByTs = useMemo(() => {
    return laneEvents.map((le) => {
      const m = new Map<number, LogEvent[]>();
      for (const ev of le) {
        let arr = m.get(ev.ts);
        if (!arr) {
          arr = [];
          m.set(ev.ts, arr);
        }
        arr.push(ev);
      }
      return m;
    });
  }, [laneEvents]);

  if (!viewRange || !fullRange) {
    return (
      <div ref={measureRef} className={styles.empty}>
        打开日志文件并添加过滤器以开始
      </div>
    );
  }

  if (visibleFilters.length === 0) {
    return (
      <div ref={measureRef} className={styles.empty}>
        请先添加过滤器，每列对应一个过滤器的匹配结果
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
              (f, _li, slot) => (
                <div
                  className={styles.laneHeader}
                  style={{ width: colWidths[slot] ?? MIN_LANE_WIDTH, borderLeftColor: f.color }}
                >
                  <span className={styles.laneDot} style={{ background: f.color }} />
                  <span className={styles.laneTitle}>{f.label}</span>
                  <span className={styles.lanePattern}>{f.pattern || '（空）'}</span>
                </div>
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
                <div className={styles.emptyMsg}>当前时间窗内无刻度</div>
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
                <div className={styles.emptyMsg}>当前时间窗内无匹配事件</div>
              )}
            </div>

            {segments.map((seg) =>
              renderSegmentColumns(seg, (f, li, slot) => (
                <LaneColumn
                  color={f.color}
                  width={colWidths[slot] ?? MIN_LANE_WIDTH}
                  visibleRows={visibleRows}
                  laneByTs={laneByTs[li] ?? new Map()}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  chainInfo={chainInfoByFilter.get(f.id)}
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
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
              )),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 单事件的序列链标记信息 */
interface ChainMark {
  chainIndex: number;
  color: string;
  anomaly: boolean;
  /** NOT 边违规（红 ⃠） */
  violation?: boolean;
  /** periodic 抖动（黄 ⚡） */
  jitter?: boolean;
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
  chainInfo?: Map<number, ChainMark>;
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
  onSelect,
  onHover,
}: GlobalLaneProps) {
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
            <span className={styles.eventRaw} title={ev.raw}>
              {ev.raw}
            </span>
          </div>
        );
      })}

      {maxCount <= 1 && visibleCards.length === 0 && (
        <div className={styles.emptyMsg}>无匹配</div>
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
  chainInfo?: Map<number, ChainMark>;
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
  onSelect,
  onHover,
}: LaneStreamProps) {
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
            <span className={styles.eventRaw} title={ev.raw}>
              {ev.raw}
            </span>
          </div>
        );
      })}
      {visible.length === 0 && <div className={styles.emptyMsg}>无匹配</div>}
      <div style={{ height: bottomPad }} />
    </div>
  );
}

interface LaneColumnProps {
  color: string;
  width: number;
  visibleRows: RowData[];
  laneByTs: Map<number, LogEvent[]>;
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  chainInfo?: Map<number, ChainMark>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function LaneColumn({
  color,
  width,
  visibleRows,
  laneByTs,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  chainInfo,
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
        const evs = laneByTs.get(r.ts) ?? [];
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
                            <span className={styles.eventRaw} title={ev.raw}>
                      {ev.raw}
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
