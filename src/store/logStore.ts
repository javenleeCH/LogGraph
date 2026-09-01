/**
 * 全局状态管理（Zustand）。
 * 持有：日志事件、过滤器、匹配结果、视图范围、选中/悬停事件、游标。
 */

import { create } from 'zustand';
import type { Filter, FilterMatch, LogEvent, TimeRange } from '../types';
import { FilterEngine } from '../filters/FilterEngine';

// 延迟重算关联，避免拖拽/缩放时每帧都重算导致抖动
let corrRaf = 0;
function scheduleCorrRecompute(run: () => void) {
  if (corrRaf) cancelAnimationFrame(corrRaf);
  corrRaf = requestAnimationFrame(() => {
    corrRaf = 0;
    run();
  });
}

// 浅色主题下调色板（颜色偏深，确保在白色背景上可见），循环使用
const PALETTE = [
  '#1a73e8', // 蓝
  '#1e8e3e', // 绿
  '#e37400', // 橙
  '#d93025', // 红
  '#9334c4', // 紫
  '#0091a0', // 青
  '#c61d73', // 粉
  '#5f8b2c', // 黄绿
];

let filterSeq = 0;
const genFilterId = () => `f${Date.now()}_${filterSeq++}`;

export interface LogMeta {
  fileName: string;
  fileSize: number;
  totalLines: number;
  skipped: number;
  timestampFormatId: string | null;
}

interface LogState {
  // --- 数据 ---
  events: LogEvent[];
  rawLines: string[]; // 原始行，用于上下文显示
  meta: LogMeta | null;

  // --- 过滤器 ---
  filters: Filter[];
  matches: FilterMatch[]; // 过滤结果，按 filters 顺序

  // --- 视图 ---
  viewRange: TimeRange | null; // 当前可见时间窗
  fullRange: TimeRange | null; // 全量时间范围

  // --- 交互 ---
  selectedEventId: number | null;
  hoveredEventId: number | null;
  scrubberTs: number | null;
  /** 是否在拖拽游标 */
  scrubberActive: boolean;
  /** 关联窗口半宽（毫秒），null 表示按视图自适应 */
  correlationHalfWindow: number | null;
  /** 选中的关联事件 id 集合（自动计算） */
  correlatedEventIds: Set<number>;

  // --- actions ---
  setLog: (events: LogEvent[], rawLines: string[], meta: LogMeta) => void;
  addFilter: (partial?: Partial<Filter>) => string;
  updateFilter: (id: string, patch: Partial<Filter>) => void;
  removeFilter: (id: string) => void;
  recomputeMatches: () => void;
  setViewRange: (r: TimeRange) => void;
  zoomTo: (centerTs: number, factor: number) => void;
  /** 增量缩放：ratioDelta>0 放大，<0 缩小；以 centerTs 为锚点保持该时刻不动 */
  zoomByRatio: (centerTs: number, ratioDelta: number) => void;
  /** 按像素增量平移（chartW 为绘图区像素宽，用于换算 px->ms） */
  panByPx: (px: number, chartW: number) => void;
  panBy: (deltaMs: number) => void;
  resetView: () => void;
  selectEvent: (id: number | null) => void;
  setHovered: (id: number | null) => void;
  setScrubber: (ts: number | null, active?: boolean) => void;
  recomputeCorrelations: () => void;
  setCorrelationWindow: (halfMs: number | null) => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  events: [],
  rawLines: [],
  meta: null,

  filters: [],
  matches: [],

  viewRange: null,
  fullRange: null,

  selectedEventId: null,
  hoveredEventId: null,
  scrubberTs: null,
  scrubberActive: false,
  correlationHalfWindow: null, // null = 自适应
  correlatedEventIds: new Set(),

  setLog: (events, rawLines, meta) => {
    if (events.length === 0) {
      set({
        events: [],
        rawLines: [],
        meta,
        fullRange: null,
        viewRange: null,
        matches: [],
        selectedEventId: null,
        hoveredEventId: null,
        scrubberTs: null,
        correlatedEventIds: new Set(),
      });
      return;
    }
    const fullRange = { start: events[0].ts, end: events[events.length - 1].ts };
    // 初始视图 = 全量
    set({
      events,
      rawLines,
      meta,
      fullRange,
      viewRange: { ...fullRange },
      matches: [], // 由 recomputeMatches 填充
      selectedEventId: null,
      hoveredEventId: null,
      scrubberTs: null,
      correlatedEventIds: new Set(),
    });
    get().recomputeMatches();
  },

  addFilter: (partial) => {
    const id = genFilterId();
    const idx = get().filters.length;
    const color = PALETTE[idx % PALETTE.length];
    const filter: Filter = {
      id,
      label: partial?.label ?? `Filter ${idx + 1}`,
      color: partial?.color ?? color,
      pattern: partial?.pattern ?? '',
      isRegex: partial?.isRegex ?? false,
      caseSensitive: partial?.caseSensitive ?? false,
      enabled: partial?.enabled ?? true,
      scope: partial?.scope ?? 'raw',
    };
    set({ filters: [...get().filters, filter] });
    get().recomputeMatches();
    return id;
  },

  updateFilter: (id, patch) => {
    set({
      filters: get().filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
    get().recomputeMatches();
  },

  removeFilter: (id) => {
    set({ filters: get().filters.filter((f) => f.id !== id) });
    get().recomputeMatches();
  },

  recomputeMatches: () => {
    const { events, filters } = get();
    if (events.length === 0 || filters.length === 0) {
      set({ matches: [], correlatedEventIds: new Set() });
      return;
    }
    const matches = FilterEngine.run(events, filters);
    set({ matches });
    get().recomputeCorrelations();
  },

  setViewRange: (r) => {
    set({ viewRange: r });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  zoomTo: (centerTs, factor) => {
    const { viewRange, fullRange } = get();
    if (!viewRange || !fullRange) return;
    const cur = viewRange.end - viewRange.start;
    const next = Math.max(cur * factor, 1);
    let start = centerTs - next / 2;
    let end = centerTs + next / 2;
    // 边界约束
    if (start < fullRange.start) {
      start = fullRange.start;
      end = start + next;
    }
    if (end > fullRange.end) {
      end = fullRange.end;
      start = end - next;
    }
    set({ viewRange: { start, end } });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  zoomByRatio: (centerTs, ratioDelta) => {
    const { viewRange, fullRange } = get();
    if (!viewRange || !fullRange) return;
    const cur = viewRange.end - viewRange.start || 1;
    // ratioDelta>0 放大(收窄)，<0 缩小(拉宽)
    let factor = 1 - ratioDelta;
    let next = Math.max(cur * factor, 1);
    // 保持 centerTs 在屏幕上不动：缩放前后其位置比例不变
    const frac = (centerTs - viewRange.start) / cur;
    let start = centerTs - frac * next;
    let end = start + next;
    // 边界约束
    if (start < fullRange.start) {
      start = fullRange.start;
      end = start + next;
    }
    if (end > fullRange.end) {
      end = fullRange.end;
      start = end - next;
    }
    set({ viewRange: { start, end } });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  panByPx: (px, chartW) => {
    const { viewRange, fullRange } = get();
    if (!viewRange || !fullRange || chartW <= 0) return;
    const span = viewRange.end - viewRange.start || 1;
    const pxToMs = span / chartW;
    const deltaMs = px * pxToMs;
    let start = viewRange.start + deltaMs;
    let end = viewRange.end + deltaMs;
    if (start < fullRange.start) {
      const d = fullRange.start - start;
      start += d;
      end += d;
    }
    if (end > fullRange.end) {
      const d = end - fullRange.end;
      start -= d;
      end -= d;
    }
    set({ viewRange: { start, end } });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  panBy: (deltaMs) => {
    const { viewRange, fullRange } = get();
    if (!viewRange || !fullRange) return;
    let start = viewRange.start + deltaMs;
    let end = viewRange.end + deltaMs;
    if (start < fullRange.start) {
      const d = fullRange.start - start;
      start += d;
      end += d;
    }
    if (end > fullRange.end) {
      const d = end - fullRange.end;
      start -= d;
      end -= d;
    }
    set({ viewRange: { start, end } });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  resetView: () => {
    const { fullRange } = get();
    if (fullRange) set({ viewRange: { ...fullRange } });
  },

  selectEvent: (id) => {
    set({ selectedEventId: id });
    const { events } = get();
    if (id !== null) {
      const ev = events.find((e) => e.id === id);
      if (ev) {
        set({ scrubberTs: ev.ts });
      }
    }
    get().recomputeCorrelations();
  },

  setHovered: (id) => set({ hoveredEventId: id }),

  setScrubber: (ts, active) =>
    set({ scrubberTs: ts, scrubberActive: active ?? get().scrubberActive }),

  setCorrelationWindow: (halfMs) => {
    set({ correlationHalfWindow: halfMs });
    get().recomputeCorrelations();
  },

  recomputeCorrelations: () => {
    const {
      matches,
      selectedEventId,
      events,
      viewRange,
      correlationHalfWindow,
      scrubberTs,
    } = get();

    // 选中事件驱动关联；若无选中则用游标
    let centerTs: number | null = null;
    if (selectedEventId !== null) {
      const ev = events.find((e) => e.id === selectedEventId);
      if (ev) centerTs = ev.ts;
    } else if (scrubberTs !== null) {
      centerTs = scrubberTs;
    }

    if (centerTs === null || matches.length === 0) {
      if (get().correlatedEventIds.size > 0) {
        set({ correlatedEventIds: new Set() });
      }
      return;
    }

    // 自适应窗口：可见范围的 2%
    const half =
      correlationHalfWindow ??
      (viewRange ? (viewRange.end - viewRange.start) * 0.02 : 1000);

    const ids = new Set<number>();
    const lo = centerTs - half;
    const hi = centerTs + half;
    for (const fm of matches) {
      for (const ev of fm.events) {
        if (ev.ts >= lo && ev.ts <= hi) ids.add(ev.id);
      }
    }
    set({ correlatedEventIds: ids });
  },
}));
