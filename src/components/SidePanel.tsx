/**
 * 左侧栏两段可折叠区块：
 * - 上：日志文件树（FileTreePanel）
 * - 下：过滤器树（分组=文件夹，filter=文件；顶层 filter 平铺在分组之后）
 *
 * 过滤器树：
 * - Group 行：文件夹 icon + 折叠箭头，展开列出组内 filter（缩进）
 * - Filter 行：文档 icon，支持复制（落回源分组）、拖拽进分组（HTML5 DnD）
 * - 一个 filter 可属于多个分组（多对多），在每个分组下各出现一次
 * - 「顶层」= 不属于任何分组的 filter
 */
import { useState, useMemo, useRef, useEffect } from 'react';
import { useLogStore } from '../store/logStore';
import { FileTreePanel } from './FileTreePanel';
import { removeFilterWithUndo, removeGroupWithUndo } from '../store/undoable';
import type { Filter, FilterGroup } from '../types';
import {
  ChevronRight,
  ChevronDown,
  Rename,
  Edit,
  Eye,
  EyeOff,
  X,
  Filter as FilterIcon,
  FolderTree,
  Folder,
  FolderOpen,
  Funnel,
  NewFile,
  NewFolder,
  Copy,
  Trash,
} from './Icon';
import styles from './SidePanel.module.css';

type SectionKey = 'files' | 'filters';

/** 拖拽 filter 用的 dataTransfer MIME 键 */
const FILTER_DRAG_TYPE = 'application/x-loggraph-filter';

export function SidePanel() {
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const matches = useLogStore((s) => s.matches);
  const addGroup = useLogStore((s) => s.addGroup);
  const addFilter = useLogStore((s) => s.addFilter);
  const addFilterToGroup = useLogStore((s) => s.addFilterToGroup);
  const setActiveGroup = useLogStore((s) => s.setActiveGroup);
  const setEditingFilterId = useLogStore((s) => s.setEditingFilterId);
  const updateGroup = useLogStore((s) => s.updateGroup);
  const toggleGroupVisible = useLogStore((s) => s.toggleGroupVisible);

  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    files: false,
    filters: false,
  });
  /** 树形分组展开态（与时间线的 group.collapsed 轨道折叠语义无关，仅本栏） */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** 拖拽悬停的目标分组 id（高亮用） */
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  const toggle = (k: SectionKey) =>
    setCollapsed((prev) => ({ ...prev, [k]: !prev[k] }));

  const toggleExpanded = (gid: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });

  const matchCount = useMemo(
    () => (fid: string) => matches.find((m) => m.filterId === fid)?.events.length ?? 0,
    [matches],
  );

  /** 分组展开/新建时默认全展开 */
  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = new Set(groups.map((g) => g.id));
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [groups]);

  /** 顶层 filter：不属于任何分组 */
  const topLevelFilters = useMemo(
    () => filters.filter((f) => !groups.some((g) => g.filterIds.includes(f.id))),
    [filters, groups],
  );

  const dropOnGroup = (e: React.DragEvent, gid: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverGroup(null);
    const fid = e.dataTransfer.getData(FILTER_DRAG_TYPE);
    if (fid) addFilterToGroup(fid, gid);
  };

  return (
    <div className={styles.sidePanel}>
      {/* ── 上：文件树 ── */}
      <section className={`${styles.section} ${collapsed.files ? styles.collapsed : ''}`}>
        <header className={styles.sectionHeader} onClick={() => toggle('files')}>
          <span className={styles.caret}>
            {collapsed.files ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <FolderTree size={13} className={styles.sectionIcon} />
          <span className={styles.sectionTitle}>日志文件</span>
        </header>
        {!collapsed.files && (
          <div className={styles.sectionBody}>
            <FileTreePanel />
          </div>
        )}
      </section>

      {/* ── 下：过滤器树（分组=文件夹 + filter=文件） ── */}
      <section className={`${styles.section} ${collapsed.filters ? styles.collapsed : ''}`}>
        <header className={styles.sectionHeader} onClick={() => toggle('filters')}>
          <span className={styles.caret}>
            {collapsed.filters ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <FilterIcon size={13} className={styles.sectionIcon} />
          <span className={styles.sectionTitle}>过滤器</span>
          <span className={styles.sectionCount}>{filters.length}</span>
          <div className={styles.spacer} />
          <button
            className={styles.addBtn}
            title="新建分组（文件夹）"
            onClick={(e) => {
              e.stopPropagation();
              addGroup({});
            }}
          >
            <NewFolder size={14} />
          </button>
          <button
            className={styles.addBtn}
            title="新建过滤器"
            onClick={(e) => {
              e.stopPropagation();
              const id = addFilter({});
              setEditingFilterId(id);
            }}
          >
            <NewFile size={14} />
          </button>
        </header>
        {!collapsed.filters && (
          <div className={styles.sectionBody}>
            {groups.map((g) => {
              const expanded = expandedGroups.has(g.id);
              const memberFilters = g.filterIds
                .map((fid) => filters.find((f) => f.id === fid))
                .filter((f): f is Filter => !!f);
              return (
                <div key={g.id}>
                  <GroupRow
                    group={g}
                    expanded={expanded}
                    dropActive={dragOverGroup === g.id}
                    onToggleExpanded={() => toggleExpanded(g.id)}
                    onOpen={() => setActiveGroup(g.id)}
                    onRename={(label) => updateGroup(g.id, { label })}
                    onRemove={() => removeGroupWithUndo(g.id)}
                    onToggleVisible={() => toggleGroupVisible(g.id)}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(FILTER_DRAG_TYPE)) return;
                      e.preventDefault();
                      setDragOverGroup(g.id);
                    }}
                    onDragLeave={() => setDragOverGroup((cur) => (cur === g.id ? null : cur))}
                    onDrop={(e) => dropOnGroup(e, g.id)}
                  />
                  {expanded &&
                    memberFilters.map((f) => (
                      <FilterRow
                        key={`${g.id}:${f.id}`}
                        filter={f}
                        nested
                        matchCount={matchCount(f.id)}
                        onEdit={() => setEditingFilterId(f.id)}
                      />
                    ))}
                </div>
              );
            })}
            {/* 顶层 filter（不属于任何分组） */}
            {topLevelFilters.map((f) => (
              <FilterRow
                key={f.id}
                filter={f}
                matchCount={matchCount(f.id)}
                onEdit={() => setEditingFilterId(f.id)}
              />
            ))}
            {groups.length === 0 && filters.length === 0 && (
              <div className={styles.emptyHint}>暂无过滤器，点击 ＋ 新建</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function GroupRow({
  group,
  expanded,
  dropActive,
  onToggleExpanded,
  onOpen,
  onRename,
  onRemove,
  onToggleVisible,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  group: FilterGroup;
  expanded: boolean;
  dropActive: boolean;
  onToggleExpanded: () => void;
  onOpen: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  onToggleVisible: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const hidden = group.visible === false;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.label);
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入编辑模式时聚焦
  useEffect(() => {
    if (editing) {
      setDraft(group.label);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, group.label]);

  const commitRename = () => {
    const v = draft.trim();
    if (v && v !== group.label) onRename(v);
    setEditing(false);
  };

  return (
    <div
      className={`${styles.groupRow} ${hidden ? styles.dim : ''} ${dropActive ? styles.dropTarget : ''}`}
      style={{ borderLeftColor: group.color }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => { if (!editing) onToggleExpanded(); }}
    >
      <button
        className={styles.treeToggle}
        title={expanded ? '折叠分组' : '展开分组'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpanded();
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <span className={styles.treeIcon} title="分组（文件夹）">
        {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className={styles.rowTitleInput}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            else if (e.key === 'Escape') { setEditing(false); }
          }}
        />
      ) : (
        <span className={styles.rowLabel} title="点击展开/折叠">{group.label}</span>
      )}
      <span className={styles.rowCount}>{group.filterIds.length}</span>
      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        <button
          className={styles.editBtn}
          title="编辑分组（节点与序列编排）"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
        >
          <Edit size={12} />
          <span>编辑</span>
        </button>
        <button
          className={styles.miniBtn}
          title="重命名"
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        >
          <Rename size={12} />
        </button>
        <button className={styles.miniBtn} title={hidden ? '显示' : '隐藏'} onClick={onToggleVisible}>
          {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <button className={styles.miniBtn} title="删除分组" onClick={onRemove}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  nested,
  matchCount,
  onEdit,
}: {
  filter: Filter;
  /** 嵌套在分组下（缩进 + 不再显示分组标签） */
  nested?: boolean;
  matchCount: number;
  onEdit: () => void;
}) {
  const duplicateFilter = useLogStore((s) => s.duplicateFilter);
  const updateFilter = useLogStore((s) => s.updateFilter);
  return (
    <div
      className={`${styles.filterRow} ${nested ? styles.nested : ''} ${filter.enabled ? '' : styles.dim}`}
      style={{ borderLeftColor: filter.color }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(FILTER_DRAG_TYPE, filter.id);
        e.dataTransfer.effectAllowed = 'link';
      }}
      title="拖拽到分组可将其加入该分组"
    >
      <span className={styles.treeIcon} title="过滤器">
        <Funnel size={12} />
      </span>
      <span className={styles.rowLabel}>{filter.label}</span>
      <span className={styles.rowCount}>{matchCount}</span>
      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        <button className={styles.editBtn} title="编辑过滤器" onClick={onEdit}>
          <Edit size={12} />
          <span>编辑</span>
        </button>
        <button
          className={styles.miniBtn}
          title={filter.enabled ? '隐藏过滤器（保留配置，不参与匹配）' : '显示过滤器'}
          onClick={() => updateFilter(filter.id, { enabled: !filter.enabled })}
        >
          {filter.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button
          className={styles.miniBtn}
          title={`复制过滤器「${filter.label}」（沿用所属分组）`}
          onClick={() => duplicateFilter(filter.id)}
        >
          <Copy size={12} />
        </button>
        <button
          className={styles.rowDelete}
          title={`删除过滤器「${filter.label}」（可撤销）`}
          aria-label={`删除过滤器 ${filter.label}`}
          onClick={() => removeFilterWithUndo(filter.id)}
        >
          <Trash size={12} />
        </button>
      </div>
    </div>
  );
}
