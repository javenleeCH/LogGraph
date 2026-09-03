import type { CSSProperties } from 'react';

/**
 * 日志级别 → 颜色（色弱友好，Okabe-Ito）。
 * 必须与 global.css 的 --level-* 保持同步。
 * 大小写不敏感：传入时统一 toUpperCase 查找。
 */
const RAW_LEVEL_COLOR: Record<string, string> = {
  ERROR: '#d55e00',
  FATAL: '#d55e00',
  CRITICAL: '#d55e00',
  WARN: '#e69f00',
  WARNING: '#e69f00',
  INFO: '#0072b2',
  DEBUG: '#009e73',
  TRACE: '#cc79a7',
};

export function levelColor(level?: string): string | undefined {
  if (!level) return undefined;
  return RAW_LEVEL_COLOR[level.toUpperCase()];
}

/** 供内联 style 直接使用：返回 { background, color } 或 undefined */
export function levelStyle(level?: string): CSSProperties | undefined {
  const c = levelColor(level);
  return c ? { background: c, color: '#fff' } : undefined;
}
