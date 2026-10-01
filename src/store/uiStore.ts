import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** 毫秒，0 表示不自动关闭 */
  duration: number;
  action?: ToastAction;
}

/** 单个后台任务；同 label 的任务可并发，按 id 区分 */
interface BusyTask {
  id: number;
  label: string;
  startedAt: number;
}

/** 自动复制全部失败时的兜底：弹出手动复制窗口 */
export interface ManualCopyPayload {
  title: string;
  text: string;
  /** 失败原因/环境诊断，展示在窗口顶部 */
  hint?: string;
}

interface UiState {
  toasts: Toast[];
  busy: BusyTask[];
  /** 当前需要用户手动复制的内容（null = 不展示窗口） */
  manualCopy: ManualCopyPayload | null;
  notify: (title: string, opts?: Partial<Omit<Toast, 'id' | 'title'>>) => number;
  dismiss: (id: number) => void;
  /** 开始一个后台任务，返回结束时必须调用的清理函数 */
  beginBusy: (label: string) => () => void;
  /** 打开手动复制窗口 */
  openManualCopy: (payload: ManualCopyPayload) => void;
  closeManualCopy: () => void;
}

let seq = 0;

/** 依据语义设定默认停留时长：错误停留更久，且默认不自动消失以免用户漏看 */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 3200,
  success: 2600,
  warn: 5200,
  error: 7000,
};

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  busy: [],
  manualCopy: null,

  notify: (title, opts) => {
    const id = ++seq;
    const kind = opts?.kind ?? 'info';
    const toast: Toast = {
      id,
      kind,
      title,
      detail: opts?.detail,
      duration: opts?.duration ?? DEFAULT_DURATION[kind],
      action: opts?.action,
    };
    // 最多同时显示 5 条，超出时挤掉最旧的一条，避免刷屏遮挡画布
    set((s) => ({ toasts: [...s.toasts, toast].slice(-5) }));
    if (toast.duration > 0) {
      window.setTimeout(() => get().dismiss(id), toast.duration);
    }
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  beginBusy: (label) => {
    const id = ++seq;
    set((s) => ({ busy: [...s.busy, { id, label, startedAt: Date.now() }] }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => ({ busy: s.busy.filter((b) => b.id !== id) }));
    };
  },

  openManualCopy: (payload) => set({ manualCopy: payload }),
  closeManualCopy: () => set({ manualCopy: null }),
}));

/**
 * 命令式通知入口，供非 React 模块（io / parser 等）直接调用。
 * 用法与 alert(...) 类似，但不阻塞交互。
 */
export function notify(title: string, opts?: Partial<Omit<Toast, 'id' | 'title'>>): number {
  return useUiStore.getState().notify(title, opts);
}

/** 便捷别名 */
export const toast = {
  info: (title: string, detail?: string) => notify(title, { kind: 'info', detail }),
  success: (title: string, detail?: string) => notify(title, { kind: 'success', detail }),
  warn: (title: string, detail?: string) => notify(title, { kind: 'warn', detail }),
  error: (title: string, detail?: string) => notify(title, { kind: 'error', detail }),
};

/** 开始一个忙碌任务，返回必须调用的结束函数（建议配合 try/finally） */
export function beginBusy(label: string): () => void {
  return useUiStore.getState().beginBusy(label);
}
