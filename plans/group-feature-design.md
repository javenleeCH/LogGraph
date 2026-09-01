# Group 功能设计（Perfetto 进程/线程模型）

## 目标
用户可手动创建 group（起名+选色），把已有 filter 拖拽归入 group。
折叠 group 时，TimelineCanvas 将组内各 filter 事件叠加成**一行密度热力条**（按颜色密度显示）。
展开时恢复为各 filter 独立 lane（多行）。

## 数据模型变更

### `src/types.ts`
新增 `FilterGroup` 接口；`Filter` 增加 `groupId?: string | null` 字段。

```ts
/** 用户定义的过滤器分组（类比 Perfetto 进程） */
export interface FilterGroup {
  id: string;
  label: string;
  color: string;
  /** 是否折叠（折叠=合并成一行密度热力条） */
  collapsed: boolean;
}

export interface Filter {
  // ...原有字段
  /** 所属 group id；null=未分组（顶层） */
  groupId?: string | null;
}
```

### `src/store/logStore.ts`
LogState 新增字段与 actions：

```ts
// --- 数据 ---
groups: FilterGroup[];              // 顺序即显示顺序
collapsedGroups: Set<string>;       // 冗余：快速查询，与 groups.collapsed 同步

// --- actions ---
addGroup: (partial?: Partial<FilterGroup>) => string;
updateGroup: (id: string, patch: Partial<FilterGroup>) => void;
removeGroup: (id: string) => void;  // 删除组时组内 filter 的 groupId 置 null
toggleGroupCollapsed: (id: string) => void;
moveFilterToGroup: (filterId: string, groupId: string | null) => void;
reorderGroup: (id: string, toIndex: number) => void;
```

`Filter` 增删/移动时调 `recomputeMatches`（matches 逻辑不变，仍按 filters 顺序）。
`removeGroup` 时把组内所有 filter 的 groupId 置 null（不删除 filter）。
`moveFilterToGroup` 即拖拽归组的后端，改 filter.groupId 即可。

### `src/io/filterPersist.ts`
`PersistedFilters` 扩展为含 groups：

```ts
export interface PersistedFilters {
  filters: Filter[];
  groups?: FilterGroup[];   // 旧文件无此字段=空 groups（向后兼容）
  savedAt: number;
}
```
`initPersistence` 恢复时同时读 groups（补默认 collapsed=false）。
`saveFiltersNow` 写入 groups + filters。

## "可见行"布局模型（核心）

TimelineCanvas 当前按 `filters` 线性索引画 lane。
改造为构建 **visibleRows** 列表，每行带类型，统一驱动 y 坐标计算、hitTest、hover、minimap。

```ts
type VisibleRow =
  | { kind: 'group-header'; group: FilterGroup; childCount: number }
  | { kind: 'filter'; filter: Filter; rowIndex: number }
  | { kind: 'group-density'; group: FilterGroup; events: LogEvent[] }; // 折叠态
```

构建逻辑（放在 store 或 TimelineCanvas 内的 memo）：
1. 遍历 groups（按序）：
   - 若 collapsed → push `group-header`（占 LANE_HEIGHT）+ `group-density`（占 LANE_HEIGHT）
   - 若展开 → push `group-header` + 各 child filter 行
2. 顶层无 group 的 filter → push `filter` 行（无 header）

> 简化：group-header 行高 = LANE_HEIGHT，与 filter 行一致，便于命中测试与 minimap。

新增布局常量到 `src/timeline/layout.ts`：
```ts
GROUP_HEADER_HEIGHT: 28,        // 折叠组标题行（比 filter 行矮）
```

## 渲染层变更

### `src/timeline/renderers.ts`
新增绘制函数：
- `drawGroupHeader(rc, group, y, childCount, collapsed, hovered)` — 绘制组标题行（折叠箭头 ▶/▼ + 组名 + 子项数 + 组色条）
- `drawGroupDensity(rc, group, events, y, selectedId, hoveredId, correlatedIds)` — 折叠态密度热力条：复用 LogStreamView 的 GlobalLane 密度桶算法（按时间分桶 + 事件数映射颜色深浅，叠加各 filter 色）

### `src/timeline/TimelineCanvas.tsx`
- 渲染循环改为遍历 `visibleRows` 而非 `filters`
- `hitTest` / `hoveredLane` 改为按 visibleRows 的 y 偏移查找
- group-header 行点击 → `toggleGroupCollapsed(id)`（需新增 canvas 鼠标事件分支）

## UI 变更

### `src/components/FilterBar.tsx`
- 现状：chips 平铺，`+ 新增` 添加 filter
- 改造：
  - chips 按 group 分段显示（组标题 chip + 缩进的组内 filter chips），顶层无组 filter 单独一段
  - 新增 `+ 组` 按钮 → `addGroup()`
  - filter chip 设为 `draggable`，group 标题 chip 设为 drop target → `moveFilterToGroup`
  - group 标题 chip 点击折叠/展开箭头 → `toggleGroupCollapsed`

### `src/components/LogStreamView.tsx`
- 列 = filters（含组内 filter），按 group 分组渲染列
- 折叠组 → 该组所有列折叠成一个"组密度列"（复用 global 模式的密度热力逻辑）
- 列头区域显示 group 分隔标题
（此组件改动较大，可作为第二阶段；第一阶段先做 TimelineCanvas + FilterBar）

## 影响范围
| 文件 | 改动 |
|------|------|
| src/types.ts | +FilterGroup, Filter.groupId |
| src/store/logStore.ts | +groups/collapsedGroups 字段, +6 个 actions, persist 恢复含 groups |
| src/io/filterPersist.ts | PersistedFilters 加 groups 字段 |
| src/timeline/layout.ts | +GROUP_HEADER_HEIGHT 常量, +visibleRows 构建函数 |
| src/timeline/renderers.ts | +drawGroupHeader, +drawGroupDensity |
| src/timeline/TimelineCanvas.tsx | 渲染改 visibleRows, hitTest/hover 改造, +折叠点击 |
| src/components/FilterBar.tsx | group 分段显示, +建组按钮, +拖拽归组 |
| src/components/FilterBar.module.css | group chip 样式 |
| src/components/LogStreamView.tsx | 组列折叠（第二阶段）|

## 实施分阶段
- **阶段1**：数据模型 + store + persist + FilterBar（建组/拖拽/折叠切换）+ TimelineCanvas 折叠渲染 + build 验证
- **阶段2**：LogStreamView 组列折叠（后续）
