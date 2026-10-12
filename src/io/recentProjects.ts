/**
 * 最近项目 & 项目收藏夹（欢迎页入口）。
 *
 * 条目持久化按运行时分流：
 * - Tauri：localStorage 存路径字符串（`loggraph.recent-projects` / `loggraph.fav-projects`）
 * - 浏览器：IndexedDB 存 FSA 句柄（跨会话可恢复，重开时需重新授权）
 * 浏览器经 <input type=file> / 拖拽打开的单文件没有句柄与路径，不进入列表。
 */
import { isTauri } from '../lib/tauri';
import { idbGet, idbSet } from './dirLoader';

export interface ProjectEntry {
  /** 稳定标识：Tauri 为 `path:<绝对路径>`，浏览器为 `idb:<随机串>` */
  id: string;
  /** 显示名（basename） */
  name: string;
  kind: 'file' | 'dir';
  /** Tauri 绝对路径；浏览器为 null（句柄随条目存 IndexedDB） */
  path: string | null;
  /** 最近一次打开时间；收藏条目为收藏时间（epoch ms） */
  openedAt: number;
}

/** IndexedDB 中的存储形态：条目 + FSA 句柄（Tauri 下 handle 恒为 null） */
interface StoredEntry {
  entry: ProjectEntry;
  handle: unknown;
}

const LS_RECENT = 'loggraph.recent-projects';
const LS_FAV = 'loggraph.fav-projects';
const IDB_RECENT = 'recentProjects';
const IDB_FAV = 'favProjects';
/** 最近打开上限（LRU 截断）；收藏夹不限量 */
const RECENT_CAP = 10;

function isValidEntry(e: unknown): e is ProjectEntry {
  const v = e as ProjectEntry;
  return (
    !!v && typeof v.id === 'string' && typeof v.name === 'string' &&
    (v.kind === 'file' || v.kind === 'dir') && typeof v.openedAt === 'number'
  );
}

async function readList(fav: boolean): Promise<StoredEntry[]> {
  if (isTauri()) {
    try {
      const raw = localStorage.getItem(fav ? LS_FAV : LS_RECENT);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter(isValidEntry).map((entry) => ({ entry, handle: null }));
    } catch {
      return [];
    }
  }
  const stored = await idbGet<StoredEntry[]>(fav ? IDB_FAV : IDB_RECENT);
  return (stored ?? []).filter((s) => isValidEntry(s?.entry));
}

async function writeList(fav: boolean, list: StoredEntry[]): Promise<void> {
  if (isTauri()) {
    try {
      localStorage.setItem(
        fav ? LS_FAV : LS_RECENT,
        JSON.stringify(list.map((s) => s.entry)),
      );
    } catch {
      /* 隐私模式等写入失败：仅当前会话可见 */
    }
    return;
  }
  await idbSet(fav ? IDB_FAV : IDB_RECENT, list);
}

export async function listRecentProjects(): Promise<ProjectEntry[]> {
  return (await readList(false)).map((s) => s.entry);
}

export async function listFavoriteProjects(): Promise<ProjectEntry[]> {
  return (await readList(true)).map((s) => s.entry);
}

/**
 * 记录一次项目打开（LRU 去重，最新在前）。
 * Tauri 需要 path；浏览器需要带 isSameEntry 的 FSA 句柄，其余静默忽略。
 */
export async function recordOpenProject(p: {
  name: string;
  kind: 'file' | 'dir';
  path?: string | null;
  handle?: unknown;
}): Promise<void> {
  if (isTauri()) {
    if (!p.path) return;
    const entry: ProjectEntry = {
      id: `path:${p.path}`,
      name: p.name,
      kind: p.kind,
      path: p.path,
      openedAt: Date.now(),
    };
    const list = (await readList(false)).filter((s) => s.entry.id !== entry.id);
    await writeList(false, [{ entry, handle: null }, ...list].slice(0, RECENT_CAP));
    return;
  }

  const handle = p.handle as { isSameEntry?: (other: unknown) => Promise<boolean> } | undefined;
  if (!handle || typeof handle.isSameEntry !== 'function') return;
  const list = await readList(false);
  const kept: StoredEntry[] = [];
  let existing: StoredEntry | null = null;
  for (const s of list) {
    let same = false;
    try {
      same = await handle.isSameEntry(s.handle);
    } catch {
      same = false; // 旧条目句柄失效，按不同处理
    }
    if (same) existing = s;
    else kept.push(s);
  }
  const entry: ProjectEntry = {
    id: existing?.entry.id ?? `idb:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: p.name,
    kind: p.kind,
    path: null,
    openedAt: Date.now(),
  };
  await writeList(false, [{ entry, handle }, ...kept].slice(0, RECENT_CAP));
}

export async function removeRecentProject(id: string): Promise<void> {
  await writeList(false, (await readList(false)).filter((s) => s.entry.id !== id));
}

export async function removeFavoriteProject(id: string): Promise<void> {
  await writeList(true, (await readList(true)).filter((s) => s.entry.id !== id));
}

/**
 * 收藏 / 取消收藏一个条目（按 id 匹配最近列表或收藏夹）。
 * 返回操作后是否处于收藏态；两处都找不到返回 null。
 */
export async function toggleFavoriteProject(id: string): Promise<boolean | null> {
  const favs = await readList(true);
  if (favs.some((s) => s.entry.id === id)) {
    await writeList(true, favs.filter((s) => s.entry.id !== id));
    return false;
  }
  const hit = (await readList(false)).find((s) => s.entry.id === id);
  if (!hit) return null;
  await writeList(true, [
    ...favs,
    { entry: { ...hit.entry, openedAt: Date.now() }, handle: hit.handle },
  ]);
  return true;
}

/** 浏览器：按 id 取回条目的 FSA 句柄（先最近后收藏；Tauri 恒 null，路径即标识） */
export async function resolveProjectHandle(
  id: string,
): Promise<FileSystemFileHandle | FileSystemDirectoryHandle | null> {
  for (const fav of [false, true]) {
    const hit = (await readList(fav)).find((s) => s.entry.id === id);
    if (hit) {
      // 写入侧 recordOpenProject 已用 isSameEntry 校验过是 FSA 句柄，读回信任该形状
      return hit.handle as FileSystemFileHandle | FileSystemDirectoryHandle;
    }
  }
  return null;
}
