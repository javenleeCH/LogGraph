/**
 * 文件加载：统一抽象浏览器 / Tauri 两种运行时。
 *
 * - 浏览器：拖拽 + FileReader + <input type=file>
 * - Tauri  ：dialog.open 选择文件 + plugin-fs 读文本 + 原生拖拽路径
 *
 * 读取 .log / .txt / 任意文本，返回字符串。
 */

import { isTauri, loadDialog, loadFs, basename } from '../lib/tauri';

const ACCEPTED = /\.(log|txt|out|csv|tsv)$/i;

export interface LoadedFile {
  name: string;
  size: number;
  text: string;
}

/** 通过 File（浏览器 <input>/拖拽）加载 */
export function loadFile(file: File): Promise<LoadedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: file.name,
        size: file.size,
        text: String(reader.result ?? ''),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** 是否为可接受的日志文件（按扩展名宽松判断） */
export function isLogFileName(name: string): boolean {
  return ACCEPTED.test(name);
}

/** 处理拖拽释放的文件列表，返回第一个文本文件（浏览器 DataTransfer 版） */
export async function loadFromDataTransfer(dt: DataTransfer): Promise<LoadedFile | null> {
  const file = dt.files?.[0];
  if (!file) return null;
  return loadFile(file);
}

/**
 * 检测拖拽的 DataTransfer 是否包含目录（Chromium 的 webkitGetAsEntry）。
 * 返回第一个目录 entry（FileSystemDirectoryEntry），没有则返回 null。
 */
export function getDroppedDirectoryEntry(dt: DataTransfer): any | null {
  if (!dt || !dt.items) return null;
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i] as any;
    const entry =
      typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) return entry;
  }
  return null;
}

/**
 * Tauri：打开「选择日志文件」对话框并读取内容。
 * 浏览器下返回 null（由调用方走 <input type=file>）。
 */
export async function openLogFileDialog(): Promise<LoadedFile | null> {
  if (!isTauri()) return null;
  const { open } = await loadDialog();
  const fs = await loadFs();

  const selected = await open({
    multiple: false,
    directory: false,
    title: '打开日志文件',
    filters: [
      { name: '日志文件', extensions: ['log', 'txt', 'out', 'csv', 'tsv'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;

  const path = selected as string;
  const text = await fs.readTextFile(path);
  let size = 0;
  try {
    const st = await fs.stat(path);
    size = st.size;
  } catch {
    /* 忽略 stat 失败，仅影响大小显示 */
  }
  return { name: basename(path), size, text };
}

/**
 * Tauri：读取一组被拖入窗口的文件路径（原生拖拽拿到的是绝对路径）。
 * 返回第一个文件的文本内容。
 */
export async function loadTauriPaths(paths: string[]): Promise<LoadedFile | null> {
  if (!isTauri() || paths.length === 0) return null;
  const fs = await loadFs();
  const path = paths[0];
  const text = await fs.readTextFile(path);
  let size = 0;
  try {
    const st = await fs.stat(path);
    size = st.size;
  } catch {
    /* 忽略 stat 失败 */
  }
  return { name: basename(path), size, text };
}
