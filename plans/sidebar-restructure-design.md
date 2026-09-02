# 左侧栏重构 + Group 详情页方案

## 背景
用户反馈：节点画布的概览页不需要，把 group 列表和 filter 列表放到左侧栏，点击 group 进入 group 详情画布。

## 新布局（移除 FilterBar）

```
┌─────────────────────────────────────┐
│ Toolbar（去掉🗂节点图按钮）          │
├──────────┬──────────────────────────┤
│ 左侧栏    │ 主区域                   │
│ ┌──────┐ │ ┌──────────────────────┐ │
│ │文件树 │ │ │ Timeline/LogStream   │ │
│ │可折叠 │ │ │                      │ │
│ ├──────┤ │ ├──────────────────────┤ │
│ │Group │ │ │ DetailPanel          │ │
│ │列表+ │ │ │                      │ │
│ │可折叠 │ │ └──────────────────────┘ │
│ ├──────┤ │
│ │Filter│ │  overlay: activeGroupId 时
│ │列表+ │ │  渲染 GroupEditorPage 抽屉
│ │可折叠 │ │  + editingFilterId 时弹
│ └──────┘ │    FilterDetailModal
└──────────┴──────────────────────────┘
```

**FilterBar 整个移除**——filter/group 管理全部迁移到左侧栏 + group 详情画布 + filter 详情弹窗。

## 改动清单

### 1. Toolbar.tsx
- 删除 `setGraphViewOpen` hook 和「🗂 节点图」按钮

### 2. logStore.ts
- `graphViewOpen: boolean` → `activeGroupId: string | null`
- `setGraphViewOpen` → `setActiveGroup(id: string | null)`
- 新增 `editingFilterId: string | null` + `setEditingFilterId`（供左侧栏/画布共用）
- 保留 graphNodes/graphPan/graphZoom

### 3. App.tsx
- **移除 `<FilterBar />` 渲染**
- `.treePane` 内改为三段可折叠 flex 区块：
  - 上：`<FileTreePanel />`
  - 中：Group 列表卡片（+ 新建按钮，点击卡片 → setActiveGroup）
  - 下：Filter 列表卡片（+ 新建按钮，点击卡片 → setEditingFilterId）
- 移除 `{graphViewOpen && <NodeCanvasView />}`
- 改为：`{activeGroupId && <GroupEditorPage .../>}` + `{editingFilterId && <FilterDetailModal .../>}`

### 4. NodeCanvasView.tsx
- 删除 `OverviewPage` 及其子组件（GroupCard/FilterCard 概览版）
- 导出 `GroupEditorPage`（整画布即 group）+ `FilterDetailModal`
- GroupEditorPage 入口：`activeGroupId` 非空 → overlay 抽屉
  - 左侧 filter 调色板 + 中间画布 + 返回/关闭按钮
- 左侧栏的 group/filter 列表卡片用紧凑布局（不是概览页的大卡片）

### 5. 新组件：SidePanel（或直接在 App.tsx 内联）
- 三段可折叠区块，每段 header 可点击折叠
- group 卡片：颜色条 + 名称（可编辑 input）+ 成员数 + 操作按钮
- filter 卡片：颜色条 + 名称 + 计数 + 所属 group 标签

### 6. CSS
- App.module.css：`.treePane` 内三段 flex 布局 + 折叠样式
- 新建或在 NodeCanvasView.module.css 补充侧栏卡片样式

## 交互
- 点击 group 卡片 → `setActiveGroup(g.id)` → 渲染 GroupEditorPage overlay
- 点击 filter 卡片 → `setEditingFilterId(f.id)` → 渲染 FilterDetailModal
- GroupEditorPage 内 Esc/返回 → `setActiveGroup(null)`
- FilterDetailModal Esc/完成 → `setEditingFilterId(null)`
