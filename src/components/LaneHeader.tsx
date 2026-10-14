import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import type { Filter, FilterGroup, LogEvent } from '../types';
import { NodeEditModal } from './flow/GroupFlowCanvas';
import { ChevronDown, ChevronUp } from './Icon';
import styles from './LogStreamView.module.css';

/**
 * 纵轴视图列头：标题行（色点 + 名称 + 正则）+ 控制行。
 *
 * 控制行：
 * - ▲/▼ + 序号框：在该 filter 的匹配事件间跳转（序号可输入直接定位，
 *   1-based，基于全量匹配而非当前视窗；跳转用 focusEvent——事件不在
 *   当前时间窗时自动平移视图，配合主体自动滚动露出卡片）
 * - 序列框：显示该节点在分组序列编排中的链上位置（前驱→[本节点]→后继），
 *   点击弹出节点约束编辑（循环次数 + 条件表达式，与编排器同一弹窗）；
 *   分组未编排序列时显示占位，点击跳转该分组编排。
 */
export function LaneHeader(props: {
  filter: Filter;
  width: number;
  /** 该 filter 的全量匹配事件（ts 有序） */
  events: LogEvent[];
  /** selectedEventId 在 events 中的下标；-1 = 选中事件不属于该列 */
  pos: number;
  onNav: (id: number) => void;
  /** 该列所属分组（顶层 filter 无分组 → null，序列框不渲染） */
  group: FilterGroup | null;
  /** 前驱/后继节点 label 查找（含被隐藏的 filter） */
  filtersById: Map<string, Filter>;
}) {
  const { filter: f, events, pos, onNav, group, filtersById } = props;
  const setActiveGroup = useLogStore((s) => s.setActiveGroup);
  const [draft, setDraft] = useState('');
  const [editingNode, setEditingNode] = useState(false);
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

  // 序列链上位置：前驱/后继节点 label（DAG，多路 join '/'；含被隐藏 filter）
  const seqCtx = (() => {
    const seq = group?.sequence;
    if (!group || !seq || seq.edges.length === 0) return null;
    const preds = seq.edges
      .filter((e) => (e.toFilterIds ?? [e.toFilterId]).includes(f.id))
      .map((e) => filtersById.get(e.fromFilterId)?.label ?? '?');
    const succs = seq.edges
      .filter((e) => e.fromFilterId === f.id)
      .flatMap((e) =>
        (e.toFilterIds ?? [e.toFilterId]).map((id) => filtersById.get(id)?.label ?? '?'),
      );
    return { preds: [...new Set(preds)], succs: [...new Set(succs)] };
  })();

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
        {group && (
          <button
            className={`${styles.seqBox} ${seqCtx ? '' : styles.seqBoxEmpty}`}
            title={
              seqCtx
                ? `序列节点 ${f.label}：点击编辑循环次数 / 条件表达式`
                : '该分组尚未编排序列，点击打开分组编排'
            }
            onClick={() => (seqCtx ? setEditingNode(true) : setActiveGroup(group.id))}
          >
            {seqCtx
              ? `${seqCtx.preds.join('/')}→[${f.label}]→${seqCtx.succs.join('/')}`
              : '⛓ 未编排'}
          </button>
        )}
      </div>
      {editingNode && group && (
        <NodeEditModal group={group} filterId={f.id} onClose={() => setEditingNode(false)} />
      )}
    </div>
  );
}
