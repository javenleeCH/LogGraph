/**
 * 全局状态管理（Zustand）。
 * 持有：日志事件、过滤器、匹配结果、视图范围、选中/悬停事件、游标。
 */

import { create } from 'zustand';
import type { Filter, FilterGroup, FilterMatch, LogEvent, NodePos, TimeRange } from '../types';
import { FilterEngine } from '../filters/FilterEngine';
import {
  pickDirectory,
  getSavedDirectory,
  ensureWritePermission,
  readFilters,
  writeFilters,
  isFSASupported,
  type PersistedFilters,
} from '../io/filterPersist';
import {
  pickLogDirectory,
  getSavedLogDirectory,
  ensureReadPermission,
  isFSASupported as isFSASupportedDir,
} from '../io/dirLoader';

// 延迟重算关联，避免拖拽/缩放时每帧都重算导致抖动
let corrRaf = 0;
function scheduleCorrRecompute(run: () => void) {
  if (corrRaf) cancelAnimationFrame(corrRaf);
  corrRaf = requestAnimationFrame(() => {
    corrRaf = 0;
    run();
  });
}

// 色弱友好调色板（Okabe-Ito），8 色对所有色觉缺陷类型可区分；与 global.css 的 --track-* 同步
const PALETTE = [
  '#0072b2', // 蓝
  '#009e73', // 蓝绿
  '#e69f00', // 橙
  '#d55e00', // 朱红（替代红）
  '#cc79a7', // 紫红
  '#56b4e9', // 天蓝
  '#b5179e', // 品红
  '#9c8a00', // 橄榄黄（白底高对比）
];

let filterSeq = 0;
const genFilterId = () => `f${Date.now()}_${filterSeq++}`;

let groupSeq = 0;
const genGroupId = () => `g${Date.now()}_${groupSeq++}`;

// ---- 过滤器持久化（File System Access API） ----
/* eslint-disable @typescript-eslint/no-explicit-any */
let persistDir: any = null; // 目录句柄
let persistTimer = 0;

/** 防抖写入 filters.json */
function schedulePersist(get: () => LogState) {
  if (!persistDir) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(async () => {
    persistTimer = 0;
    if (!persistDir) return;
    try {
      const data: PersistedFilters = {
        filters: get().filters.map((f) => ({ ...f })),
        groups: get().groups.map((g) => ({ ...g })),
        graphNodes: { ...get().graphNodes },
        savedAt: Date.now(),
      };
      await writeFilters(persistDir, data);
    } catch (e) {
      console.error('过滤器持久化写入失败', e);
    }
  }, 400);
}

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
  groups: FilterGroup[]; // 过滤器分组（顺序即显示顺序）
  collapsedGroups: Set<string>; // 冗余：快速查询折叠状态
  // --- group actions ---
  addGroup: (partial?: Partial<FilterGroup>) => string;
  updateGroup: (id: string, patch: Partial<FilterGroup>) => void;
  removeGroup: (id: string) => void;
  toggleGroupCollapsed: (id: string) => void;
  toggleGroupVisible: (id: string) => void;
  addFilterToGroup: (filterId: string, groupId: string) => void;
  removeFilterFromGroup: (filterId: string, groupId: string) => void;
  reorderGroup: (id: string, toIndex: number) => void;

  // --- 节点画布（draw.io 风格区域式） ---
  /** 当前展开的 group 详情页（null=关闭抽屉） */
  activeGroupId: string | null;
  /** 当前编辑的 filter 详情弹窗（null=关闭弹窗） */
  editingFilterId: string | null;
  /** 节点坐标表 id → NodePos（持久化） */
  graphNodes: Record<string, NodePos>;
  /** 画布平移偏移（屏幕像素，会话级） */
  graphPan: { x: number; y: number };
  /** 画布缩放倍数（会话级） */
  graphZoom: number;
  setActiveGroup: (id: string | null) => void;
  setEditingFilterId: (id: string | null) => void;
  /** 设置/更新某节点坐标（可同时更新宽高） */
  setNodePos: (
    id: string,
    x: number,
    y: number,
    wh?: { w?: number; h?: number },
  ) => void;
  /** 确保节点有坐标（无则按缺省网格/所属区域生成） */
  ensureNodePos: (id: string, kind: 'group' | 'filterItem') => void;
  /** 删除某节点坐标 */
  removeNodePos: (id: string) => void;
  setGraphPan: (x: number, y: number) => void;
  setGraphZoom: (z: number) => void;

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

  // --- 持久化 ---
  /** 持久化目录名（已授权）；null=未配置 */
  persistDirName: string | null;
  /** 浏览器是否支持 FSA */
  persistSupported: boolean;
  /** 启动时调用：从 IndexedDB 恢复目录句柄并加载 filters.json */
  initPersistence: () => Promise<void>;
  /** 让用户选择持久化目录 */
  choosePersistDir: () => Promise<void>;
  /** 立即写入一次 */
  saveFiltersNow: () => Promise<void>;

  // --- 日志目录（目录式加载） ---
  /** 日志目录句柄（已授权）；null=未选择。用 any 避免 FSA 类型缺失 */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  logsDirHandle: any;
  /** 日志目录名；null=未选择 */
  logsDirName: string | null;
  /** 设置日志目录（来自 FileTreePanel 或 Toolbar） */
  setLogsDir: (handle: any, name: string) => void;
  /** 让用户选择日志目录（弹窗授权） */
  chooseLogsDir: () => Promise<void>;
  /** 启动时调用：从 IndexedDB 恢复日志目录句柄 */
  initLogsDir: () => Promise<void>;

  // --- 主区域布局 ---
  /** 时间线/详情 横竖排列：vertical=上下，horizontal=左右 */
  splitOrientation: 'vertical' | 'horizontal';
  setSplitOrientation: (o: 'vertical' | 'horizontal') => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  events: [],
  rawLines: [],
  meta: null,

  filters: [],
  matches: [],
  groups: [],
  collapsedGroups: new Set(),

  viewRange: null,
  fullRange: null,

  selectedEventId: null,
  hoveredEventId: null,
  scrubberTs: null,
  scrubberActive: false,
  correlationHalfWindow: null, // null = 自适应
  correlatedEventIds: new Set(),

  persistDirName: null,
  persistSupported: isFSASupported(),

  logsDirHandle: null,
  logsDirName: null,

  splitOrientation: 'vertical',
  setSplitOrientation: (o) => set({ splitOrientation: o }),

  // --- 节点画布 ---
  activeGroupId: null,
  editingFilterId: null,
  graphNodes: {},
  graphPan: { x: 0, y: 0 },
  graphZoom: 1,
  setActiveGroup: (id) => set({ activeGroupId: id }),
  setEditingFilterId: (id) => set({ editingFilterId: id }),
  setNodePos: (id, x, y, wh) =>
    set({
      graphNodes: {
        ...get().graphNodes,
        [id]: {
          ...get().graphNodes[id],
          id,
          x,
          y,
          ...(wh?.w !== undefined ? { w: wh.w } : {}),
          ...(wh?.h !== undefined ? { h: wh.h } : {}),
        },
      },
    }),
  ensureNodePos: (id, kind) => {
    if (get().graphNodes[id]) return; // 已有坐标
    const nodes = get().graphNodes;
    const groups = get().groups;
    const filters = get().filters;
    if (kind === 'group') {
      // group 按网格：col*420, row*320，每行 3 个
      const gIdx = groups.findIndex((g) => g.id === id);
      const i = gIdx >= 0 ? gIdx : Object.values(nodes).filter((n) => n.kind === 'group').length;
      const col = i % 3;
      const row = Math.floor(i / 3);
      const pos: NodePos = { id, kind, x: 40 + col * 420, y: 40 + row * 320, w: 400, h: 300 };
      set({ graphNodes: { ...get().graphNodes, [id]: pos } });
      return;
    }
    // filterItem：落在其「首个所属 group」区域内左上起始；无所属则顶层网格
    const primary = groups.find((g) => g.filterIds.includes(id));
    if (primary && nodes[primary.id]) {
      const gp = nodes[primary.id];
      // 区域内已有 filterItem 数量决定行列
      const existing = Object.values(nodes).filter(
        (n) => n.kind === 'filterItem' && n.x >= gp.x && n.x < gp.x + (gp.w ?? 400) && n.y >= gp.y && n.y < gp.y + (gp.h ?? 300),
      ).length;
      const col = existing % 3;
      const row = Math.floor(existing / 3);
      const pos: NodePos = {
        id,
        kind,
        x: gp.x + 20 + col * 180,
        y: gp.y + 50 + row * 60,
      };
      set({ graphNodes: { ...get().graphNodes, [id]: pos } });
      return;
    }
    // 顶层无 group：网格排布在 group 区域下方
    const topExisting = Object.values(nodes).filter(
      (n) => n.kind === 'filterItem' && !groups.some((g) => g.filterIds.includes(n.id)),
    ).length;
    const fIdx = filters.findIndex((f) => f.id === id);
    const i = fIdx >= 0 ? fIdx : topExisting;
    const col = i % 6;
    const row = Math.floor(i / 6);
    const pos: NodePos = { id, kind, x: 40 + col * 180, y: 400 + row * 60 };
    set({ graphNodes: { ...get().graphNodes, [id]: pos } });
  },
  removeNodePos: (id) => {
    const next = { ...get().graphNodes };
    delete next[id];
    set({ graphNodes: next });
  },
  setGraphPan: (x, y) => set({ graphPan: { x, y } }),
  setGraphZoom: (z) => set({ graphZoom: z }),

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
    schedulePersist(get);
    return id;
  },

  updateFilter: (id, patch) => {
    set({
      filters: get().filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
    get().recomputeMatches();
    schedulePersist(get);
  },

  removeFilter: (id) => {
    set({ filters: get().filters.filter((f) => f.id !== id) });
    get().recomputeMatches();
    schedulePersist(get);
  },

  // ---- 分组（group） ----
  addGroup: (partial) => {
    const id = genGroupId();
    const idx = get().groups.length;
    const group: FilterGroup = {
      id,
      label: partial?.label ?? `Group ${idx + 1}`,
      color: partial?.color ?? PALETTE[idx % PALETTE.length],
      collapsed: partial?.collapsed ?? false,
      visible: partial?.visible ?? true,
      filterIds: partial?.filterIds ?? [],
    };
    set({ groups: [...get().groups, group] });
    schedulePersist(get);
    return id;
  },

  updateGroup: (id, patch) => {
    set({
      groups: get().groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    });
    schedulePersist(get);
  },

  removeGroup: (id) => {
    // 删组：只删 group（filter 不动，多对多引用自然断开）
    set({ groups: get().groups.filter((g) => g.id !== id) });
    const collapsed = new Set(get().collapsedGroups);
    collapsed.delete(id);
    set({ collapsedGroups: collapsed });
    get().removeNodePos(id);
    schedulePersist(get);
  },

  toggleGroupCollapsed: (id) => {
    const groups = get().groups.map((g) =>
      g.id === id ? { ...g, collapsed: !g.collapsed } : g,
    );
    const collapsed = new Set<string>();
    for (const g of groups) if (g.collapsed) collapsed.add(g.id);
    set({ groups, collapsedGroups: collapsed });
    schedulePersist(get);
  },

  toggleGroupVisible: (id) => {
    set({
      groups: get().groups.map((g) =>
        g.id === id ? { ...g, visible: !g.visible } : g,
      ),
    });
    schedulePersist(get);
  },

  addFilterToGroup: (filterId, groupId) => {
    set({
      groups: get().groups.map((g) =>
        g.id === groupId && !g.filterIds.includes(filterId)
          ? { ...g, filterIds: [...g.filterIds, filterId] }
          : g,
      ),
    });
    get().recomputeMatches();
    schedulePersist(get);
  },

  removeFilterFromGroup: (filterId, groupId) => {
    set({
      groups: get().groups.map((g) =>
        g.id === groupId
          ? { ...g, filterIds: g.filterIds.filter((fid) => fid !== filterId) }
          : g,
      ),
    });
    get().recomputeMatches();
    schedulePersist(get);
  },

  reorderGroup: (id, toIndex) => {
    const arr = [...get().groups];
    const from = arr.findIndex((g) => g.id === id);
    if (from === -1 || from === toIndex) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(toIndex, 0, moved);
    set({ groups: arr });
    schedulePersist(get);
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

  // ---- 过滤器持久化 ----
  initPersistence: async () => {
    if (!isFSASupported()) return;
    try {
      const dir = await getSavedDirectory();
      if (!dir) return;
      if (!(await ensureWritePermission(dir))) return;
      persistDir = dir;
      set({ persistDirName: dir.name });
      const saved = await readFilters(dir);
      if (saved && Array.isArray(saved.filters) && saved.filters.length > 0) {
        // 旧 filter id → 新 filter id 的映射（filter 加载时重新生成 id）
        const oldToNewFid = new Map<string, string>();
        // 从 JSON 恢复过滤器（补全默认字段；保留原 groupId 用于迁移）
        const restoredRaw: Filter[] = saved.filters.map((f: any, i: number) => {
          const newId = genFilterId();
          if (f.id) oldToNewFid.set(f.id, newId);
          return {
            id: newId,
            label: f.label ?? `Filter ${i + 1}`,
            color: f.color ?? PALETTE[i % PALETTE.length],
            pattern: f.pattern ?? '',
            isRegex: f.isRegex ?? false,
            caseSensitive: f.caseSensitive ?? false,
            enabled: f.enabled ?? true,
            scope: f.scope === 'message' ? 'message' : 'raw',
            groupId: f.groupId ?? null, // 旧字段，迁移后置 null
          };
        });
        // 恢复分组；新格式有 filterIds（需重映射到新 id），旧格式无则从 filter.groupId 反向迁移
        const restoredGroups: FilterGroup[] = Array.isArray(saved.groups)
          ? saved.groups.map((g: any, i: number) => {
              const id = genGroupId();
              const base = {
                id,
                label: g.label ?? `Group ${i + 1}`,
                color: g.color ?? PALETTE[i % PALETTE.length],
                collapsed: g.collapsed ?? false,
                visible: g.visible ?? true,
              };
              // 新格式：filterIds 重映射 旧id→新id（找不到的丢弃）
              if (Array.isArray(g.filterIds)) {
                return {
                  ...base,
                  filterIds: g.filterIds
                    .map((fid: string) => oldToNewFid.get(fid))
                    .filter((fid: string | undefined): fid is string => !!fid),
                };
              }
              // 旧格式：filterIds 为空，下方迁移旧 filter.groupId
              return { ...base, filterIds: [] as string[] };
            })
          : [];
        // 旧→新迁移：若 filter 仍带 legacy groupId，按 saved.filter.groupId 反向构建 group.filterIds
        const hasLegacyGroupIds = restoredRaw.some((f) => f.groupId);
        if (hasLegacyGroupIds && saved.groups && Array.isArray(saved.groups)) {
          for (let gi = 0; gi < restoredGroups.length; gi++) {
            const oldGid = saved.groups[gi]?.id;
            if (!oldGid) continue;
            restoredGroups[gi].filterIds = restoredRaw
              .filter((f) => f.groupId === oldGid)
              .map((f) => f.id);
          }
        }
        // 迁移完毕，filter.groupId 全部置 null（不再使用单值归属）
        const restored: Filter[] = restoredRaw.map((f) => ({
          ...f,
          groupId: null,
        }));
        const collapsed = new Set<string>();
        for (const g of restoredGroups) if (g.collapsed) collapsed.add(g.id);
        // 恢复节点画布坐标：旧 group id → 新 group id 映射
        const oldToNewGid = new Map<string, string>();
        if (Array.isArray(saved.groups)) {
          saved.groups.forEach((sg: any, i: number) => {
            if (sg?.id && restoredGroups[i]) oldToNewGid.set(sg.id, restoredGroups[i].id);
          });
        }
        const restoredGraphNodes: Record<string, NodePos> = {};
        if (saved.graphNodes && typeof saved.graphNodes === 'object') {
          for (const [oldKey, node] of Object.entries(saved.graphNodes) as [string, any][]) {
            const newId = node.kind === 'group' ? oldToNewGid.get(oldKey) : oldToNewFid.get(oldKey);
            if (!newId) continue; // 找不到映射（已删除），丢弃
            restoredGraphNodes[newId] = {
              id: newId,
              kind: node.kind,
              x: node.x ?? 0,
              y: node.y ?? 0,
              ...(node.w != null ? { w: node.w } : {}),
              ...(node.h != null ? { h: node.h } : {}),
            };
          }
        }
        set({
          filters: restored,
          groups: restoredGroups,
          collapsedGroups: collapsed,
          graphNodes: restoredGraphNodes,
        });
        // 兜底：无坐标的 filter/group 补缺省坐标
        for (const g of restoredGroups) get().ensureNodePos(g.id, 'group');
        for (const f of restored) get().ensureNodePos(f.id, 'filterItem');
        get().recomputeMatches();
      }
    } catch (e) {
      console.error('过滤器持久化初始化失败', e);
    }
  },

  choosePersistDir: async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    persistDir = dir;
    set({ persistDirName: dir.name });
    // 选择目录后：优先读取并加载目录中已有的 filters.json 配置；
    // 若目录无配置（新建空目录），则把当前过滤器写一次作为初始持久化
    const saved = await readFilters(dir);
    if (saved && Array.isArray(saved.filters) && saved.filters.length > 0) {
      await get().initPersistence();
    } else {
      await get().saveFiltersNow();
    }
  },

  saveFiltersNow: async () => {
    if (!persistDir) return;
    try {
      const data: PersistedFilters = {
        filters: get().filters.map((f) => ({ ...f })),
        groups: get().groups.map((g) => ({ ...g })),
        savedAt: Date.now(),
      };
      await writeFilters(persistDir, data);
    } catch (e) {
      console.error('过滤器持久化写入失败', e);
    }
  },

  // ---- 日志目录 ----
  setLogsDir: (handle, name) => {
    set({ logsDirHandle: handle, logsDirName: name });
  },

  chooseLogsDir: async () => {
    const dir = await pickLogDirectory();
    if (!dir) return;
    set({ logsDirHandle: dir, logsDirName: dir.name });
  },

  initLogsDir: async () => {
    if (!isFSASupportedDir()) return;
    try {
      const dir = await getSavedLogDirectory();
      if (!dir) return;
      if (!(await ensureReadPermission(dir))) return;
      set({ logsDirHandle: dir, logsDirName: dir.name });
    } catch (e) {
      console.error('日志目录恢复失败', e);
    }
  },
}));
