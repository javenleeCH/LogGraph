/**
 * v2 数据层桥接：rg 直扫 + 瘦 SQL（plans/v2-rg-sql-architecture.md）。
 *
 * - 打开目录：db_open（指纹缓存 / ts 扫描建瘦表，带进度）
 * - 事件索引：db_event_index_chunk 键集分页（line, ts）
 * - 过滤：db_filters_batch（单遍批量扫描 + filter_hits 落库）→ 二进制 (line, ts)[]
 * - 详情/上下文：db_context_lines / db_line（mmap 直读原文件）
 */

import { isTauri } from '../lib/tauri';

// ---- DTO（Rust serde camelCase）----

export interface DbOpenResult {
  cacheHit: boolean;
  totalLines: number;
  totalEvents: number;
  skipped: number;
  fileCount: number;
  timestampFormatId: string | null;
}

/** db_events_in_window 条目（line + ts，按 ts 升序） */
export interface DbHitEntry {
  line: number;
  ts: number;
}

/** 文件清单条目（db_files：firstLine 升序） */
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

/** 打开目录缓存库（命中则秒开；重建时经 onProgress 报告逐文件进度） */
export async function dbOpen(
  dir: string,
  onProgress?: (loaded: number, total: number, current: string) => void,
): Promise<DbOpenResult | null> {
  if (!isTauri()) return null;
  let unlisten: (() => void) | null = null;
  try {
    if (onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ loaded: number; total: number; current: string }>(
        'db_build_progress',
        (e) => onProgress(e.payload.loaded, e.payload.total, e.payload.current),
      );
    }
    const r = await invoke<DbOpenResult>('db_open', { dir });
    if (
      !r ||
      typeof r.totalLines !== 'number' ||
      typeof r.totalEvents !== 'number'
    ) {
      console.warn('[dbStore] db_open 返回形状异常', r);
      return null;
    }
    return r;
  } catch (err) {
    console.warn('[dbStore] db_open 失败:', err);
    return null;
  } finally {
    unlisten?.();
  }
}

export function dbClose(): void {
  if (!isTauri()) return;
  invoke('db_close').catch(() => {});
}

// ---- 事件索引（键集分页，二进制 SoA 通道） ----

const INDEX_CHUNK = 200_000;

/** SoA 事件索引：平行数组按 (ts, line) 升序 */
export interface DbEventIndex {
  count: number;
  lines: Uint32Array;
  ts: Float64Array;
}

/**
 * 拉取全量事件索引（二进制 SoA，零对象解析）。
 * 每块字节布局（Rust db_event_index_chunk）：
 * `[count u32][pad u32][ts × count f64 LE][line × count u32 LE]`
 * 注意：首块用 null 作为「无下界」哨兵（Rust 侧 after_ts: Option<i64>）。
 */
export async function fetchEventIndex(
  totalEvents: number,
  onProgress?: (frac: number) => void,
): Promise<DbEventIndex> {
  const lines = new Uint32Array(totalEvents);
  const ts = new Float64Array(totalEvents);
  let filled = 0;
  let afterTs: number | null = null;
  let afterLine = 0;
  while (filled < totalEvents) {
    const buf = (await invoke('db_event_index_chunk', {
      afterTs,
      afterLine,
      max: INDEX_CHUNK,
    })) as ArrayBuffer;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) break;
    const count = new Uint32Array(buf, 0, 1)[0];
    if (count === 0) break;
    const partLines = new Uint32Array(buf, 8 + count * 8, count);
    const partTs = new Float64Array(buf, 8, count);
    lines.set(partLines, filled);
    ts.set(partTs, filled);
    filled += count;
    afterLine = partLines[count - 1];
    afterTs = partTs[count - 1];
    onProgress?.(filled / Math.max(1, totalEvents));
    const { promise: yieldToUi, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await yieldToUi;
  }
  // 库在打开后行数变化（重建并发）→ 截断到实收
  return filled === totalEvents
    ? { count: totalEvents, lines, ts }
    : {
        count: filled,
        lines: lines.subarray(0, filled),
        ts: ts.subarray(0, filled),
      };
}

// ---- 过滤下推（v2：rg 引擎 + filter_hits 落库）----

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

/**
 * 批量运行过滤器（单遍扫描下推：全部 filter 一次 invoke）。
 * 二进制布局（Rust encode_filter_batch）：
 * `[filterCount u32]` + 每 filter `[idLen u32][id utf8][hitCount u32][pad u32][line u32×n][ts f64×n]`
 * （百万级命中走 JSON 会 100MB+/双端数秒序列化，故走 ArrayBuffer 路径）
 */
export async function runDbFiltersBatch(
  queries: DbFilterQuery[],
): Promise<Map<string, DbFilterHits>> {
  const out = new Map<string, DbFilterHits>();
  if (queries.length === 0) return out;
  const buf = await invoke<ArrayBuffer>('db_filters_batch', { queries });
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return out;
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
    out.set(id, { lines, ts });
  }
  return out;
}

/** 删除 filter 的命中记录（filter 被删时调用） */
export function dropDbFilter(filterId: string): void {
  if (!isTauri()) return;
  invoke('db_filter_drop', { filterId }).catch(() => {});
}

/**
 * 视口行文本：按全局行号集合批量取（任意顺序；Rust 侧排序去重 + 分段 seek）。
 * 字节布局：`[count u32][pad u32] + 每行 [line u32][len u32][utf-8 bytes]`
 */
export async function fetchLinesByIds(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const buf = (await invoke('db_lines_by_ids', { ids })) as ArrayBuffer;
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

/** 关联窗口下推：filter_ids 任一命中且 ts∈[start,end] 的去重全局行号（SQL 侧完成） */
export async function fetchCorrIds(
  filterIds: string[],
  start: number,
  end: number,
): Promise<number[]> {
  if (filterIds.length === 0) return [];
  const r = await invoke<number[]>('db_corr_ids', { filterIds, start, end });
  return Array.isArray(r) ? r : [];
}

// ---- 按需取数 ----

/** 视口事件（ts 窗口内，按 ts 升序） */
export async function fetchEventsInWindow(
  start: number,
  end: number,
): Promise<DbHitEntry[]> {
  const r = await invoke<DbHitEntry[]>('db_events_in_window', { start, end });
  return Array.isArray(r) ? r : [];
}

/** 文件清单（firstLine 升序；详情无限上下文的行号→文件定位 + 右键打开用） */
export async function fetchDbFiles(): Promise<DbFileInfo[]> {
  const r = await invoke<DbFileInfo[]>('db_files');
  return Array.isArray(r) ? r : [];
}

/** 在系统文件管理器中定位该文件（Windows 选中显示）。失败 toast 由调用方处理。 */
export function revealInDir(path: string): Promise<void> {
  return invoke('db_reveal_path', { path });
}

/** 用系统默认应用打开该文件。失败 toast 由调用方处理。 */
export function openFileExternally(path: string): Promise<void> {
  return invoke('db_open_path', { path });
}

/** 单行文本 */
export async function fetchLine(no: number): Promise<string> {
  return invoke<string>('db_line', { no });
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
}

export interface DbRunSeqResponse {
  /** true → 存在不支持的特性（thread 分桶 / nodeConditions / nodeCounts / opt / periodic），
   *  调用方应整体回退到前端 TS 引擎 runSequenceMatching */
  fallback: boolean;
  results: Record<string, unknown>;
}

/**
 * 把序列匹配下推到 Rust（从 filter_hits JOIN line_ts 取事件，贪心链匹配）。
 * 仅支持 global 作用域 + seq/and/or/not 边；其它特性由 Rust 端标记 fallback。
 */
export async function runDbSequences(
  groups: DbRunSeqGroup[],
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
    }));
  if (specs.length === 0) return { fallback: true, results: {} };
  try {
    const r = await invoke<DbRunSeqResponse>('db_run_sequences', { groups: specs });
    return r ?? { fallback: true, results: {} };
  } catch (err) {
    console.warn('[dbStore] db_run_sequences 失败，回退 TS:', err);
    return { fallback: true, results: {} };
  }
}
