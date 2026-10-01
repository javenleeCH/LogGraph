/**
 * v2 数据层桥接：rg 直扫 + 瘦 SQL（plans/v2-rg-sql-architecture.md）。
 *
 * - 打开目录：db_open（指纹缓存 / ts 扫描建瘦表，带进度）
 * - 事件索引：db_event_index_chunk 键集分页（line, ts）
 * - 过滤：db_filter（rg 引擎直扫原文件 + filter_hits 落库）→ (line, ts)[]
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

/** db_filter 命中条目（line + ts，按 ts 升序） */
export interface DbHitEntry {
  line: number;
  ts: number;
}

export interface DbContextRow {
  no: number;
  text: string;
  ts: number | null;
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

// ---- 事件索引（键集分页） ----

const INDEX_CHUNK = 60_000;

/** 拉取全量事件索引：(line, ts)[]，按 (ts, line) 升序 */
export async function fetchEventIndex(
  totalEvents: number,
  onProgress?: (frac: number) => void,
): Promise<{ line: number; ts: number }[]> {
  const out: { line: number; ts: number }[] = [];
  // 注意：首块用 null 作为「无下界」哨兵（Rust 侧 after_ts: Option<i64>）。
  // 不能用 Number.NEGATIVE_INFINITY —— 它不是合法 JSON/serde 值，
  // 会被序列化成 null 后触发 Rust 端反序列化报错，进而 invoke 直接 reject。
  let afterTs: number | null = null;
  let afterLine = 0;
  while (out.length < totalEvents) {
    // 用 as 断言而非 invoke<T> 泛型：避免 tsc 对元组数组的推断环路（TS7022）
    const chunk = (await invoke('db_event_index_chunk', {
      afterTs,
      afterLine,
      max: INDEX_CHUNK,
    })) as [number, number][];
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    for (const [line, ts] of chunk) out.push({ line, ts });
    const last = chunk[chunk.length - 1];
    afterLine = last[0];
    afterTs = last[1];
    onProgress?.(out.length / Math.max(1, totalEvents));
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
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

/** 运行一个过滤器：rg 直扫原文件 → (line, ts)[]（按 ts 升序；Rust 侧已 JOIN line_ts） */
export async function runDbFilter(q: DbFilterQuery): Promise<DbHitEntry[]> {
  const r = await invoke<DbHitEntry[]>('db_filter', { q });
  return Array.isArray(r) ? r : [];
}

/** 删除 filter 的命中记录（filter 被删时调用） */
export function dropDbFilter(filterId: string): void {
  if (!isTauri()) return;
  invoke('db_filter_drop', { filterId }).catch(() => {});
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

/** 上下文行（全局行号闭区间，按行号升序；DetailPanel 用） */
export async function fetchContextLines(
  from: number,
  to: number,
): Promise<DbContextRow[]> {
  const r = await invoke<DbContextRow[]>('db_context_lines', { from, to });
  return Array.isArray(r) ? r : [];
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
