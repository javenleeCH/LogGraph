import { copyToClipboard } from './clipboard';
import { useUiStore, toast } from '../store/uiStore';

export interface CopyFlowOptions {
  /** 成功提示标题 */
  successTitle: string;
  /** 成功提示副标题 */
  successDetail?: string;
  /** 手动复制兜底窗口的标题 */
  fallbackTitle: string;
}

/**
 * 统一的复制流程：自动路径优先，全失败则弹手动复制窗口。
 *
 * 旧实现在两条自动路径都失败时只弹一句「当前环境不支持剪贴板操作」，
 * 用户拿到的是一个死胡同——内容就在屏幕上却取不走。这里改成兜底窗口：
 * 文本放进可聚焦的 textarea 并预先全选，用户按 Ctrl/⌘+C 即可。
 */
export async function copyWithFallback(
  text: string,
  opts: CopyFlowOptions,
): Promise<boolean> {
  if (!text) {
    toast.warn('没有可复制的内容', '该行暂无原始文本，可能尚未加载完成');
    return false;
  }

  const r = await copyToClipboard(text);
  if (r.ok) {
    toast.success(opts.successTitle, opts.successDetail);
    return true;
  }

  useUiStore.getState().openManualCopy({
    title: opts.fallbackTitle,
    text,
    hint: r.detail,
  });
  return false;
}
