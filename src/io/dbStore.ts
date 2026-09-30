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
  let afterTs = Number.NEGATIVE_INFINITY;
  let afterLine = 0;
  while (out.length < totalEvents) {
    const chunk = await invoke<[number, number][]>('db_event_index_chunk', {
      afterTs,
      afterLine,
      max: INDEX_CHUNK,
    });
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
