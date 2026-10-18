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
import { parseLogText, parseLogPath, type FullParseResult } from '../parser/parseBridge';
import { isLogFileName } from './fileLoader';
import { compileExcludePatterns } from './excludeGlob';
import { isTauri, loadDialog, loadFs, basename } from '../lib/tauri';
import { notify } from '../store/uiStore';

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

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, val: unknown): Promise<void> {
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
    notify(
      '当前浏览器不支持 File System Access API',
      { kind: 'warn', detail: '请使用 Chrome / Edge 等 Chromium 浏览器以启用「打开目录」工作区能力' },
    );
    return null;
  }
  const handle = await (window as any).showDirectoryPicker({
    id: 'loggraph-logs',
    mode: 'readwrite', // 目录即工作区：需要写权限在目录内创建 .logGraph
    startIn: 'documents',
  });
  if (!(await verifyPermission(handle, true))) {
    notify('需要读写权限', {
      kind: 'warn',
      detail: '工作区状态（过滤器 / 分组）会保存在所选目录内的 .logGraph 下，请授予读写权限',
    });
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

/** 递归枚举目录下所有日志文件（按扩展名宽松判断）。
 *  excludePatterns：rg 式 glob 排除规则（不含 '/' 对文件名、含 '/' 对相对路径；
 *  命中目录 → 整棵子树跳过）。见 io/excludeGlob.ts。 */
export async function listLogFiles(
  dirHandle: any,
  opts: { recursive?: boolean; maxDepth?: number; excludePatterns?: string[] } = {},
): Promise<LogFileInfo[]> {
  const { recursive = true, maxDepth = 5 } = opts;
  const excluded = compileExcludePatterns(opts.excludePatterns ?? []);
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
        const relPath = pathPrefix.length ? `${pathPrefix.join('/')}/${entry.name}` : entry.name;
        if (excluded && excluded(relPath, entry.name)) continue;
        if (entry.isDirectory) {
          if (recursive && entry.name !== '.logGraph') {
            await walk(`${dirPath}/${entry.name}`, [...pathPrefix, entry.name], depth + 1);
          }
        } else if (entry.isFile) {
          if (isLogFileName(entry.name)) {
            let size = 0;
            try {
              const st = await fs.stat(`${dirPath}/${entry.name}`);
              size = st.size;
            } catch { /* 忽略读取失败的文件 */ }
            results.push({
              name: relPath,
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
      const relPath = pathPrefix.length ? `${pathPrefix.join('/')}/${entry.name}` : entry.name;
      if (excluded && excluded(relPath, entry.name)) continue;
      if (entry.kind === 'file') {
        if (isLogFileName(entry.name)) {
          let size = 0;
          try {
            const file = await entry.getFile();
            size = file.size;
          } catch { /* 忽略读取失败的文件 */ }
          results.push({
            name: relPath,
            size,
            path: [...pathPrefix, entry.name],
          });
        }
      } else if (entry.kind === 'directory' && recursive && entry.name !== '.logGraph') {
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

/**
 * 加载多个日志文件，合并成单一事件流。
 *
 * @param dirHandle 目录句柄（浏览器 FSA 或 Tauri {__tauriDir, path}）
 * @param names 文件相对路径名列表（来自 listLogFiles 的 name）
 * @param onProgress 可选进度回调（已加载文件数）
 */
/**
 * 把一组「已解析」的文件结果合并为全局事件流（供多文件/目录加载共用）。
 * 解析本身由调用方完成（Tauri→parseLogPath Rust 引擎；浏览器→parseLogText JS 引擎），
 * 合并规则与原 mergeParsed 完全一致：全局 id 重编号 / sourceFile 标记 / 全局按 ts 排序。
 */
function mergeParsedInputs(files: { name: string; parse: FullParseResult }[]): MultiLoadResult {
  const allEvents: LogEvent[] = [];
  const allRawLines: string[] = [];
  let totalLines = 0;
  let totalSkipped = 0;
  const formatIds = new Set<string | null>();
  let firstFileName: string | null = null;

  for (const { name, parse: result } of files) {
    if (!firstFileName) firstFileName = name;
    formatIds.add(result.timestampFormatId);
    totalLines += result.totalLines;
    totalSkipped += result.skipped;

    // 记录该文件原始行在全局 rawLines 中的起始偏移（rawLines 由解析引擎产出，与 split(/\r?\n/) 一致）
    const baseId = allRawLines.length;
    for (const l of result.rawLines) allRawLines.push(l);

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

  // ---- 快速路径：Tauri + Rust parse_dir（枚举+解析+合并+排序 全在 Rust，1 次 IPC）----
  if (tauriRoot) {
    const { parseLogDir } = await import('../parser/parseBridge');
    // 进度事件订阅（Rust 侧逐文件 emit）
    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ loaded: number; total: number; current: string }>(
        'parse_dir_progress',
        (e) => onProgress?.(e.payload.loaded, e.payload.total, e.payload.current),
      );
    } catch {
      /* 进度订阅失败不阻断加载 */
    }
    try {
      const r = await parseLogDir(tauriRoot, (frac) => {
        // 拉取阶段进度：映射到 loaded/total 语义（解析事件已由 parse_dir_progress 推送）
        onProgress?.(
          Math.min(names.length, Math.round(frac * names.length)),
          names.length,
          '合并传输中',
        );
      });
      if (r) {
        // Rust 已完成合并排序：零拷贝构造（事件对象直接透传，sourceFile 已赋值）
        return {
          events: r.events,
          rawLines: r.rawLines,
          meta: {
            fileName: '',
            fileSize: 0,
            totalLines: r.totalLines,
            skipped: r.skipped,
            fileErrors: r.fileErrors,
            timestampFormatId: r.timestampFormatId,
          },
        };
      }
    } catch (err) {
      console.warn('[dirLoader] parse_dir 快速路径失败，回退逐文件:', err);
    } finally {
      unlisten?.();
    }
  }

  // ---- 逐文件路径（浏览器 / Rust 不可用降级）----
  const files: { name: string; parse: FullParseResult }[] = [];
  for (let fi = 0; fi < names.length; fi++) {
    const name = names[fi];
    onProgress?.(fi, names.length, name);

    if (tauriRoot) {
      // 首选：Rust 原生解析（进程内读文件，不过 IPC 桥）
      const parsed = await parseLogPath(`${tauriRoot}/${name}`);
      if (parsed) {
        files.push({ name, parse: parsed });
        continue;
      }
      // 降级：invoke 失败（命令未注册等）→ plugin-fs 读文本走 JS 引擎，功能不中断
      try {
        const fs = await loadFs();
        const text = await fs.readTextFile(`${tauriRoot}/${name}`);
        files.push({ name, parse: await parseLogText(text) });
      } catch {
        continue; // 读取失败跳过该文件（原行为）
      }
    } else {
      // 浏览器：FSA 句柄读文本 → JS 引擎（parseLogText 在浏览器下即原 LogParser 路径）
      const fh = await getFileHandleByPath(dirHandle, name);
      if (!fh) continue;
      let file: File;
      try {
        file = await fh.getFile();
      } catch {
        continue;
      }
      files.push({ name, parse: await parseLogText(await file.text()) });
    }
  }

  onProgress?.(names.length, names.length, '');

  return mergeParsedInputs(files);
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

  // 浏览器专用路径（webkitGetAsEntry）：FSA 读文本 → JS 引擎解析（parseLogText 浏览器分支）
  const files: { name: string; parse: FullParseResult }[] = [];
  for (const fe of fileEntries) {
    const file: File = await new Promise((resolve, reject) => fe.entry.file(resolve, reject));
    files.push({ name: fe.name, parse: await parseLogText(await file.text()) });
  }

  return { result: mergeParsedInputs(files), count: files.length };
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
