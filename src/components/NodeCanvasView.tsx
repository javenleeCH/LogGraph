/**
 * 节点画布视图（draw.io 风格整画布即 group）
 *
 * 本文件仅导出两个顶层组件，由 App.tsx 根据 store 中的
 * activeGroupId / editingFilterId 决定是否渲染：
 *
 * - <GroupEditorPage />  activeGroupId 非空时渲染，整画布即 group 区域，
 *   左侧 filter 调色板 + 中间画布；拖 filter 到画布即归属，拖出画布即脱离。
 * - <FilterDetailModal />  editingFilterId 非空时渲染弹窗，编辑 filter 属性与归属。
 *
 * group / filter 的列表浏览已迁移到左侧栏（App.tsx 内联 SidePanel）。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLogStore } from '../store/logStore';
import { FilterEngine } from '../filters/FilterEngine';
import type { FilterGroup, NodePos, SequenceEdge } from '../types';
import { ChevronLeft, X, Check, AlertTriangle, Trash } from './Icon';
import styles from './NodeCanvasView.module.css';

/** 格式化时间窗标签：1000 → 1s，1500 → 1.5s，500 → 500ms */
export function formatGap(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 取某节点的矩形（缺省尺寸兜底） */
function nodeRect(n: NodePos): Rect {
  const w = n.kind === 'group' ? n.w ?? 400 : 160;
  const h = n.kind === 'group' ? n.h ?? 300 : 44;
  return { x: n.x, y: n.y, w, h };
}

/* ============================================================
 * Group 编辑画布：左侧 filter 调色板 + 中间画布 + 返回
 * 整个画布即 group 区域
 * ========================================================== */

export function GroupEditorPage() {
  const activeGroupId = useLogStore((s) => s.activeGroupId);
  const setActiveGroup = useLogStore((s) => s.setActiveGroup);
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const matches = useLogStore((s) => s.matches);
  const graphNodes = useLogStore((s) => s.graphNodes);
  const graphPan = useLogStore((s) => s.graphPan);
  const graphZoom = useLogStore((s) => s.graphZoom);
  const setGraphPan = useLogStore((s) => s.setGraphPan);
  const setGraphZoom = useLogStore((s) => s.setGraphZoom);
  const setNodePos = useLogStore((s) => s.setNodePos);
  const ensureNodePos = useLogStore((s) => s.ensureNodePos);
  const updateGroup = useLogStore((s) => s.updateGroup);
  const addFilterToGroup = useLogStore((s) => s.addFilterToGroup);
  const removeFilterFromGroup = useLogStore((s) => s.removeFilterFromGroup);
  // 序列图关联
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const addSequenceEdge = useLogStore((s) => s.addSequenceEdge);
  const removeSequenceEdge = useLogStore((s) => s.removeSequenceEdge);
  const toggleSequenceAnomaly = useLogStore((s) => s.toggleSequenceAnomaly);
  const setSequenceScope = useLogStore((s) => s.setSequenceScope);

  const groupId = activeGroupId ?? '';
  const group = groups.find((g) => g.id === groupId);
  const containerRef = useRef<HTMLDivElement>(null);

  // 连线中状态：从节点右缘热区按下拖出橡皮筋线，松开在目标节点上建立序列边
  const [linking, setLinking] = useState<{
    fromFilterId: string;
    cur: { x: number; y: number }; // 画布内屏幕坐标
  } | null>(null);
  // 编辑中的序列边（点击边弹出）
  const [editingEdge, setEditingEdge] = useState<SequenceEdge | null>(null);

  // 拖拽状态：palette 拖拽 / 已有节点拖拽 / 平移
  const [dragging, setDragging] = useState<{
    kind: 'palette' | 'node' | 'pan';
    filterId?: string;
    nodeId?: string;
    offset?: { x: number; y: number };
    startScreen?: { x: number; y: number };
    startPan?: { x: number; y: number };
    moved?: boolean;
  } | null>(null);

  // 确保进入画布时 group 节点有坐标
  useEffect(() => {
    if (groupId) ensureNodePos(groupId, 'group');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  // 兜底：组内任何成员 filter 缺坐标时自动补（覆盖持久化缺失/其它路径入组）
  useEffect(() => {
    if (!group) return;
    for (const fid of group.filterIds) {
      if (!graphNodes[fid]) ensureNodePos(fid, 'filterItem');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id, group?.filterIds.length, graphNodes]);

  // Esc 关闭抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dragging) setActiveGroup(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging, setActiveGroup]);

  const toScreen = useCallback(
    (wx: number, wy: number) => ({ x: wx * graphZoom + graphPan.x, y: wy * graphZoom + graphPan.y }),
    [graphZoom, graphPan],
  );
  const toWorld = useCallback(
    (sx: number, sy: number) => ({ x: (sx - graphPan.x) / graphZoom, y: (sy - graphPan.y) / graphZoom }),
    [graphZoom, graphPan],
  );

  // 该 group 下的 filter（用于画布上显示实体）
  const memberFilters = useMemo(
    () => (group ? filters.filter((f) => group.filterIds.includes(f.id)) : []),
    [filters, group],
  );

  const matchCount = useCallback(
    (fid: string) => matches.find((m) => m.filterId === fid)?.events.length ?? 0,
    [matches],
  );

  // ---- 序列边渲染数据（世界坐标 → 屏幕坐标）----
  const seqEdges = group?.sequence?.edges ?? [];
  const seqResult = group ? sequenceResults[group.id] : undefined;

  /** 该 filter 被链消耗的事件数（节点角标） */
  const chainedCount = useCallback(
    (fid: string) => {
      if (!seqResult) return 0;
      let n = 0;
      for (const ch of seqResult.chains) {
        for (const st of ch.steps) if (st.filterId === fid) n++;
      }
      return n;
    },
    [seqResult],
  );

  /** 边统计（matched/miss） */
  const edgeStat = useCallback(
    (edgeId: string) =>
      seqResult?.edgeStats.find((s) => s.edgeId === edgeId) ?? null,
    [seqResult],
  );

  /** 边有效目标列表（and/or 用 toFilterIds） */
  const edgeTargets = useCallback((edge: SequenceEdge): string[] => {
    if ((edge.kind === 'and' || edge.kind === 'or') && edge.toFilterIds?.length) {
      return edge.toFilterIds;
    }
    return [edge.toFilterId];
  }, []);

  /** 目标节点左侧中点（屏幕坐标） */
  const targetPoint = useCallback(
    (fid: string) => {
      const node = graphNodes[fid];
      if (!node) return null;
      const r = nodeRect(node);
      return toScreen(r.x, r.y + r.h / 2);
    },
    [graphNodes, toScreen],
  );

  /** 源节点右侧中点（屏幕坐标） */
  const sourcePoint = useCallback(
    (fid: string) => {
      const node = graphNodes[fid];
      if (!node) return null;
      const r = nodeRect(node);
      return toScreen(r.x + r.w, r.y + r.h / 2);
    },
    [graphNodes, toScreen],
  );

  /** NOT 边违规数（画布边标签用） */
  const violationCount = useCallback(
    (edgeId: string) =>
      seqResult?.notViolations.filter((v) => v.edgeId === edgeId).length ?? 0,
    [seqResult],
  );

  // ---- 连线模式：橡皮筋拖线 ----
  // linking 状态：mousemove 实时更新终点，mouseup 判定落点是否在某节点上
  useEffect(() => {
    if (!linking) return;
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setLinking((l) =>
        l ? { ...l, cur: { x: e.clientX - rect.left, y: e.clientY - rect.top } } : l,
      );
    };
    const onUp = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect && linking && group) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        // 修饰键：Shift=AND 多目标，Alt=OR 多目标（单支时仍是 and/or 单目标边）
        const multiKind: 'and' | 'or' | null = e.shiftKey ? 'and' : e.altKey ? 'or' : null;
        // 找落点落在哪个成员节点上（屏幕坐标矩形判定）
        for (const f of memberFilters) {
          const node = graphNodes[f.id];
          if (!node) continue;
          const r = nodeRect(node);
          const fs = toScreen(r.x, r.y);
          const w = r.w * graphZoom;
          const h = (node.kind === 'group' ? node.h ?? 300 : 44) * graphZoom;
          if (sx >= fs.x && sx <= fs.x + w && sy >= fs.y && sy <= fs.y + h) {
            if (f.id === linking.fromFilterId) {
              // 拖回自身 → periodic 心跳自环
              addSequenceEdge(group.id, f.id, f.id, 1000, {
                kind: 'periodic',
                periodMs: 1000,
              });
            } else if (multiKind) {
              // AND/OR：把「已有同 from 的对目标边」升级为多目标，或新建
              addSequenceEdge(group.id, linking.fromFilterId, f.id, 1000, {
                kind: multiKind,
                toFilterIds: [f.id],
              });
            } else {
              addSequenceEdge(group.id, linking.fromFilterId, f.id);
            }
            break;
          }
        }
      }
      setLinking(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [linking, memberFilters, graphNodes, graphZoom, toScreen, addSequenceEdge, group]);

  /** 连线模式下从节点右缘开始拖线 */
  const startLinkDrag = (e: React.MouseEvent, fid: string) => {
    e.preventDefault(); // 阻止原生拖拽
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLinking({
      fromFilterId: fid,
      cur: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    });
  };

  // 滚轮缩放
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newZoom = Math.max(0.2, Math.min(3, graphZoom * factor));
      const wx = (mx - graphPan.x) / graphZoom;
      const wy = (my - graphPan.y) / graphZoom;
      setGraphPan(mx - wx * newZoom, my - wy * newZoom);
      setGraphZoom(newZoom);
    },
    [graphZoom, graphPan, setGraphPan, setGraphZoom],
  );

  // 全局拖拽处理
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (dragging.kind === 'pan') {
        const dx = sx - (dragging.startScreen?.x ?? 0);
        const dy = sy - (dragging.startScreen?.y ?? 0);
        setGraphPan((dragging.startPan?.x ?? 0) + dx, (dragging.startPan?.y ?? 0) + dy);
        return;
      }
      // palette / node 拖拽：实时更新坐标（node）
      if (dragging.kind === 'node' && dragging.nodeId) {
        const w = toWorld(sx, sy);
        const nx = w.x - (dragging.offset?.x ?? 0);
        const ny = w.y - (dragging.offset?.y ?? 0);
        setNodePos(dragging.nodeId, nx, ny);
      }
      if (
        Math.abs(sx - (dragging.startScreen?.x ?? 0)) > 2 ||
        Math.abs(sy - (dragging.startScreen?.y ?? 0)) > 2
      ) {
        if (!dragging.moved) setDragging({ ...dragging, moved: true });
      }
    };
    const onUp = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect && dragging) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        // 整个画布即 group 区域：落在画布边界内即归属，拖出画布外即脱离
        const insideCanvas = sx >= 0 && sx <= rect.width && sy >= 0 && sy <= rect.height;
        if (dragging.kind === 'palette' && dragging.filterId) {
          if (insideCanvas) {
            // 从调色板拖入画布 → 加入该组 + 落点生成节点坐标
            const wasMember = group?.filterIds.includes(dragging.filterId) ?? false;
            addFilterToGroup(dragging.filterId, groupId);
            if (!wasMember) {
              // 落点世界坐标（节点中心对齐鼠标）
              const w = toWorld(sx, sy);
              setNodePos(dragging.filterId, w.x - 80, w.y - 18);
            }
          }
        } else if (dragging.kind === 'node' && dragging.moved && dragging.filterId) {
          if (!insideCanvas) {
            // 拖出画布 → 从该组移除
            removeFilterFromGroup(dragging.filterId, groupId);
          }
        }
      }
      setDragging(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, toWorld, toScreen, setNodePos, setGraphPan, groupId, group, addFilterToGroup, removeFilterFromGroup]);

  // 调色板拖拽起始
  const startPaletteDrag = (e: React.MouseEvent, fid: string) => {
    e.preventDefault(); // 阻止原生文本/元素拖拽，避免吞掉 mousemove/mouseup
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    setDragging({ kind: 'palette', filterId: fid, startScreen: { x: sx, y: sy }, moved: false });
  };

  // 已有节点拖拽起始
  const startNodeDrag = (e: React.MouseEvent, fid: string) => {
    e.preventDefault(); // 阻止原生拖拽
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = toWorld(sx, sy);
    const node = graphNodes[fid];
    const offset = { x: w.x - (node?.x ?? 0), y: w.y - (node?.y ?? 0) };
    setDragging({ kind: 'node', filterId: fid, nodeId: fid, offset, startScreen: { x: sx, y: sy }, moved: false });
  };

  // 空白平移
  const startPan = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault(); // 防止画布空白处的原生拖拽/选中
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    setDragging({ kind: 'pan', startScreen: { x: sx, y: sy }, startPan: { ...graphPan }, moved: false });
  };

  if (!group) {
    return (
      <div className={styles.overlay}>
        <div className={styles.toolbar}>
        <button className="ghost" onClick={() => setActiveGroup(null)}><ChevronLeft size={14} /> 返回</button>
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
        <button className="ghost" onClick={() => setActiveGroup(null)} title="关闭分组编辑，回到数据视图"><X size={14} /> 关闭</button>
      </div>
      <div className={styles.editorLayout}>
        {/* 左侧 filter 调色板 */}
        <aside className={styles.palette}>
          <div className={styles.paletteHeader}>过滤器列表</div>
          <div className={styles.paletteHint}>已归属高亮 · 拖入画布添加</div>
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
                  onMouseDown={(e) => startPaletteDrag(e, f.id)}
                  onClick={(e) => { e.stopPropagation(); }}
                >
                  <span className={styles.paletteDot} style={{ background: f.color }} />
                  <span className={styles.paletteLabel}>{f.label}</span>
                  <span className={styles.paletteCount}>{matchCount(f.id)}</span>
                  {isMember && <span className={styles.paletteCheck}><Check size={13} /></span>}
                </div>
              );
            })}
            {filters.length === 0 && (
              <div className={styles.emptyHint}>暂无 filter</div>
            )}
          </div>
        </aside>

        {/* 中间画布——整个画布即 group 区域 */}
        <div
          ref={containerRef}
          className={[styles.canvas, styles.canvasIsGroup].filter(Boolean).join(' ')}
          style={{ borderLeftColor: group.color }}
          onMouseDown={startPan}
          onWheel={onWheel}
        >
          {/* 画布标题条 */}
          <div className={styles.canvasTitle} style={{ background: group.color }}>
            <span>{group.label}</span>
            <span className={styles.groupCount}>{group.filterIds.length}</span>
          </div>

          {/* 序列边 SVG 层（pointer-events 只开在边线上） */}
          <svg className={styles.edgeLayer}>
            <defs>
              <marker
                id="seq-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="context-stroke" />
              </marker>
            </defs>
            {seqEdges.map((edge) => {
              const kind = edge.kind ?? 'seq';
              const fromFilter = filters.find((f) => f.id === edge.fromFilterId);
              const st = edgeStat(edge.id);
              const total = (st?.matchedCount ?? 0) + (st?.missCount ?? 0);
              const rate = total > 0 ? Math.round((st!.matchedCount / total) * 100) : null;
              const hasMiss = (st?.missCount ?? 0) > 0;

              // ---- periodic 自环：节点右缘绕出小圆环回到自身 ----
              if (kind === 'periodic') {
                const node = graphNodes[edge.fromFilterId];
                if (!node) return null;
                const r = nodeRect(node);
                const right = toScreen(r.x + r.w, r.y + r.h / 2);
                const cx = right.x + 22;
                const cy = right.y;
                const hb = seqResult?.heartbeats.find(
                  (h) => h.filterId === edge.fromFilterId,
                );
                const gapN = hb?.gaps.length ?? 0;
                const jitN = hb?.jitters.length ?? 0;
                return (
                  <g key={edge.id} className={styles.edgeGroup}>
                    <circle
                      className={styles.edgeLoop}
                      style={{ stroke: fromFilter?.color ?? undefined }}
                      cx={cx}
                      cy={cy}
                      r="14"
                    />
                    <text
                      className={styles.edgeLabel}
                      x={cx}
                      y={cy - 18}
                      textAnchor="middle"
                      onClick={() => setEditingEdge(edge)}
                    >
                      ♥ {formatGap(edge.periodMs ?? edge.maxGapMs)} ±{formatGap(edge.maxGapMs)}
                      {gapN + jitN > 0 ? ` · ⚠${gapN} ⚡${jitN}` : ''}
                    </text>
                    <g
                      className={styles.edgeDeleteBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSequenceEdge(group.id, edge.id);
                      }}
                    >
                      <title>删除心跳约束</title>
                      <circle cx={cx} cy={cy} r="8" />
                      <path
                        d={`M ${cx - 3} ${cy - 3} L ${cx + 3} ${cy + 3} M ${cx - 3} ${cy + 3} L ${cx + 3} ${cy - 3}`}
                      />
                    </g>
                  </g>
                );
              }

              // ---- 普通边（seq / not / and / or）：源点 + 目标点集合 ----
              const p1 = sourcePoint(edge.fromFilterId);
              if (!p1) return null;
              const targets = edgeTargets(edge);
              const pts = targets
                .map((t) => targetPoint(t))
                .filter((p): p is { x: number; y: number } => !!p);
              if (pts.length === 0) return null;
              const isNot = kind === 'not';
              const vCount = isNot ? violationCount(edge.id) : 0;

              return (
                <g key={edge.id} className={styles.edgeGroup}>
                  {pts.map((p2, ti) => {
                    // 三次贝塞尔：控制点水平外扩
                    const dx = Math.max(40, (p2.x - p1.x) / 2);
                    const cx1 = p1.x + dx;
                    const cx2 = p2.x - dx;
                    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                    const d = `M ${p1.x} ${p1.y} C ${cx1} ${p1.y}, ${cx2} ${p2.y}, ${p2.x} ${p2.y}`;
                    return (
                      <g key={ti}>
                        <path className={styles.edgeHit} d={d} />
                        <path
                          className={
                            isNot
                              ? styles.edgePathNot
                              : hasMiss
                                ? styles.edgePathMiss
                                : styles.edgePath
                          }
                          style={
                            isNot ? undefined : { stroke: fromFilter?.color ?? undefined }
                          }
                          markerEnd={isNot ? undefined : 'url(#seq-arrow)'}
                          d={d}
                        />
                        {/* 多支时每支中点也放小 ×（主 × 放首支） */}
                        {ti > 0 && (
                          <g
                            className={styles.edgeDeleteBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSequenceEdge(group.id, edge.id);
                            }}
                          >
                            <title>切断连线</title>
                            <circle cx={mid.x} cy={mid.y} r="7" />
                            <path
                              d={`M ${mid.x - 2.5} ${mid.y - 2.5} L ${mid.x + 2.5} ${mid.y + 2.5} M ${mid.x - 2.5} ${mid.y + 2.5} L ${mid.x + 2.5} ${mid.y - 2.5}`}
                            />
                          </g>
                        )}
                      </g>
                    );
                  })}
                  {/* 主标签 + 主 ×：放首支中点 */}
                  {(() => {
                    const p2 = pts[0];
                    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                    const kindLabel =
                      kind === 'and' ? 'AND' : kind === 'or' ? 'OR' : isNot ? '⃠' : '';
                    return (
                      <>
                        <text
                          className={styles.edgeLabel}
                          x={mid.x}
                          y={mid.y - 12}
                          textAnchor="middle"
                          onClick={() => setEditingEdge(edge)}
                        >
                          {kindLabel}
                          {kindLabel ? ' ' : ''}
                          {formatGap(edge.maxGapMs)}
                          {isNot
                            ? ` · ${vCount} 违规`
                            : rate !== null
                              ? ` · ${rate}%`
                              : ''}
                        </text>
                        <g
                          className={styles.edgeDeleteBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSequenceEdge(group.id, edge.id);
                          }}
                        >
                          <title>切断连线</title>
                          <circle cx={mid.x} cy={mid.y} r="8" />
                          <path
                            d={`M ${mid.x - 3} ${mid.y - 3} L ${mid.x + 3} ${mid.y + 3} M ${mid.x - 3} ${mid.y + 3} L ${mid.x + 3} ${mid.y - 3}`}
                          />
                        </g>
                      </>
                    );
                  })()}
                </g>
              );
            })}
            {/* 连线模式橡皮筋 */}
            {linking &&
              (() => {
                const node = graphNodes[linking.fromFilterId];
                if (!node) return null;
                const r = nodeRect(node);
                const p1 = toScreen(r.x + r.w, r.y + r.h / 2);
                return (
                  <line
                    className={styles.edgeRubber}
                    x1={p1.x}
                    y1={p1.y}
                    x2={linking.cur.x}
                    y2={linking.cur.y}
                  />
                );
              })()}
          </svg>

          {/* filter 实体直接铺在画布上 */}
          {memberFilters.map((f) => {
            const node = graphNodes[f.id];
            if (!node) return null;
            const r = nodeRect(node);
            const fs = toScreen(r.x, r.y);
            const chained = chainedCount(f.id);
            return (
              <div
                key={f.id}
                className={styles.filterNode}
                style={{ left: fs.x, top: fs.y, width: r.w * graphZoom, borderLeftColor: f.color }}
                onMouseDown={(e) => startNodeDrag(e, f.id)}
              >
                <span className={styles.filterDot} style={{ background: f.color }} />
                <span className={styles.filterLabel} style={{ opacity: f.enabled ? 1 : 0.4 }}>{f.label}</span>
                <span className={styles.filterCount}>{matchCount(f.id)}</span>
                {chained > 0 && (
                  <span className={styles.chainBadge} title="被完整链消耗的事件数">
                    ⛓{chained}
                  </span>
                )}
                <button
                  className={styles.filterRemoveBtn}
                  title={`从「${group.label}」移出`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); removeFilterFromGroup(f.id, group.id); }}
                >
                  <X size={12} />
                </button>
                {/* 右缘连线热区：从这里按下拖出即建序列边 */}
                <span
                  className={styles.nodeLinkHandle}
                  title="拖出连线到目标节点，声明 A→B 时序约束"
                  onMouseDown={(e) => startLinkDrag(e, f.id)}
                />
              </div>
            );
          })}
          {memberFilters.length === 0 && (
            <div className={styles.emptyHint}>从左侧拖入 filter 到画布即归属该组</div>
          )}
          {filters.length === 0 && (
            <div className={styles.emptyHint}>暂无 filter</div>
          )}
        </div>
      </div>

      {/* 序列边编辑弹窗 */}
      {editingEdge && group && (
        <EdgeEditModal
          groupId={group.id}
          edge={editingEdge}
          fromLabel={
            filters.find((f) => f.id === editingEdge.fromFilterId)?.label ??
            editingEdge.fromFilterId
          }
          toLabel={
            filters.find((f) => f.id === editingEdge.toFilterId)?.label ??
            editingEdge.toFilterId
          }
          memberTargets={memberFilters
            .filter((f) => f.id !== editingEdge.fromFilterId)
            .map((f) => ({ id: f.id, label: f.label }))}
          stat={edgeStat(editingEdge.id)}
          violationCount={violationCount(editingEdge.id)}
          onClose={() => setEditingEdge(null)}
        />
      )}
    </div>
  );
}

/* ============================================================
 * 序列边编辑弹窗：时间窗 maxGapMs 编辑 + 删除
 * ========================================================== */

function EdgeEditModal(props: {
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
          {/* 类型切换 */}
          <div className={styles.edgeEditRow}>
            <label className={styles.edgeEditLabel}>约束类型</label>
            <select
              className={styles.edgeEditSelect}
              value={kind}
              onChange={(e) => {
                const k = e.target.value as SequenceEdge['kind'];
                setKind(k);
                if (k === 'periodic') {
                  // 自环：目标 = from 自身
                  setTargets([edge.fromFilterId]);
                }
              }}
            >
              {(['seq', 'not', 'and', 'or', 'periodic'] as const).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          {/* periodic：周期 + 容差 */}
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
                {kind === 'not'
                  ? `（窗口内出现禁止目标即违规）`
                  : `（目标须在 ${fromLabel} 之后此窗口内出现）`}
              </span>
            </div>
          )}

          {/* and/or：目标多选 */}
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
                            e.target.checked
                              ? [...prev, t.id]
                              : prev.filter((x) => x !== t.id),
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

          {/* 统计 */}
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

  const filter = useMemo(
    () => filters.find((f) => f.id === editingFilterId) ?? null,
    [filters, editingFilterId],
  );

  const onClose = useCallback(() => setEditingFilterId(null), [setEditingFilterId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!filter) return null;

  const regexError = filter.isRegex ? FilterEngine.validateRegex(filter.pattern) : null;

  return (
    <>
      <div className={styles.modalBackdrop} onClick={onClose} />
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>编辑过滤器</span>
          <button className="ghost" onClick={onClose}><X size={14} /></button>
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

          <input
            className={`${styles.patternInput} mono`}
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
          <button className="ghost" onClick={() => { removeFilter(filter.id); onClose(); }}>
            删除过滤器
          </button>
          <button className="primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </>
  );
}
