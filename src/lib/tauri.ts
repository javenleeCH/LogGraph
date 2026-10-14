/**
 * Tauri 运行时检测与动态导入工具。
 *
 * 不在此模块顶部静态 import @tauri-apps/* ，而是用动态 import 按需加载，
 * 保证纯浏览器环境（npm run dev 直接打开）下不会加载/执行任何 Tauri 代码。
 */

/** 是否运行在 Tauri 桌面容器中（WebView2 / WKWebView 注入 __TAURI_INTERNALS__） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 取路径的最后一个段作为显示名（兼容 Windows `\` 与 POSIX `/`） */
export function basename(path: string): string {
  const segs = path.split(/[\\/]+/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

/** 动态加载 @tauri-apps/plugin-fs，避免浏览器环境报错 */
export function loadFs() {
  return import('@tauri-apps/plugin-fs');
}

/** 动态加载 @tauri-apps/plugin-dialog，避免浏览器环境报错 */
export function loadDialog() {
  return import('@tauri-apps/plugin-dialog');
}

/** 动态加载 @tauri-apps/plugin-opener（资源管理器定位文件），避免浏览器环境报错 */
export function loadOpener() {
  return import('@tauri-apps/plugin-opener');
}

// ---- Tauri 原生拖拽 ----

export interface DragDropHandlers {
  /** 文件悬停进入窗口（enter/over） */
  onDragOver: () => void;
  /** 拖拽离开 / 取消 */
  onDragLeave: () => void;
  /** 释放文件，paths 为绝对路径列表 */
  onDrop: (paths: string[]) => void;
}

/**
 * 注册 Tauri 原生文件拖放事件（浏览器下 no-op）。
 * 返回取消监听的清理函数，供 React useEffect 卸载时调用。
 */
export async function setupTauriDragDrop(h: DragDropHandlers): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    switch (p.type) {
      case 'enter':
      case 'over':
        h.onDragOver();
        break;
      case 'leave':
        h.onDragLeave();
        break;
      case 'drop':
        h.onDrop(p.paths);
        break;
    }
  });
  return unlisten;
}
