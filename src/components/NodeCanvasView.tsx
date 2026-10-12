/**
 * 分组编辑页外壳（ReactFlow 版）
 *
 * 本文件导出两个顶层组件，由 App.tsx 按 store 状态渲染：
 * - <GroupEditorPage />  activeGroupId 非空时渲染：
 *   工具栏（返回/异常开关/作用域/统计/改名）+ <GroupFlowCanvas />（ReactFlow 画布）
 * - <FilterDetailModal />  editingFilterId 非空时渲染，编辑 filter 属性与归属。
 *
 * 画布交互（拖入/拖出/连线/自环/边编辑）全部在 ./flow/GroupFlowCanvas。
 */
import { useEffect, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { FilterEngine } from '../filters/FilterEngine';
import type { FilterGroup, SequenceEdge } from '../types';
import { ChevronLeft, X, AlertTriangle, Trash } from './Icon';
import { GroupFlowCanvas } from './flow/GroupFlowCanvas';
import styles from './NodeCanvasView.module.css';

/** 格式化时间窗标签：1000 → 1s，1500 → 1.5s，500 → 500ms */
export function formatGap(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function GroupEditorPage() {
  const activeGroupId = useLogStore((s) => s.activeGroupId);
  const setActiveGroup = useLogStore((s) => s.setActiveGroup);
  const groups = useLogStore((s) => s.groups);
  const updateGroup = useLogStore((s) => s.updateGroup);
  const toggleSequenceAnomaly = useLogStore((s) => s.toggleSequenceAnomaly);
  const setSequenceScope = useLogStore((s) => s.setSequenceScope);
  const sequenceResults = useLogStore((s) => s.sequenceResults);

  const groupId = activeGroupId ?? '';
  const group = groups.find((g) => g.id === groupId);
  const seqResult = group ? sequenceResults[group.id] : undefined;

  // Esc 关闭抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveGroup(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveGroup]);

  if (!group) {
    return (
      <div className={styles.overlay}>
        <div className={styles.toolbar}>
          <button className="ghost" onClick={() => setActiveGroup(null)}>
            <ChevronLeft size={14} /> 返回
          </button>
          <span className={styles.crumbs}>分组不存在</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.toolbar}>
        <button className="ghost" onClick={() => setActiveGroup(null)}>← 返回</button>
        <span className={styles.crumbs}>分组编辑 / {group.label}</span>
        <div className={styles.spacer} />
        <button
          className={`ghost ${group.sequence?.anomalyEnabled ? styles.toolbarBtnActive : ''}`}
          onClick={() => toggleSequenceAnomaly(group.id)}
          title="异常开关：开启后在时间线/日志流视图中把未覆盖事件标红"
        >
          <AlertTriangle size={14} /> 异常
          {seqResult && seqResult.uncoveredEvents.length > 0 && (
            <span className={styles.anomalyBadge}>{seqResult.uncoveredEvents.length}</span>
          )}
        </button>
        <button
          className={`ghost ${group.sequence?.scope === 'thread' ? styles.toolbarBtnActive : ''}`}
          onClick={() =>
            setSequenceScope(group.id, group.sequence?.scope === 'thread' ? 'global' : 'thread')
          }
          title="匹配作用域：全局=所有事件在同一条时间轴上竞争；按线程=每个 thread 独立匹配（推荐多线程日志开启）"
        >
          {group.sequence?.scope === 'thread' ? '🧵 按线程' : '🌐 全局'}
        </button>
        {seqResult && (
          <span className={styles.seqStat}>
            ⛓ {seqResult.chains.length} 链
            {group.sequence?.anomalyEnabled ? ` · ${seqResult.uncoveredEvents.length} 异常` : ''}
          </span>
        )}
        <input
          className={`${styles.labelInput} mono`}
          type="text"
          value={group.label}
          onChange={(e) => updateGroup(group.id, { label: e.target.value })}
          placeholder="分组名称"
        />
        <span className={styles.hint}>
          右缘拖出连线=时序 · 拖回自身=心跳 · Shift=AND Alt=OR · 点边可编辑/切类型
        </span>
        <div className={styles.spacer} />
        <button
          className="ghost"
          onClick={() => setActiveGroup(null)}
          title="关闭分组编辑，回到数据视图"
        >
          <X size={14} /> 关闭
        </button>
      </div>

      {/* ReactFlow 画布：调色板 + 画布 + 边编辑弹窗均在 GroupFlowCanvas 内 */}
      <GroupFlowCanvas group={group} />
    </div>
  );
}

/* ============================================================
 * 序列边编辑弹窗：类型切换 / 时间窗 / AND-OR 目标 / 周期容差
 * （由 GroupFlowCanvas 触发；props 兼容旧调用）
 * ========================================================== */

export function EdgeEditModal(props: {
  groupId: string;
  edge: SequenceEdge;
  fromLabel: string;
  toLabel: string;
  /** 可选目标列表（组成员，排除 from） */
  memberTargets: { id: string; label: string }[];
  stat: { matchedCount: number; missCount: number; lateCount?: number; jitterCount?: number } | null;
  violationCount: number;
  onClose: () => void;
}) {
  const { groupId, edge, fromLabel, toLabel, memberTargets, stat, violationCount, onClose } = props;
  const updateSequenceEdge = useLogStore((s) => s.updateSequenceEdge);
  const removeSequenceEdge = useLogStore((s) => s.removeSequenceEdge);
  const [kind, setKind] = useState<SequenceEdge['kind']>(edge.kind ?? 'seq');
  const [gap, setGap] = useState(String(edge.maxGapMs));
  const [period, setPeriod] = useState(String(edge.periodMs ?? 1000));
  const [targets, setTargets] = useState<string[]>(
    (edge.kind === 'and' || edge.kind === 'or') && edge.toFilterIds?.length
      ? [...edge.toFilterIds]
      : [edge.toFilterId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const KIND_LABEL: Record<string, string> = {
    seq: '串行 SEQ（A 后须有 B，不容另一 A 插队）',
    not: '禁止 NOT（A 的窗口内不得出现 B）',
    and: '汇聚 AND（A 后全部目标都须出现）',
    or: '分支 OR（A 后任一目标出现即可）',
    opt: '可选 OPT（B 可缺省，缺失时直接跳到后续）',
    periodic: '周期心跳 Periodic（A 以固定周期反复出现）',
  };

  const apply = () => {
    const n = parseInt(gap, 10);
    const p = parseInt(period, 10);
    const patch: Partial<SequenceEdge> = {
      kind,
      maxGapMs: Number.isFinite(n) && n > 0 ? n : edge.maxGapMs,
    };
    if (kind === 'and' || kind === 'or') {
      if (targets.length === 0) return; // 无目标不保存
      patch.toFilterId = targets[0];
      patch.toFilterIds = targets;
    } else if (kind === 'periodic') {
      patch.toFilterId = edge.fromFilterId;
      patch.periodMs = Number.isFinite(p) && p > 0 ? p : edge.periodMs ?? 1000;
    } else {
      patch.toFilterId = targets[0] ?? edge.toFilterId;
    }
    updateSequenceEdge(groupId, edge.id, patch);
    onClose();
  };

  const isPeriodic = kind === 'periodic';
  const isMulti = kind === 'and' || kind === 'or';

  return (
    <>
      <div className={styles.modalBackdrop} onClick={onClose} />
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>
            约束编辑：<span className="mono">{fromLabel}</span>
            {isPeriodic ? ' ↻' : ` → ${isMulti ? targets.length + ' 目标' : toLabel}`}
          </span>
          <button className="ghost" onClick={onClose}><X size={14} /></button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.edgeEditRow}>
            <label className={styles.edgeEditLabel}>约束类型</label>
            <select
              className={styles.edgeEditSelect}
              value={kind}
              onChange={(e) => {
                const k = e.target.value as SequenceEdge['kind'];
                setKind(k);
                if (k === 'periodic') setTargets([edge.fromFilterId]);
              }}
            >
              {(['seq', 'not', 'and', 'or', 'opt', 'periodic'] as const).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          {isPeriodic ? (
            <>
              <div className={styles.edgeEditRow}>
                <label className={styles.edgeEditLabel}>期望周期 P</label>
                <input
                  className={`${styles.edgeEditInput} mono`}
                  type="number"
                  min={1}
                  step={100}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                />
                <span className={styles.edgeEditUnit}>ms</span>
              </div>
              <div className={styles.edgeEditRow}>
                <label className={styles.edgeEditLabel}>容差 δ</label>
                <input
                  className={`${styles.edgeEditInput} mono`}
                  type="number"
                  min={1}
                  step={100}
                  value={gap}
                  onChange={(e) => setGap(e.target.value)}
                />
                <span className={styles.edgeEditUnit}>ms</span>
                <span className={styles.edgeEditHint}>（间隔 ∈ [P−δ, P+δ] 正常；超上限=缺口，低于下限=抖动）</span>
              </div>
            </>
          ) : (
            <div className={styles.edgeEditRow}>
              <label className={styles.edgeEditLabel}>
                {kind === 'not' ? '观察窗' : '时间窗上限'}
              </label>
              <input
                className={`${styles.edgeEditInput} mono`}
                type="number"
                min={1}
                step={100}
                value={gap}
                onChange={(e) => setGap(e.target.value)}
              />
              <span className={styles.edgeEditUnit}>ms</span>
              <span className={styles.edgeEditHint}>
                {kind === 'not' ? '（窗口内出现禁止目标即违规）' : `（目标须在 ${fromLabel} 之后此窗口内出现）`}
              </span>
            </div>
          )}

          {isMulti && (
            <div className={styles.modalSection}>
              <div className={styles.modalSectionTitle}>
                目标（{targets.length}）— 全选 AND 语义 / 任一 OR 语义
              </div>
              <div className={styles.groupCheckboxList}>
                {memberTargets.map((t) => {
                  const checked = targets.includes(t.id);
                  return (
                    <label key={t.id} className={styles.groupCheckboxItem}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setTargets((prev) =>
                            e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id),
                          );
                        }}
                      />
                      <span className={styles.groupCheckboxLabel}>{t.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {stat && !isPeriodic && (
            <div className={styles.edgeStatRow}>
              {kind === 'not' ? (
                <>违规 <b>{violationCount}</b></>
              ) : (
                <>命中 <b>{stat.matchedCount}</b> · 断裂 <b>{stat.missCount}</b></>
              )}
            </div>
          )}
          {isPeriodic && stat && (
            <div className={styles.edgeStatRow}>
              缺口 <b>{stat.lateCount ?? 0}</b> · 抖动 <b>{stat.jitterCount ?? 0}</b>
            </div>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button
            className="ghost danger"
            onClick={() => {
              removeSequenceEdge(groupId, edge.id);
              onClose();
            }}
          >
            <Trash size={13} /> 删除约束
          </button>
          <button className="primary" onClick={apply}>保存</button>
        </div>
      </div>
    </>
  );
}

/* ============================================================
 * Filter 详情弹窗
 * ========================================================== */

export function FilterDetailModal() {
  const editingFilterId = useLogStore((s) => s.editingFilterId);
  const setEditingFilterId = useLogStore((s) => s.setEditingFilterId);
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const updateFilter = useLogStore((s) => s.updateFilter);
  const removeFilter = useLogStore((s) => s.removeFilter);
  const addFilterToGroup = useLogStore((s) => s.addFilterToGroup);
  const removeFilterFromGroup = useLogStore((s) => s.removeFilterFromGroup);

  const filter = filters.find((f) => f.id === editingFilterId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingFilterId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setEditingFilterId]);

  if (!filter) return null;

  const regexError = filter.isRegex ? FilterEngine.validateRegex(filter.pattern) : null;

  return (
    <>
      <div className={styles.modalBackdrop} onClick={() => setEditingFilterId(null)} />
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>编辑过滤器</span>
          <button className="ghost" onClick={() => setEditingFilterId(null)}><X size={14} /></button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <input
              className={styles.colorPick}
              type="color"
              value={filter.color}
              onChange={(e) => updateFilter(filter.id, { color: e.target.value })}
              title="颜色"
            />
            <input
              className={`${styles.labelInput} mono`}
              type="text"
              value={filter.label}
              onChange={(e) => updateFilter(filter.id, { label: e.target.value })}
              placeholder="名称"
            />
          </div>

          <textarea
            className={`${styles.patternInput} ${styles.patternArea} mono`}
            value={filter.pattern}
            onChange={(e) => updateFilter(filter.id, { pattern: e.target.value })}
            placeholder={
              filter.isRegex
                ? '正则表达式…（每行一个，全部命中；! 开头排除）'
                : '关键词…（每行一个，全部命中；! 开头排除）'
            }
            rows={Math.min(6, Math.max(1, filter.pattern.split('\n').length))}
            autoFocus
          />
          <div className={styles.syntaxHint}>
            多行 = 同时满足（AND）；<code>!</code> 开头 = 排除该行；行内 <code>|</code> = 或
          </div>
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
                onChange={(e) => updateFilter(filter.id, { caseSensitive: e.target.checked })}
              />
              区分大小写
            </label>
            <label>
              <input
                type="checkbox"
                checked={filter.scope === 'raw'}
                onChange={(e) => updateFilter(filter.id, { scope: e.target.checked ? 'raw' : 'message' })}
              />
              匹配整行
            </label>
            <label>
              <input
                type="checkbox"
                checked={filter.enabled}
                onChange={(e) => updateFilter(filter.id, { enabled: e.target.checked })}
              />
              启用
            </label>
          </div>

          {/* 归属分组多选 */}
          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>归属分组</div>
            {groups.length === 0 ? (
              <div className={styles.emptyHint}>无可用分组</div>
            ) : (
              <div className={styles.groupCheckboxList}>
                {groups.map((g: FilterGroup) => {
                  const checked = g.filterIds.includes(filter.id);
                  return (
                    <label key={g.id} className={styles.groupCheckboxItem}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) addFilterToGroup(filter.id, g.id);
                          else removeFilterFromGroup(filter.id, g.id);
                        }}
                      />
                      <span className={styles.groupColorDot} style={{ background: g.color }} />
                      <span className={styles.groupCheckboxLabel}>{g.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className={styles.modalFooter}>
          <button
            className="ghost"
            onClick={() => {
              removeFilter(filter.id);
              setEditingFilterId(null);
            }}
          >
            删除过滤器
          </button>
          <button className="primary" onClick={() => setEditingFilterId(null)}>完成</button>
        </div>
      </div>
    </>
  );
}
