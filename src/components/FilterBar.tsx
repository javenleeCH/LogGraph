import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogStore, selectEventCount } from '../store/logStore';
import { FilterEngine } from '../filters/FilterEngine';
import { isRegexWasmFallback } from '../filters/regexWasm';
import type { Filter, FilterGroup } from '../types';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  X,
  ArrowRight,
  ArrowUturnLeft,
  Plus,
} from './Icon';
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
  const groups = useLogStore((s) => s.groups);
  const addFilterToGroup = useLogStore((s) => s.addFilterToGroup);
  const removeFilterFromGroup = useLogStore((s) => s.removeFilterFromGroup);
  const editorRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 定位弹出框，确保不溢出视口
  useEffect(() => {
    const pw = 320;
    const ph = 280;
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
  // 引擎统一后（wasm Rust regex = 桌面引擎），仅在 wasm 加载失败回退 JS 时提示
  const wasmFallback = filter.isRegex && isRegexWasmFallback();

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

        {wasmFallback && (
          <div className={styles.warn}>
            ⚠ WASM 正则引擎未加载，当前使用 JS 正则兜底，结果可能与桌面端不一致。
            刷新页面或检查网络后重试。
          </div>
        )}

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

        {/* 归属分组选择（多选：一个 filter 可同时归属多个 group） */}
        <div className={styles.toggles}>
          <div className={styles['group-select-wrap']}>
            <span className={styles['group-select-label']}>分组</span>
            {groups.length === 0 ? (
              <span className={styles['group-select-empty']}>无可用分组</span>
            ) : (
              <div className={styles['group-checkbox-list']}>
                {groups.map((g) => {
                  const checked = g.filterIds.includes(filter.id);
                  return (
                    <label
                      key={g.id}
                      className={styles['group-checkbox-item']}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            addFilterToGroup(filter.id, g.id);
                          } else {
                            removeFilterFromGroup(filter.id, g.id);
                          }
                        }}
                      />
                      <span
                        className={styles['group-color-dot']}
                        style={{ background: g.color }}
                      />
                      <span className={styles['group-checkbox-label']}>
                        {g.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
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

/** 单个 filter chip（可拖拽到 group） */
function FilterChip({
  filter,
  count,
  hasSelected,
  onOpen,
  onToggle,
  onJump,
}: {
  filter: Filter;
  count: number;
  hasSelected: boolean;
  onOpen: (e: React.MouseEvent) => void;
  onToggle: (e: React.MouseEvent) => void;
  onJump: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={[
        styles.chip,
        !filter.enabled ? styles.disabled : '',
        hasSelected ? styles.active : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onOpen}
      title="点击编辑，拖拽到分组标题归组"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/filterId', filter.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <span
        className={styles.dot}
        style={{ background: filter.color }}
        onClick={onToggle}
        title={filter.enabled ? '点击禁用' : '点击启用'}
      />
      <span className={styles.name}>{filter.label}</span>
      <span className={styles.count}>{count}</span>
      {count > 0 && (
        <button className={styles.toggle} onClick={onJump} title="跳到首个匹配">
          <ArrowRight size={12} />
        </button>
      )}
    </div>
  );
}

/** group 标题 chip（点击弹出详情 / 箭头折叠 / 眼睛显隐 / × 删除 / drop target） */
function GroupHeaderChip({
  group,
  childCount,
  onToggle,
  onRemove,
  onShowDetails,
}: {
  group: FilterGroup;
  childCount: number;
  onToggle: () => void;
  onRemove: () => void;
  onShowDetails: (e: React.MouseEvent) => void;
}) {
  const addFilterToGroup = useLogStore((s) => s.addFilterToGroup);
  const toggleGroupVisible = useLogStore((s) => s.toggleGroupVisible);
  const [dragover, setDragover] = useState(false);
  const hidden = group.visible === false;
  return (
    <div
      className={[
        styles.chip,
        styles['group-chip'],
        dragover ? styles.dragover : '',
        hidden ? styles['group-hidden'] : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onShowDetails}
      title="点击查看组内匹配项"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/filterid')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragover(true);
        }
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        const fid = e.dataTransfer.getData('text/filterId');
        setDragover(false);
        if (fid) {
          e.preventDefault();
          addFilterToGroup(fid, group.id);
        }
      }}
      style={{ borderLeft: `3px solid ${group.color}` }}
    >
      <span
        className={styles['group-arrow']}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title={group.collapsed ? '点击展开' : '点击折叠'}
      >
        {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </span>
      <span className={styles.name}>{group.label}</span>
      <span className={styles.count}>{childCount}</span>
      <button
        className={styles.toggle}
        onClick={(e) => {
          e.stopPropagation();
          toggleGroupVisible(group.id);
        }}
        title={hidden ? '点击显示该组' : '点击隐藏该组'}
      >
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      <button
        className={styles.toggle}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="删除分组（组内过滤器移至顶层）"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** 点击 group 头弹出的详情下拉框 */
function GroupDetailsPopover({
  group,
  anchor,
  onClose,
}: {
  group: FilterGroup;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const filters = useLogStore((s) => s.filters);
  const matches = useLogStore((s) => s.matches);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const toggleGroupCollapsed = useLogStore((s) => s.toggleGroupCollapsed);
  const toggleGroupVisible = useLogStore((s) => s.toggleGroupVisible);
  const removeFilterFromGroup = useLogStore((s) => s.removeFilterFromGroup);
  const updateGroup = useLogStore((s) => s.updateGroup);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [renameMode, setRenameMode] = useState(false);
  const [renameVal, setRenameVal] = useState(group.label);
  const [colorVal, setColorVal] = useState(group.color);

  const children = group.filterIds
    .map((fid) => filters.find((f) => f.id === fid))
    .filter((f): f is Filter => !!f);
  const totalCount = children.reduce((sum, f) => {
    const m = matches.find((mm) => mm.filterId === f.id);
    return sum + (m?.events.length ?? 0);
  }, 0);

  // 定位弹出框
  useEffect(() => {
    const pw = 280;
    const ph = 260;
    let left = anchor.x;
    let top = anchor.y + 8;
    if (left + pw > window.innerWidth) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight) top = anchor.y - ph - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [anchor]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (!pos) return null;

  const commitRename = () => {
    const label = renameVal.trim() || group.label;
    const color = colorVal || group.color;
    if (label !== group.label || color !== group.color) {
      updateGroup(group.id, { label, color });
    }
    setRenameMode(false);
  };

  return (
    <div
      ref={popRef}
      className={styles['group-popover']}
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 头部：组名 + 颜色 + 折叠按钮 */}
      <div className={styles['group-popover-head']}>
        <span
          className={styles.dot}
          style={{ background: group.color, cursor: 'pointer' }}
          onClick={() => setRenameMode((v) => !v)}
          title="点击改名/改色"
        />
        {renameMode ? (
          <>
            <input
              className={`${styles['label-input']} mono`}
              type="text"
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setRenameVal(group.label);
                  setColorVal(group.color);
                  setRenameMode(false);
                }
              }}
              placeholder="组名"
              autoFocus
              style={{ flex: 1, minWidth: 0 }}
            />
            <input
              className={styles['color-pick']}
              type="color"
              value={colorVal}
              onChange={(e) => setColorVal(e.target.value)}
              title="组色"
              style={{ width: 22, height: 22 }}
            />
            <button
              className="primary"
              style={{ padding: '2px 8px', fontSize: 11 }}
              onClick={commitRename}
            >
              确定
            </button>
          </>
        ) : (
          <span className={styles['group-popover-title']}>{group.label}</span>
        )}
        <span
          className={styles['group-arrow']}
          onClick={() => {
            toggleGroupCollapsed(group.id);
            onClose();
          }}
          title={group.collapsed ? '展开' : '折叠'}
        >
          {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className={styles['group-arrow-text']}>{group.collapsed ? '展开' : '折叠'}</span>
        </span>
        <span
          className={styles['group-arrow']}
          onClick={() => toggleGroupVisible(group.id)}
          title={group.visible === false ? '显示该组' : '隐藏该组'}
        >
          {group.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
          <span className={styles['group-arrow-text']}>{group.visible === false ? '显示' : '隐藏'}</span>
        </span>
      </div>

      {/* 汇总 */}
      <div className={styles['group-popover-summary']}>
        {children.length} 个过滤器 · {totalCount} 个匹配事件
      </div>

      {/* 子过滤器列表 */}
      <div className={styles['group-popover-list']}>
        {children.length === 0 ? (
          <div className={styles['group-popover-empty']}>
            暂无子过滤器，拖拽 filter 到组头即可归入
          </div>
        ) : (
          children.map((f) => {
            const m = matches.find((mm) => mm.filterId === f.id);
            const cnt = m?.events.length ?? 0;
            return (
              <div key={f.id} className={styles['group-popover-item']}>
                <span
                  className={styles.dot}
                  style={{ background: f.color }}
                  title={f.enabled ? '已启用' : '已禁用'}
                />
                <span
                  className={styles['group-popover-item-name']}
                  style={{ opacity: f.enabled ? 1 : 0.4 }}
                >
                  {f.label}
                </span>
                <span className={styles.count}>{cnt}</span>
                {cnt > 0 && (
                  <button
                    className={styles.toggle}
                    title="跳到首个匹配"
                    onClick={() => {
                      selectEvent(m!.events[0].id);
                      onClose();
                    }}
                  >
                    <ArrowRight size={12} />
                  </button>
                )}
                <button
                  className={styles.toggle}
                  title="移出该分组"
                  onClick={() => {
                    removeFilterFromGroup(f.id, group.id);
                  }}
                >
                  <ArrowUturnLeft size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 新建分组弹窗（命名 + 选色） */
function GroupCreateModal({
  anchor,
  onClose,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const addGroup = useLogStore((s) => s.addGroup);
  const modalRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#7c5cff');

  useEffect(() => {
    const pw = 280;
    const ph = 200;
    let left = anchor.x;
    let top = anchor.y + 8;
    if (left + pw > window.innerWidth) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight) top = anchor.y - ph - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node))
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (!pos) return null;

  const submit = () => {
    const name = label.trim() || `Group ${Date.now() % 1000}`;
    addGroup({ label: name, color });
    onClose();
  };

  return (
    <div
      ref={modalRef}
      className={styles['group-popover']}
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles['group-popover-head']}>
        <span className={styles['group-popover-title']}>新建分组</span>
      </div>
      <div className={styles.row}>
        <input
          className={styles['color-pick']}
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="组色"
          style={{ width: 28, height: 28 }}
        />
        <input
          className={`${styles['label-input']} mono`}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="组名（如 Net、IO、CPU）"
          autoFocus
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
      <div className={styles.actions}>
        <button className="ghost" onClick={onClose}>
          取消
        </button>
        <button className="primary" onClick={submit}>
          创建
        </button>
      </div>
    </div>
  );
}

export function FilterBar() {
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const addFilter = useLogStore((s) => s.addFilter);
  const removeGroup = useLogStore((s) => s.removeGroup);
  const toggleGroupCollapsed = useLogStore((s) => s.toggleGroupCollapsed);
  const updateFilter = useLogStore((s) => s.updateFilter);
  const eventCount = useLogStore(selectEventCount);
  const matches = useLogStore((s) => s.matches);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [groupDetailsId, setGroupDetailsId] = useState<string | null>(null);
  const [groupAnchor, setGroupAnchor] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [createAnchor, setCreateAnchor] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  const editingFilter = filters.find((f) => f.id === editingId) ?? null;

  const openEditor = (id: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: rect.left + rect.width / 2, y: rect.bottom });
    setEditingId(id);
  };

  const openGroupDetails = (gid: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setGroupAnchor({ x: rect.left, y: rect.bottom });
    setGroupDetailsId((prev) => (prev === gid ? null : gid));
  };

  const openCreateGroup = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCreateAnchor({ x: rect.left, y: rect.bottom });
    setCreatingGroup(true);
  };

  // 多对多：每个 filter 在「第一个可见且包含它的 group」里渲染，避免重复。
  // 预计算每个 filter 的首选可见组 id（无可见组则 null → 归顶层）
  const firstVisibleGroupOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const f of filters) {
      let assigned: string | null = null;
      for (const g of groups) {
        if (g.visible === false) continue;
        if (g.filterIds.includes(f.id)) {
          assigned = g.id;
          break;
        }
      }
      map.set(f.id, assigned);
    }
    return map;
  }, [filters, groups]);

  // 分组内 filter：仅渲染首选可见组 === 本组 的 filter（跳过已删除的）
  const childFiltersOf = (gid: string) => {
    const g = groups.find((gg) => gg.id === gid);
    if (!g || g.visible === false) return [];
    return g.filterIds
      .map((fid) => filters.find((f) => f.id === fid))
      .filter((f): f is Filter => !!f)
      .filter((f) => firstVisibleGroupOf.get(f.id) === gid);
  };
  // 预计算所有 group（含隐藏）引用的 filter id 集合
  // → 隐藏组独占的 filter 不回流到顶层，实现"真隐藏"
  const allReferenced = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) {
      for (const fid of g.filterIds) s.add(fid);
    }
    return s;
  }, [groups]);
  // 顶层 filter = 不被任何 group 引用的 filter
  const topFilters = filters.filter((f) => !allReferenced.has(f.id));

  // 渲染单个 filter chip 的辅助
  const renderFilter = (f: Filter, indented: boolean) => {
    const match = matches.find((m) => m.filterId === f.id);
    const count = match?.events.length ?? 0;
    const hasSelected =
      selectedEventId !== null &&
      (match?.events.some((ev) => ev.id === selectedEventId) ?? false);
    return (
      <div
        key={f.id}
        className={indented ? styles['chip-indented'] : undefined}
      >
        <FilterChip
          filter={f}
          count={count}
          hasSelected={hasSelected}
          onOpen={(e) => openEditor(f.id, e)}
          onToggle={(e) => {
            e.stopPropagation();
            updateFilter(f.id, { enabled: !f.enabled });
          }}
          onJump={(e) => {
            e.stopPropagation();
            selectEvent(match!.events[0].id);
          }}
        />
      </div>
    );
  };

  return (
    <div className={styles.bar}>
      <span className={styles.label}>过滤</span>
      <div className={styles.chips}>
        {filters.length === 0 && groups.length === 0 ? (
          <span className={styles.empty}>
            {eventCount === 0 ? '加载日志后添加过滤器' : '点击 + 添加过滤器'}
          </span>
        ) : (
          <>
            {/* 按 group 分段：隐藏的 group 保留头（可重新显示），子 filter 不在此渲染而回流到顶层/其它可见组 */}
            {groups.map((g) => {
              const children = childFiltersOf(g.id);
              const hidden = g.visible === false;
              return (
                <div key={g.id} className={styles['group-segment']}>
                  <GroupHeaderChip
                    group={g}
                    childCount={g.filterIds.length}
                    onToggle={() => toggleGroupCollapsed(g.id)}
                    onRemove={() => removeGroup(g.id)}
                    onShowDetails={(e) => openGroupDetails(g.id, e)}
                  />
                  {!g.collapsed &&
                    !hidden &&
                    children.map((f) => renderFilter(f, true))}
                </div>
              );
            })}
            {/* 顶层 filter：不被任何可见 group 引用的（含被隐藏 group 独占的 filter） */}
            {topFilters.map((f) => renderFilter(f, false))}
          </>
        )}
      </div>
      <button
        className={styles.addBtn}
        onClick={() => addFilter()}
        disabled={eventCount === 0}
      >
        <Plus size={12} /> 过滤
      </button>
      <button
        className={styles.addBtn}
        onClick={openCreateGroup}
        disabled={eventCount === 0}
        title="新建分组（类比 Perfetto 进程）"
      >
        <Plus size={12} /> 组
      </button>

      {editingFilter && (
        <FilterEditor
          filter={editingFilter}
          anchor={anchor}
          onClose={() => setEditingId(null)}
        />
      )}
      {creatingGroup && (
        <GroupCreateModal
          anchor={createAnchor}
          onClose={() => setCreatingGroup(false)}
        />
      )}
      {groupDetailsId &&
        (() => {
          const g = groups.find((gg) => gg.id === groupDetailsId);
          if (!g) return null;
          return (
            <GroupDetailsPopover
              group={g}
              anchor={groupAnchor}
              onClose={() => setGroupDetailsId(null)}
            />
          );
        })()}
    </div>
  );
}
