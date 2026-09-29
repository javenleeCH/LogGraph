# EPL/CEP 规则能力规格 — group 模式族增强（v3）

> 输入：OpenHarmony 日志故障规则场景的 EPL 能力清单（8 项）。
> 基线：现有五类边（seq/not/and/or/periodic）+ thread 作用域 + 时间窗。
> 目标：逐项评估「图形表达 / 引擎语义 / 差距 / 实施方案」，排定 P1~P4。

## 差距总览

| # | EPL 能力 | 现状 | 差距 | 图形表达 | 优先级 |
|---|----------|------|------|----------|--------|
| 1 | `every A -> B within 10s` 顺序时序 | ✅ seq 边 + maxGapMs | 无（`every` 语义=每个 A 独立匹配，已实现） | 现有 A→B 边 | 完成 |
| 2 | `every A -> not B within 5s` 否定 | ✅ not 边（纯断言） | 无 | 现有红色虚线边 | 完成 |
| 3 | `A (B|C)` OR 分支 | ✅ or 边（多目标） | 无 | 现有扇形分叉 | 完成 |
| 4 | `A B? C` **可选事件** | ❌ | 新边类型 `opt`（skip 容忍） | A→B 边标记 `?`，B→C 正常；A 可直接跳到 C | **P1** |
| 5 | `A{3}` / `A{2,5}` **循环次数** | ❌（periodic 是周期断言，非计数） | 节点/边属性 `count: [min,max]` | 节点角标 `{3}` / `{2,5}` | **P1** |
| 6 | `PARTITION BY pid` 分组 | ✅ scope=thread | 语义等价但字段固定为 thread | 已有 🧵 按钮；可扩展为「分组字段表达式」 | P3（扩展） |
| 7 | `MEASURES` 字段提取 | ❌ | 匹配链产出结构化记录（msg/ts/thread/来源 filter） | 无需画布元素：**DetailPanel 增加「链详情」卡** | **P2** |
| 8 | 事件内部条件 `tag='AMS' and msg like '%x%'` | ⚠️ 部分（Filter 本身即条件，但**匹配后不可再细化**） | 节点级**条件表达式**（在 filter 匹配集上二次过滤） | 双击节点弹条件编辑器 | **P2** |

---

## P1-A：可选边 `opt`（EPL `B?`）

### 语义
```
A --opt(B, W)--> C：
  窗口 W 内出现 B → 链走 A→B→C（B 步被消耗）
  窗口内先遇 C 或窗口耗尽 → B 缺省，链直接 A→C
  （与 seq 的区别：B 不出现不算断裂）
  插队规则沿用：窗口内先遇另一 A → 仍断裂
```
EPL 对应：`A -> B? -> C`（Esper 写法 `A -> (B -> C or C)` 的语法糖）。

### 数据模型
```ts
type EdgeKind = 'seq' | 'not' | 'and' | 'or' | 'periodic' | 'opt';
// opt 边：fromFilterId=A(实际是链上前驱), toFilterId=B
// 链解析：opt 边的目标节点「可跳过」——resolveChains 中 opt 边产生两条路径
//   （带 B 的长路径 + 跳过 B 的短路径），匹配时优先长路径（贪心：有 B 用 B）
```

### 引擎改动（SequenceMatcher.ts）
- `resolveChains`：opt 边分支为两条链（`[...acc, optEdge, ...后续]` 与 `[...acc, ...后续]`），链集合翻倍但每条仍线性
- `advanceEdge` 加 opt 分支：归并扫描遇 **链上下一目标的就绪事件** 或 **窗口耗尽** 都算「通过」（前者消耗 B，后者跳过）；**另一 A 插队仍断裂**
- 优先序：先试长路径（含 B），失败再试短路径——同一 A 事件只产出一条链

### 画布/交互
- 建边：**Ctrl+拖** → opt 边（与 Shift=AND / Alt=OR 并列）
- 渲染：组色**点线**（dasharray 2-4）+ 标签 `B? 1s`；节点 B 右上角 `?` 角标
- 编辑弹窗：kind 下拉加「可选 OPT（B 可缺省）」

## P1-B：循环计数 `count`（EPL `A{3}` / `A{2,5}`）

### 语义
```
节点属性 count = {min, max}（缺省 1,1）：
  A{3}    = 恰好连续 3 个 A（间隔任意 or 受周期约束？→ 本实现：受所在入边的 maxGapMs 约束）
  A{2,5}  = 连续 2~5 个 A，取「贪心最大」满足后续推进
  应用位置：**节点**（该 filter 在链中此步需重复出现 N 次）
```

### 数据模型
```ts
// FilterGroup.sequence 扩展：节点计数表（filterId → 次数约束）
export interface SequenceConfig {
  edges: SequenceEdge[];
  anomalyEnabled: boolean;
  scope?: 'global' | 'thread';
  /** 节点循环次数：filterId → [min, max]；缺省 [1,1] */
  nodeCounts?: Record<string, { min: number; max: number }>;
}
```

### 引擎改动
- `matchBucket` 推进前查 `nodeCounts`：当前步 filter 有 count 时，先在窗口内**连续收集**同 filter 未消耗事件（每个间隔 ≤ 入边 maxGapMs），收集数 c ∈ [min,max]；取 c=max 消耗，若后续推进失败回退 c=min 重试（局部回溯，深度 ≤ max）
- `A{3}` 表示 min=max=3；`A{2,5}` min=2,max=5；`A{3,}` min=3,max=∞
- 边统计按「组」计一次（不按内部重复次数）

### 画布/交互
- **双击节点** → 条件+计数编辑器（见 P2-B 合并）：`出现次数 [min] ~ [max]`
- 渲染：节点 label 后角标 `{3}` / `{2,5}`（紫底白字）
- 快捷：Alt+点击节点循环 +1（弹 toast 显示当前次数）——可选

---

## P2-A：MEASURES 链详情（字段提取展示）

### 语义
匹配链产出即「MEASURES」：链上每步的事件自带 msg/ts/thread/sourceFile/filterId。

### 实现（纯 UI，引擎已产出 MatchedChain）
- **DetailPanel**：选中链上事件时（或新增「链」实体选中态），展示整链卡片：
  ```
  ⛓ 链 #3（Group 1 · thread: pool-4）
  ┌ A  10:00:01.123  [AMS] schedule ipc msg=…
  ├ B? 10:00:01.130  (可选步命中)
  └ C  10:00:02.001  timeout=3000
  [复制为 JSON] [定位到时间线]
  ```
- TimelineCanvas：点链号角标 `#3` → 选中整链（三视图联动高亮已有基础）
- 「复制为 JSON」导出 MEASURES 结构（steps[].{filterId,label,ts,thread,raw}）

### 画布
无需新元素。EdgeEditModal 统计区加「查看命中链」按钮 → 跳最近一条链的 DetailPanel。

## P2-B：节点条件表达式（事件内部过滤）

### 语义
filter 已完成第一层筛选（pattern）；节点条件是**第二层运行时过滤**（对匹配事件再判表达式），用于同 filter 多场景复用：
```
节点 B 条件：level == 'E' && msg.includes('IPC timeout')
```

### 数据模型
```ts
// 条件挂在 sequence 上（每节点一份，属规则而非 filter 本体）
export interface SequenceConfig {
  ...
  /** 节点条件表达式：filterId → 表达式串（空串=无） */
  nodeConditions?: Record<string, string>;
}
```

### 引擎
- 轻量表达式求值：支持 `&& || () == != includes level thread ts>` 子集（自写 ~80 行 parser 或引 naruto-micro-expr 类 0 依赖库）
- `matchBucket` 的 `eventsOf(fid)` 出口处过滤（分桶后、匹配前），成本 O(events × expr)

### 画布/交互
- **双击节点** → 节点编辑弹窗（与 P1-B 合并）：
  ```
  ┌ 节点：Filter B ────────────┐
  │ 出现次数 [1] ~ [1]         │
  │ 条件表达式（对匹配事件二次过滤）│
  │ ┌──────────────────────┐  │
  │ │ level=='E' && msg.includes('IPC')│  │
  │ └──────────────────────┘  │
  │ [语法检查✓/✗]  实时命中预览 N/M │
  │ ─────────────────────────  │
  │ （filter 本体编辑 → 前往过滤器）│
  └───────────────────────────┘
  ```
- 渲染：有条件的节点加 `ƒ` 角标（青色）；有计数的加 `{n}` 角标（紫色）

---

## P3：PARTITION BY 通用化（scope 字段表达式）

现状 `scope='thread'` 硬绑 `LogEvent.thread`。通用化：

```ts
scope?: 'global' | 'thread' | { field: 'thread' | 'sourceFile' | 'expr', expr?: string };
```
- 内置枚举先行（thread/sourceFile），表达式分组远期（与 P2-B parser 共用）
- UI：作用域按钮变下拉（全局 / 按线程 / 按文件）
- **优先级最低**：现有 thread 覆盖 95% 日志场景，sourceFile 分组需求待真实样本确认

---

## EPL 双向翻译（远期，验收器）

`sequence → EPL 文本` 生成器（只读方向）：
```
A→B(1s) + A⃠E(2s) + B{2,3} + scope:thread ≡
context threadContext partition by thread
select * from pattern [
  every A -> B{2,3} where timer:within(1s) and not E where timer:within(2s) ]
```
用途：导出给 Esper 验证语义一致性（CI 金标准）、规则分享。**翻译器只做导出不做导入**——画布是唯一编辑源。

---

## 实施顺序与验收

| 阶段 | 内容 | 验收场景（tsx 脚本） |
|------|------|---------------------|
| **P1** | opt 边 + nodeCounts（模型/引擎/画布/弹窗） | `A X? C`：X 在→3 步链；X 缺→2 步链（X 不算异常）<br>`A{2,3}→B`：AAB 成链消耗 2A；AB 情况 min=2 断裂 |
| **P2** | 节点编辑弹窗（条件+次数）+ DetailPanel 链详情 + 复制 JSON | 条件 `level=='E'` 过滤后 INFO 级 B 不再推进；链卡展示/复制正确 |
| **P3** | scope 枚举扩展 | sourceFile 分桶各自匹配 |
| 远期 | EPL 导出器 | 五类边+计数+条件 → Esper 可执行文本 |

每阶段：引擎场景脚本全绿 → build → 浏览器手测 → 独立 commit。
