# ReactFlow 迁移评估 + 技术栈升级方案

> 评估对象：NodeCanvasView（分组编辑画布）手写 SVG/DOM 图编辑层 → @xyflow/react（ReactFlow v12）
> 同时评估：React 18 → 19、Vite 5 → 7、TypeScript 5.5 → 5.9、zustand 4 → 5 全栈升级
> 决策输入：自环边 hack 方案、归属语义适配、工作量估算、风险清单

---

## 一、现状盘点

### 1.1 依赖现状（package.json）

| 包 | 当前 | 最新稳定（2025-09） | 升级风险 |
|----|------|---------------------|----------|
| react / react-dom | 18.3.1 | **19.x** | 低（代码零 forwardRef/legacy API，仅 main.tsx 入口） |
| vite | 5.4.2 | **8.x** | 低-中（Rolldown 构建 + Node ≥ 20.19；`@vitejs/plugin-react` 须同步升到 v8 配套版；无自定义插件/特殊配置，适配面小） |
| typescript | 5.5.4 | **5.9.x** | 低 |
| zustand | 4.5.5 | **5.x** | 低（`create` API 兼容；`useSyncExternalStore` 用法不变） |
| @xyflow/react | —（手写） | **12.x** | 本次引入 |

### 1.2 手写画布的规模与问题

- [NodeCanvasView.tsx](../src/components/NodeCanvasView.tsx)：**1100+ 行**（拖拽引擎 + 连线交互 + 五类边渲染 + 弹窗 + 调色板）
- 历史修复记录（全部是 ReactFlow 内建能力）：
  贝塞尔中点公式错误 / pointer-events 穿透 / hover 死区（2 轮）/ 原生拖拽吞事件 / 拖入坐标缺失 / pan-zoom 锚点数学
- 缺失的图编辑器标配：小地图、框选、对齐线、撤销重做、键盘移动节点

---

## 二、ReactFlow（@xyflow/react v12）适配方案

### 2.1 数据映射

| 现有模型 | ReactFlow 映射 | 说明 |
|----------|----------------|------|
| `graphNodes: Record<id, NodePos>` | `Node<{...}, 'filter'>[]` 的 `position` | 受控模式，`onNodesChange` 同步回 store |
| filter 实体节点 | **自定义节点** `FilterNode`（卡片：色点/label/计数/链角标/移除按钮/连线热区） | NodeToolbar 可选 |
| `SequenceEdge` | **自定义边** 按kind五类：`SeqEdge/NotEdge/AndOrEdge/PeriodicEdge` | periodic 见 2.2 hack |
| `sequenceResults` 统计 | 通过边 `data` 注入（matched/miss/violation/gap/jitter） | 边标签直接渲染 |
| `graphPan/graphZoom` | `useViewport()` / `setViewport()`（会话级，不持久化——与现状一致） | — |

### 2.2 Periodic 自环边 hack 方案（关键技术点）

ReactFlow v12 自环仍为**实验性**。两个候选方案：

**方案 A：同节点双 Handle + 自连边（官方实验路径）** ✅ 推荐
```tsx
// FilterNode 内放两个紧贴的 source/target handle（右缘上下错开 6px）
<Handle type="source" position={Position.Right} id="loop-src" style={{ top: 30% }} />
<Handle type="target" position={Position.Right} id="loop-dst" style={{ top: 70% }} />
// 建边：source=handle:'loop-src', target=同节点 handle:'loop-dst'
// 自定义 PeriodicEdge 里不用 getBezierPath，直接画 <circle>（保留现有视觉）
```
- 优点：连线手势（从 handle 拖出）天然支持「拖回自身」；命中由 ReactFlow 管理
- 风险：v12 对同节点双 handle 自环的 `edgeInteractionWidth` 命中带表现需实测；若命中异常，fallback 到 B

**方案 B：隐藏锚点节点（旁路方案）**
- 在自环节点右侧 30px 放一个 `draggable:false, selectable:false, hidden 渲染` 的辅助节点，periodic 边 = 节点→辅助节点→节点 两条边拼视觉，或一条绕行 bezier
- 优点：完全走 ReactFlow 主路径，零实验特性
- 缺点：辅助节点要跟随主节点移动（onNodesChange 联动）、序列化时过滤、导出时排除——脏模型

**结论：先 A 后 B**。A 的自环视觉直接复用现有 `<circle>` SVG（视觉与今天完全一致），只有交互命中有不确定性；B 是保底，成本 1 天内。

### 2.3 「画布即 group 区域」归属语义适配

现状：整个画布 = group，拖入画布即归属、拖出画布即脱离。

**适配方案：不用 ReactFlow 父子容器，保留视口边界判定**
```tsx
// ReactFlow 受控节点 + onNodeDragStop：
const rfBounds = wrapperRef.current.getBoundingClientRect(); // 或 useReactFlow().screenToFlowPosition
onNodeDragStop={(e, node) => {
  // 调色板拖入（HTML DnD onDrop → screenToFlowPosition → addNode + addFilterToGroup）
  // 拖出视口：node.internals.positionAbsolute 超出 rfBounds → removeFilterFromGroup
}}
// pan/zoom 时视口边界变化：仅影响「拖出」判定瞬时值，可接受
```
- 画布背景 = ReactFlow 容器背景（CSS 网格用现成的 `colorMode` + 自定义 className 保留）
- 调色板拖入用 ReactFlow 官方推荐 `onDragOver/onDrop` + `screenToFlowPosition` 模式（文档标准配方）

### 2.4 修饰键建边（Shift=AND / Alt=OR）

`onConnect(connection)` 回调不带修饰键 → 在 `onConnectStart` 记录 `e.shiftKey/altKey`，`onConnect` 里读取：
```tsx
const modifierRef = useRef<'and'|'or'|null>(null);
onConnectStart={(e) => { modifierRef.current = e.shiftKey ? 'and' : e.altKey ? 'or' : null; }}
onConnect={(conn) => { addSequenceEdge(gid, conn.source, conn.target, 1000, { kind: modifierRef.current ?? 'seq' }); }}
```
- 拖回自身：`conn.source === conn.target`（走自环 handle）→ periodic
- AND 多目标：现有交互是「多次单拖」聚合，ReactFlow 下保持一致（每次拖仍单目标，kind=and 时 store 侧聚合 toFilterIds——现有 `addSequenceEdge` 去重逻辑已支持）

### 2.5 五类边视觉迁移对照

| kind | 现有视觉 | ReactFlow 实现 |
|------|----------|----------------|
| seq | 组色实线+箭头+中点标签+× | `getBezierPath` + `EdgeLabelRenderer`（标签/×放 label 容器，天然无死区） |
| not | 红密虚线无箭头 | 同上，stroke=--danger + dasharray |
| and/or | 扇形分叉（一对多 path） | **一条边 data.targets 多目标**，自定义边内 map 画多 path；或 v12 的多 handle 分支——选前者（模型不变） |
| periodic | 自环 circle + ♥标签 | 见 2.2 方案 A，视觉复用 |
| 删除按钮 × | 线中点 SVG 徽章 | `EdgeLabelRenderer` 内 button（HTML，悬停/点击/无障碍全免费） |

### 2.6 保留不动（迁移零成本资产）

- `SequenceMatcher` 匹配引擎（纯逻辑）
- types.ts 数据模型 / logStore actions / 持久化格式
- EdgeEditModal（仅换触发入口）
- TimelineCanvas / LogStreamView（与画布无关）
- 19 场景语义验证脚本思路

---

## 三、React 19 + 全栈升级方案

### 3.1 变更清单

| 项 | 动作 | 影响面 |
|----|------|--------|
| react/react-dom → 19 | 升依赖 + @types | main.tsx 的 `createRoot` API 不变；React 19 移除的 PropTypes/legacy Context/`react-dom/test-utils` 项目均未用 |
| `React.StrictMode` | 保持（React 19 下行为一致） | 无 |
| zustand 4 → 5 | 升依赖 | `create` 签名兼容；v5 移除的 `equalityFn` 参数与 default equality 变更项目未用（全部 selector 形式） |
| vite 5 → **8** | 升依赖 + `@vitejs/plugin-react` → v8 配套版 | 配置零改动（无插件/alias 特殊用法）；**前置检查：Node ≥ 20.19**（tauri dev 环境同为系统 Node）；Vite 8 = Rolldown 默认构建，首次构建需验证产物体积/兼容性；dev server 行为差异极小 |
| typescript 5.5 → 5.9 | 升依赖 | tsc -b 无新增 flag 需求；`@types/node` 同步升 |
| @xyflow/react 12 | 新增 | **要求 React ≥ 17，React 19 兼容（官方支持矩阵）**；CSS：`import '@xyflow/react/dist/style.css'` |

### 3.2 React 19 与本项目相关的注意点

- `useSyncExternalStore`（useTheme 用了）：React 19 行为无变化 ✓
- 事件委托变更（React 17→19 root 级委托）：现有 window 级 mousemove/mouseup 拖拽（NodeCanvasView）不受影响；ReactFlow v12 已适配 19 ✓
- 无 SSR / RSC / Suspense 边界 / use() —— 无需动
- Tauri WebView2：纯前端渲染，React 19 正常

---

## 四、工作量估算（分阶段，可独立交付/回滚）

> 按熟悉本项目的人折算；含自测。不含已沉没的讨论成本。

### 阶段 S1：全栈版本升级（先行，独立提交）
- React 19 + types + zustand 5 + TS 5.9 + Vite 7 + Node 版本确认
- 回归：全功能手测一轮（时间线/纵轴/分组编辑/持久化/Tauri dev & build）
- **预计：0.5 天**；风险：低；git 单 commit，可整体 revert

### 阶段 S2：ReactFlow 骨架替换
- 引入 @xyflow/react，FilterNode/五类自定义边 + 受控 nodes/edges 双向同步 store
- 保留：调色板、工具栏、EdgeEditModal、scope/异常开关
- **预计：1.5 天**（含 pan/zoom/落点归属判定改造）

### 阶段 S3：自环 + 修饰键 + 边交互细节
- 方案 A 自环实测（含命中带），异常则 fallback 方案 B
- Shift/Alt 修饰键、拖回自身=periodic、AND 聚合交互回归
- **预计：1 天**

### 阶段 S4：体验增强（迁移红利）
- MiniMap / 框选多选 / 键盘移动 / 对齐线（SnapGrid）按需开启
- **预计：0.5 天**

**合计：约 3.5 天**。旧实现 1100 行预计缩减至 ~500 行（NodeCanvasView 装配 + customNode + 4 个 customEdge 文件）。

### 收益/成本对比

| | 迁移 | 不迁 |
|---|------|------|
| 一次性成本 | ~3.5 天 + 34KB gzip 依赖 | 0 |
| 后续每个图编辑特性（框选/撤销/对齐…） | 组件级（小时） | 手写（天级，且重蹈命中/hover 坑） |
| 自环交互 | 实验特性风险（有 B 方案保底） | 已稳定 ✓ |
| 触发迁移的三个信号（多 group 总览/标配特性/边类型再增） | 一旦出现，不迁成本更高 | — |

---

## 五、风险清单与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| ReactFlow 自环命中带异常（方案 A 失败） | 中 | 方案 B 保底（≤1 天）；或自环交互降级为「节点右键菜单 → 添加心跳」 |
| React 19 升级引发隐性 break（第三方未列 peer 警告） | 低 | S1 独立 commit 整体 revert；Tauri build 全量回归 |
| Vite 7 要求 Node ≥ 20.19 | 低 | 先 `node -v` 确认；不满足则钉 Vite 6 |
| zustand v5 类型收窄报错 | 低 | 项目全部 selector 用法，预计零改动；构建即验 |
| 受控 nodes 同步与 ReactFlow 内部状态竞态（拖拽抖动） | 中 | 官方受控模式配方 + `applyNodeChanges`；S2 首项验证 |
| 双份鼠标事件体系（旧 window 监听 + RF 内部 d3-drag）冲突 | 低 | S2 中删除全部旧拖拽代码，避免共存 |

---

## 六、建议执行顺序

```
S1 升级（0.5d，独立 revert 点）
 └─ S2 ReactFlow 骨架（1.5d）
     └─ S3 自环+修饰键（1d）   ← 若方案 A 失败此处触发 B 方案决策
         └─ S4 增强红利（0.5d，可选）
```

每个阶段独立 commit + `npm run build` + 手测清单（拖入/拖出/五类边建删改/三视图标记/持久化往返/Tauri 双通道），任一阶段失败可停在上一阶段，功能不受损。
