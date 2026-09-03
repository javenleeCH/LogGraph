/**
 * 过滤器持久化：统一抽象浏览器 / Tauri 两种运行时。
 *
 * 浏览器：File System Access API（showDirectoryPicker + IndexedDB 存句柄）。
 * Tauri  ：dialog.open({ directory:true }) 选目录 + plugin-fs 读写 filters.json，
 *          目录路径存 localStorage（WebView2 持久化，无需再次授权）。
 *
 * 约定在所选目录下创建/读写 `filters.json`。
 */

import type { Filter, FilterGroup } from '../types';
import { isTauri, loadDialog, loadFs, basename } from '../lib/tauri';

const DB_NAME = 'loggraph';
const STORE = 'handles';
const KEY_DIR = 'filtersDir';
const LS_KEY_DIR = 'loggraph.filtersDir';
const FILE_NAME = 'filters.json';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- 类型 ----

export interface PersistedFilters {
  filters: Filter[];
  /** 分组列表（旧文件无此字段=空 groups，向后兼容） */
  groups?: FilterGroup[];
  /** 节点画布坐标表（旧文件无此字段=自动生成缺省布局） */
  graphNodes?: Record<string, import('../types').NodePos>;
  savedAt: number;
}

/** 目录句柄：浏览器=FSA handle；Tauri={__tauriDir:true, path, name} */
type DirHandle = any;

// ---- IndexedDB 句柄存取（仅浏览器路径使用） ----

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
    const os = tx.objectStore(STORE);
    const req = os.get(key);
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

async function idbDel(key: string): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 能力检测 ----

/** 是否支持过滤器持久化（Tauri 恒支持；浏览器需 FSA） */
export function isFSASupported(): boolean {
  if (isTauri()) return true;
  return typeof (window as any).showDirectoryPicker === 'function';
}

// ---- 浏览器：权限 ----

async function verifyPermission(handle: DirHandle, write: boolean): Promise<boolean> {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/** 判断 handle 是否为 Tauri 目录对象 */
function isTauriDir(handle: DirHandle): boolean {
  return !!handle && handle.__tauriDir === true;
}

/**
 * 让用户选择持久化目录。
 * - Tauri：弹系统目录选择框，返回 { name, path } 并存 localStorage。
 * - 浏览器：showDirectoryPicker + IndexedDB 存句柄。
 */
export async function pickDirectory(): Promise<DirHandle | null> {
  if (isTauri()) {
    const { open } = await loadDialog();
    const selected = await open({ directory: true, multiple: false, title: '选择持久化目录（用于保存 filters.json）' });
    if (!selected || Array.isArray(selected)) return null;
    const path = selected as string;
    const handle = { __tauriDir: true, path, name: basename(path) };
    try {
      localStorage.setItem(LS_KEY_DIR, path);
    } catch { /* 忽略 localStorage 写入失败 */ }
    return handle;
  }

  if (!isFSASupported()) {
    alert('当前浏览器不支持 File System Access API，请使用 Chrome/Edge 等 Chromium 浏览器');
    return null;
  }
  const handle: DirHandle = await (window as any).showDirectoryPicker({
    id: 'loggraph-filters',
    mode: 'readwrite',
    startIn: 'documents',
  });
  if (!(await verifyPermission(handle, true))) {
    alert('需要读写权限才能持久化过滤器');
    return null;
  }
  await idbSet(KEY_DIR, handle);
  return handle;
}

/** 清除已保存的目录（Tauri 清 localStorage，浏览器清 IndexedDB） */
export async function clearDirectory(): Promise<void> {
  if (isTauri()) {
    try { localStorage.removeItem(LS_KEY_DIR); } catch { /* noop */ }
    return;
  }
  await idbDel(KEY_DIR);
}

/** 获取已保存的目录句柄（不弹窗） */
export async function getSavedDirectory(): Promise<DirHandle | null> {
  if (isTauri()) {
    let path: string | null = null;
    try { path = localStorage.getItem(LS_KEY_DIR); } catch { /* noop */ }
    if (!path) return null;
    return { __tauriDir: true, path, name: basename(path) };
  }
  const h = await idbGet<DirHandle>(KEY_DIR);
  return h ?? null;
}

/** 确保已保存句柄有写权限（Tauri 恒 true） */
export async function ensureWritePermission(handle: DirHandle): Promise<boolean> {
  if (isTauriDir(handle)) return true;
  return verifyPermission(handle, true);
}

/** 读取目录下的 filters.json；文件不存在返回 null */
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

/** 写入 filters.json */
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
