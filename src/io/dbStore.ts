/**
 * SQLite 数据驻留桥接层（P3，plans/perf-optimization-design.md）。
 *
 * 模式：日志数据驻留 Rust 侧 cache.db；前端只持轻量索引：
 * - eventIndex: (line, ts)[] 按 ts 升序（≈12B/事件）
 * - LogEvent.raw/message 惰性化：需要时经 db_context_lines / db_line 拉取
 *
 * 过滤下推：runDbFilter → db_filter（FTS5 trigram / Rust 扫描）→ 命中行号数组
 * → 前端用 eventIndex 组装 FilterMatch（events 按行号查 ts）。
 */

import { isTauri } from '../lib/tauri';
import type { LogEvent } from '../types';

// ---- DTO（Rust serde camelCase）----

export interface DbOpenResult {
  cacheHit: boolean;
  totalLines: number;
  totalEvents: number;
  skipped: number;
  fileCount: number;
  timestampFormatId: string | null;
}

export interface DbEventRow {
  line: number;
  ts: number;
  thread?: string;
  level?: string;
  sourceFile?: string;
}

export interface DbContextRow {
  no: number;
  text: string;
  ts: number | null;
  thread?: string;
  level?: string;
  sourceFile?: string;
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

// ---- 索引拉取 ----

const INDEX_CHUNK = 60_000;

/** 拉取全量事件索引：(line, ts)[]，按 ts 升序（每块让出主线程保 UI 响应） */
export async function fetchEventIndex(
  totalEvents: number,
  onProgress?: (frac: number) => void,
): Promise<{ line: number; ts: number }[]> {
  const out: { line: number; ts: number }[] = [];
  let off = 0;
  while (off < totalEvents) {
    const chunk = await invoke<[number, number][]>('db_event_index_chunk', {
      offset: off,
      max: INDEX_CHUNK,
    });
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    for (const [line, ts] of chunk) out.push({ line, ts });
    off += chunk.length;
    onProgress?.(off / Math.max(1, totalEvents));
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

// ---- 过滤下推 ----

export interface DbFilterQuery {
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  scope: 'raw' | 'message';
}

/** 运行一个过滤器（Rust 侧执行），返回命中全局行号升序数组 */
export async function runDbFilter(q: DbFilterQuery): Promise<number[]> {
  const r = await invoke<number[]>('db_filter', { q });
  return Array.isArray(r) ? r : [];
}

// ---- 按需取数 ----

/** 视口事件（ts 窗口内，按 ts 升序） */
export async function fetchEventsInWindow(
  start: number,
  end: number,
): Promise<DbEventRow[]> {
  const r = await invoke<DbEventRow[]>('db_events_in_window', { start, end });
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

// ---- FilterMatch 组装 ----

/**
 * 命中行号 → FilterMatch.events（按 ts 升序）。
 * eventIndex 按 ts 升序、行号 → ts 二分查找（index 构建时排序 Map）。
 * 生成的 LogEvent 是「骨架」：id/ts 就位，raw/message 惰性（'' 占位，详情面板拉取真值）。
 */
export function hitsToEvents(
  hits: number[],
  lineToIdx: Map<number, { line: number; ts: number }>,
): LogEvent[] {
  const evs: LogEvent[] = [];
  for (const h of hits) {
    const e = lineToIdx.get(h);
    if (e) {
      evs.push({
        id: e.line,
        ts: e.ts,
        raw: '',
        message: '',
        sourceFile: undefined,
      });
    }
  }
  // hits 升序（行号序）≠ ts 序 → 按 ts 稳定排序（行号序为稳定打破器）
  evs.sort((a, b) => a.ts - b.ts || a.id - b.id);
  return evs;
}
