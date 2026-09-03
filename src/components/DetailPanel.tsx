import { useEffect, useMemo, useRef } from 'react';
import { useLogStore } from '../store/logStore';
import { formatDateTime } from '../utils/timeFormat';
import { levelStyle } from '../constants';
import { FileText } from './Icon';
import styles from './DetailPanel.module.css';

const CONTEXT_LINES = 4;

export function DetailPanel() {
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const events = useLogStore((s) => s.events);
  const rawLines = useLogStore((s) => s.rawLines);
  const matches = useLogStore((s) => s.matches);
  const filters = useLogStore((s) => s.filters);
  const correlatedEventIds = useLogStore((s) => s.correlatedEventIds);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const selectedRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () =>
      selectedEventId !== null
        ? events.find((e) => e.id === selectedEventId)
        : undefined,
    [selectedEventId, events],
  );

  // 选中行时滚动到视图
  useEffect(() => {
    if (selected && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selected]);

  const owningFilters = useMemo(() => {
    if (!selected) return [];
    return filters.filter((f) =>
      matches.find((m) => m.filterId === f.id)?.events.some(
        (e) => e.id === selected.id,
      ),
    );
  }, [selected, filters, matches]);

  if (!selected) {
    return (
      <div className={styles.detail}>
        <div className={styles['detail-empty']}>
          点击时间线上的事件以查看详情与上下文行
        </div>
      </div>
    );
  }

  const startLine = Math.max(0, selected.id - CONTEXT_LINES);
  const endLine = Math.min(rawLines.length - 1, selected.id + CONTEXT_LINES);
  const ctxLines: { lineno: number; text: string; lineId: number }[] = [];
  for (let i = startLine; i <= endLine; i++) {
    ctxLines.push({ lineno: i + 1, text: rawLines[i] ?? '', lineId: i });
  }

  const lvlStyle = levelStyle(selected.level);

  return (
    <div className={styles.detail}>
      <div className={styles['detail-header']}>
        <span className={styles.label}>详情</span>
        <span className={styles.linenum}>行 #{selected.id + 1}</span>
        <span className={styles.ts}>{formatDateTime(selected.ts)}</span>
        {selected.sourceFile && (
          <span className={styles.tag} title={`来源文件：${selected.sourceFile}`}>
            <FileText size={11} />
            {selected.sourceFile}
          </span>
        )}
        {selected.thread && (
          <span className={styles.tag}>{selected.thread}</span>
        )}
        {selected.level && (
          <span
            className={`${styles.tag} ${styles.level}`}
            style={lvlStyle}
          >
            {selected.level}
          </span>
        )}
        {owningFilters.map((f) => (
          <span
            key={f.id}
            className={styles.tag}
            style={{ borderColor: f.color, color: f.color }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: f.color,
              }}
            />
            {f.label}
          </span>
        ))}
      </div>
      <div className={styles['detail-body']}>
        {ctxLines.map((l) => {
          const isSelected = l.lineId === selected.id;
          const isCorrelated = correlatedEventIds.has(l.lineId);
          const cls = [
            styles['ctx-line'],
            isSelected ? styles.selected : '',
            isCorrelated && !isSelected ? styles.correlated : '',
            !isSelected && !isCorrelated ? styles.context : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={l.lineId}
              ref={isSelected ? selectedRef : undefined}
              className={cls}
              onClick={() => selectEvent(l.lineId)}
              style={{ cursor: 'pointer' }}
            >
              <span className={styles.lineno}>{l.lineno}</span>
              <span className={styles.content}>{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
