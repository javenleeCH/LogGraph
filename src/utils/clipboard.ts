/**
 * 复制到剪贴板。
 *
 * 浏览器侧有两条自动路径，任一可用即成功：
 *   1. navigator.clipboard.writeText —— 需要安全上下文（https / localhost / Tauri 容器）
 *   2. document.execCommand('copy')  —— 旧兜底，非安全上下文下仍可用
 *
 * 两条都失败时（企业策略禁用剪贴板、部分 WebView 无权限、非安全上下文且
 * execCommand 被裁剪）不再简单返回 false，而是带上环境诊断信息，由上层
 * 弹出「手动复制」窗口兜底，保证用户一定能拿到内容。
 */

export type CopyVia = 'async' | 'exec';

export type CopyReason = 'empty' | 'unsupported';

export interface CopyOutcome {
  ok: boolean;
  /** 成功时走的是哪条路径 */
  via?: CopyVia;
  /** 失败原因：empty = 没有内容；unsupported = 环境不支持 */
  reason?: CopyReason;
  /** 失败时的环境诊断串，用于提示与排查 */
  detail?: string;
}

/** 当前环境的剪贴板能力诊断（失败时直接展示，方便定位而不是甩一句"不支持"） */
function buildDetail(info: {
  apiPresent: boolean;
  apiError: Error | null;
  execPresent: boolean;
}): string {
  const secure = window.isSecureContext === true;
  const api = info.apiError
    ? `剪贴板写入被拒（${info.apiError.name}${
        info.apiError.message ? ': ' + info.apiError.message.slice(0, 60) : ''
      }）`
    : info.apiPresent
      ? '剪贴板 API 已就绪'
      : '剪贴板 API 不可用（非 https / 非 localhost）';
  const exec = info.execPresent
    ? 'execCommand 复制失败'
    : 'execCommand 不可用';
  return [`安全上下文=${secure ? '是' : '否'}`, api, exec].join(' · ');
}

/**
 * execCommand 兜底实现。
 * 注意：元素不能用 display:none / visibility:hidden —— 不可聚焦就没有选区，
 * execCommand('copy') 会静默返回 false。
 */
function execCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.boxShadow = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  // 记下用户原有选区，复制完还原，避免打断正在进行的阅读/选择
  const sel = window.getSelection();
  const prevRange =
    sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    // iOS Safari 上 select() 不生效，必须显式设置选区
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();

  if (prevRange && sel) {
    sel.removeAllRanges();
    sel.addRange(prevRange);
  }
  return ok;
}

export async function copyToClipboard(text: string): Promise<CopyOutcome> {
  if (!text) return { ok: false, reason: 'empty' };

  const apiPresent = !!navigator.clipboard?.writeText;
  const execPresent = typeof document.execCommand === 'function';
  let apiError: Error | null = null;

  if (apiPresent) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, via: 'async' };
    } catch (err) {
      apiError = err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    if (execPresent && execCopy(text)) return { ok: true, via: 'exec' };
  } catch {
    /* 忽略，落到失败分支 */
  }

  return {
    ok: false,
    reason: 'unsupported',
    detail: buildDetail({ apiPresent, apiError, execPresent }),
  };
}

/** 仅关心成败的便捷包装（旧调用点兼容） */
export async function tryCopy(text: string): Promise<boolean> {
  return (await copyToClipboard(text)).ok;
}
