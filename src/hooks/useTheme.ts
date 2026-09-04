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
