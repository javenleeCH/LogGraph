/**
 * 左侧栏三段可折叠区块：
 * - 上：日志文件树（FileTreePanel）
 * - 中：Group 列表（+ 新建按钮，点击卡片 → setActiveGroup）
 * - 下：Filter 列表（+ 新建按钮，点击卡片 → setEditingFilterId）
 *
 * 每段 header 可点击折叠，折叠后只显示标题条；展开时内容区滚动。
 */
import { useState, useMemo, useRef, useEffect } from 'react';
import { useLogStore } from '../store/logStore';
import { FileTreePanel } from './FileTreePanel';
import type { FilterGroup } from '../types';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Pencil,
  Eye,
  EyeOff,
  X,
  Layers,
  Filter as FilterIcon,
  FolderTree,
} from './Icon';
import styles from './SidePanel.module.css';

type SectionKey = 'files' | 'groups' | 'filters';

export function SidePanel() {
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const matches = useLogStore((s) => s.matches);
  const addGroup = useLogStore((s) => s.addGroup);
  const addFilter = useLogStore((s) => s.addFilter);
  const setActiveGroup = useLogStore((s) => s.setActiveGroup);
  const setEditingFilterId = useLogStore((s) => s.setEditingFilterId);
  const updateGroup = useLogStore((s) => s.updateGroup);
  const removeGroup = useLogStore((s) => s.removeGroup);
  const toggleGroupVisible = useLogStore((s) => s.toggleGroupVisible);
  const toggleGroupCollapsed = useLogStore((s) => s.toggleGroupCollapsed);

  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    files: false,
    groups: false,
    filters: false,
  });

  const toggle = (k: SectionKey) =>
    setCollapsed((prev) => ({ ...prev, [k]: !prev[k] }));

  const matchCount = useMemo(
    () => (fid: string) => matches.find((m) => m.filterId === fid)?.events.length ?? 0,
    [matches],
  );

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

      {/* ── 中：Group 列表 ── */}
      <section className={`${styles.section} ${collapsed.groups ? styles.collapsed : ''}`}>
        <header className={styles.sectionHeader} onClick={() => toggle('groups')}>
          <span className={styles.caret}>
            {collapsed.groups ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <Layers size={13} className={styles.sectionIcon} />
          <span className={styles.sectionTitle}>分组 Groups</span>
          <span className={styles.sectionCount}>{groups.length}</span>
          <div className={styles.spacer} />
          <button
            className={styles.addBtn}
            title="新建分组"
            onClick={(e) => {
              e.stopPropagation();
              addGroup({});
            }}
          >
            <Plus size={13} />
          </button>
        </header>
        {!collapsed.groups && (
          <div className={styles.sectionBody}>
            {groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                onOpen={() => setActiveGroup(g.id)}
                onRename={(label) => updateGroup(g.id, { label })}
                onRemove={() => removeGroup(g.id)}
                onToggleVisible={() => toggleGroupVisible(g.id)}
                onToggleCollapsed={() => toggleGroupCollapsed(g.id)}
              />
            ))}
            {groups.length === 0 && (
              <div className={styles.emptyHint}>暂无分组，点击 ＋ 新建</div>
            )}
          </div>
        )}
      </section>

      {/* ── 下：Filter 列表 ── */}
      <section className={`${styles.section} ${collapsed.filters ? styles.collapsed : ''}`}>
        <header className={styles.sectionHeader} onClick={() => toggle('filters')}>
          <span className={styles.caret}>
            {collapsed.filters ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <FilterIcon size={13} className={styles.sectionIcon} />
          <span className={styles.sectionTitle}>过滤器 Filters</span>
          <span className={styles.sectionCount}>{filters.length}</span>
          <div className={styles.spacer} />
          <button
            className={styles.addBtn}
            title="新建过滤器"
            onClick={(e) => {
              e.stopPropagation();
              const id = addFilter({});
              setEditingFilterId(id);
            }}
          >
            <Plus size={13} />
          </button>
        </header>
        {!collapsed.filters && (
          <div className={styles.sectionBody}>
            {filters.map((f) => {
              const owningGroups = groups.filter((g) => g.filterIds.includes(f.id));
              return (
                <div
                  key={f.id}
                  className={`${styles.filterRow} ${f.enabled ? '' : styles.dim}`}
                  style={{ borderLeftColor: f.color }}
                  onClick={() => setEditingFilterId(f.id)}
                >
                  <span className={styles.dot} style={{ background: f.color }} />
                  <span className={styles.rowLabel}>{f.label}</span>
                  <span className={styles.rowCount}>{matchCount(f.id)}</span>
                  <div className={styles.rowTags}>
                    {owningGroups.length === 0 ? (
                      <span className={styles.rowTag}>顶层</span>
                    ) : (
                      owningGroups.map((g) => (
                        <span key={g.id} className={styles.rowTag} style={{ borderColor: g.color }}>
                          {g.label}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
            {filters.length === 0 && (
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
  onOpen,
  onRename,
  onRemove,
  onToggleVisible,
  onToggleCollapsed,
}: {
  group: FilterGroup;
  onOpen: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  onToggleVisible: () => void;
  onToggleCollapsed: () => void;
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
      className={`${styles.groupRow} ${hidden ? styles.dim : ''}`}
      style={{ borderLeftColor: group.color }}
      onClick={() => { if (!editing) onOpen(); }}
    >
      <span className={styles.dot} style={{ background: group.color }} />
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
        <span className={styles.rowLabel} title="点击进入画布编辑">{group.label}</span>
      )}
      <span className={styles.rowCount}>{group.filterIds.length}</span>
      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        <button
          className={styles.miniBtn}
          title="重命名"
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        >
          <Pencil size={12} />
        </button>
        <button className={styles.miniBtn} title={hidden ? '显示' : '隐藏'} onClick={onToggleVisible}>
          {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <button className={styles.miniBtn} title={group.collapsed ? '展开' : '折叠'} onClick={onToggleCollapsed}>
          {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <button className={styles.miniBtn} title="删除分组" onClick={onRemove}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
