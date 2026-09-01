/**
 * 过滤器持久化：基于 File System Access API。
 *
 * 流程：
 * 1. 首次用户点击"持久化目录"按钮 → showDirectoryPicker() 选目录 → 授权。
 *    约定在该目录下创建/读写 `filters.json`。
 * 2. 目录句柄存入 IndexedDB，刷新后仍保留授权（需 verifyPermission 重新确认）。
 * 3. filters 变化时自动保存；启动时若有已存句柄则自动加载。
 *
 * 兼容性：仅 Chromium 系浏览器支持 showDirectoryPicker。
 */

const DB_NAME = 'loggraph';
const STORE = 'handles';
const KEY_DIR = 'filtersDir';
const FILE_NAME = 'filters.json';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- IndexedDB 句柄存取（文件句柄可被结构化克隆保存） ----

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

// ---- 类型 ----

export interface PersistedFilters {
  filters: unknown[];
  savedAt: number;
}

type DirHandle = any;

/** 浏览器是否支持 File System Access API */
export function isFSASupported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function';
}

/** 检查/请求目录权限 */
async function verifyPermission(handle: DirHandle, write: boolean): Promise<boolean> {
  const opts = { mode: write ? 'readwrite' : 'read' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/**
 * 让用户选择持久化目录（会触发权限弹窗）。
 * 成功后把句柄存入 IndexedDB，返回句柄。
 */
export async function pickDirectory(): Promise<DirHandle | null> {
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

/** 清除已保存的目录句柄 */
export async function clearDirectory(): Promise<void> {
  await idbDel(KEY_DIR);
}

/** 获取已保存的目录句柄（不触发权限弹窗） */
export async function getSavedDirectory(): Promise<DirHandle | null> {
  const h = await idbGet<DirHandle>(KEY_DIR);
  return h ?? null;
}

/** 确保已保存句柄有写权限（若无则返回 false，调用方可提示重新选择） */
export async function ensureWritePermission(handle: DirHandle): Promise<boolean> {
  return verifyPermission(handle, true);
}

/** 读取目录下的 filters.json，返回解析后的对象；文件不存在返回 null */
export async function readFilters(handle: DirHandle): Promise<PersistedFilters | null> {
  try {
    const fileHandle = await handle.getFileHandle(FILE_NAME);
    const file = await fileHandle.getFile();
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.filters)) return null;
    return data as PersistedFilters;
  } catch {
    return null;
  }
}

/** 写入 filters.json */
export async function writeFilters(handle: DirHandle, data: PersistedFilters): Promise<void> {
  const fileHandle = await handle.getFileHandle(FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}
