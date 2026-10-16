/**
 * 全局行号 → 「文件 + 文件内行号」。
 *
 * 多文件合并后 LogEvent.id 是全局行号（跨文件累加），直接显示会让人看不出
 * 出处。db 模式下按 `files` 表的 firstLine 二分定位；单文件 / 无索引时返回
 * null，由调用方退回 sourceFile + 全局行号。
 */
import { getDbFiles } from './dbStore';

export interface LineLocation {
  /** 相对路径（目录内的名字） */
  file: string;
  /** 文件内行号（1-based） */
  line: number;
}

export function lineLocation(no: number): LineLocation | null {
  const files = getDbFiles();
  if (files.length === 0) return null;
  // 二分：找 firstLine <= no 的最后一个文件
  let lo = 0;
  let hi = files.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid].firstLine <= no) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  return { file: files[idx].name, line: no - files[idx].firstLine + 1 };
}

/** 显示用定位串：app.log:1234 / app.log#1234 / #1234 */
export function formatLineLoc(no: number, sourceFile?: string): string {
  const loc = lineLocation(no);
  if (loc) return `${loc.file}:${loc.line}`;
  return sourceFile ? `${sourceFile}#${no}` : `#${no}`;
}
