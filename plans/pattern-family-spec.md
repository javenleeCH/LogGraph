# 组合匹配模式族规格（v2）

> 基于 [sequence-graph-design.md](./sequence-graph-design.md)（v1 串行序列）的扩展规格。
> 本文档细化选定模式族的：数据模型、匹配语义、渲染样式、编辑交互、实施顺序。
> **评审通过后再进入实现。**

## 选定模式族（本次范围）

| # | 模式 | 类型归属 | 选定理由 |
|---|------|----------|----------|
| 1 | **Session 线程隔离** | 作用域修饰符 | 修复多线程交织误配；`LogEvent.thread` 已有，改动小正确性收益大 |
| 2 | **NOT 禁止边** | 一跳边类型 | 异常检测语义最小完备；归并扫描框架镜像复用 |
| 3 | **AND 汇聚 / OR 分支** | 一跳边类型 | 覆盖一对多场景；与 SEQ/NOT 构成一跳逻辑完备集 |
| 4 | **Periodic 周期心跳** | 时间结构 | 自环边；现有「插队断裂」语义的正面利用，运维刚需 |

**明确排除**（远期另行评审）：XOR（用 AND+NOT 可组合表达）、minGap 双边窗、变量绑定捕获组、FSM 全局状态机。

---

## 1. 数据模型

### 1.1 `src/types.ts` 边类型扩展

```ts
/** 边类型 */
export type EdgeKind = 'seq' | 'not' | 'and' | 'or' | 'periodic';

export interface SequenceEdge {
  id: string;
  fromFilterId: string;
  /** seq/not：单一目标；and/or：多目标（toFilterIds 非空时以 toFilterIds 为准） */
  toFilterId: string;
  toFilterIds?: string[];          // and/or 专用
  /** 边类型，缺省 'seq'（v1 数据向后兼容） */
  kind?: EdgeKind;
  /** seq/not/and/or：目标须在 (tsA, tsA+maxGapMs] 内；periodic：期望周期 P 的容差上限 */
  maxGapMs: number;
  /** periodic 专用：期望周期毫秒（maxGapMs 此时作为容差：间隔 ∈ [P-δ, P+δ]，δ=maxGapMs） */
  periodMs?: number;
}
```

**向后兼容**：v1 的 filters.json 中 `kind`/`toFilterIds`/`periodMs` 缺失 → 读入时补 `kind:'seq'`，其余字段可选不动。

### 1.2 `SequenceConfig` 作用域扩展

```ts
export interface SequenceConfig {
  edges: SequenceEdge[];
  anomalyEnabled: boolean;
  /** 匹配作用域：global=全局时间轴（v1 行为）；thread=按 thread 字段分桶隔离 */
  scope?: 'global' | 'thread';   // 缺省 'global'
}
```

### 1.3 匹配结果扩展

```ts
export interface MatchedChain {
  chainIndex: number;
  steps: { edgeId: string | null; filterId: string; event: LogEvent }[];
  startTs: number;
  endTs: number;
  /** 该链所属会话（scope='thread' 时的 thread 值；global 为 null） */
  thread?: string | null;
}

export interface SequenceEdgeStat {
  edgeId: string;
  matchedCount: number;
  missCount: number;
  /** periodic 专用：间隔超期次数（心跳延迟/缺失） */
  lateCount?: number;
  /** periodic 专用：间隔过密次数（抖动） */
  jitterCount?: number;
}

/** period 心跳断言结果：一组连续心跳 + 缺口 */
export interface HeartbeatGroup {
  filterId: string;
  thread?: string | null;
  /** 连续心跳段的 [startTs, endTs]（间隔均在容差内） */
  segments: { startTs: number; endTs: number }[];
  /** 异常缺口：期望心跳时刻附近无心跳 */
  gaps: { afterTs: number; expectedTs: number }[];
  /** 异常抖动：间隔 < P-δ 的相邻对 */
  jitters: { ts: number; interval: number }[];
}
```

`SequenceMatchResult` 增加 `heartbeats: HeartbeatGroup[]`（仅当组内有 periodic 边时非空）。

---

## 2. 匹配语义（`SequenceMatcher.ts`）

### 2.1 作用域分桶（Session 隔离）

```
matchGroup(config, filterIds, matchByFilterId):
  if scope === 'thread':
    按 ev.thread（null 归入 '∅' 桶）把各 filter 事件分桶
    对每个 thread 桶独立跑链匹配 → chains 带 thread 标记
    未覆盖事件 = 各桶未覆盖的并集（保持 ts 全局排序）
  else: 现有全局逻辑不变
```

线程内语义与全局完全一致（含插队断裂），只是竞争视野收窄到同 thread。

### 2.2 NOT 边（seq 的镜像）

```
推进 A --NOT--> B（窗口 W = maxGapMs）：
  归并扫描窗口内 from(A) ∪ B 事件：
    先遇到 B（未消耗）           → 违规！断裂，A 标异常（matchedCount 不变，记 violation）
    先遇到另一个 A 实例          → 本 A 的观察期提前结束，B 未出现 → 本边对该 A「通过」
    窗口耗尽，B 未出现           → 通过 ✓（A 保持正常，可继续链的后续推进）
```

**注意**：NOT 边「通过」不消耗任何事件（B 不存在才对），链推进时 cur 停留在 A。
NOT 边可以在链中间出现（A --NOT--> X --seq--> B：A 后禁止 X，且之后需 B）。

### 2.3 AND / OR 边（一对多）

```
推进 A --AND--> [B, C]（共享窗口 W，从 tsA 起算）：
  目标集合 T = {B, C}；对每个 t ∈ T 归并扫描：
    t 在 (tsA, tsA+W] 内有未消耗事件 → 标记就绪
  同时沿用插队规则：窗口内先遇另一 A 实例 → 断裂（A 的 AND 未完成）
  全部就绪 → 推进成功；任一缺失 → 断裂
  消耗：各目标取「窗口内最早未消耗事件」；同目标多实例不重复消耗

推进 A --OR--> [B, C]：
  任一就绪 → 推进，cur 移到「最早出现的那个就绪目标事件」
  全部缺失（且无插队）→ 断裂
```

### 2.4 Periodic 自环（心跳）

```
断言 A --periodic(P, δ)--> A：
  对 A 的事件序列 e₁, e₂, …（按 thread 桶隔离时按桶内序）：
    interval = eᵢ₊₁.ts - eᵢ.ts
    |interval - P| ≤ δ      → 正常段延续
    interval > P + δ        → 缺口 gap：期望 ts = eᵢ.ts + P，记录 { afterTs: eᵢ.ts, expectedTs }
    interval < P - δ        → 抖动 jitter：记录 { ts: eᵢ₊₁.ts, interval }
  输出 HeartbeatGroup：segments（正常段）+ gaps + jitters
  链匹配跳过 periodic 边（不参与贪心推进，独立断言）
```

periodic 边的 `toFilterId === fromFilterId` 在建边时校验强制（UI 层也只允许自环连线）。

### 2.5 复杂度

NOT/AND/OR 均为归并扫描变体：O(k · log M)（k=目标数，AND/OR 时）；分桶后总量不变。periodic 为线性扫描。

---

## 3. 渲染样式（NodeCanvasView 边层 + 视图标记）

### 3.1 画布边样式（SVG）

| 边类型 | 线型 | 颜色 | 箭头 | 中点标签 |
|--------|------|------|------|----------|
| seq（现状） | 实线 | 源 filter 色 | ➤ 实心 | `1s · 85%` |
| **not** | **虚线（密 4-3）** | **`--danger` 红** | **⊘ 禁止符（circle+斜杠，自定义 marker）** | `⃠ 1s · 0违规` |
| **and** | 实线主支 + **扇形分叉**（贝塞尔分别到各目标） | 源色 | 每支各一个 ➤ | 主干标 `AND · 2/2 · 1s` |
| **or** | 实线主支 + 扇形分叉 | 源色 | 就绪目标实线，未就绪目标**半透明** | 主干标 `OR · 任一 · 1s` |
| **periodic** | **自环**（节点右缘绕出的小圆环回到自身） | 源色 | 无 | 环侧标 `♥ 5s ±500ms` |

### 3.2 编辑交互（GroupEditorPage）

- **建边**：右缘热区拖出（不变）。落点判定按目标数区分：
  - 单目标 → kind 询问弹层（`seq / not` 二选一，默认 seq；从节点拖到自身 → 直接 periodic 配置弹窗）
  - **多目标建 and/or**：按住 `Shift` 从热区拖出 → 橡皮筋可连续点选多个目标节点（选中的节点高亮描边），Enter/双击确认 → kind=and；再按 `Alt` 确认 → kind=or（工具栏提示文案说明）
- **边编辑弹窗**（点击边/标签）：
  - kind 下拉切换（seq↔not 互切保留 maxGapMs；and↔or 互切；切换到 periodic 弹出周期+容差输入）
  - and/or：目标列表可增删（点 + 从成员 filter 选择）
  - periodic：`周期 P` + `容差 δ` 两个数字输入 + 实时统计（正常段数/缺口数/抖动数）
- **切断**：× 徽章逻辑不变（所有边类型通用）

### 3.3 视图标记（TimelineCanvas / LogStreamView）

| 边类型 | Timeline 呈现 | LogStream 卡片 |
|--------|---------------|----------------|
| not 违规 | A 事件红框 + 到违规 B 的**红色短虚线连线**（区别于链连线的组色实线） | A 卡片 `⃠违规` 红标 |
| and 就绪 | 链连线扇形展开（组色，各支箭头到各目标 lane） | 各目标卡片同链号 |
| or 就绪 | 只画实际走的那条支（未走的不画，避免视觉噪声） | 实际目标卡片链号 |
| periodic 正常段 | lane 上 A 事件的**底线连成段**（组色细线下划线标记连续段） | 段内卡片 `♥` 标 |
| periodic 缺口 | 期望时刻画 **红色 ⚠ + 虚线空洞标记**（在时间轴位置） | 无卡片（缺失即异常本身），缺口数进组头统计 |
| periodic 抖动 | 抖动事件黄色边框 | 卡片 `⚡` 黄标 |

### 3.4 作用域 UI

- GroupEditorPage 工具栏新增 scope 切换按钮：`🌐 全局 / 🧵 按线程`（`SequenceConfig.scope`）
- 切到 thread 后，链连线在 Timeline 上按 thread 着色可用**连线粗细或 dash pattern 区分**（同 thread 同 pattern，取 thread hash % 4 种 pattern），避免引入新颜色维度

---

## 4. Store 变更

```ts
// logStore.ts 新增/调整 actions：
setSequenceScope: (groupId: string, scope: 'global' | 'thread') => void;
addSequenceEdge: (groupId, from, to, opts?: { kind?: EdgeKind; toFilterIds?: string[]; periodMs?: number }) => string;
updateSequenceEdge: (groupId, edgeId, patch: Partial<SequenceEdge>) => void;  // 已有，支持 kind 切换
// removeSequenceEdge / toggleSequenceAnomaly 不变
```

`recomputeSequences` 内部按 2.1~2.5 分发；`runSequenceMatching` 返回结构增加 heartbeats。

---

## 5. 实施顺序（建议 4 个独立可交付的阶段）

| 阶段 | 内容 | 验证点 |
|------|------|--------|
| **P1 数据模型 + 作用域** | EdgeKind 枚举、SequenceEdge 扩展、scope 字段、持久化兼容读入、setSequenceScope、matchGroup 分桶；**行为不变**（kind 缺省 seq） | 多线程交织样例：分桶后 A₁A₂B₂B₁ 正确配对 |
| **P2 NOT 边** | 匹配镜像逻辑 + 画布虚线红边样式 + 禁止符 marker + 编辑弹窗 kind 切换 + Timeline 违规标记 | A 后 1s 内出现 ERROR → A 红框 + 红虚线 |
| **P3 AND / OR 边** | 多目标匹配 + Shift/Alt 多选建边 + 扇形渲染 + 编辑弹窗目标增删 + 视图扇形/单支呈现 | Fork 场景：A 后 B、C 都到才成链；OR 走最早支 |
| **P4 Periodic 心跳** | 自环边 + HeartbeatGroup 断言 + 自环渲染 + 周期编辑弹窗 + 段/缺口/抖动三态视图标记 | 心跳样例：抽掉一拍 → 缺口 ⚠；加密一拍 → 抖动 ⚡ |

每阶段结束跑 `npm run build` + 补一个 `scripts/verify-*.mts` 语义场景脚本（跑完即删，场景沉淀到本文档附录）。

---

## 附录 A：语义场景验收清单（实现时逐条核对）

```
Session 隔离:
  T1: 线程1 A₁→B₁、线程2 A₂→B₂ 交织（A₁A₂B₂B₁）→ 两条链各自正确配对
  T2: thread 为空的事件归入 '∅' 桶，不与有线程事件混配
  T3: scope=global 时行为与 v1 完全一致（回归）

NOT:
  N1: A 后窗口内出现 B → A 违规标红
  N2: A 后窗口内无 B → 通过，A 可继续链后续
  N3: 窗口内先出现另一 A → 观察期提前结束，本 A 通过
  N4: 链中间 NOT：A --NOT--> X --seq--> B 组合语义

AND:
  D1: A 后 B、C 都在窗口内 → 成链，三事件同链号
  D2: B 在、C 缺 → 断裂，A 与 B 未消耗
  D3: 窗口内另一 A 插队 → 断裂（沿用插队规则）

OR:
  R1: A 后仅 B 出现 → 成链走 B 支
  R2: B、C 都出现 → 成链走最早者
  R3: 都缺 → 断裂

Periodic:
  H1: 均匀心跳（P±δ 内）→ 单一正常段
  H2: 抽掉一拍 → gap 记录 + 视图 ⚠
  H3: 间隔过密 → jitter 记录 + ⚡
  H4: thread 桶隔离下各自独立断言
```
