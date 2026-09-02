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
import type { FilterGroup, NodePos } from '../types';
import styles from './NodeCanvasView.module.css';

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

  const groupId = activeGroupId ?? '';
  const group = groups.find((g) => g.id === groupId);
  const containerRef = useRef<HTMLDivElement>(null);

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
            // 从调色板拖入画布 → 加入该组
            addFilterToGroup(dragging.filterId, groupId);
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
  }, [dragging, toWorld, toScreen, setNodePos, setGraphPan, groupId, addFilterToGroup, removeFilterFromGroup]);

  // 调色板拖拽起始
  const startPaletteDrag = (e: React.MouseEvent, fid: string) => {
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    setDragging({ kind: 'palette', filterId: fid, startScreen: { x: sx, y: sy }, moved: false });
  };

  // 已有节点拖拽起始
  const startNodeDrag = (e: React.MouseEvent, fid: string) => {
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
          <button className="ghost" onClick={() => setActiveGroup(null)}>← 返回</button>
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
        <div style={{ flex: 1 }} />
        <input
          className={`${styles.labelInput} mono`}
          type="text"
          value={group.label}
          onChange={(e) => updateGroup(group.id, { label: e.target.value })}
          placeholder="分组名称"
        />
        <span className={styles.hint}>从左侧拖 filter 到画布即归属 · 拖出画布即脱离 · 滚轮缩放 · 空白拖拽平移</span>
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setActiveGroup(null)} title="关闭分组编辑，回到数据视图">✕ 关闭</button>
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
                  {isMember && <span className={styles.paletteCheck}>✓</span>}
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
          {/* filter 实体直接铺在画布上 */}
          {memberFilters.map((f) => {
            const node = graphNodes[f.id];
            if (!node) return null;
            const r = nodeRect(node);
            const fs = toScreen(r.x, r.y);
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
                <button
                  className={styles.filterRemoveBtn}
                  title={`从「${group.label}」移出`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); removeFilterFromGroup(f.id, group.id); }}
                >
                  ×
                </button>
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
    </div>
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
          <button className="ghost" onClick={onClose}>✕</button>
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
