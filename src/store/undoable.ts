/**
 * 可撤销的删除操作。
 *
 * 过滤器 / 分组里存着用户手工调好的正则、颜色、序列关系，
 * 一次误点就没了代价太大。这里统一走「删除 + 撤销通知」的模式：
 * 删除前快照对象，事后可从通知条一键还原到原来的位置。
 */
import { useLogStore } from './logStore';
import { notify } from './uiStore';
import type { Filter, FilterGroup } from '../types';

export function removeFilterWithUndo(id: string): void {
  const st = useLogStore.getState();
  const idx = st.filters.findIndex((f) => f.id === id);
  if (idx < 0) return;
  const snapshot: Filter = { ...st.filters[idx] };
  const ownerGroups = st.groups
    .filter((g) => g.filterIds.includes(id))
    .map((g) => g.id);
  st.removeFilter(id);

  notify(`已删除过滤器「${snapshot.label || '未命名'}」`, {
    kind: 'info',
    duration: 6000,
    action: {
      label: '撤销',
      run: () => {
        const s = useLogStore.getState();
        const next = [...s.filters];
        next.splice(Math.min(idx, next.length), 0, snapshot);
        useLogStore.setState({ filters: next });
        // 恢复原本的分组从属关系（removeFilter 会把 id 从各 group 里摘掉）
        if (ownerGroups.length > 0) {
          useLogStore.setState({
            groups: useLogStore.getState().groups.map((g) =>
              ownerGroups.includes(g.id) && !g.filterIds.includes(snapshot.id)
                ? { ...g, filterIds: [...g.filterIds, snapshot.id] }
                : g,
            ),
          });
        }
        useLogStore.getState().recomputeMatches();
        notify('已恢复过滤器', { kind: 'success' });
      },
    },
  });
}

export function removeGroupWithUndo(id: string): void {
  const st = useLogStore.getState();
  const idx = st.groups.findIndex((g) => g.id === id);
  if (idx < 0) return;
  const snapshot: FilterGroup = { ...st.groups[idx], filterIds: [...st.groups[idx].filterIds] };
  st.removeGroup(id);

  notify(`已删除分组「${snapshot.label || '未命名'}」`, {
    kind: 'info',
    duration: 6000,
    action: {
      label: '撤销',
      run: () => {
        const next = [...useLogStore.getState().groups];
        next.splice(Math.min(idx, next.length), 0, snapshot);
        useLogStore.setState({ groups: next });
        useLogStore.getState().recomputeMatches();
        notify('已恢复分组', { kind: 'success' });
      },
    },
  });
}

/** 清空全部过滤器（可一次性还原） */
export function clearFiltersWithUndo(): void {
  const st = useLogStore.getState();
  if (st.filters.length === 0) {
    notify('当前没有过滤器');
    return;
  }
  const snapshots = st.filters.map((f) => ({ ...f }));
  const ownerGroups = snapshots.map((f) => ({
    id: f.id,
    groups: st.groups.filter((g) => g.filterIds.includes(f.id)).map((g) => g.id),
  }));
  for (const f of snapshots) st.removeFilter(f.id);

  notify(`已删除 ${snapshots.length} 个过滤器`, {
    kind: 'info',
    duration: 8000,
    action: {
      label: '全部恢复',
      run: () => {
        useLogStore.setState({ filters: snapshots });
        const ownerMap = new Map(ownerGroups.map((o) => [o.id, o.groups]));
        useLogStore.setState({
          groups: useLogStore.getState().groups.map((g) => {
            const recovered = snapshots
              .filter((f) => ownerMap.get(f.id)?.includes(g.id))
              .map((f) => f.id);
            if (recovered.length === 0) return g;
            return { ...g, filterIds: [...g.filterIds, ...recovered] };
          }),
        });
        useLogStore.getState().recomputeMatches();
        notify(`已恢复 ${snapshots.length} 个过滤器`, { kind: 'success' });
      },
    },
  });
}
