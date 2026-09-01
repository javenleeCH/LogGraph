import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { FilterEngine } from '../filters/FilterEngine';
import type { Filter } from '../types';
import styles from './FilterBar.module.css';

function FilterEditor({
  filter,
  anchor,
  onClose,
}: {
  filter: Filter;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const updateFilter = useLogStore((s) => s.updateFilter);
  const removeFilter = useLogStore((s) => s.removeFilter);
  const editorRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 定位弹出框，确保不溢出视口
  useEffect(() => {
    const pw = 320;
    const ph = 240;
    let left = anchor.x;
    let top = anchor.y + 8;
    if (left + pw > window.innerWidth) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight) top = anchor.y - ph - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const regexError = filter.isRegex ? FilterEngine.validateRegex(filter.pattern) : null;

  if (!pos) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div
        ref={editorRef}
        className={styles.editor}
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.row}>
          <input
            className={styles['color-pick']}
            type="color"
            value={filter.color}
            onChange={(e) => updateFilter(filter.id, { color: e.target.value })}
            title="颜色"
          />
          <input
            className={`${styles['label-input']} mono`}
            type="text"
            value={filter.label}
            onChange={(e) => updateFilter(filter.id, { label: e.target.value })}
            placeholder="名称"
          />
        </div>

        <input
          className={`${styles['pattern-input']} mono`}
          type="text"
          value={filter.pattern}
          onChange={(e) => updateFilter(filter.id, { pattern: e.target.value })}
          placeholder={filter.isRegex ? '正则表达式…' : '关键词…'}
          autoFocus
        />

        {regexError && <div className={styles.error}>{regexError}</div>}

        <div className={styles.toggles}>
          <label>
            <input
              type="checkbox"
              checked={filter.isRegex}
              onChange={(e) => updateFilter(filter.id, { isRegex: e.target.checked })}
            />
            正则
          </label>
          <label>
            <input
              type="checkbox"
              checked={filter.caseSensitive}
              onChange={(e) =>
                updateFilter(filter.id, { caseSensitive: e.target.checked })
              }
            />
            区分大小写
          </label>
          <label>
            <input
              type="checkbox"
              checked={filter.scope === 'raw'}
              onChange={(e) =>
                updateFilter(filter.id, { scope: e.target.checked ? 'raw' : 'message' })
              }
            />
            匹配整行
          </label>
        </div>

        <div className={styles.actions}>
          <button className="ghost" onClick={() => removeFilter(filter.id)}>
            删除
          </button>
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </>
  );
}

export function FilterBar() {
  const filters = useLogStore((s) => s.filters);
  const addFilter = useLogStore((s) => s.addFilter);
  const updateFilter = useLogStore((s) => s.updateFilter);
  const events = useLogStore((s) => s.events);
  const matches = useLogStore((s) => s.matches);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const editingFilter = filters.find((f) => f.id === editingId) ?? null;

  const openEditor = (id: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: rect.left + rect.width / 2, y: rect.bottom });
    setEditingId(id);
  };

  return (
    <div className={styles.bar}>
      <span className={styles.label}>过滤</span>
      <div className={styles.chips}>
        {filters.length === 0 ? (
          <span className={styles.empty}>
            {events.length === 0 ? '加载日志后添加过滤器' : '点击 + 添加过滤器'}
          </span>
        ) : (
          filters.map((f) => {
            const match = matches.find((m) => m.filterId === f.id);
            const count = match?.events.length ?? 0;
            const hasSelected =
              selectedEventId !== null &&
              (match?.events.some((ev) => ev.id === selectedEventId) ?? false);
            return (
              <div
                key={f.id}
                className={[
                  styles.chip,
                  !f.enabled ? styles.disabled : '',
                  hasSelected ? styles.active : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={(e) => openEditor(f.id, e)}
                title="点击编辑"
              >
                <span
                  className={styles.dot}
                  style={{ background: f.color }}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateFilter(f.id, { enabled: !f.enabled });
                  }}
                  title={f.enabled ? '点击禁用' : '点击启用'}
                />
                <span className={styles.name}>{f.label}</span>
                <span className={styles.count}>{count}</span>
                {count > 0 && (
                  <button
                    className={styles.toggle}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectEvent(match!.events[0].id);
                    }}
                    title="跳到首个匹配"
                    style={{
                      border: 'none',
                      background: 'none',
                      color: 'var(--text-dim)',
                    }}
                  >
                    →
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
      <button
        className={styles.addBtn}
        onClick={() => addFilter()}
        disabled={events.length === 0}
      >
        + 新增
      </button>

      {editingFilter && (
        <FilterEditor
          filter={editingFilter}
          anchor={anchor}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
