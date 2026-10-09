/**
 * 全局状态管理（Zustand）。
 * 持有：日志事件、过滤器、匹配结果、视图范围、选中/悬停事件、游标。
 */

import { create } from 'zustand';
import type { Filter, FilterGroup, FilterMatch, LogEvent, NodeCount, NodePos, SequenceConfig, SequenceEdge, SequenceMatchResult, TimeRange } from '../types';
import { FilterEngine } from '../filters/FilterEngine';
import { runSequenceMatching } from '../sequence/SequenceMatcher';
import {
  openWorkspaceDir,
  readFilters,
  writeFilters,
  readLegacyPersistedFilters,
  clearLegacyPersistDir,
  isFSASupported,
  type PersistedFilters,
} from '../io/filterPersist';
import {
  pickLogDirectory,
  getSavedLogDirectory,
  ensureReadPermission,
  isFSASupported as isFSASupportedDir,
} from '../io/dirLoader';
import {
  dbClose,
  runDbFiltersBatch,
  runDbSequences,
  fetchCorrIds,
  type DbEventIndex,
  type DbRunSeqGroup,
  type DbFilterHits,
} from '../io/dbStore';

let corrRaf = 0;
let corrSeq = 0; // dbMode 关联下推的响应序号（过期丢弃）

// ---- dbMode SoA 索引（v3）----

/** 行号 → 事件下标直查表；posByLine[line] = 事件在 lines/ts 中的下标 */
export interface DbIndex extends DbEventIndex {
  /** 大小 = maxLine+1；0xFFFFFFFF = 该行无事件 */
  posByLine: Uint32Array;
}

const NO_EVENT = 0xffffffff;

/** dbMode 下按行号查事件 ts（O(1)，替代 events.find O(N)）；无事件行返回 null */
export function dbTsByLine(state: { dbIndex: DbIndex | null }, line: number): number | null {
  const idx = state.dbIndex;
  if (!idx || line < 0 || line >= idx.posByLine.length) return null;
  const p = idx.posByLine[line];
  return p === NO_EVENT ? null : idx.ts[p];
}

/** 事件总数（dbMode 走 SoA 索引 count——事件不物化后 events.length 恒为 0） */
export const selectEventCount = (s: {
  dbMode: boolean;
  dbIndex: DbIndex | null;
  events: LogEvent[];
}): number => (s.dbMode ? s.dbIndex?.count ?? 0 : s.events.length);

/** 二进制命中 → 骨架事件数组（raw/message 按需拉行；ts 升序由 Rust 保证） */
function skelEvents(hits: DbFilterHits | undefined): LogEvent[] {
  if (!hits || hits.lines.length === 0) return [];
  const out = new Array<LogEvent>(hits.lines.length);
  for (let i = 0; i < hits.lines.length; i++) {
    out[i] = { id: hits.lines[i], ts: hits.ts[i], raw: '', message: '' };
  }
  return out;
}

function scheduleCorrRecompute(run: () => void) {
  if (corrRaf) cancelAnimationFrame(corrRaf);
  corrRaf = requestAnimationFrame(() => {
    corrRaf = 0;
    run();
  });
}

// 浅色主题下调色板（颜色偏深，确保在白色背景上可见），循环使用
const PALETTE = [
  '#4ea2ff', // 蓝
  '#34d399', // 绿
  '#fb923c', // 橙
  '#f87171', // 红
  '#a78bfa', // 紫
  '#22d3ee', // 青
  '#f472b6', // 粉
  '#a3e635', // 黄绿
];

let filterSeq = 0;
const genFilterId = () => `f${Date.now()}_${filterSeq++}`;

let groupSeq = 0;
const genGroupId = () => `g${Date.now()}_${groupSeq++}`;

let edgeSeq = 0;
const genEdgeId = () => `e${Date.now()}_${edgeSeq++}`;

// 分块过滤任务的取消句柄（连续编辑时取消旧任务，只保留最新）
let chunkedCancel: (() => void) | null = null;

// ---- 工作区持久化（目录即工作区，<日志目录>/.logGraph/filters.json） ----
/* eslint-disable @typescript-eslint/no-explicit-any */
let workspaceDir: any = null; // 当前工作区句柄（.logGraph 子目录）
let persistTimer = 0;

/** 组装持久化数据（过滤器 + 分组 + 画布坐标） */
function buildPersistData(get: () => LogState): PersistedFilters {
  return {
    filters: get().filters.map((f) => ({ ...f })),
    groups: get().groups.map((g) => ({ ...g })),
    graphNodes: { ...get().graphNodes },
    savedAt: Date.now(),
  };
}

/** 立即写入当前工作区（无工作区则 no-op） */
async function persistNow(get: () => LogState): Promise<void> {
  if (!workspaceDir) return;
  try {
    await writeFilters(workspaceDir, buildPersistData(get));
  } catch (e) {
    console.error('工作区持久化写入失败', e);
  }
}

/** 防抖写入工作区 filters.json */
function schedulePersist(get: () => LogState) {
  if (!workspaceDir) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    persistNow(get);
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

  // --- SQLite 数据驻留模式（dbMode）---
  /** true=数据驻留 cache.db（rawLines 空、raw/message 惰性）；过滤走 Rust 下推 */
  dbMode: boolean;
  /** dbMode：SoA 事件索引（事件不物化成对象，行号 O(1) 查 ts） */
  dbIndex: DbIndex | null;

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

  // --- 序列图关联（group 内 filter 串行时序） ---
  /** 各 group 的序列匹配结果（groupId → result；未配置/无边的 group 不在内） */
  sequenceResults: Record<string, SequenceMatchResult>;
  recomputeSequences: () => void;
  addSequenceEdge: (
    groupId: string,
    fromFilterId: string,
    toFilterId: string,
    maxGapMs?: number,
    opts?: { kind?: SequenceEdge['kind']; toFilterIds?: string[]; periodMs?: number },
  ) => string;
  updateSequenceEdge: (
    groupId: string,
    edgeId: string,
    patch: Partial<SequenceEdge>,
  ) => void;
  removeSequenceEdge: (groupId: string, edgeId: string) => void;
  toggleSequenceAnomaly: (groupId: string) => void;
  setSequenceScope: (groupId: string, scope: 'global' | 'thread') => void;
  /** 设置节点循环次数（EPL A{min,max}）；null 删除约束 */
  setNodeCount: (
    groupId: string,
    filterId: string,
    count: { min: number; max: number } | null,
  ) => void;
  /** 设置节点条件表达式（空串删除） */
  setNodeCondition: (groupId: string, filterId: string, expr: string) => void;

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
  /** dbMode 装载：SoA 事件索引 + 元数据；事件不物化，行文本惰性按需取 */
  setLogDb: (index: DbEventIndex, meta: LogMeta) => void;
  /** 离开 dbMode（切回普通模式/关闭目录） */
  exitDbMode: () => void;
  addFilter: (partial?: Partial<Filter>) => string;
  updateFilter: (id: string, patch: Partial<Filter>) => void;
  removeFilter: (id: string) => void;
  recomputeMatches: () => void;
  /** 单 filter 增量重算（编辑 filter 用；大数据量自动分块异步） */
  recomputeFilterMatch: (id: string) => void;
  /** 分块过滤进度（null=无进行中任务）；UI 展示进度条用 */
  matchProgress: { filterId: string; done: number; total: number } | null;
  setViewRange: (r: TimeRange) => void;
  zoomTo: (centerTs: number, factor: number) => void;
  /** 增量缩放：ratioDelta>0 放大，<0 缩小；以 centerTs 为锚点保持该时刻不动 */
  zoomByRatio: (centerTs: number, ratioDelta: number) => void;
  /** 按像素增量平移（chartW 为绘图区像素宽，用于换算 px->ms） */
  panByPx: (px: number, chartW: number) => void;
  panBy: (deltaMs: number) => void;
  resetView: () => void;
  selectEvent: (id: number | null) => void;
  /** 选中并定位：视图范围不含该事件时平移视图使其居中（上方视图跟随切换） */
  focusEvent: (id: number) => void;
  setHovered: (id: number | null) => void;
  setScrubber: (ts: number | null, active?: boolean) => void;
  recomputeCorrelations: () => void;
  setCorrelationWindow: (halfMs: number | null) => void;

  // --- 工作区持久化（目录即工作区） ---
  /** 当前绑定的工作区目录名；null=未绑定（本次会话不持久化） */
  workspaceDirName: string | null;
  /** 浏览器是否支持 FSA */
  persistSupported: boolean;
  /** 把一份存档整体应用到当前状态（id 重映射 / 旧格式迁移 / 补缺省坐标） */
  applyPersistedFilters: (saved: PersistedFilters) => void;
  /** 绑定目录的工作区：创建 .logGraph + 恢复存档（或继承当前状态播种） */
  openWorkspace: (dirHandle: any) => Promise<void>;
  /** 立即写入一次当前状态到工作区 */
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
  dbMode: false,
  dbIndex: null,

  filters: [],
  matches: [],
  matchProgress: null,
  groups: [],
  collapsedGroups: new Set(),
  sequenceResults: {},

  viewRange: null,
  fullRange: null,

  selectedEventId: null,
  hoveredEventId: null,
  scrubberTs: null,
  scrubberActive: false,
  correlationHalfWindow: null, // null = 自适应
  correlatedEventIds: new Set(),

  workspaceDirName: null,
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

  setLogDb: (index, meta) => {
    if (index.count === 0) {
      get().exitDbMode();
      set({ meta });
      return;
    }
    // v3：不物化事件对象（旧版 500 万骨架 LogEvent 是主要 JS 开销）——
    // 索引即 SoA 数组，行号经 posByLine O(1) 查 ts
    let maxLine = 0;
    for (let i = 0; i < index.count; i++) {
      if (index.lines[i] > maxLine) maxLine = index.lines[i];
    }
    const posByLine = new Uint32Array(maxLine + 1).fill(NO_EVENT);
    for (let i = 0; i < index.count; i++) posByLine[index.lines[i]] = i;
    const dbIndex: DbIndex = { ...index, posByLine };
    const fullRange = {
      start: index.ts[0],
      end: index.ts[index.count - 1],
    };
    set({
      events: [], // dbMode：事件不物化，视口/详情按需拉
      rawLines: [],
      meta,
      dbMode: true,
      dbIndex,
      fullRange,
      viewRange: { ...fullRange },
      matches: [],
      selectedEventId: null,
      hoveredEventId: null,
      scrubberTs: null,
      correlatedEventIds: new Set(),
    });
    get().recomputeMatches();
  },

  exitDbMode: () => {
    dbClose();
    set({
      events: [],
      rawLines: [],
      meta: null,
      dbMode: false,
      dbIndex: null,
      fullRange: null,
      viewRange: null,
      matches: [],
      sequenceResults: {},
      selectedEventId: null,
      hoveredEventId: null,
      scrubberTs: null,
      correlatedEventIds: new Set(),
    });
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
    get().recomputeFilterMatch(id); // 增量：只重跑该 filter，其余 matches 引用复用
    schedulePersist(get);
  },

  /** 单 filter 增量重算：dbMode 走 Rust 下推；大数据量（>30 万）走分块异步 + 进度 */
  recomputeFilterMatch: (id) => {
    const { events, filters, matches, dbMode } = get();
    const filter = filters.find((f) => f.id === id);
    if (!filter || (dbMode ? (get().dbIndex?.count ?? 0) === 0 : events.length === 0)) {
      get().recomputeMatches();
      return;
    }
    // 取消上一次未完成的分块任务（连续编辑时只保留最新）
    if (chunkedCancel) {
      chunkedCancel();
      chunkedCancel = null;
    }
    // dbMode：单 filter 也走批量下推（缓存命中直接读库；否则并入单遍扫描），
    // 二进制 (line, ts)[] 直接组装骨架事件
    if (dbMode) {
      void (async () => {
        let events: LogEvent[] = [];
        if (filter.pattern && filter.enabled) {
          try {
            const res = await runDbFiltersBatch([{
              filterId: id,
              pattern: filter.pattern,
              isRegex: filter.isRegex,
              caseSensitive: filter.caseSensitive,
              scope: filter.scope,
            }]);
            events = skelEvents(res.get(id));
          } catch (err) {
            console.warn('[dbMode] db_filters_batch 失败，该 filter 置空:', id, err);
          }
        }
        const match: FilterMatch = { filterId: id, events };
        // 编辑期间 filter 又变了 → 丢弃本次结果
        const cur = get().filters.find((f) => f.id === id);
        if (cur !== filter) return;
        const idx = matches.findIndex((m) => m.filterId === id);
        const next = idx >= 0
          ? matches.map((m, i) => (i === idx ? match : m))
          : [...matches, match];
        set({ matches: next });
        get().recomputeSequences();
        get().recomputeCorrelations();
      })();
      return;
    }
    const applyResult = (match: FilterMatch) => {
      // 与 filters 原序对齐替换该 filter 的 match（其余引用复用）
      const idx = matches.findIndex((m) => m.filterId === id);
      const next = idx >= 0
        ? matches.map((m, i) => (i === idx ? match : m))
        : [...matches, match];
      set({ matches: next, matchProgress: null });
      get().recomputeSequences();
      get().recomputeCorrelations();
    };
    if (events.length <= 300_000) {
      applyResult(FilterEngine.runFilter(events, filter));
      return;
    }
    set({ matchProgress: { filterId: id, done: 0, total: events.length } });
    chunkedCancel = FilterEngine.runFilterChunked(
      events,
      filter,
      (done, total) => {
        // 进度节流：仅当百分比变化 ≥2% 才写 store
        const cur = get().matchProgress;
        if (!cur || cur.filterId !== id) return;
        if (total - done < 50_000 || done - cur.done >= total * 0.02) {
          set({ matchProgress: { filterId: id, done, total } });
        }
      },
      applyResult,
    );
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

  // ---- 序列图关联（group 内 filter 串行时序） ----

  /** 重算所有 group 的序列匹配（依赖 matches + groups.sequence） */
  recomputeSequences: () => {
    const { groups, matches, dbMode } = get();
    // dbMode：优先下推 Rust（PR-4 CEP 加速路径），不支持的特性整体回退 TS 引擎
    if (dbMode) {
      void (async () => {
        const seqGroups: DbRunSeqGroup[] = groups
          .filter((g) => g.sequence && g.sequence.edges.length > 0)
          .map((g) => ({
            groupId: g.id,
            filterIds: g.filterIds,
            scope: g.sequence!.scope,
            edges: g.sequence!.edges.map((e) => ({
              id: e.id,
              fromFilterId: e.fromFilterId,
              toFilterId: e.toFilterId,
              toFilterIds: e.toFilterIds,
              kind: e.kind,
              maxGapMs: e.maxGapMs,
              periodMs: e.periodMs,
            })),
            nodeConditions: g.sequence!.nodeConditions,
            nodeCounts: g.sequence!.nodeCounts,
          }));
        let results: Record<string, SequenceMatchResult>;
        try {
          const resp = await runDbSequences(seqGroups);
          if (resp.fallback) {
            results = runSequenceMatching(groups, matches);
          } else {
            results = resp.results as Record<string, SequenceMatchResult>;
          }
        } catch {
          results = runSequenceMatching(groups, matches);
        }
        set({ sequenceResults: results });
        get().recomputeCorrelations();
      })();
      return;
    }
    const results = runSequenceMatching(groups, matches);
    // 引用不变时避免无谓 set（runSequenceMatching 每次新对象，简单比较）
    set({ sequenceResults: results });
  },

  addSequenceEdge: (groupId, fromFilterId, toFilterId, maxGapMs, opts) => {
    const kind = opts?.kind ?? 'seq';
    // periodic 允许自环；其余不允许 from === to 单目标
    if (kind !== 'periodic' && fromFilterId === toFilterId) return '';
    const newTargets =
      kind === 'and' || kind === 'or'
        ? (opts?.toFilterIds?.length ? opts.toFilterIds : [toFilterId]).slice().sort()
        : null;
    const groups = get().groups.map((g) => {
      if (g.id !== groupId) return g;
      const seq = g.sequence ?? { edges: [], anomalyEnabled: false };
      // 去重：同 from + 同 kind + 同目标集合（periodic 只看 from+kind）
      const dup = seq.edges.some((e) => {
        if (e.fromFilterId !== fromFilterId || (e.kind ?? 'seq') !== kind) return false;
        if (kind === 'periodic') return true;
        const eTargets =
          (kind === 'and' || kind === 'or') && e.toFilterIds?.length
            ? [...e.toFilterIds].sort()
            : [e.toFilterId];
        return JSON.stringify(eTargets) === JSON.stringify(newTargets);
      });
      if (dup) return g;
      const edge: SequenceEdge = {
        id: genEdgeId(),
        fromFilterId,
        toFilterId,
        ...(kind !== 'seq' ? { kind } : {}),
        ...(newTargets && newTargets.length > 1 ? { toFilterIds: newTargets } : {}),
        maxGapMs: maxGapMs ?? 1000,
        ...(kind === 'periodic' ? { periodMs: opts?.periodMs ?? 1000 } : {}),
      };
      return { ...g, sequence: { ...seq, edges: [...seq.edges, edge] } };
    });
    set({ groups });
    get().recomputeSequences();
    schedulePersist(get);
    const g = get().groups.find((x) => x.id === groupId);
    const edge = g?.sequence?.edges.find(
      (e) => e.fromFilterId === fromFilterId && (e.kind ?? 'seq') === kind,
    );
    return edge?.id ?? '';
  },

  updateSequenceEdge: (groupId, edgeId, patch) => {
    const groups = get().groups.map((g) => {
      if (g.id !== groupId || !g.sequence) return g;
      return {
        ...g,
        sequence: {
          ...g.sequence,
          edges: g.sequence.edges.map((e) =>
            e.id === edgeId ? { ...e, ...patch } : e,
          ),
        },
      };
    });
    set({ groups });
    get().recomputeSequences();
    schedulePersist(get);
  },

  removeSequenceEdge: (groupId, edgeId) => {
    const groups = get().groups.map((g) => {
      if (g.id !== groupId || !g.sequence) return g;
      return {
        ...g,
        sequence: {
          ...g.sequence,
          edges: g.sequence.edges.filter((e) => e.id !== edgeId),
        },
      };
    });
    set({ groups });
    get().recomputeSequences();
    schedulePersist(get);
  },

  toggleSequenceAnomaly: (groupId) => {
    const groups = get().groups.map((g) => {
      if (g.id !== groupId) return g;
      const seq = g.sequence ?? { edges: [], anomalyEnabled: false };
      return { ...g, sequence: { ...seq, anomalyEnabled: !seq.anomalyEnabled } };
    });
    set({ groups });
    schedulePersist(get);
  },

  setSequenceScope: (groupId, scope) => {
    const groups = get().groups.map((g) => {
      if (g.id !== groupId) return g;
      const seq = g.sequence ?? { edges: [], anomalyEnabled: false };
      return { ...g, sequence: { ...seq, scope } };
    });
    set({ groups });
    get().recomputeSequences();
    schedulePersist(get);
  },

  setNodeCount: (groupId, filterId, count) => {
    const groups = get().groups.map((g) => {
      if (g.id !== groupId) return g;
      const seq = g.sequence ?? { edges: [], anomalyEnabled: false };
      const next = { ...seq.nodeCounts };
      if (count === null) delete next[filterId];
      else next[filterId] = count;
      return { ...g, sequence: { ...seq, nodeCounts: next } };
    });
    set({ groups });
    get().recomputeSequences();
    schedulePersist(get);
  },

  setNodeCondition: (groupId, filterId, expr) => {
    const groups = get().groups.map((g) => {
      if (g.id !== groupId) return g;
      const seq = g.sequence ?? { edges: [], anomalyEnabled: false };
      const next = { ...seq.nodeConditions };
      if (expr.trim()) next[filterId] = expr;
      else delete next[filterId];
      return { ...g, sequence: { ...seq, nodeConditions: next } };
    });
    set({ groups });
    get().recomputeSequences();
    schedulePersist(get);
  },

  recomputeMatches: () => {
    const { events, filters, dbMode } = get();
    if ((dbMode ? (get().dbIndex?.count ?? 0) : events.length) === 0 || filters.length === 0) {
      set({ matches: [], correlatedEventIds: new Set(), sequenceResults: {} });
      return;
    }
    // dbMode：全部 filter 一次批量下推（单遍扫描；缓存命中的 filter 直接读库）
    if (dbMode) {
      void (async () => {
        const active = filters.filter((f) => f.pattern && f.enabled);
        let results = new Map<string, DbFilterHits>();
        if (active.length > 0) {
          try {
            results = await runDbFiltersBatch(active.map((f) => ({
              filterId: f.id,
              pattern: f.pattern,
              isRegex: f.isRegex,
              caseSensitive: f.caseSensitive,
              scope: f.scope,
            })));
          } catch (err) {
            console.warn('[dbMode] db_filters_batch 失败，全部置空:', err);
          }
        }
        const out: FilterMatch[] = filters.map((f) => ({
          filterId: f.id,
          events: skelEvents(results.get(f.id)),
        }));
        // 过滤期间用户可能又改了 filters → 结果以最新为准重新跑
        if (get().filters !== filters) {
          get().recomputeMatches();
          return;
        }
        set({ matches: out });
        get().recomputeSequences();
        get().recomputeCorrelations();
      })();
      return;
    }
    const matches = FilterEngine.run(events, filters);
    set({ matches });
    get().recomputeSequences();
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
    if (id !== null) {
      const s = get();
      const ts = s.dbMode ? dbTsByLine(s, id) : (s.events.find((e) => e.id === id)?.ts ?? null);
      if (ts !== null) set({ scrubberTs: ts });
    }
    get().recomputeCorrelations();
  },

  focusEvent: (id) => {
    get().selectEvent(id);
    const s = get();
    const { viewRange, fullRange } = s;
    const evTs = s.dbMode ? dbTsByLine(s, id) : (s.events.find((e) => e.id === id)?.ts ?? null);
    if (evTs === null || !viewRange || !fullRange) return;
    // 已在可视范围内则不平移
    if (evTs >= viewRange.start && evTs <= viewRange.end) return;
    // 平移视图使事件居中（宽度保持不变）
    const span = viewRange.end - viewRange.start || 1;
    let start = evTs - span / 2;
    let end = start + span;
    if (start < fullRange.start) {
      start = fullRange.start;
      end = start + span;
    }
    if (end > fullRange.end) {
      end = fullRange.end;
      start = Math.max(fullRange.start, end - span);
    }
    set({ viewRange: { start, end } });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  setHovered: (id) => set({ hoveredEventId: id }),

  setScrubber: (ts, active) =>
    set({ scrubberTs: ts, scrubberActive: active ?? get().scrubberActive }),

  setCorrelationWindow: (halfMs) => {
    set({ correlationHalfWindow: halfMs });
    get().recomputeCorrelations();
  },

  recomputeCorrelations: () => {
    const s = get();
    const { matches, selectedEventId, events, viewRange, correlationHalfWindow, scrubberTs } = s;

    // 选中事件驱动关联；若无选中则用游标
    let centerTs: number | null = null;
    if (selectedEventId !== null) {
      centerTs = s.dbMode
        ? dbTsByLine(s, selectedEventId)
        : (events.find((e) => e.id === selectedEventId)?.ts ?? null);
    } else if (scrubberTs !== null) {
      centerTs = scrubberTs;
    }

    const filterIds = matches.filter((m) => m.events.length > 0).map((m) => m.filterId);
    if (centerTs === null || filterIds.length === 0) {
      if (get().correlatedEventIds.size > 0) {
        set({ correlatedEventIds: new Set() });
      }
      return;
    }

    // 自适应窗口：可见范围的 2%
    const half =
      correlationHalfWindow ??
      (viewRange ? (viewRange.end - viewRange.start) * 0.02 : 1000);

    if (s.dbMode) {
      // v3：关联窗口下推 SQL（line_ts 覆盖索引范围扫 × filter_hits 点查），
      // 替代 JS 全量扫 matches（每次视图变化 O(总命中数)）
      const seq = ++corrSeq; // 视图快速变化时丢弃过期响应
      void fetchCorrIds(filterIds, centerTs - half, centerTs + half)
        .then((ids) => {
          if (seq !== corrSeq) return;
          set({ correlatedEventIds: new Set(ids) });
        })
        .catch(() => {
          if (seq !== corrSeq) return;
          set({ correlatedEventIds: new Set() });
        });
      return;
    }

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

  // ---- 工作区持久化（目录即工作区） ----
  applyPersistedFilters: (saved) => {
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
    // 序列配置恢复：边端点 / 节点约束里的 filter id 全部重映射 旧id→新id，
    // 端点已删除的边与约束直接丢弃；全部边失效则视为未配置（undefined）
    const remapSequence = (seq: any): SequenceConfig | undefined => {
      if (!seq || !Array.isArray(seq.edges)) return undefined;
      const edges: SequenceEdge[] = [];
      for (const e of seq.edges) {
        if (!e || typeof e.fromFilterId !== 'string' || typeof e.toFilterId !== 'string') continue;
        const from = oldToNewFid.get(e.fromFilterId);
        if (!from) continue;
        const to = oldToNewFid.get(e.toFilterId);
        const toList = Array.isArray(e.toFilterIds)
          ? (e.toFilterIds as string[])
              .map((t) => oldToNewFid.get(t))
              .filter((t): t is string => !!t)
          : undefined;
        const kind = (e.kind ?? 'seq') as SequenceEdge['kind'];
        // 非 periodic 需要有效目标（单目标或 and/or 多目标列表）
        if (kind !== 'periodic' && !to && !(toList && toList.length)) continue;
        edges.push({
          id: typeof e.id === 'string' ? e.id : genEdgeId(),
          fromFilterId: from,
          toFilterId: to ?? from, // and/or 以 toFilterIds 为准，单值仅占位
          ...(toList && toList.length ? { toFilterIds: toList } : {}),
          ...(kind !== 'seq' ? { kind } : {}),
          maxGapMs: typeof e.maxGapMs === 'number' ? e.maxGapMs : 1000,
          ...(kind === 'periodic' && typeof e.periodMs === 'number' ? { periodMs: e.periodMs } : {}),
        });
      }
      if (edges.length === 0) return undefined;
      const nodeCounts: Record<string, NodeCount> = {};
      if (seq.nodeCounts && typeof seq.nodeCounts === 'object') {
        for (const [fid, c] of Object.entries(seq.nodeCounts) as [string, any][]) {
          const nid = oldToNewFid.get(fid);
          if (!nid || !c || typeof c.min !== 'number' || typeof c.max !== 'number') continue;
          nodeCounts[nid] = { min: c.min, max: c.max };
        }
      }
      const nodeConditions: Record<string, string> = {};
      if (seq.nodeConditions && typeof seq.nodeConditions === 'object') {
        for (const [fid, expr] of Object.entries(seq.nodeConditions) as [string, any][]) {
          const nid = oldToNewFid.get(fid);
          if (!nid || typeof expr !== 'string' || !expr) continue;
          nodeConditions[nid] = expr;
        }
      }
      return {
        edges,
        anomalyEnabled: seq.anomalyEnabled === true,
        ...(seq.scope === 'thread' ? { scope: 'thread' } : {}),
        ...(Object.keys(nodeCounts).length ? { nodeCounts } : {}),
        ...(Object.keys(nodeConditions).length ? { nodeConditions } : {}),
      };
    };
    // 恢复分组；新格式有 filterIds（需重映射到新 id），旧格式无则从 filter.groupId 反向迁移；
    // sequence（连线/节点约束）一并恢复并重映射（修复：刷新后连线丢失）
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
          const sequence = remapSequence(g.sequence);
          // 新格式：filterIds 重映射 旧id→新id（找不到的丢弃）
          if (Array.isArray(g.filterIds)) {
            return {
              ...base,
              filterIds: g.filterIds
                .map((fid: string) => oldToNewFid.get(fid))
                .filter((fid: string | undefined): fid is string => !!fid),
              ...(sequence ? { sequence } : {}),
            };
          }
          // 旧格式：filterIds 为空，下方迁移旧 filter.groupId
          return { ...base, filterIds: [] as string[], ...(sequence ? { sequence } : {}) };
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
  },

  openWorkspace: async (dirHandle) => {
    // 1. 先把旧工作区的当前状态刷盘（切目录防丢最后一次编辑）
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    await persistNow(get);
    // 2. 创建/打开 <目录>/.logGraph（失败→降级：本次会话不持久化，不阻断日志加载）
    const ws = await openWorkspaceDir(dirHandle);
    workspaceDir = ws;
    set({ workspaceDirName: ws ? dirHandle.name ?? '.logGraph' : null });
    if (!ws) return;
    // 3. 有存档→整体恢复（存档是权威，空存档也如实应用）；
    //    无存档→继承当前内存状态作为起点（选 B），立即播种写入新工作区
    const saved = await readFilters(ws);
    if (saved) {
      get().applyPersistedFilters(saved);
    } else {
      await persistNow(get);
    }
  },

  saveFiltersNow: async () => {
    await persistNow(get);
  },

  // ---- 日志目录 ----
  setLogsDir: (handle, name) => {
    set({ logsDirHandle: handle, logsDirName: name });
  },

  chooseLogsDir: async () => {
    const dir = await pickLogDirectory();
    if (!dir) return;
    set({ logsDirHandle: dir, logsDirName: dir.name });
    // 目录即工作区：绑定 .logGraph（恢复存档或继承当前状态播种）
    await get().openWorkspace(dir);
  },

  initLogsDir: async () => {
    if (!isFSASupportedDir()) return;
    try {
      const dir = await getSavedLogDirectory();
      if (!dir) {
        // 无已存日志目录：尝试旧版「持久化目录」一次性迁移（种子本次会话，成功后清理指针）
        const legacy = await readLegacyPersistedFilters();
        if (legacy && Array.isArray(legacy.filters) && legacy.filters.length > 0) {
          get().applyPersistedFilters(legacy);
          await clearLegacyPersistDir();
        }
        return;
      }
      if (!(await ensureReadPermission(dir))) return;
      set({ logsDirHandle: dir, logsDirName: dir.name });
      // 恢复上次工作区（含其过滤器/分组/画布坐标）
      await get().openWorkspace(dir);
    } catch (e) {
      console.error('日志目录恢复失败', e);
    }
  },
}));
