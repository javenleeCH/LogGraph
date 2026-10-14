/**
 * 工作区持久化：目录即工作区（类似 .idea / .vscode）。
 *
 * 打开日志目录时自动在目录内创建 `.logGraph/`，过滤器 / 分组 / 画布坐标
 * 持久化到 `.logGraph/filters.json`：
 * - Tauri ：plugin-fs（mkdir recursive + readTextFile/writeTextFile，路径来自 dialog/拖放）
 * - 浏览器：File System Access API（getDirectoryHandle({create}) + writable 流）
 *
 * 打开目录时的语义：
 * - 目录里已有存档 → 整体恢复（替换当前内存状态）；
 * - 无存档 → 继承当前内存状态作为起点，并立即播种写入一份。
 *
 * 另含旧版「独立持久化目录」（根目录 filters.json）的一次性迁移读取，
 * 迁移成功后由调用方清理旧指针。
 */

import type { Filter, FilterGroup, NodePos } from '../types';
import { isTauri, loadFs, basename } from '../lib/tauri';

const DB_NAME = 'loggraph';
const STORE = 'handles';
/** 旧版独立持久化目录：IndexedDB 句柄 key（浏览器） */
const LEGACY_KEY_DIR = 'filtersDir';
/** 旧版独立持久化目录：localStorage 路径 key（Tauri） */
const LEGACY_LS_KEY_DIR = 'loggraph.filtersDir';
/** 工作区目录名（创建在所打开的日志目录内） */
export const WORKSPACE_DIR = '.logGraph';
const FILE_NAME = 'filters.json';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- 类型 ----

export interface PersistedFilters {
  filters: Filter[];
  /** 分组列表（旧文件无此字段=空 groups，向后兼容） */
  groups?: FilterGroup[];
  /** 节点画布坐标表（旧文件无此字段=自动生成缺省布局） */
  graphNodes?: Record<string, NodePos>;
  /** 目录排除规则（glob，旧文件无此字段=无排除） */
  dirExcludePatterns?: string[];
  savedAt: number;
}

/** 目录句柄：浏览器=FSA handle；Tauri={__tauriDir:true, path, name} */
type DirHandle = any;

// ---- IndexedDB（仅旧版迁移读取用） ----

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

async function idbDel(key: string): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 能力检测 / 权限 ----

/** 是否支持工作区持久化（Tauri 恒支持；浏览器需 FSA） */
export function isFSASupported(): boolean {
  if (isTauri()) return true;
  return typeof (window as any).showDirectoryPicker === 'function';
}

/** 判断 handle 是否为 Tauri 目录对象 */
function isTauriDir(handle: DirHandle): boolean {
  return !!handle && handle.__tauriDir === true;
}

async function verifyPermission(handle: DirHandle, write: boolean): Promise<boolean> {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

// ---- 工作区 ----

/**
 * 打开/创建日志目录下的 `.logGraph` 工作区，返回工作区句柄。
 * 失败（目录只读 / 权限被拒）返回 null —— 调用方降级为本次会话不持久化。
 *
 * - Tauri：mkdir recursive（已存在则幂等）；
 * - 浏览器：需 readwrite 权限（选目录时已授；拖放场景在用户手势内提权，
 *   启动恢复场景依赖 Chrome 122+ 的持久授权，query 不到则降级）。
 */
export async function openWorkspaceDir(dirHandle: DirHandle): Promise<DirHandle | null> {
  try {
    if (isTauriDir(dirHandle)) {
      const fs = await loadFs();
      const root = String(dirHandle.path).replace(/[\\/]+$/, '');
      await fs.mkdir(`${root}/${WORKSPACE_DIR}`, { recursive: true });
      return { __tauriDir: true, path: `${root}/${WORKSPACE_DIR}`, name: WORKSPACE_DIR };
    }
    if (!(await verifyPermission(dirHandle, true))) return null;
    return await dirHandle.getDirectoryHandle(WORKSPACE_DIR, { create: true });
  } catch (e) {
    console.warn(`创建 ${WORKSPACE_DIR}/ 工作区失败（目录可能只读），本次会话不持久化`, e);
    return null;
  }
}

/** 读取工作区下的 filters.json；文件不存在 / 损坏返回 null */
export async function readFilters(handle: DirHandle): Promise<PersistedFilters | null> {
  try {
    let text: string;
    if (isTauriDir(handle)) {
      const fs = await loadFs();
      text = await fs.readTextFile(`${handle.path.replace(/[\\/]+$/, '')}/${FILE_NAME}`);
    } else {
      const fileHandle = await handle.getFileHandle(FILE_NAME);
      const file = await fileHandle.getFile();
      text = await file.text();
    }
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.filters)) return null;
    return data as PersistedFilters;
  } catch {
    return null;
  }
}

/** 写入工作区 filters.json */
export async function writeFilters(handle: DirHandle, data: PersistedFilters): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  if (isTauriDir(handle)) {
    const fs = await loadFs();
    await fs.writeTextFile(`${handle.path.replace(/[\\/]+$/, '')}/${FILE_NAME}`, json);
    return;
  }
  const fileHandle = await handle.getFileHandle(FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(json);
  await writable.close();
}

// ---- 旧版「独立持久化目录」一次性迁移 ----

/**
 * 读取旧版独立持久化目录（目录根 filters.json）的存档；无配置 / 失败返回 null。
 * 只读不弹窗（启动时机无用户手势，requestPermission 会失败，仅 query 已授权的）。
 */
export async function readLegacyPersistedFilters(): Promise<PersistedFilters | null> {
  try {
    if (isTauri()) {
      let path: string | null = null;
      try { path = localStorage.getItem(LEGACY_LS_KEY_DIR); } catch { /* noop */ }
      if (!path) return null;
      return await readFilters({ __tauriDir: true, path, name: basename(path) });
    }
    const handle = await idbGet<DirHandle>(LEGACY_KEY_DIR);
    if (!handle) return null;
    if (!(await verifyPermission(handle, false))) return null;
    return await readFilters(handle);
  } catch {
    return null;
  }
}

/** 清理旧版持久化目录指针（迁移成功后调用，之后不再触发迁移） */
export async function clearLegacyPersistDir(): Promise<void> {
  if (isTauri()) {
    try { localStorage.removeItem(LEGACY_LS_KEY_DIR); } catch { /* noop */ }
    return;
  }
  await idbDel(LEGACY_KEY_DIR);
}
