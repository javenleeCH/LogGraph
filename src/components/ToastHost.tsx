import { useUiStore } from '../store/uiStore';
import { X } from './Icon';
import styles from './ToastHost.module.css';

const KIND_GLYPH: Record<string, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '×',
};

const KIND_CLASS: Record<string, string> = {
  success: styles.itemSuccess,
  warn: styles.itemWarn,
  error: styles.itemError,
};

/** 右下角通知堆叠：非阻塞，最多 5 条，错误默认停留更久 */
export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`${styles.item} ${KIND_CLASS[t.kind] ?? ''}`}>
          <span className={styles.icon} aria-hidden="true">
            {KIND_GLYPH[t.kind] ?? 'i'}
          </span>
          <div className={styles.body}>
            <div className={styles.title}>{t.title}</div>
            {t.detail && <div className={styles.detail}>{t.detail}</div>}
            {t.action && (
              <div className={styles.row}>
                <button
                  className={styles.action}
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              </div>
            )}
          </div>
          <button
            className={styles.close}
            onClick={() => dismiss(t.id)}
            aria-label="关闭通知"
            title="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 顶部忙碌指示：解析/加载期间给确定性反馈，避免“点了没反应” */
export function BusyIndicator() {
  const busy = useUiStore((s) => s.busy);
  if (busy.length === 0) return null;
  const top = busy[busy.length - 1];
  return (
    <div className={styles.busyWrap} role="progressbar" aria-label={top.label}>
      <div className={styles.busyBar} />
      <div className={styles.busyChip}>
        <span className={styles.spinner} aria-hidden="true" />
        <span>{top.label}</span>
        {busy.length > 1 && <span style={{ opacity: 0.6 }}>+{busy.length - 1}</span>}
      </div>
    </div>
  );
}
