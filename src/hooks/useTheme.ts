import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'loggraph-theme';

function readStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  // 默认暗黑（与 index.html 早期注入脚本保持一致）
  return 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

// 简单的外部 store，保证多组件实例共享同一份状态
let currentTheme: Theme = readStoredTheme();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Theme {
  return currentTheme;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setTheme = useCallback((next: Theme) => {
    if (next === currentTheme) return;
    currentTheme = next;
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  }, []);

  const toggle = useCallback(() => {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return { theme, toggle, setTheme } as const;
}

/**
 * 命令式主题切换（供命令面板等非组件上下文调用）。
 * 与 useTheme 共享同一份外部 store，因此工具栏图标状态会同步更新。
 */
export const toggleTheme = (): Theme => {
  const next: Theme = currentTheme === 'dark' ? 'light' : 'dark';
  currentTheme = next;
  applyTheme(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
  return next;
};
