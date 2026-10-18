/**
 * 全局状态管理（Zustand）。
 * 持有：日志事件、过滤器、匹配结果、视图范围、选中/悬停事件、游标。
 */

import { create } from 'zustand';
import { toast } from './uiStore';
import type { Filter, FilterGroup, FilterMatch, LogEvent, NodeCount, NodePos, SavedRange, SequenceConfig, SequenceEdge, SequenceMatchResult, TimeRange } from '../types';
import type { FullParseResult } from '../parser/parseBridge';
import { FilterEngine, splitSubConditions } from '../filters/FilterEngine';
import {
  ensureCepWasm,
  isCepWasmFailed,
  isCepWasmReady,
  onCepWasmSettled,
  retryCepWasm,
  runCepWasm,
  type CepWasmOutcome,
} from '../sequence/cepWasm';
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
import { recordOpenProject } from '../io/recentProjects';
import {
  dbClose,
  runDbFiltersBatch,
  runDbSequences,
  type DbFilterQuery,
  type DbFilterHits,
} from '../io/dbStore';
import { mergeEventsByTs } from './eventMerge';

let corrRaf = 0;


// ---- 已保存时间范围（localStorage 持久化，跨会话/跨目录共享） ----

const SAVED_RANGES_KEY = 'loggraph.saved-ranges';

function loadSavedRanges(): SavedRange[] {
  try {
    const raw = localStorage.getItem(SAVED_RANGES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r): r is SavedRange =>
        r && typeof r.id === 'string' && typeof r.name === 'string' &&
        typeof r.start === 'number' && typeof r.end === 'number' && r.start < r.end,
    );
  } catch {
    return [];
  }
}

function persistSavedRanges(ranges: SavedRange[]): void {
  try {
    localStorage.setItem(SAVED_RANGES_KEY, JSON.stringify(ranges));
  } catch {
    /* 隐私模式等场景写入失败：仅当前会话可用 */
  }
}

// ---- dbMode 命中查询（v4：无事件索引，matches 骨架自带 ts） ----

/** dbMode 下按行号查命中 ts（选中/悬停都是低频点击级操作，线性足够）；
 *  非命中行（如上下文行）返回 null。 */
export function hitTsByLine(
  state: { matches: FilterMatch[] },
  line: number,
): number | null {
  for (const m of state.matches) {
    const ev = m.events.find((e) => e.id === line);
    if (ev) return ev.ts;
  }
  return null;
}

/** 事件总数（dbMode 走行数——事件不物化，matches 只含命中） */
export const selectEventCount = (s: {
  dbMode: boolean;
  meta: LogMeta | null;
  events: LogEvent[];
}): number => (s.dbMode ? s.meta?.totalLines ?? 0 : s.events.length);

/** 二进制命中 → 骨架事件数组（raw/message 按需拉行；ts 升序由 Rust 保证） */
function skelEvents(hits: DbFilterHits | undefined): LogEvent[] {
  if (!hits || hits.lines.length === 0) return [];
  const out = new Array<LogEvent>(hits.lines.length);
  for (let i = 0; i < hits.lines.length; i++) {
    out[i] = { id: hits.lines[i], ts: hits.ts[i], raw: '', message: '' };
  }
  return out;
}

/** ws_sequences 下推时每组请求的链数上限：引擎只回传按时间序的前 N 条链，
 *  载荷随 N 线性增长（~200B/链，coveredMarks 不受影响）。面板按 RENDER_BATCH
 *  渐进渲染（见 CepTimelinePanel），2000 行 ≈ 50 屏，再深请收窄规则/时间窗。 */
export const CEP_MAX_CHAINS = 2000;

/** 引擎非 ok 结局的 UI 文案（ctx=失败场景前缀）。TS 副本已删除，
 *  失败必须显式呈现，绝不把"没跑"伪装成"没有匹配"。 */
function cepFailureText(
  w: Extract<CepWasmOutcome, { kind: 'failed' } | { kind: 'unsupported' }>,
  ctx?: string,
): string {
  const reason =
    w.kind === 'unsupported'
      ? '引擎声明不支持当前规则特性（is_supported 恒 true 后不应出现，请检查引擎版本）'
      : `引擎错误：${w.error instanceof Error ? w.error.message : String(w.error)}`;
  return ctx ? `${ctx}；${reason}` : `CEP 引擎不可用——${reason}`;
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

/** 取 Tauri 绝对路径的目录部分（统一 / 分隔；根目录返回盘符根） */
function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? '' : norm.slice(0, i);
}

/** 取路径末段（文件名或目录名） */
function baseNameOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

/** 独立会话中的单个日志文件（enabled 控制是否参与分析） */
interface SessionFile {
  name: string;
  size: number;
  /** Tauri 绝对路径（右键「打开所在目录/加载目录」用；浏览器拖入为 null） */
  path: string | null;
  enabled: boolean;
}

/** 实时 tail 状态（C 阶段一：单文件实时跟随，仅桌面 standalone 模式） */
export interface TailState {
  /** 跟随的文件绝对路径 */
  path: string;
  /** 已消费到的字节偏移（下次从该处续读） */
  offset: number;
  /** 是否正在轮询 */
  enabled: boolean;
  /** 本次跟随累计新增事件数（UI 显示「N 新行」） */
  newCount: number;
}

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
    dirExcludePatterns: [...get().dirExcludePatterns],
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

  // --- 数据驻留模式（dbMode）---
  /** true=数据驻留（rawLines 空、raw/message 惰性）；过滤走 Rust 下推 */
  dbMode: boolean;

  // --- 过滤器 ---
  filters: Filter[];
  matches: FilterMatch[]; // 过滤结果，按 filters 顺序
  /** ws_filters 批量下推在途（dbMode）：纵轴空态据此显示"计算中"而非"无匹配" */
  filtersComputing: boolean;
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
  /** CEP 引擎（wasm）最近一次失败的说明；null=正常。失败时序列匹配未执行，
   *  UI 显示横幅 + 重试——TS 兜底副本已删除，不再有静默回退 */
  cepEngineError: string | null;
  /** wasm 加载窗口期：已注册就绪重算，sequenceResults 暂为旧值 */
  cepEnginePending: boolean;
  recomputeSequences: () => void;
  /** 重试 CEP 引擎（UI 横幅按钮）：重置 wasm 加载状态，就绪/失败后自动重算 */
  retryCepEngine: () => void;
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
  /** 已保存的时间范围书签（时间线 Shift 框选 / 工具栏保存） */
  savedRanges: SavedRange[];
  /** 当前视口来自哪个书签（应用时设置；任何视口操作后清除，chips 高亮用） */
  activeSavedRangeId: string | null;
  /** 保存当前视口（或指定范围）为命名书签；返回新建项（视口无效时 null） */
  saveRange: (name: string, range?: TimeRange) => SavedRange | null;
  /** 应用已存范围：clamp 到 fullRange 后设为当前视口（表格流/时间线共用） */
  applySavedRange: (id: string) => void;
  /** 删除已存范围 */
  removeSavedRange: (id: string) => void;
  /** 重命名 / 修改已存范围的时间戳（校验 name 非空、start < end），失败返回 null */
  updateSavedRange: (
    id: string,
    patch: { name?: string; start?: number; end?: number },
  ) => SavedRange | null;

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
  /** dbMode 装载：时间轴范围 + 元数据；事件不物化，命中/行文本惰性按需取 */
  setLogDb: (range: { start: number | null; end: number | null }, meta: LogMeta) => void;
  /** 离开 dbMode（切回普通模式/关闭目录） */
  exitDbMode: () => void;
  addFilter: (partial?: Partial<Filter>) => string;
  /** 复制过滤器（同 pattern/选项/备注/颜色，沿用所属分组，label 加「副本」后缀） */
  duplicateFilter: (id: string) => string;
  updateFilter: (id: string, patch: Partial<Filter>) => void;
  removeFilter: (id: string) => void;
  recomputeMatches: () => void;
  /** 编辑事件时间戳（纵轴视图时间列可编辑）：不可变更新 events 并级联重算
   *  过滤/CEP/关联。仅内存修改，dbMode 不支持；同 ts 的全部事件一起移动。 */
  updateEventTs: (oldTs: number, newTs: number) => void;
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
  /** 独立会话：脱离目录工作区（外部单文件打开/拖入）。刷盘旧工作区、
   *  解绑 .logGraph，并清空过滤器/分组/CEP 结果/画布/书签等配置态，
   *  防止上一个日志文件的配置残留到新文件 */
  startStandaloneSession: () => Promise<void>;
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
  /** 目录排除规则（glob；文件树枚举与 dbMode 建库清单都会应用） */
  dirExcludePatterns: string[];
  /** 设置排除规则（每条一行；持久化到工作区） */
  setDirExcludePatterns: (patterns: string[]) => void;
  /** 启动时调用：从 IndexedDB 恢复日志目录句柄 */
  initLogsDir: () => Promise<void>;

  // --- 单文件独立会话（拖入/打开的文件集） ---
  /** 当前独立会话已载入的文件清单（enabled=参与分析；文件树勾选控制） */
  sessionFiles: SessionFile[];
  /** 独立会话目录（Tauri 绝对路径；浏览器拖入无路径 → null，永不追加） */
  sessionDirPath: string | null;
  /** 会话全量事件（含已失效文件的；勾选切换时按 sourceFile 过滤重建） */
  sessionEvents: LogEvent[];
  /** 载入单个日志文件：与当前会话同目录（Tauri）则追加合并，
   *  否则新开独立会话（清空上一会话配置）。返回实际采用的方式 */
  ingestSingleFile: (
    loaded: { name: string; size: number; path?: string | null },
    result: FullParseResult,
  ) => Promise<'appended' | 'replaced' | 'duplicate'>;
  /** 勾选切换会话内某文件的启用状态：失效文件的事件从分析中剔除，
   *  重新勾选恢复（时间窗尽量保持，CEP 结果同步重算） */
  toggleSessionFile: (name: string) => void;

  // --- 实时 tail（C 阶段一） ---
  /** 跟随配置；null=当前会话不支持/未启用实时跟随（多文件 / dbMode / 无路径） */
  tail: TailState | null;
  /** 开启/关闭跟随轮询（tail 存在时切换 enabled） */
  setTailEnabled: (on: boolean) => void;
  /** 增量追加 tail 解析结果（重基 id + 稳定合并进全局 events + 重算） */
  appendTailEvents: (
    events: LogEvent[],
    rawLines: string[],
    newOffset: number,
    skipped: number,
    fileSize: number,
  ) => void;

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
  sessionFiles: [],
  sessionDirPath: null,
  sessionEvents: [],
  tail: null,

  filters: [],
  matches: [],
  filtersComputing: false,
  matchProgress: null,
  groups: [],
  collapsedGroups: new Set(),
  sequenceResults: {},
  cepEngineError: null,
  cepEnginePending: false,

  viewRange: null,
  fullRange: null,
  savedRanges: loadSavedRanges(),
  activeSavedRangeId: null,

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
  dirExcludePatterns: [],
  setDirExcludePatterns: (patterns) => {
    set({ dirExcludePatterns: patterns });
    schedulePersist(get);
  },

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
        tail: null,
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
      tail: null,
    });
    get().recomputeMatches();
  },

  setLogDb: (range, meta) => {
    // 无行或无任何 ts → 与旧版（事件索引为空）同语义：退回非 dbMode
    if (meta.totalLines === 0 || range.start == null || range.end == null) {
      get().exitDbMode();
      set({ meta });
      return;
    }
    // v4：无事件索引/无 JS 侧物化（旧版 10M 行 posByLine 双循环 ~4s）——
    // 时间轴范围来自建库首/末行 ts，命中 ts 在 matches 骨架里
    const fullRange = { start: range.start, end: range.end };
    set({
      events: [], // dbMode：事件不物化，视口/详情按需拉
      rawLines: [],
      meta,
      dbMode: true,
      fullRange,
      viewRange: { ...fullRange },
      matches: [],
      selectedEventId: null,
      hoveredEventId: null,
      scrubberTs: null,
      correlatedEventIds: new Set(),
      tail: null,
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
      fullRange: null,
      viewRange: null,
      matches: [],
      sequenceResults: {},
      cepEngineError: null,
      cepEnginePending: false,
      selectedEventId: null,
      hoveredEventId: null,
      scrubberTs: null,
      correlatedEventIds: new Set(),
      tail: null,
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
      ...(Array.isArray(partial?.subNotes) ? { subNotes: partial.subNotes } : {}),
    };
    set({ filters: [...get().filters, filter] });
    get().recomputeMatches();
    schedulePersist(get);
    return id;
  },

  duplicateFilter: (id) => {
    const src = get().filters.find((f) => f.id === id);
    if (!src) return '';
    const newId = genFilterId();
    const copy: Filter = {
      ...src,
      id: newId,
      label: `${src.label.replace(/ 副本$/, '')} 副本`,
    };
    set({
      filters: [...get().filters, copy],
      // 源 filter 所在的分组一并加入副本（文件复制落在同一文件夹）
      groups: get().groups.map((g) =>
        g.filterIds.includes(id) ? { ...g, filterIds: [...g.filterIds, newId] } : g,
      ),
    });
    get().recomputeMatches();
    schedulePersist(get);
    return newId;
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
    if (!filter || (dbMode ? get().meta?.totalLines === 0 : events.length === 0)) {
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
            console.warn('[dbMode] ws_filters 失败，该 filter 置空:', id, err);
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

  /** 重算所有 group 的序列匹配（依赖 matches + groups.sequence）。
   *
   *  引擎拓扑（TS 副本已删除，wasm 与桌面 native 编译同一份 cep.rs）：
   *  - dbMode：单行/常规组下推 native（runDbSequences，可扩展）；
   *    仅「全排除」跨行组必须走 wasm（需要全量行基集，目录模式拿不到）；
   *    native 异常/回退时用同一份 cep.rs 的 wasm 兜底，仍失败才显式报错。
   *  - Web 端：wasm 是唯一引擎。
   *  wasm 首次加载窗口期：保留旧结果，注册 onCepWasmSettled 就绪后自动重算；
   *  失败写 cepEngineError 由 UI 横幅 + 重试呈现，绝不静默空跑。 */
  recomputeSequences: () => {
    const { groups, matches, dbMode, filters } = get();
    // 幂等启动 wasm CEP 引擎（App 启动时已预热，这里双保险）
    void ensureCepWasm();
    if (dbMode) {
      void (async () => {
        // engine ≥ 0.2.2 起引擎自带跨行聚合（拆分下推 fid\0i + 引擎内取交集），
        // 含跨行 filter 的 group 也能下推；仅「全排除」仍需走 wasm——它需要全量
        // 行基集，目录模式拿不到（与 dbStore 的全排除提示同源）。
        const seqGroups = groups.filter((g) => g.sequence && g.sequence.edges.length > 0);
        const tsGroups = seqGroups.filter((g) =>
          g.filterIds.some((fid) => {
            const p = filters.find((f) => f.id === fid)?.pattern ?? '';
            if (!p.includes('\n')) return false;
            const subs = splitSubConditions(p);
            return subs.length > 0 && subs.every((s) => s.negate);
          }),
        );
        const rustGroups = seqGroups.filter((g) => !tsGroups.includes(g));
        let results: Record<string, SequenceMatchResult> = {};
        let engineError: string | null = null;
        // wasm 恰好在加载（含重试竞态）：保留旧结果，落定后自动重算
        const deferUntilSettled = () => {
          set({ cepEnginePending: true });
          onCepWasmSettled(() => {
            set({ cepEnginePending: false });
            get().recomputeSequences();
          });
        };
        // 仅当本批规则确实需要 wasm（tsGroups 非空）时才预检加载窗口——
        // 纯 native 路径不应被 wasm 加载状态阻塞
        if (tsGroups.length > 0 && !isCepWasmReady() && !isCepWasmFailed()) {
          deferUntilSettled();
          return;
        }
        if (rustGroups.length > 0) {
          try {
            // REST 化：ws_sequences 需携带 groups 引用到的全部 filter 的
            // FilterQuery（先 warm 命中缓存再跑 CEP）；rustGroups 已排除
            // 含多行 filter 的组，故引用集均为单行 filter
            const refIds = new Set(rustGroups.flatMap((g) => g.filterIds));
            const seqQueries: DbFilterQuery[] = filters
              .filter((f) => refIds.has(f.id) && f.pattern)
              .map((f) => ({
                filterId: f.id,
                pattern: f.pattern,
                isRegex: f.isRegex,
                caseSensitive: f.caseSensitive,
                scope: f.scope,
              }));
            const resp = await runDbSequences(
              rustGroups.map((g) => ({
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
                maxChains: CEP_MAX_CHAINS,
              })),
              seqQueries,
            );
            if (resp.fallback) {
              // 引擎整体回退（is_supported 恒 true 后不应出现）：同一份 cep.rs 的 wasm 顶上
              const w = runCepWasm(rustGroups, matches);
              if (w.kind === 'ok') results = w.results;
              else if (w.kind === 'loading') {
                deferUntilSettled();
                return;
              } else engineError = cepFailureText(w, '原生引擎回退了该组规则');
            } else {
              results = resp.results as Record<string, SequenceMatchResult>;
            }
          } catch (e) {
            // native IPC 失败（传输/进程层，非语义问题）：wasm 顶上，仍失败才显式报错
            const w = runCepWasm(rustGroups, matches);
            if (w.kind === 'ok') results = w.results;
            else if (w.kind === 'loading') {
              deferUntilSettled();
              return;
            } else engineError = cepFailureText(w, `原生引擎下推失败（${String(e)}）`);
          }
        }
        if (tsGroups.length > 0) {
          const w = runCepWasm(tsGroups, matches);
          if (w.kind === 'ok') Object.assign(results, w.results);
          else if (w.kind === 'loading') {
            deferUntilSettled();
            return;
          } else engineError = engineError ?? cepFailureText(w, '跨行规则组的 CEP 引擎不可用');
        }
        set({
          sequenceResults: results,
          cepEngineError: engineError,
          cepEnginePending: false,
        });
        get().recomputeCorrelations();
      })();
      return;
    }
    // Web 端：wasm 是唯一引擎（与桌面 native 同一份 cep.rs）
    const w = runCepWasm(groups, matches);
    if (w.kind === 'loading') {
      // 首次加载窗口期：保留旧结果不闪空，就绪/失败后自动重算
      set({ cepEnginePending: true });
      onCepWasmSettled(() => {
        set({ cepEnginePending: false });
        get().recomputeSequences();
      });
      return;
    }
    if (w.kind === 'ok') {
      set({ sequenceResults: w.results, cepEngineError: null, cepEnginePending: false });
    } else {
      // 引擎不可用：清空结果 + 显式错误（UI 横幅 + 重试）——
      // 绝不把"没跑"伪装成"没有匹配"
      set({
        sequenceResults: {},
        cepEngineError: cepFailureText(w),
        cepEnginePending: false,
      });
    }
  },

  retryCepEngine: () => {
    set({ cepEngineError: null, cepEnginePending: true });
    retryCepWasm();
    if (isCepWasmReady()) {
      set({ cepEnginePending: false });
      get().recomputeSequences();
      return;
    }
    // 重置后必然处于 loading：落定（就绪/再次失败）后自动重算，
    // 失败路径由 recomputeSequences 重新写回 cepEngineError
    onCepWasmSettled(() => {
      set({ cepEnginePending: false });
      get().recomputeSequences();
    });
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
    if ((dbMode ? get().meta?.totalLines : events.length) === 0 || filters.length === 0) {
      set({ matches: [], correlatedEventIds: new Set(), sequenceResults: {}, filtersComputing: false });
      return;
    }
    // dbMode：全部 filter 一次批量下推（单遍扫描；缓存命中的 filter 直接读库）
    if (dbMode) {
      set({ filtersComputing: true });
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
            console.warn('[dbMode] ws_filters 失败，全部置空:', err);
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
        set({ matches: out, filtersComputing: false });
        get().recomputeSequences();
        get().recomputeCorrelations();
      })();
      return;
    }
    const matches = FilterEngine.run(events, filters);
    set({ matches, filtersComputing: false });
    get().recomputeSequences();
    get().recomputeCorrelations();
  },

  updateEventTs: (oldTs, newTs) => {
    if (!Number.isFinite(newTs) || newTs <= 0 || oldTs === newTs) return;
    const { dbMode, events } = get();
    if (dbMode || !events || events.length === 0) {
      if (dbMode) toast.warn('数据库模式下暂不支持编辑时间戳');
      return;
    }
    const updated = events.map((e) => (e.ts === oldTs ? { ...e, ts: newTs } : e));
    // 维持 events 按 ts 升序不变式（FilterEngine 不分桶排序，下游 bisect 依赖有序）
    updated.sort((a, b) => a.ts - b.ts);
    set({ events: updated });
    get().recomputeMatches();
  },

  setViewRange: (r) => {
    set({ viewRange: r, activeSavedRangeId: null });
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
    set({ viewRange: { start, end }, activeSavedRangeId: null });
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
    set({ viewRange: { start, end }, activeSavedRangeId: null });
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
    set({ viewRange: { start, end }, activeSavedRangeId: null });
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
    set({ viewRange: { start, end }, activeSavedRangeId: null });
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  resetView: () => {
    const { fullRange } = get();
    if (fullRange) set({ viewRange: { ...fullRange }, activeSavedRangeId: null });
  },

  saveRange: (name, range) => {
    const r = range ?? get().viewRange;
    const trimmed = name.trim();
    if (!r || !trimmed || r.end <= r.start) return null;
    const item: SavedRange = {
      id: `rng_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: trimmed,
      start: r.start,
      end: r.end,
    };
    const next = [...get().savedRanges, item];
    set({ savedRanges: next });
    persistSavedRanges(next);
    return item;
  },

  applySavedRange: (id) => {
    const { savedRanges, fullRange } = get();
    const item = savedRanges.find((r) => r.id === id);
    if (!item) return;
    // clamp 到当前数据范围；完全不相交（换了数据集）则不动作
    if (fullRange) {
      const start = Math.max(item.start, fullRange.start);
      const end = Math.min(item.end, fullRange.end);
      if (start >= end) return;
      set({ viewRange: { start, end }, activeSavedRangeId: id });
    } else {
      set({ viewRange: { start: item.start, end: item.end }, activeSavedRangeId: id });
    }
    scheduleCorrRecompute(() => get().recomputeCorrelations());
  },

  removeSavedRange: (id) => {
    const next = get().savedRanges.filter((r) => r.id !== id);
    set({ savedRanges: next });
    persistSavedRanges(next);
  },

  updateSavedRange: (id, patch) => {
    const cur = get().savedRanges.find((r) => r.id === id);
    if (!cur) return null;
    const name = patch.name !== undefined ? patch.name.trim() : cur.name;
    const start = patch.start !== undefined ? patch.start : cur.start;
    const end = patch.end !== undefined ? patch.end : cur.end;
    if (!name || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (name === cur.name && start === cur.start && end === cur.end) return cur;
    const item: SavedRange = { id: cur.id, name, start, end };
    const next = get().savedRanges.map((r) => (r.id === id ? item : r));
    set({ savedRanges: next });
    persistSavedRanges(next);
    // 该范围正被使用时，编辑后同步切换到新范围（含 fullRange 钳制）
    if (get().activeSavedRangeId === id) get().applySavedRange(id);
    return item;
  },

  selectEvent: (id) => {
    set({ selectedEventId: id });
    if (id !== null) {
      const s = get();
      const ts = s.dbMode ? hitTsByLine(s, id) : (s.events.find((e) => e.id === id)?.ts ?? null);
      if (ts !== null) set({ scrubberTs: ts });
    }
    get().recomputeCorrelations();
  },

  focusEvent: (id) => {
    get().selectEvent(id);
    const s = get();
    const { viewRange, fullRange } = s;
    const evTs = s.dbMode ? hitTsByLine(s, id) : (s.events.find((e) => e.id === id)?.ts ?? null);
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
    set({ viewRange: { start, end }, activeSavedRangeId: null });
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
        ? hitTsByLine(s, selectedEventId)
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

    // db_corr_ids IPC 已删除：关联窗口本地计算——matches 即 SoA 解码产物组装的
    // 骨架事件（id=全局行号、ts 内联；无 ts 命中的 ts=NO_TS 极大负数，永不落入
    // 窗口），与通用路径同构，直接走通用路径。
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
    // filter id 沿用持久化原值(缺失/重复才生成新 id):
    // db 缓存(filter_meta 指纹 → filter_hits 复用)按 filter_id 命中,
    // 换 id = 每次打开目录都全量重扫+重写百万级命中行,且旧行成为
    // 无人清理的死数据(实测 cache.db 膨胀到 3.74GB)。
    const oldToNewFid = new Map<string, string>();
    const seenIds = new Set<string>();
    // 从 JSON 恢复过滤器（补全默认字段；保留原 groupId 用于迁移）
    const restoredRaw: Filter[] = saved.filters.map((f: any, i: number) => {
      const keep = typeof f.id === 'string' && !!f.id && !seenIds.has(f.id);
      const newId = keep ? f.id : genFilterId();
      seenIds.add(newId);
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
        ...(Array.isArray(f.subNotes)
          ? { subNotes: f.subNotes.map((n: unknown) => (typeof n === 'string' ? n : '')) }
          : {}),
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
      dirExcludePatterns: Array.isArray(saved.dirExcludePatterns)
        ? saved.dirExcludePatterns.filter((p): p is string => typeof p === 'string')
        : [],
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

  startStandaloneSession: async () => {
    // 1. 旧工作区最后状态刷盘（防丢编辑），随后解绑
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    await persistNow(get);
    workspaceDir = null;
    // 2. 取消进行中的分块过滤任务（旧 filters 的结果对新会话无意义）
    if (chunkedCancel) {
      chunkedCancel();
      chunkedCancel = null;
    }
    // 3. dbMode（目录全量 SQLite 驻留）同样属于旧会话，关闭释放
    dbClose();
    // 4. 清配置态：过滤器/分组/CEP/画布/书签全部归零
    try {
      localStorage.removeItem(SAVED_RANGES_KEY);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    set({
      filters: [],
      groups: [],
      collapsedGroups: new Set<string>(),
      sequenceResults: {},
      cepEngineError: null,
      cepEnginePending: false,
      graphNodes: {},
      graphPan: { x: 0, y: 0 },
      graphZoom: 1,
      activeGroupId: null,
      editingFilterId: null,
      savedRanges: [],
      workspaceDirName: null,
  logsDirName: null,
  dirExcludePatterns: [],
      dbMode: false,
      sessionFiles: [],
      sessionDirPath: null,
      sessionEvents: [],
      tail: null,
    });
  },

  ingestSingleFile: async (loaded, result) => {
    const state = get();
    const dirPath = loaded.path ? dirOf(loaded.path) : null;
    const sameDir =
      dirPath !== null &&
      state.sessionDirPath === dirPath &&
      state.sessionFiles.length > 0;
    // 同目录同名文件已在会话中 → 拒绝（防重复追加翻倍）
    if (sameDir && state.sessionFiles.some((f) => f.name === loaded.name)) {
      return 'duplicate';
    }
    if (sameDir) {
      // 追加：基于会话全量事件合并（禁用文件的事件也在全量里），
      // 全局行号重编 + sourceFile 标记 + 按 ts 全局排序（与目录合并规则一致）
      const baseId = state.rawLines.length;
      const mergedEvents = [
        ...state.sessionEvents,
        ...result.events.map((e) => ({
          ...e,
          id: baseId + e.id,
          sourceFile: loaded.name,
        })),
      ].sort((a, b) => a.ts - b.ts);
      const meta = state.meta;
      const nextFiles: SessionFile[] = [
        ...state.sessionFiles,
        { name: loaded.name, size: loaded.size, path: loaded.path ?? null, enabled: true },
      ];
      const enabledNames = new Set(
        nextFiles.filter((f) => f.enabled).map((f) => f.name),
      );
      get().setLog(
        mergedEvents.filter((e) => enabledNames.has(e.sourceFile ?? '')),
        [...state.rawLines, ...result.rawLines],
        {
          fileName: `${baseNameOf(state.sessionDirPath ?? loaded.name)} (${nextFiles.length} 文件)`,
          fileSize: (meta?.fileSize ?? 0) + loaded.size,
          totalLines: (meta?.totalLines ?? 0) + result.totalLines,
          skipped: (meta?.skipped ?? 0) + result.skipped,
          timestampFormatId: meta?.timestampFormatId ?? result.timestampFormatId,
        },
      );
      set({ sessionFiles: nextFiles, sessionEvents: mergedEvents, tail: null });
      return 'appended';
    }
    // 新开独立会话：清上一会话配置后载入（事件直接标记 sourceFile，
    // 供后续按文件启用/禁用过滤）
    await get().startStandaloneSession();
    const events = result.events.map((e) => ({ ...e, sourceFile: loaded.name }));
    get().setLog(events, result.rawLines, {
      fileName: loaded.name,
      fileSize: loaded.size,
      totalLines: result.totalLines,
      skipped: result.skipped,
      timestampFormatId: result.timestampFormatId,
    });
    set({
      sessionFiles: [{ name: loaded.name, size: loaded.size, path: loaded.path ?? null, enabled: true }],
      sessionDirPath: dirPath,
      sessionEvents: events,
      // 单文件 standalone：配置实时跟随（默认关闭，由工具栏开关启用）
      tail: loaded.path
        ? { path: loaded.path, offset: loaded.size, enabled: false, newCount: 0 }
        : null,
    });
    return 'replaced';
  },

  toggleSessionFile: (name) => {
    const state = get();
    const target = state.sessionFiles.find((f) => f.name === name);
    if (!target || !state.meta) return;
    const nextFiles = state.sessionFiles.map((f) =>
      f.name === name ? { ...f, enabled: !f.enabled } : f,
    );
    const enabledNames = new Set(
      nextFiles.filter((f) => f.enabled).map((f) => f.name),
    );
    const prevView = state.viewRange;
    // 用启用过滤后的事件重建（rawLines 保留全量：事件 id 按行号寻址上下文）
    get().setLog(
      state.sessionEvents.filter((e) => enabledNames.has(e.sourceFile ?? '')),
      state.rawLines,
      state.meta,
    );
    // 时间窗尽量保持（clamp 到新范围；变空则跟随新全量）
    const fr = get().fullRange;
    if (prevView && fr && prevView.start < fr.end && prevView.end > fr.start) {
      const start = Math.max(prevView.start, fr.start);
      const end = Math.min(prevView.end, fr.end);
      if (start < end) set({ viewRange: { start, end } });
    }
    set({ sessionFiles: nextFiles });
    // CEP 结果含事件集合，需同步重算（setLog 只重算过滤器匹配）
    get().recomputeSequences();
  },

  // ---- 实时 tail（C 阶段一） ----

  setTailEnabled: (on) => {
    const t = get().tail;
    if (!t) return;
    set({
      tail: {
        ...t,
        enabled: on,
        // 关闭时清空累计计数；重新开启从当前偏移继续（offset 不变）
        newCount: on ? t.newCount : 0,
      },
    });
  },

  appendTailEvents: (events, rawLines, newOffset, skipped, fileSize) => {
    const state = get();
    const t = state.tail;
    if (!t) return;
    const oldRawLen = state.rawLines.length;
    // 段内事件 id 是段首行号 → 重基为全局 rawLines 行号（追加位置）
    const rebased = events.map((e) => ({ ...e, id: oldRawLen + e.id }));
    // 全局 events 按 ts 升序；两段各自已排序 → 稳定合并（O(N)，不破坏 ts 不变式）
    const mergedEvents = mergeEventsByTs(state.events, rebased);
    const meta = state.meta;
    set({
      events: mergedEvents,
      rawLines: [...state.rawLines, ...rawLines],
      meta: meta
        ? {
            ...meta,
            fileSize,
            totalLines: meta.totalLines + rawLines.length,
            skipped: meta.skipped + skipped,
          }
        : meta,
      tail: { ...t, offset: newOffset, newCount: t.newCount + rebased.length },
      // 新数据到达时若有选中事件，刷新其关联窗口（保持跟随感）
      correlatedEventIds: state.correlatedEventIds,
    });
    get().recomputeMatches();
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
    // 用户显式选择的目录计入最近项目（initLogsDir 的自动恢复不记录）
    await recordOpenProject({ name: dir.name, kind: 'dir', path: dir.path ?? null, handle: dir });
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
