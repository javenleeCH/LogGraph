/**
 * 目录式日志加载：统一抽象浏览器 / Tauri 两种运行时。
 *
 * 流程：
 * 1. pickLogDirectory() → 选目录 → 浏览器存 IndexedDB 句柄，Tauri 存 localStorage 路径
 * 2. listLogFiles(dirHandle) → 枚举目录下日志文件（递归）
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
import { isTauri, loadDialog, loadFs, basename } from '../lib/tauri';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_NAME = 'loggraph';
const STORE = 'handles';
const KEY_LOGS_DIR = 'logsDir';
const LS_KEY_LOGS_DIR = 'loggraph.logsDir';

// ---- IndexedDB（仅浏览器路径，复用 filterPersist 的数据库不同 key） ----

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

// ---- 能力检测 / 权限 ----

export function isFSASupported(): boolean {
  if (isTauri()) return true;
  return typeof (window as any).showDirectoryPicker === 'function';
}

function isTauriDir(handle: any): boolean {
  return !!handle && handle.__tauriDir === true;
}

async function verifyPermission(handle: any, write: boolean): Promise<boolean> {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

export async function ensureReadPermission(handle: any): Promise<boolean> {
  if (isTauriDir(handle)) return true;
  return verifyPermission(handle, false);
}

/**
 * 让用户选择日志目录。
 * - Tauri：系统目录选择框，返回 { name, path } 并存 localStorage。
 * - 浏览器：showDirectoryPicker + IndexedDB 存句柄。
 */
export async function pickLogDirectory(): Promise<any | null> {
  if (isTauri()) {
    const { open } = await loadDialog();
    const selected = await open({ directory: true, multiple: false, title: '选择日志文件夹' });
    if (!selected || Array.isArray(selected)) return null;
    const path = selected as string;
    try {
      localStorage.setItem(LS_KEY_LOGS_DIR, path);
    } catch { /* noop */ }
    return { __tauriDir: true, path, name: basename(path) };
  }

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

/** 从 IndexedDB / localStorage 取回已存的日志目录（不弹窗） */
export async function getSavedLogDirectory(): Promise<any | null> {
  if (isTauri()) {
    let path: string | null = null;
    try { path = localStorage.getItem(LS_KEY_LOGS_DIR); } catch { /* noop */ }
    if (!path) return null;
    return { __tauriDir: true, path, name: basename(path) };
  }
  const h = await idbGet<any>(KEY_LOGS_DIR);
  return h ?? null;
}

// ---- 枚举 ----

export interface LogFileInfo {
  /** 相对路径名，如 "app.log" 或 "archive/2024-01.log" */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 该文件在目录树中的路径段数组 */
  path: string[];
}

/** 递归枚举目录下所有日志文件（按扩展名宽松判断） */
export async function listLogFiles(
  dirHandle: any,
  opts: { recursive?: boolean; maxDepth?: number } = {},
): Promise<LogFileInfo[]> {
  const { recursive = true, maxDepth = 5 } = opts;
  const results: LogFileInfo[] = [];

  if (isTauriDir(dirHandle)) {
    const fs = await loadFs();
    const root = String(dirHandle.path).replace(/[\\/]+$/, '');

    async function walk(dirPath: string, pathPrefix: string[], depth: number) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await fs.readDir(dirPath);
      } catch {
        return; // 无权限/目录不存在则跳过
      }
      for (const entry of entries) {
        if (entry.isDirectory) {
          if (recursive) await walk(`${dirPath}/${entry.name}`, [...pathPrefix, entry.name], depth + 1);
        } else if (entry.isFile) {
          if (isLogFileName(entry.name)) {
            let size = 0;
            try {
              const st = await fs.stat(`${dirPath}/${entry.name}`);
              size = st.size;
            } catch { /* 忽略读取失败的文件 */ }
            results.push({
              name: pathPrefix.length ? `${pathPrefix.join('/')}/${entry.name}` : entry.name,
              size,
              path: [...pathPrefix, entry.name],
            });
          }
        }
      }
    }

    await walk(root, [], 0);
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  // 浏览器 FSA 路径
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
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/** 在目录中按相对路径取文件句柄（浏览器 FSA，支持 "a/b/c.log"） */
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
 * @param dirHandle 目录句柄（浏览器 FSA 或 Tauri {__tauriDir, path}）
 * @param names 文件相对路径名列表（来自 listLogFiles 的 name）
 * @param onProgress 可选进度回调（已加载文件数）
 */
/** 把一组（文件名 + 文本）逐文件解析并合并为全局事件流（供多文件/目录加载共用） */
function mergeParsed(files: { name: string; text: string }[]): MultiLoadResult {
  const allEvents: LogEvent[] = [];
  const allRawLines: string[] = [];
  let totalLines = 0;
  let totalSkipped = 0;
  const formatIds = new Set<string | null>();
  let firstFileName: string | null = null;

  for (const { name, text } of files) {
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

export async function loadMultiple(
  dirHandle: any,
  names: string[],
  onProgress?: (loaded: number, total: number, current: string) => void,
): Promise<MultiLoadResult> {
  const tauriRoot = isTauriDir(dirHandle)
    ? String(dirHandle.path).replace(/[\\/]+$/, '')
    : null;
  const fs = tauriRoot ? await loadFs() : null;

  const files: { name: string; text: string }[] = [];
  for (let fi = 0; fi < names.length; fi++) {
    const name = names[fi];
    onProgress?.(fi, names.length, name);

    let text: string | null = null;
    if (tauriRoot) {
      try {
        text = await fs!.readTextFile(`${tauriRoot}/${name}`);
      } catch {
        continue;
      }
    } else {
      const fh = await getFileHandleByPath(dirHandle, name);
      if (!fh) continue;
      let file: File;
      try {
        file = await fh.getFile();
      } catch {
        continue;
      }
      text = await file.text();
    }
    files.push({ name, text });
  }

  onProgress?.(names.length, names.length, '');

  return mergeParsed(files);
}

/**
 * 浏览器：从拖拽的目录 entry（FileSystemDirectoryEntry，来自 webkitGetAsEntry）
 * 递归收集日志文件并合并解析。无日志文件返回 null。
 */
export async function loadDroppedDirectory(
  rootEntry: any,
): Promise<{ result: MultiLoadResult; count: number } | null> {
  const fileEntries: { name: string; entry: any }[] = [];

  async function walk(entry: any, prefix: string, depth: number) {
    if (depth > 5) return;
    if (entry.isFile) {
      if (isLogFileName(entry.name)) {
        fileEntries.push({ name: prefix ? `${prefix}/${entry.name}` : entry.name, entry });
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries 每次至多返回 100 条，需循环直到读空
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const batch: any[] = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) {
          await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name, depth + 1);
        }
      }
    }
  }

  await walk(rootEntry, '', 0);
  if (fileEntries.length === 0) return null;
  fileEntries.sort((a, b) => a.name.localeCompare(b.name));

  const files: { name: string; text: string }[] = [];
  for (const fe of fileEntries) {
    const file: File = await new Promise((resolve, reject) => fe.entry.file(resolve, reject));
    files.push({ name: fe.name, text: await file.text() });
  }

  return { result: mergeParsed(files), count: files.length };
}

/** Tauri：判断路径是否为目录；是则返回可枚举的目录 handle，否则返回 null */
export async function tauriPathAsDirectory(path: string): Promise<any | null> {
  if (!isTauri()) return null;
  const fs = await loadFs();
  try {
    const st = await fs.stat(path);
    if (st.isDirectory) return { __tauriDir: true, path, name: basename(path) };
  } catch {
    /* ignore */
  }
  return null;
}
