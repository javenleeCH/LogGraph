import { useEffect, useRef, useState } from 'react';
import type { Filter, LogEvent } from '../types';
import { ChevronDown, ChevronUp } from './Icon';
import styles from './LogStreamView.module.css';

/**
 * 纵轴视图列头：标题行（色点 + 名称 + 正则）+ 控制行（▲/▼ + 序号框）。
 *
 * 序号框在该 filter 的匹配事件间跳转（可输入数字直接定位，1-based，
 * 基于全量匹配而非当前视窗；跳转用 focusEvent——事件不在当前时间窗时
 * 自动平移视图，配合主体自动滚动露出卡片）。
 */
export function LaneHeader(props: {
  filter: Filter;
  width: number;
  /** 该 filter 的全量匹配事件（ts 有序） */
  events: LogEvent[];
  /** selectedEventId 在 events 中的下标；-1 = 选中事件不属于该列 */
  pos: number;
  onNav: (id: number) => void;
}) {
  const { filter: f, events, pos, onNav } = props;
  const [draft, setDraft] = useState('');
  const draftDirty = useRef(false);

  // 外部选中变化 → 同步序号草稿（用户正在输入时不打扰）
  useEffect(() => {
    if (draftDirty.current) return;
    setDraft(pos >= 0 ? String(pos + 1) : '');
  }, [pos]);

  const nav = (dir: -1 | 1) => {
    if (events.length === 0) return;
    // 选中事件不在本列：▲ 跳列尾、▼ 跳列首（朝视野方向进入）
    const nextIdx = pos < 0 ? (dir === 1 ? 0 : events.length - 1) : pos + dir;
    const clamped = Math.min(events.length - 1, Math.max(0, nextIdx));
    onNav(events[clamped].id);
  };

  const jump = () => {
    draftDirty.current = false;
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && events.length > 0) {
      const idx = Math.min(events.length, Math.max(1, n)) - 1;
      onNav(events[idx].id);
    } else {
      setDraft(pos >= 0 ? String(pos + 1) : '');
    }
  };

  return (
    <div
      className={styles.laneHeader}
      style={{ width: props.width, borderLeftColor: f.color }}
    >
      <div className={styles.laneTop}>
        <span className={styles.laneDot} style={{ background: f.color }} />
        <span className={styles.laneTitle}>{f.label}</span>
        <span className={styles.lanePattern}>{f.pattern || '（空）'}</span>
      </div>
      <div className={styles.laneCtrl}>
        <button
          className={styles.navBtn}
          title="上一个匹配事件"
          disabled={events.length === 0}
          onClick={() => nav(-1)}
        >
          <ChevronUp size={11} />
        </button>
        <span className={styles.navPos} title="当前序号 / 总数，输入数字回车直接定位">
          <input
            className={styles.navInput}
            value={draft}
            placeholder="-"
            onChange={(e) => {
              draftDirty.current = true;
              setDraft(e.target.value.replace(/[^\d]/g, ''));
            }}
            onFocus={(e) => e.target.select()}
            onBlur={jump}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            disabled={events.length === 0}
          />
          <span className={styles.navTotal}>/{events.length}</span>
        </span>
        <button
          className={styles.navBtn}
          title="下一个匹配事件"
          disabled={events.length === 0}
          onClick={() => nav(1)}
        >
          <ChevronDown size={11} />
        </button>
      </div>
    </div>
  );
}
