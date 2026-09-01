/**
 * 目录式日志加载：基于 File System Access API。
 *
 * 流程：
 * 1. pickLogDirectory() → showDirectoryPicker() 选目录 → 授权 → 句柄存 IndexedDB
 * 2. listLogFiles(dirHandle) → 枚举目录下日志文件（递归可选）
 * 3. loadMultiple(dirHandle, names) → 逐文件解析 → 合并成带 sourceFile 的全局事件流
 *
 * 合并规则：
 * - 每文件独立调 LogParser.parse（格式自洽，各文件时间戳格式可能不同）
 * - 全局 id 重编号（保证 id 是全局行号，DetailPanel 用 id 索引 rawLines）
 * - sourceFile 标记来源
 * - 全局按 ts 排序
 * - rawLines 也按全局 id 对应拼好
 */

import type { LogEvent } from '../types';
import type { LogMeta } from '../store/logStore';
import { LogParser } from '../parser/LogParser';
import { isLogFileName } from './fileLoader';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_NAME = 'loggraph';
const STORE = 'handles';
const KEY_LOGS_DIR = 'logsDir';

// ---- IndexedDB（复用 filterPersist 的数据库，不同 key） ----

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 目录权限 ----

export function isFSASupported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function';
}

async function verifyPermission(handle: any, write: boolean): Promise<boolean> {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

export async function ensureReadPermission(handle: any): Promise<boolean> {
  return verifyPermission(handle, false);
}

/**
 * 让用户选择日志目录（会触发权限弹窗），成功后句柄存 IndexedDB。
 * 返回句柄；用户取消返回 null。
 */
export async function pickLogDirectory(): Promise<any | null> {
  if (!isFSASupported()) {
    alert('当前浏览器不支持 File System Access API，请使用 Chrome/Edge 等 Chromium 浏览器');
    return null;
  }
  const handle = await (window as any).showDirectoryPicker({
    id: 'loggraph-logs',
    mode: 'read',
    startIn: 'documents',
  });
  if (!(await verifyPermission(handle, false))) {
    alert('需要读取权限才能浏览日志目录');
    return null;
  }
  await idbSet(KEY_LOGS_DIR, handle);
  return handle;
}

/** 从 IndexedDB 取回已存的日志目录句柄（不弹窗） */
export async function getSavedLogDirectory(): Promise<any | null> {
  const h = await idbGet<any>(KEY_LOGS_DIR);
  return h ?? null;
}

// ---- 枚举 ----

export interface LogFileInfo {
  /** 相对路径名，如 "app.log" 或 "archive/2024-01.log" */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 仅供内部使用：该文件在目录树中的路径段数组 */
  path: string[];
}

/** 递归枚举目录下所有日志文件（按扩展名宽松判断） */
export async function listLogFiles(
  dirHandle: any,
  opts: { recursive?: boolean; maxDepth?: number } = {},
): Promise<LogFileInfo[]> {
  const { recursive = true, maxDepth = 5 } = opts;
  const results: LogFileInfo[] = [];

  async function walk(dir: any, pathPrefix: string[], depth: number) {
    if (depth > maxDepth) return;
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        if (isLogFileName(entry.name)) {
          let size = 0;
          try {
            const file = await entry.getFile();
            size = file.size;
          } catch { /* 忽略读取失败的文件 */ }
          results.push({
            name: pathPrefix.length ? `${pathPrefix.join('/')}/${entry.name}` : entry.name,
            size,
            path: [...pathPrefix, entry.name],
          });
        }
      } else if (entry.kind === 'directory' && recursive) {
        await walk(entry, [...pathPrefix, entry.name], depth + 1);
      }
    }
  }

  await walk(dirHandle, [], 0);
  // 按路径名排序，便于展示
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * 在目录中按相对路径取文件句柄（支持 "a/b/c.log"）。
 * 注意：path 可能含目录段，需逐段 resolve。
 */
async function getFileHandleByPath(dirHandle: any, name: string): Promise<any | null> {
  const segs = name.split('/');
  let cur = dirHandle;
  for (let i = 0; i < segs.length - 1; i++) {
    try {
      cur = await cur.getDirectoryHandle(segs[i]);
    } catch {
      return null;
    }
  }
  try {
    return await cur.getFileHandle(segs[segs.length - 1]);
  } catch {
    return null;
  }
}

// ---- 多文件加载合并 ----

export interface MultiLoadResult {
  events: LogEvent[];
  rawLines: string[];
  meta: LogMeta;
}

const parser = new LogParser();

/**
 * 加载多个日志文件，合并成单一事件流。
 *
 * @param dirHandle 目录句柄
 * @param names 文件相对路径名列表（来自 listLogFiles 的 name）
 * @param onProgress 可选进度回调（已加载文件数）
 */
export async function loadMultiple(
  dirHandle: any,
  names: string[],
  onProgress?: (loaded: number, total: number, current: string) => void,
): Promise<MultiLoadResult> {
  const allEvents: LogEvent[] = [];
  const allRawLines: string[] = [];
  let totalLines = 0;
  let totalSkipped = 0;
  const formatIds = new Set<string | null>();
  let firstFileName: string | null = null;

  for (let fi = 0; fi < names.length; fi++) {
    const name = names[fi];
    onProgress?.(fi, names.length, name);
    const fh = await getFileHandleByPath(dirHandle, name);
    if (!fh) continue;
    let file: File;
    try {
      file = await fh.getFile();
    } catch {
      continue;
    }
    const text = await file.text();
    const result = parser.parse(text);
    if (!firstFileName) firstFileName = name;
    formatIds.add(result.timestampFormatId);
    totalLines += result.totalLines;
    totalSkipped += result.skipped;

    // 记录该文件原始行在全局 rawLines 中的起始偏移
    const baseId = allRawLines.length;
    const fileLines = text.split(/\r?\n/);
    for (const l of fileLines) allRawLines.push(l);

    // 把该文件 events 的 id 重编为全局行号，并标记 sourceFile
    for (const ev of result.events) {
      allEvents.push({
        ...ev,
        id: baseId + ev.id,
        sourceFile: name,
      });
    }
  }

  onProgress?.(names.length, names.length, '');

  // 全局按 ts 排序
  allEvents.sort((a, b) => a.ts - b.ts);

  const meta: LogMeta = {
    fileName: firstFileName ?? '',
    fileSize: 0,
    totalLines,
    skipped: totalSkipped,
    timestampFormatId: formatIds.size === 1 ? [...formatIds][0] : null,
  };

  return { events: allEvents, rawLines: allRawLines, meta };
}
