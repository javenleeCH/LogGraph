# 节点画布子页面设计（draw.io 风格区域式画布）

## 目标
新建一个独立全屏抽屉式子页面，以 draw.io 风格的区域式画布展示 group 与 filter 的归属关系。
- 节点类型两种：`group` 节点（大型带框画布容器）、`filterItem` 节点。
- **区域式收纳**：group 是大型带框区域容器，filterItem 拖进某 group 区域内即归属该 group；拖出区域即脱离。
- **多对多处理**：filterItem 物理坐标唯一，**只在其「主 group」（首个所属 group）区域内渲染实体**；其它所属 group 区域内显示**只读引用占位**（点击占位聚焦/平移到主实体并高亮）。
- 区域内 filter 之间后续可连线（v2 预留，先不实现）。
- 复用现有 store 的 `groups` / `filters` / `FilterGroup.filterIds` 多对多数据，节点坐标新增持久化字段。

## 入口
- `Toolbar` 新增按钮 `🗂 节点图`，点击切换 `graphViewOpen: true`（store 状态）。
- `App` 在 `graphViewOpen` 时渲染全屏 `NodeCanvasView` 抽屉，`z-index: 1000` 高于主区域，遮盖 `main-row`（但 Toolbar 仍可见，便于关闭）。
- 关闭：抽屉右上角 `×` 或再次点 Toolbar 按钮。

## 数据模型变更

### `src/types.ts`
节点坐标独立于 group/filter 本身，新增统一的「节点定位」表（绝对世界坐标），不侵入 Filter/FilterGroup：

```ts
/** 节点画布上一个节点的位置与尺寸（世界坐标，非屏幕坐标） */
export interface NodePos {
  id: string;        // filter id 或 group id
  kind: 'group' | 'filterItem';
  x: number;
  y: number;
  /** group 节点需要宽高（容器）；filterItem 用固定尺寸即可，存了也兼容 */
  w?: number;
  h?: number;
}
```

画布整体状态（pan/zoom 会话级，不持久化）：
```ts
export interface GraphViewState {
  nodes: Record<string, NodePos>;  // id → pos，持久化
  panX: number;
  panY: number;
  zoom: number;
}
```

### `src/store/logStore.ts`
LogState 新增：
```ts
graphViewOpen: boolean;
graphNodes: Record<string, NodePos>;   // id → pos，持久化
graphPan: { x: number; y: number };
graphZoom: number;
// actions
setGraphViewOpen: (open: boolean) => void;
setNodePos: (id: string, x: number, y: number, wh?: { w?: number; h?: number }) => void;
ensureNodePos: (id: string, kind: 'group' | 'filterItem') => void;  // 缺省坐标：group 按网格，filterItem 落在其首个所属 group 区域内或顶层网格
removeNodePos: (id: string) => void;
setGraphPan: (x: number, y: number) => void;
setGraphZoom: (z: number) => void;
```
- `addFilter` / `addGroup` 后调 `ensureNodePos`。
- `removeFilter` / `removeGroup` 后调 `removeNodePos`。
- `schedulePersist` 写入 `graphNodes`；`initPersistence` 读取恢复，缺省时按网格/所属区域自动生成。

### `src/io/filterPersist.ts`
`PersistedFilters` 增 `graphNodes?: Record<string, NodePos>`（可选，旧文件无则自动生成）。
区域式特有：group 节点 `NodePos` 带 `w/h`（容器宽高，缺省如 360×260）。

## 组件结构

### `src/components/NodeCanvasView.tsx`（抽屉根容器 + 画布）
- 全屏 fixed 定位，`z-index: 1000`，遮盖主区域（Toolbar 仍可见）。
- 持有本地拖拽状态：`draggingNode`(id|null)、`dragOffset`、`panning`(bool)、`panStart`。
- 渲染分三层：
  1. **group 区域层（HTML）**：每个 group 一个大型带框容器 div（绝对定位 + w/h），可拖拽移动整体、可拖右下角改尺寸。
  2. **filterItem 节点层（HTML）**：filterItem 实体卡片（绝对定位），可拖拽改坐标；拖入某 group 区域内部即归属该 group（mouseup 时判定落点 group，调 addFilterToGroup）。
  3. **引用占位层**：非主 group 区域内的只读占位（小标签 + 虚线框），点击平移聚焦主实体。
- 缩放/平移：滚轮缩放（以鼠标为锚点）、空白拖拽平移。
- 坐标换算：世界坐标 → 屏幕坐标 = `(worldX * zoom + panX, worldY * zoom + panY)`。

### `src/components/GraphNode.tsx`（单个节点卡片）
两种渲染分支 + 实体/占位两种模式：
- **group 节点**：大型带框容器，色条 = group.color，标题栏 = label + 子 filter 数 + 匹配事件总数，按钮组：`👁/∅`(visible)、`▼/▶`(折叠，影响 Timeline)、`✎`(改名改色)、`×`(删组)。内部区域为 drop target，filterItem 实体落入即 addFilterToGroup。
- **filterItem 实体节点**（主 group 内）：小矩形，色点 = filter.color，标题 = label，匹配数，按钮组：`+group`(多选弹列表 addFilterToGroup)、`↩`(从当前主 group 移除)、`✎`(编辑 filter，复用 FilterEditor)、`×`(删 filter)、`👁/∅`(enabled)。可拖拽改坐标。
- **filterItem 占位节点**（非主 group 区域内）：只读，虚线框 + 半透明 + "↗ 主实体"标记，点击 → setGraphPan 平移到主实体并高亮。
- 拖拽实体落点判定：mouseup 时遍历 group 区域矩形，若落点在某 group 内且该 group 非其主 group → addFilterToGroup；落点在所有 group 外 → removeFilterFromGroup(主 group)（脱离到顶层）。

### `src/components/NodeCanvasView.module.css`
节点卡片样式、group 容器样式、占位样式、工具栏、抽屉遮罩。

## 缺省布局
新节点无坐标时 `ensureNodePos`：
- group 节点：按创建顺序网格 (col*420, row*320)，宽 400 高 300。
- filterItem 节点：落在其「首个所属 group」区域内左上起始 (groupX+20+col*180, groupY+50+row*60)；无所属则顶层网格。
- 用户拖拽后坐标持久化，刷新保留。

## 主 group 判定
`primaryGroupOf(filterId)` = `groups.find(g => g.filterIds.includes(fid))`（首个包含的 group）。
- 实体渲染在主 group 区域内。
- 其它所属 group 区域内渲染占位。

## 与现有视图的关系
- 节点画布是**独立第三视图**，不影响 FilterBar / TimelineCanvas / LogStreamView。
- group 的 visible/collapsed 仍由节点画布上的按钮控制，与其它视图共享同一 store，三处一致。
- 删除/改名/改色同样通过 store 同步全局。

## 持久化
- filters.json 新增 `graphNodes` 字段（Record<id, {id,kind,x,y,w?,h?}>）。
- pan/zoom 不持久化（会话级），仅 graphNodes 持久化。
- 旧文件无 graphNodes：initPersistence 时按缺省布局生成并写入。

## 实施步骤（todo）
1. types.ts 加 NodePos / GraphViewState；logStore 加 graphViewOpen/graphNodes/graphPan/graphZoom 状态 + actions（setNodePos/ensureNodePos/removeNodePos/setGraphViewOpen/setGraphPan/setGraphZoom），addFilter/addGroup/removeFilter/removeGroup 联动坐标；schedulePersist + initPersistence 读写 graphNodes；filterPersist.ts PersistedFilters 加 graphNodes。
2. NodeCanvasView.tsx 骨架：全屏抽屉 + group 区域层 + filterItem 实体层 + 占位层 + 滚轮缩放/空白拖拽平移 + 坐标换算。
3. GraphNode.tsx：group 容器节点（drop target）+ filterItem 实体节点（拖拽改坐标/归属）+ 占位节点（点击聚焦），按钮组复用 store actions。
4. 拖拽落点归属判定：实体 mouseup 时判定落点 group 区域 → addFilterToGroup / removeFilterFromGroup。
5. App.tsx 接入 graphViewOpen → 渲染 NodeCanvasView 抽屉；Toolbar 加 `🗂 节点图` 按钮。
6. NodeCanvasView.module.css 节点/容器/占位/工具栏样式 + 缺省网格布局 + build 验证。
