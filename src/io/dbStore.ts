/**
 * v4 数据层桥接（REST 化）：ws_* 无状态命令 + 命中缓存。
 *
 * - 打开目录：ws_info（读 + 行偏移 + 计数 + 首/末行 ts，带进度）→ 返回 WsCtx，
 *   由客户端持有、后续请求回传（服务端无会话状态）
 * - 过滤：ws_filters（单遍批量扫描，命中行 ts 内联解析）→ 二进制 (line, ts)[]
 * - 详情/上下文：ws_lines / ws_line（行偏移 seek 直读原文件）
 */

import { splitSubConditions } from '../filters/FilterEngine';
import { aggregateFilterHits, ensureRegexWasm } from '../filters/regexWasm';
import { isTauri } from '../lib/tauri';
import { toast } from '../store/uiStore';

// ---- DTO（Rust serde camelCase）----

/** ctx 文件表条目（firstLine 升序；客户端不透明持有、原样回传） */
export interface WsCtxFile {
  name: string;
  firstLine: number;
  lineCount: number;
  size: number;
}

/** 工作区上下文：ws_info 产出，客户端持有回传；引擎按 ctx 零 I/O 重建请求级工作视图 */
export interface WsCtx {
  files: WsCtxFile[];
  totalLines: number;
  skipped: number;
  fileCount: number;
  timestampFormatId: string | null;
  /** 时间轴范围（epoch ms）；目录无任何 ts → null（退回非 dbMode） */
  rangeStart: number | null;
  rangeEnd: number | null;
}

// ---- 客户端状态（REST：服务端无状态，dir + ctx 由客户端携带）----

/** 当前工作区（ws_info 成功时写入；替代 Rust 侧已删除的会话状态） */
let currentDir: string | null = null;
let currentCtx: WsCtx | null = null;

/** 无工作区时抛错（语义同旧「目录未打开」） */
function requireWs(): { dir: string; ctx: WsCtx } {
  if (!currentDir || !currentCtx) {
    throw new Error('目录未打开');
  }
  return { dir: currentDir, ctx: currentCtx };
}

/** dir 去尾部斜杠 + '/' + name（getDbFiles 拼绝对路径用） */
function joinDirFile(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`;
}



/** 文件清单条目（firstLine 升序；由 ctx 推导） */
export interface DbFileInfo {
  /** 该文件首行的全局行号 */
  firstLine: number;
  /** 相对路径（显示用） */
  name: string;
  /** 绝对路径（reveal / 外部打开用） */
  path: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: fn } = await import('@tauri-apps/api/core');
  return fn<T>(cmd, args);
}

// ---- 打开 / 关闭 ----

/** 建工作区上下文（ws_info：REST 化后唯一付整读价的入口；重建时经
 *  onProgress 报告逐文件进度）。成功后 dir + ctx 存入模块状态，后续
 *  ws_* 请求自动携带。files：相对路径清单（不传=目录全集）；部分勾选 /
 *  排除规则后的可见集都传清单——子集建库，不再落回 loadMultiple 慢路径。 */
export async function dbOpen(
  dir: string,
  onProgress?: (loaded: number, total: number, current: string) => void,
  files?: string[],
): Promise<WsCtx | null> {
  if (!isTauri()) return null;
  let unlisten: (() => void) | null = null;
  try {
    if (onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ loaded: number; total: number; current: string }>(
        'ws_build_progress',
        (e) => onProgress(e.payload.loaded, e.payload.total, e.payload.current),
      );
    }
    const r = await invoke<WsCtx>('ws_info', { dir, files: files ?? null });
    if (
      !r ||
      typeof r.totalLines !== 'number' ||
      !Array.isArray(r.files) ||
      (r.rangeStart !== null && typeof r.rangeStart !== 'number')
    ) {
      console.warn('[dbStore] ws_info 返回形状异常', r);
      return null;
    }
    currentDir = dir;
    currentCtx = r;
    return r;
  } catch (err) {
    console.warn('[dbStore] ws_info 失败:', err);
    return null;
  } finally {
    unlisten?.();
  }
}

/** 关闭工作区：清客户端 dir/ctx 状态（服务端本就无状态，无需 invoke） */
export function dbClose(): void {
  currentDir = null;
  currentCtx = null;
}


// ---- 过滤下推（rg 引擎 + 命中缓存）----

export interface DbFilterQuery {
  /** 前端 filter id（filter_hits 表主键之一；编辑覆盖重写） */
  filterId: string;
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  scope: 'raw' | 'message';
}

/** 单个 filter 的命中：平行数组（ts 升序；raw/message 由前端按需拉行） */
export interface DbFilterHits {
  lines: Uint32Array;
  ts: Float64Array;
}

/** 多行 filter 子条件的下推 id 分隔符（fid \0 i；引擎命中缓存按子条件独立存） */
const SUB_ID_SEP = '\u0000';

/** 升序行号数组的二分包含判断 */
function includesLine(arr: Uint32Array, x: number): boolean {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === x) return true;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** 多行 filter 聚合（JS 兜底）：正向 sub 行集交集 − 排除 sub 行集并集。
 *  与桌面引擎 `engine/src/filter_agg.rs::aggregate_sub_hits` 逐字一致——仅当 wasm
 *  未就绪/失败时使用；`aggregateFilterHits`（wasm）与桌面跑同一份 Rust 实现。 */
function aggregateSubHitsJs(pos: DbFilterHits[], neg: DbFilterHits[]): DbFilterHits {
  // 与引擎 aggregate_sub_hits 一致：无正向锚（全排除）直接返回空，不崩溃。
  if (pos.length === 0) {
    return { lines: new Uint32Array(0), ts: new Float64Array(0) };
  }
  const sorted = [...pos].sort((a, b) => a.lines.length - b.lines.length);
  const base = sorted[0];
  const lines: number[] = [];
  const ts: number[] = [];
  for (let i = 0; i < base.lines.length; i++) {
    const line = base.lines[i];
    let ok = true;
    for (let k = 1; k < sorted.length && ok; k++) {
      if (!includesLine(sorted[k].lines, line)) ok = false;
    }
    for (let k = 0; k < neg.length && ok; k++) {
      if (includesLine(neg[k].lines, line)) ok = false;
    }
    if (!ok) continue;
    lines.push(line);
    ts.push(base.ts[i]);
  }
  return { lines: new Uint32Array(lines), ts: new Float64Array(ts) };
}

/** 多行 filter 的子条件命中聚合（正向交集 − 排除并集）。
 *  优先走 wasm（`filter-wasm::aggregate_filter_hits`，= 桌面引擎同一份实现），
 *  未就绪/失败回退 `aggregateSubHitsJs`（算法一致）。聚合逻辑单一事实来源在
 *  `engine/src/filter_agg.rs`，Web 与桌面不再各维护一份。 */
export function aggregateSubHits(pos: DbFilterHits[], neg: DbFilterHits[]): DbFilterHits {
  const wasmOut = aggregateFilterHits(pos, neg);
  if (wasmOut) return wasmOut;
  return aggregateSubHitsJs(pos, neg);
}

/**
 * 批量运行过滤器（单遍扫描下推：全部 filter 一次 invoke）。
 * 二进制布局（Rust encode_filter_batch）：
 * `[filterCount u32]` + 每 filter `[idLen u32][id utf8][hitCount u32][pad u32][line u32×n][ts f64×n]`
 * （百万级命中走 JSON 会 100MB+/双端数秒序列化，故走 ArrayBuffer 路径）
 *
 * 多行子条件（换行 AND / ! 排除）：拆成 K 个单行 pattern 一起下推——
 * Rust scan_filters_once 本就单遍多 expr（文件只读一次，K 趟 prefilter），
 * 扫描层零改动；命中在前端聚合（正向交集 − 排除并集），语义与 JS 引擎一致。
 * 全部为排除 sub 的 filter 需要全量行基集，dbMode 拿不到，仍置空并提示。
 */
export async function runDbFiltersBatch(
  queries: DbFilterQuery[],
): Promise<Map<string, DbFilterHits>> {
  const out = new Map<string, DbFilterHits>();
  if (queries.length === 0) return out;
  // 顺手预热 wasm 聚合引擎（幂等；首次可能仍走 JS 兜底，后续走与桌面同源的 wasm）
  void ensureRegexWasm();
  const expanded: DbFilterQuery[] = [];
  const multiPlans: { filterId: string; subs: { subId: string; negate: boolean }[] }[] = [];
  let allNegate = 0;
  for (const q of queries) {
    if (!q.pattern.includes('\n')) {
      expanded.push(q);
      continue;
    }
    const subs = splitSubConditions(q.pattern);
    if (subs.length === 0 || subs.every((s) => s.negate)) {
      // 纯空白（视同空 pattern，无命中）或全排除（无正向锚，缺全行基集）
      if (subs.length > 0) allNegate++;
      continue;
    }
    const plan = { filterId: q.filterId, subs: [] as { subId: string; negate: boolean }[] };
    subs.forEach((s, i) => {
      const subId = `${q.filterId}${SUB_ID_SEP}${i}`;
      expanded.push({
        filterId: subId,
        pattern: s.source,
        isRegex: q.isRegex,
        caseSensitive: q.caseSensitive,
        scope: q.scope,
      });
      plan.subs.push({ subId, negate: s.negate });
    });
    multiPlans.push(plan);
  }
  if (expanded.length === 0) {
    if (allNegate > 0) {
      toast.warn('全排除条件暂不支持目录工作区', '全部为「排除」的过滤器需要全量行基集，目录模式暂不生效，已置空');
    }
    return out;
  }
  const { dir, ctx } = requireWs();
  const buf = await invoke<ArrayBuffer>('ws_filters', { dir, ctx, queries: expanded });
  const raw = new Map<string, DbFilterHits>();
  const v = new DataView(buf);
  const dec = new TextDecoder();
  const fc = v.getUint32(0, true);
  let p = 4;
  for (let i = 0; i < fc; i++) {
    const idLen = v.getUint32(p, true);
    p += 4;
    const id = dec.decode(new Uint8Array(buf, p, idLen));
    p += idLen;
    const n = v.getUint32(p, true);
    p += 8; // hitCount + pad
    const lines = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      lines[k] = v.getUint32(p + k * 4, true);
    }
    p += n * 4;
    const ts = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      ts[k] = v.getFloat64(p + k * 8, true);
    }
    p += n * 8;
    raw.set(id, { lines, ts });
  }
  // 单行 filter 直通；多行按 sub 聚合
  for (const q of queries) {
    if (!q.pattern.includes('\n')) {
      const h = raw.get(q.filterId);
      if (h) out.set(q.filterId, h);
    }
  }
  for (const plan of multiPlans) {
    const pos = plan.subs
      .filter((s) => !s.negate)
      .map((s) => raw.get(s.subId))
      .filter((h): h is DbFilterHits => !!h);
    if (pos.length === 0) continue;
    const neg = plan.subs
      .filter((s) => s.negate)
      .map((s) => raw.get(s.subId))
      .filter((h): h is DbFilterHits => !!h);
    out.set(plan.filterId, aggregateSubHits(pos, neg));
  }
  if (allNegate > 0) {
    toast.warn('全排除条件暂不支持目录工作区', '全部为「排除」的过滤器需要全量行基集，目录模式暂不生效，已置空');
  }
  return out;
}



/**
 * 视口行文本：按全局行号集合批量取（任意顺序；Rust 侧排序去重 + 分段 seek）。
 * 字节布局：`[count u32][pad u32] + 每行 [line u32][len u32][utf-8 bytes]`
 */
export async function fetchLinesByIds(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const buf = (await invoke('ws_lines', { ...requireWs(), ids })) as ArrayBuffer;
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return out;
  const view = new DataView(buf);
  const count = view.getUint32(0, true);
  const decoder = new TextDecoder();
  let p = 8;
  for (let i = 0; i < count; i++) {
    const line = view.getUint32(p, true);
    const len = view.getUint32(p + 4, true);
    p += 8;
    out.set(line, decoder.decode(new Uint8Array(buf, p, len)));
    p += len;
  }
  return out;
}

/** 文件清单（firstLine 升序；详情无限上下文的行号→文件定位 + 右键打开用）。
 *  db_files IPC 已删除：由客户端持有的 ctx 推导（dir + ctx 是唯一权威）。 */
export function getDbFiles(): DbFileInfo[] {
  if (!currentDir || !currentCtx) return [];
  const dir = currentDir;
  return currentCtx.files.map((f) => ({
    firstLine: f.firstLine,
    name: f.name,
    path: joinDirFile(dir, f.name),
  }));
}

/** 在系统文件管理器中定位该文件（Windows 选中显示）。失败 toast 由调用方处理。 */
export function revealInDir(path: string): Promise<void> {
  return invoke('ws_reveal_path', { path });
}

/** 用系统默认应用打开该文件。失败 toast 由调用方处理。 */
export function openFileExternally(path: string): Promise<void> {
  return invoke('ws_open_path', { path });
}

/** 单行文本 */
export async function fetchLine(no: number): Promise<string> {
  return invoke<string>('ws_line', { ...requireWs(), no });
}

// ---- 序列匹配 SQL 加速路径（PR-4：CEP 下推，dbMode 大数据加速）----

export interface DbRunSeqEdge {
  id: string;
  fromFilterId: string;
  toFilterId: string;
  toFilterIds?: string[];
  kind?: 'seq' | 'not' | 'and' | 'or' | 'periodic' | 'opt';
  maxGapMs: number;
  periodMs?: number;
}

export interface DbRunSeqGroup {
  groupId: string;
  filterIds: string[];
  scope?: 'global' | 'thread';
  edges: DbRunSeqEdge[];
  nodeConditions?: Record<string, string>;
  nodeCounts?: Record<string, { min: number; max: number }>;
  /** 引擎返回链数上限：截断时 totalChains/coveredMarks 携带全量统计与 lane 标记 */
  maxChains?: number;
}

export interface DbRunSeqResponse {
  /** true → 引擎整体回退（is_supported 恒 true 后不应出现；保留供引擎未来新增门控）。
   *  调用方（logStore.recomputeSequences）以同一份 cep.rs 的 wasm 兜底，
   *  仍失败则写 cepEngineError 显式报错——TS 兜底副本已删除 */
  fallback: boolean;
  results: Record<string, unknown>;
}

/**
 * 把序列匹配下推到 Rust（queries 先 warm 命中缓存，再以 (line, ts) 命中
 * 作为事件流贪心链匹配）。queries 必须覆盖 groups 引用到的全部 filter，
 * 否则对应事件缺失。thread 分桶 / nodeConditions / nodeCounts / opt /
 * periodic 自 engine ≥ 0.2.1 起均已支持；「全排除」跨行组需全量行基集，
 * 由调用方分流到 wasm 路径（见 logStore.recomputeSequences）。
 */
export async function runDbSequences(
  groups: DbRunSeqGroup[],
  queries: DbFilterQuery[],
): Promise<DbRunSeqResponse> {
  if (!isTauri()) return { fallback: true, results: {} };
  const specs = groups
    .filter((g) => g.edges && g.edges.length > 0)
    .map((g) => ({
      groupId: g.groupId,
      filterIds: g.filterIds,
      scope: g.scope ?? 'global',
      edges: g.edges.map((e) => ({
        id: e.id,
        fromFilterId: e.fromFilterId,
        toFilterId: e.toFilterId,
        toFilterIds: e.toFilterIds,
        kind: e.kind,
        maxGapMs: e.maxGapMs,
        periodMs: e.periodMs,
      })),
      nodeConditions: g.nodeConditions,
      nodeCounts: g.nodeCounts,
      maxChains: g.maxChains,
    }));
  if (specs.length === 0) return { fallback: true, results: {} };
  try {
    const r = await invoke<DbRunSeqResponse>('ws_sequences', { ...requireWs(), queries, groups: specs });
    return r ?? { fallback: true, results: {} };
  } catch (err) {
    console.warn('[dbStore] ws_sequences 失败，回退 TS:', err);
    return { fallback: true, results: {} };
  }
}
