/**
 * ReactFlow 版分组编辑画布（替换手写 NodeCanvasView 的 GroupEditorPage 渲染层）
 *
 * 受控模式：nodes/edges 由 store（graphNodes/groups.sequence）派生，
 * 拖拽经 onNodesChange → applyNodeChanges → setNodePos 同步回 store。
 *
 * 交互保留：
 * - 调色板 HTML5 DnD 拖入 → addFilterToGroup + 落点 setNodePos
 * - onNodeDragStop 视口边界判定 → 拖出画布即 removeFilterFromGroup
 * - onConnect + 修饰键（Shift=AND / Alt=OR / 自环=periodic）
 * - 边标签点击 → EdgeEditModal（复用旧组件）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  useReactFlow,
  type NodeChange,
  type Connection,
  type OnConnect,
  type OnConnectStart,
} from '@xyflow/react';
import { validateExpr, compileExpr } from '../../sequence/expr';
import '@xyflow/react/dist/style.css';
import { useLogStore } from '../../store/logStore';
import type { FilterGroup, SequenceEdge } from '../../types';
import { formatGap } from '../NodeCanvasView';
import { FilterNode, type FilterNodeData } from './FilterNode';
import { SeqEdge, type SeqEdgeData } from './SeqEdge';
import { Check, X } from '../Icon';
import styles from '../NodeCanvasView.module.css';

const nodeTypes = { filter: FilterNode };
const edgeTypes = { seq: SeqEdge };

function GroupFlowCanvasInner({ group }: { group: FilterGroup }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const filters = useLogStore((s) => s.filters);
  const matches = useLogStore((s) => s.matches);
  const graphNodes = useLogStore((s) => s.graphNodes);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const setNodePos = useLogStore((s) => s.setNodePos);
  const ensureNodePos = useLogStore((s) => s.ensureNodePos);
  const addFilterToGroup = useLogStore((s) => s.addFilterToGroup);
  const removeFilterFromGroup = useLogStore((s) => s.removeFilterFromGroup);
  const addSequenceEdge = useLogStore((s) => s.addSequenceEdge);
  const removeSequenceEdge = useLogStore((s) => s.removeSequenceEdge);

  const { screenToFlowPosition } = useReactFlow();

  // 编辑中的边（复用旧弹窗）
  const [editingEdge, setEditingEdge] = useState<SequenceEdge | null>(null);
  // 编辑中的节点（条件+次数弹窗）
  const [editingNode, setEditingNode] = useState<string | null>(null);
  // 调色板拖拽的 filterId（HTML5 DnD）
  const dragFilterId = useRef<string | null>(null);
  // 连线修饰键
  const modifierRef = useRef<'and' | 'or' | 'opt' | null>(null);

  const seqResult = sequenceResults[group.id];

  // ---- 兜底：成员缺坐标自动补 ----
  useEffect(() => {
    for (const fid of group.filterIds) {
      if (!graphNodes[fid]) ensureNodePos(fid, 'filterItem');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, group.filterIds.length, graphNodes]);

  // ---- 受控 nodes：store.graphNodes → RF nodes ----
  const rfNodes = useMemo(() => {
    return group.filterIds
      .map((fid) => {
        const f = filters.find((x) => x.id === fid);
        const pos = graphNodes[fid];
        if (!f || !pos) return null;
        const matchCount = matches.find((m) => m.filterId === fid)?.events.length ?? 0;
        let chained = 0;
        for (const ch of seqResult?.chains ?? []) {
          for (const st of ch.steps) if (st.filterId === fid) chained++;
        }
        const nc = group.sequence?.nodeCounts?.[fid];
        const countLabel = nc
          ? nc.min === nc.max
            ? `{${nc.min}}`
            : `{${nc.min},${nc.max === Infinity ? '' : nc.max}}`
          : null;
        const hasCondition = !!group.sequence?.nodeConditions?.[fid]?.trim();
        const data: FilterNodeData = {
          label: f.label,
          color: f.color,
          enabled: f.enabled,
          matchCount,
          chainedCount: chained,
          countLabel,
          hasCondition,
          onEdit: () => setEditingNode(fid),
          onRemove: () => removeFilterFromGroup(fid, group.id),
        };
        return {
          id: fid,
          type: 'filter' as const,
          position: { x: pos.x, y: pos.y },
          data,
          selected: false,
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }, [group.filterIds, group.id, filters, graphNodes, matches, seqResult, removeFilterFromGroup]);

  // ---- 受控 edges：group.sequence.edges → RF edges ----
  const rfEdges = useMemo(() => {
    return (group.sequence?.edges ?? []).map((edge) => {
      const kind = edge.kind ?? 'seq';
      const fromFilter = filters.find((f) => f.id === edge.fromFilterId);
      const st = seqResult?.edgeStats.find((s) => s.edgeId === edge.id);
      const vCount =
        seqResult?.notViolations.filter((v) => v.edgeId === edge.id).length ?? 0;
      let label = '';
      if (kind === 'periodic') {
        const hb = seqResult?.heartbeats.find((h) => h.filterId === edge.fromFilterId);
        label = `♥ ${formatGap(edge.periodMs ?? edge.maxGapMs)} ±${formatGap(edge.maxGapMs)}${
          hb && hb.gaps.length + hb.jitters.length > 0
            ? ` · ⚠${hb.gaps.length} ⚡${hb.jitters.length}`
            : ''
        }`;
      } else {
        const total = (st?.matchedCount ?? 0) + (st?.missCount ?? 0);
        const rate = total > 0 ? Math.round((st!.matchedCount / total) * 100) : null;
        const kindLabel =
          kind === 'and' ? 'AND ' : kind === 'or' ? 'OR ' : kind === 'not' ? '⃠ ' : kind === 'opt' ? '? ' : '';
        label = `${kindLabel}${formatGap(edge.maxGapMs)}${
          kind === 'not' ? ` · ${vCount} 违规` : rate !== null ? ` · ${rate}%` : ''
        }`;
      }
      // and/or 副支目标（除首目标外的 toFilterIds 坐标）
      const targets =
        (kind === 'and' || kind === 'or') && edge.toFilterIds?.length
          ? edge.toFilterIds
          : [edge.toFilterId];
      const extraTargets = targets
        .slice(1)
        .map((t) => graphNodes[t])
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({ x: p.x, y: p.y + 22 }));
      const data: SeqEdgeData = {
        kind,
        color: fromFilter?.color,
        label,
        extraTargets,
        onLabelClick: () => setEditingEdge(edge),
        onDelete: () => removeSequenceEdge(group.id, edge.id),
      };
      return {
        id: edge.id,
        type: 'seq' as const,
        source: edge.fromFilterId,
        target:
          kind === 'periodic'
            ? edge.fromFilterId
            : (edge.toFilterIds?.[0] ?? edge.toFilterId),
        sourceHandle: kind === 'periodic' ? 'loop-src' : 'out',
        targetHandle: kind === 'periodic' ? 'loop-dst' : 'in',
        data,
      };
    });
  }, [group.id, group.sequence?.edges, filters, seqResult, graphNodes, removeSequenceEdge]);

  // ---- 拖拽同步：onNodesChange（只处理位置类变更）→ setNodePos ----
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) {
          setNodePos(ch.id, ch.position.x, ch.position.y);
        }
      }
    },
    [setNodePos],
  );

  // ---- 拖出画布 → 脱离组（onNodeDragStop 视口判定，用 RF viewport 换算）----
  const { getViewport } = useReactFlow();
  const onNodeDragStop = useCallback(
    (
      _e: globalThis.MouseEvent | globalThis.TouchEvent,
      node: { id: string; position: { x: number; y: number } },
    ) => {
      const el = wrapperRef.current;
      if (!el) return;
      const { x: panX, y: panY, zoom } = getViewport();
      const sx = node.position.x * zoom + panX;
      const sy = node.position.y * zoom + panY;
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      const margin = 200; // 容忍度：完全拖出视口才脱离
      if (sx < -margin || sy < -margin || sx > vw + margin || sy > vh + margin) {
        removeFilterFromGroup(node.id, group.id);
      }
    },
    [getViewport, group.id, removeFilterFromGroup],
  );

  // ---- 调色板 HTML5 DnD ----
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const fid = dragFilterId.current ?? e.dataTransfer.getData('application/loggraph-filter');
      if (!fid) return;
      const wasMember = group.filterIds.includes(fid);
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (!wasMember) {
        addFilterToGroup(fid, group.id);
      }
      setNodePos(fid, p.x - 80, p.y - 18);
      dragFilterId.current = null;
    },
    [group.filterIds, group.id, addFilterToGroup, setNodePos, screenToFlowPosition],
  );

  // ---- 连线：修饰键建边 ----
  const onConnectStart: OnConnectStart = useCallback((e) => {
    const me = e as unknown as React.MouseEvent;
    modifierRef.current = me.shiftKey ? 'and' : me.altKey ? 'or' : me.ctrlKey || me.metaKey ? 'opt' : null;
  }, []);
  const onConnect: OnConnect = useCallback(
    (conn: Connection) => {
      if (conn.source === conn.target) {
        // 拖回自身 → periodic 自环
        addSequenceEdge(group.id, conn.source, conn.source, 1000, {
          kind: 'periodic',
          periodMs: 1000,
        });
        return;
      }
      if (modifierRef.current === 'and' || modifierRef.current === 'or') {
        addSequenceEdge(group.id, conn.source, conn.target, 1000, {
          kind: modifierRef.current,
          toFilterIds: [conn.target],
        });
      } else if (modifierRef.current === 'opt') {
        addSequenceEdge(group.id, conn.source, conn.target, 1000, { kind: 'opt' });
      } else {
        addSequenceEdge(group.id, conn.source, conn.target);
      }
      modifierRef.current = null;
    },
    [group.id, addSequenceEdge],
  );

  const memberFilters = useMemo(
    () => filters.filter((f) => group.filterIds.includes(f.id)),
    [filters, group.filterIds],
  );

  const matchCount = useCallback(
    (fid: string) => matches.find((m) => m.filterId === fid)?.events.length ?? 0,
    [matches],
  );

  return (
    <div className={styles.editorLayout}>
      {/* 左侧调色板（保留旧交互，改为 HTML5 DnD） */}
      <aside
        className={styles.palette}
        onDragOver={(e) => e.preventDefault()}
      >
        <div className={styles.paletteHeader}>过滤器列表</div>
        <div className={styles.paletteHint}>拖入画布添加 · 画布内为成员</div>
        <div className={styles.paletteList}>
          {filters.map((f) => {
            const isMember = group.filterIds.includes(f.id);
            return (
              <div
                key={f.id}
                className={[
                  styles.paletteItem,
                  isMember ? styles.paletteActive : '',
                  f.enabled ? '' : styles.cardDim,
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ borderLeftColor: f.color }}
                draggable
                onDragStart={(e) => {
                  dragFilterId.current = f.id;
                  e.dataTransfer.setData('application/loggraph-filter', f.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => {
                  // 点击快捷加入（不设坐标，走 ensureNodePos 网格）
                  if (!isMember) addFilterToGroup(f.id, group.id);
                }}
              >
                <span className={styles.paletteDot} style={{ background: f.color }} />
                <span className={styles.paletteLabel}>{f.label}</span>
                <span className={styles.paletteCount}>{matchCount(f.id)}</span>
                {isMember && (
                  <span className={styles.paletteCheck}>
                    <Check size={13} />
                  </span>
                )}
              </div>
            );
          })}
          {filters.length === 0 && <div className={styles.emptyHint}>暂无 filter</div>}
        </div>
      </aside>

      {/* ReactFlow 画布：整个画布即 group 区域 */}
      <div
        ref={wrapperRef}
        className={`${styles.canvas} ${styles.canvasIsGroup} rfHost`}
        style={{ borderLeftColor: group.color }}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnectStart={onConnectStart}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          nodesDraggable
          nodesConnectable
          zoomOnScroll
          minZoom={0.2}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          fitView={false}
          selectionOnDrag
          panOnDrag={[1, 2]} /* 中键/右键拖拽平移，左键留给框选 */
          selectionKeyCode="Shift"
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          snapToGrid
          snapGrid={[10, 10]}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.data as FilterNodeData)?.color ?? '#ccc'}
            nodeStrokeWidth={2}
            style={{ width: 140, height: 100 }}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className={styles.canvasTitle} style={{ background: group.color }}>
          <span>{group.label}</span>
          <span className={styles.groupCount}>{group.filterIds.length}</span>
        </div>
        {memberFilters.length === 0 && (
          <div className={styles.emptyHint}>从左侧拖入 filter 到画布即归属该组</div>
        )}
      </div>

      {/* 节点编辑弹窗（条件+次数） */}
      {editingNode && (
        <NodeEditModal
          group={group}
          filterId={editingNode}
          onClose={() => setEditingNode(null)}
        />
      )}

      {/* 复用旧边编辑弹窗 */}
      {editingEdge && (
        <EdgeEditModalLazy
          group={group}
          edge={editingEdge}
          memberTargets={memberFilters
            .filter((f) => f.id !== editingEdge.fromFilterId)
            .map((f) => ({ id: f.id, label: f.label }))}
          onClose={() => setEditingEdge(null)}
        />
      )}
    </div>
  );
}

/** 懒挂载旧 EdgeEditModal（含其内部 zustand 订阅） */
import { EdgeEditModal } from '../NodeCanvasView';
function EdgeEditModalLazy(props: {
  group: FilterGroup;
  edge: SequenceEdge;
  memberTargets: { id: string; label: string }[];
  onClose: () => void;
}) {
  const { group, edge, memberTargets, onClose } = props;
  const filters = useLogStore((s) => s.filters);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const st = sequenceResults[group.id]?.edgeStats.find((s) => s.edgeId === edge.id) ?? null;
  const vCount =
    sequenceResults[group.id]?.notViolations.filter((v) => v.edgeId === edge.id).length ?? 0;
  return (
    <EdgeEditModal
      groupId={group.id}
      edge={edge}
      fromLabel={filters.find((f) => f.id === edge.fromFilterId)?.label ?? edge.fromFilterId}
      toLabel={filters.find((f) => f.id === edge.toFilterId)?.label ?? edge.toFilterId}
      memberTargets={memberTargets}
      stat={st}
      violationCount={vCount}
      onClose={onClose}
    />
  );
}

/** 节点编辑弹窗：循环次数 + 条件表达式（EPL A{n,m} 与事件内部条件） */
export function NodeEditModal(props: {
  group: FilterGroup;
  filterId: string;
  onClose: () => void;
}) {
  const { group, filterId, onClose } = props;
  const filters = useLogStore((s) => s.filters);
  const matches = useLogStore((s) => s.matches);
  const setNodeCount = useLogStore((s) => s.setNodeCount);
  const setNodeCondition = useLogStore((s) => s.setNodeCondition);
  const f = filters.find((x) => x.id === filterId);
  const nc = group.sequence?.nodeCounts?.[filterId];
  const cond = group.sequence?.nodeConditions?.[filterId] ?? '';
  const [minS, setMinS] = useState(String(nc?.min ?? 1));
  const [maxS, setMaxS] = useState(nc?.max === Infinity ? '' : String(nc?.max ?? 1));
  const [expr, setExpr] = useState(cond);

  // 实时校验 + 命中预览
  const exprErr = useMemo(() => validateExpr(expr), [expr]);
  const preview = useMemo(() => {
    if (!expr.trim() || exprErr) return null;
    const pred = compileExpr(expr);
    if (!pred) return null;
    const evs = matches.find((m) => m.filterId === filterId)?.events ?? [];
    return { total: evs.length, hit: evs.filter(pred).length };
  }, [expr, exprErr, matches, filterId]);

  if (!f) return null;

  const apply = () => {
    const min = Math.max(1, parseInt(minS, 10) || 1);
    const maxRaw = maxS.trim() === '' ? Infinity : parseInt(maxS, 10) || min;
    const max = Math.max(min, maxRaw);
    if (min > 1 || max > 1) setNodeCount(group.id, filterId, { min, max });
    else setNodeCount(group.id, filterId, null);
    setNodeCondition(group.id, filterId, expr);
    onClose();
  };

  return (
    <>
      <div className={styles.modalBackdrop} onClick={onClose} />
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>
            节点约束：<span className="mono">{f.label}</span>
          </span>
          <button className="ghost" onClick={onClose}><X size={14} /></button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.edgeEditRow}>
            <label className={styles.edgeEditLabel}>出现次数</label>
            <input
              className={`${styles.edgeEditInput} mono`}
              type="number"
              min={1}
              value={minS}
              onChange={(e) => setMinS(e.target.value)}
              style={{ width: 60 }}
            />
            <span className={styles.edgeEditUnit}>~</span>
            <input
              className={`${styles.edgeEditInput} mono`}
              type="number"
              min={1}
              placeholder="∞"
              value={maxS}
              onChange={(e) => setMaxS(e.target.value)}
              style={{ width: 60 }}
            />
            <span className={styles.edgeEditHint}>
              （EPL A&#123;{minS || 1}&#125; 语义；1~1 = 不约束）
            </span>
          </div>

          <div className={styles.modalSection}>
            <div className={styles.modalSectionTitle}>条件表达式（对匹配事件二次过滤）</div>
            <input
              className={`${styles.edgeEditInput} mono`}
              style={{ width: '100%' }}
              type="text"
              value={expr}
              placeholder="level == 'E' && msg.includes('IPC timeout')"
              onChange={(e) => setExpr(e.target.value)}
            />
            {exprErr ? (
              <div style={{ color: 'var(--danger)', fontSize: 12 }}>{exprErr}</div>
            ) : preview ? (
              <div className={styles.edgeStatRow}>
                命中预览：<b>{preview.hit}</b> / {preview.total} 条匹配事件
              </div>
            ) : null}
            <div className={styles.edgeEditHint}>
              {'字段：raw / msg / thread / level / ts / file · 运算：== != > < && || · 方法：msg.includes(\'x\') / startsWith / endsWith'}
            </div>
          </div>
        </div>
        <div className={styles.modalFooter}>
          <button className="primary" onClick={apply}>保存</button>
        </div>
      </div>
    </>
  );
}

/** 导出：带 Provider 的顶层组件 */
export function GroupFlowCanvas(props: { group: FilterGroup }) {
  return (
    <ReactFlowProvider>
      <GroupFlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
