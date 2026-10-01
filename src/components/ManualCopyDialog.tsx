import { useEffect, useRef } from 'react';
import { useUiStore } from '../store/uiStore';
import { copyToClipboard } from '../utils/clipboard';
import { toast } from '../store/uiStore';
import { X } from './Icon';
import styles from './ManualCopyDialog.module.css';

/**
 * 剪贴板自动复制失败时的兜底窗口。
 * 文本放入可聚焦 textarea 并预先全选，用户按 Ctrl/⌘+C 即可取走内容。
 */
export function ManualCopyDialog() {
  const payload = useUiStore((s) => s.manualCopy);
  const close = useUiStore((s) => s.closeManualCopy);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // 打开即聚焦全选，让 Ctrl/⌘+C 直接可用
  useEffect(() => {
    if (!payload) return;
    const t = window.setTimeout(() => {
      const ta = areaRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      ta.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [payload]);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [payload, close]);

  if (!payload) return null;

  const retry = async () => {
    const r = await copyToClipboard(payload.text);
    if (r.ok) {
      toast.success('已复制到剪贴板');
      close();
    } else {
      toast.error('仍然无法自动复制', r.detail);
    }
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="手动复制"
      >
        <div className={styles.header}>
          <span className={styles.title}>{payload.title}</span>
          <button
            className={styles.closeBtn}
            onClick={close}
            aria-label="关闭"
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {payload.hint && <div className={styles.hint}>{payload.hint}</div>}
          <p className={styles.tip}>
            当前环境无法自动写入剪贴板。下方内容已全选，按
            <kbd className={styles.kbd}>Ctrl</kbd>
            <span className={styles.or}>或</span>
            <kbd className={styles.kbd}>⌘</kbd>
            <span className={styles.plus}>+</span>
            <kbd className={styles.kbd}>C</kbd>
            即可复制。
          </p>
          <textarea
            ref={areaRef}
            className={styles.area}
            readOnly
            value={payload.text}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              // 让 Ctrl/⌘+A 全选整段而不是页面
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.stopPropagation();
                e.currentTarget.select();
              }
            }}
          />
        </div>

        <div className={styles.footer}>
          <span className={styles.meta}>{payload.text.length} 字符</span>
          <div className={styles.actions}>
            <button className="ghost" onClick={() => areaRef.current?.select()}>
              全选
            </button>
            <button className="ghost" onClick={retry}>
              重试自动复制
            </button>
            <button className="primary" onClick={close}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
