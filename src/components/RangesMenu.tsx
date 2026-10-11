import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import { Save, Trash } from './Icon';
import styles from './RangesMenu.module.css';

/**
 * 时间范围书签下拉（Toolbar）：
 * - 保存当前视口为命名范围（时间线 Shift 框选 / 缩放后随手存）
 * - 列表一键应用：视口跳到该范围，表格流随之只显示该范围
 * - localStorage 持久化，跨会话保留；与数据目录无关（换数据集时 clamp）
 */
export function RangesMenu() {
  const viewRange = useLogStore((s) => s.viewRange);
  const savedRanges = useLogStore((s) => s.savedRanges);
  const saveRange = useLogStore((s) => s.saveRange);
  const applySavedRange = useLogStore((s) => s.applySavedRange);
  const removeSavedRange = useLogStore((s) => s.removeSavedRange);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const save = () => {
    if (!viewRange) return;
    const fallback = `范围 ${savedRanges.length + 1}`;
    if (saveRange(name.trim() || fallback)) {
      setName('');
    }
  };

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        className={`ghost ${styles.trigger}`}
        onClick={() => setOpen((o) => !o)}
        title="时间范围书签：保存 / 应用已框选范围"
      >
        <Save size={14} />
        <span>范围{savedRanges.length > 0 ? ` (${savedRanges.length})` : ''}</span>
      </button>

      {open && (
        <div className={styles.menu}>
          <div className={styles.saveRow}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setName('');
              }}
              placeholder={viewRange ? `范围 ${savedRanges.length + 1}` : '无数据'}
              disabled={!viewRange}
              spellCheck={false}
            />
            <button className="primary" onClick={save} disabled={!viewRange} title="把当前视口存为范围书签">
              保存当前视口
            </button>
          </div>
          {viewRange && (
            <div className={styles.rangeInfo} title="当前视口">
              {formatDateTime(viewRange.start)} → {formatDateTime(viewRange.end)} ·{' '}
              {formatDuration(viewRange.end - viewRange.start)}
            </div>
          )}

          {savedRanges.length > 0 ? (
            <div className={styles.list}>
              {savedRanges.map((r) => (
                <div key={r.id} className={styles.item}>
                  <button
                    className={styles.apply}
                    onClick={() => {
                      applySavedRange(r.id);
                      setOpen(false);
                    }}
                    title={`应用：${formatDateTime(r.start)} → ${formatDateTime(r.end)}`}
                  >
                    <span className={styles.itemName}>{r.name}</span>
                    <span className={styles.itemSpan}>
                      {formatDateTime(r.start)} → {formatDateTime(r.end)} ·{' '}
                      {formatDuration(r.end - r.start)}
                    </span>
                  </button>
                  <button
                    className={`ghost ${styles.del}`}
                    onClick={() => removeSavedRange(r.id)}
                    title="删除该范围"
                  >
                    <Trash size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              还没有已存范围——时间线上按住 Shift 拖拽框选，或在上方保存当前视口
            </div>
          )}
        </div>
      )}
    </div>
  );
}
