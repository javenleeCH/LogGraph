# logGraph 产品优化计划 · 下一阶段（1–2 周）（2026-10-19）

> 依据：`plans/product-review-2026-10.md`（三层用户/兑现度框架）、
> `plans/product-rescore-2026-10-18-round13.md` 与
> `plans/product-rescore-2026-10-19-round14.md`（剩余可推动分数节）、README、
> 以及对相关源码的只读勘察（本文所有结论均附代码证据）。
> 基线：dev @ `026d28b`，综合 9.8（加权 9.30）；round 14 已注明 Rust 侧待验证机确认。

---

## 0. 框架回顾与阶段判断

初评的三层用户/兑现度模型到今天的变化：

| 层 | 用户 | 初评兑现度 | 当前兑现度 | 判断依据 |
|---|---|---|---|---|
| 第一层 | 排障的开发/运维（垂直对齐看关联） | ~85% | **~90%** | round 14 关闭截断痛点（异常 SoA 全量回传 + 面板虚拟滚动），「大目录看不到全貌」不再成立 |
| 第二层 | 把排障经验沉淀成规则的人（CEP 资产化） | ~40% | **~70%** | 规则导入/导出（`rulesIo.ts` + `exportRulesFile`）、scope=key 关联键分桶（round 12）、模板库/引导/「为何没匹配」（round 13 并分）均已落地 |
| 第三层 | 要把结论交付给别人的人（最后一公里） | ~10% | **~50%** | `exportMd.ts` 链/事件 Markdown、命中导出、逐链复制已有；**链/异常窗口整窗导出开发中** |

结论：第一层接近饱和，第二层还差「非专家零规则也能关联」（需求洞察 8.5→9.0 的下一档杠杆），
第三层的最后一块（链/异常窗口批量导出）已在开发。**下一阶段的正确配比是：
交付进位（发版）+ 第三层收尾（进行中）+ 第二层降门槛（自动发现关联键 MVP + 模板扩容）**，
而不是继续在第一层（渲染/性能）投入——那里已经过剩且工程维度封顶 9.5。

---

## 1. 优先级矩阵

分数拉动按复评惯例口径：维度分 × 权重 ≈ 加权分，感知分按档位约 +0.1/档
（权重：核心 30% / 工程 20% / UX 20% / 交付 20% / 需求 10%）。

| # | 候选项 | 用户痛感 | 工程成本 | 分数拉动 | 优先级 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 发版 + tag（含 `026d28b` Rust 侧验证） | 高（没人见过它=白做） | **S**（半天~1 天，验证机执行） | 交付 9.1→9.2（+0.02 加权）；验证全绿后十五轮可复核综合 9.9 | **P0** | 可立即启动 |
| 2 | 自动发现关联键（纯前端 MVP：嗅探→建议→一键填入） | **最高**（第二层天花板：非专家零规则关联） | **M**（2–4 天，纯 TS，零 engine 改动） | 需求洞察 8.5→9.0 的主要杠杆（+0.05 加权，感知 +0.1） | **P0** | 建议本轮做 |
| 3 | 模板库扩容（Spring Boot / logback / nginx / Python） | 中高（新手第一印象=模板覆盖度） | **S–M**（1–2 天，纯数据条目 + 一个可选字段） | 需求洞察 8.5→9.0 的辅助杠杆（与 #2 合并拉动） | **P1** | 建议本轮做 |
| 4 | 序列链 / 异常窗口导出 | 高（第三层最后一块） | M | 核心/交付随复核 | P0 | **已排期，本轮开发中**（另行开发线，见 §2.4） |
| 5 | #43 跨目录会话模型（唯一文件身份） | 中（异目录同名文件混淆，长尾场景） | L | 核心 9.5→9.6 的一部分 | **阻塞**（需先与用户对齐，round 13/14 均明确） | 不排期 |
| 6 | 纵轴时间编辑写回源文件 | 低（内存模式已可编辑；写回是边缘诉求） | **L + 高风险**（改用户日志原文件） | 核心 9.5→9.6 的一小部分（<0.01 加权） | **P2 搁置** | 不排期 |

---

## 2. 分项详述

### 2.1 发版 + tag（P0，成本 S）

**价值**：交付维度 9.1 长期钉住的唯一原因就是「dev 分支、未发版、未打 tag」；
round 13/14 均注明「发版后 +0.1」。同时 round 14 指出 `026d28b` 的 Rust 侧
（`build:wasm:cep` 重建 + `cargo test`）未在验证机跑过——发版流程天然把这次验证
带上，两件事一次闭环。发版还是初评 P1⑦（无 release）的正式关闭。

**范围**：
1. 验证机执行：`cargo test --workspace` + `npm run build:wasm:cep` + `vitest` + `tsc -b`，
   全绿后才可发版（round 14 明确「未验证不加码」口径，验证全绿后十五轮可复核综合 9.9）；
2. 版本进位：`package.json:4` 与 `src-tauri/tauri.conf.json:4` 当前均为 `0.2.7`，
   按近期引擎版本节奏（契约已到 engine ≥ 0.2.7）进位 `0.3.0` 并两处同步；
3. 打 tag（如 `v0.3.0`）+ 构建桌面 release 产物；
4. 发版说明引用 round 12–14 的能力清单（关联键分桶、模板库、异常全量回传等）。

**风险**：低，但有两项已知发布链路脆弱点（初评附 A ⑤ 实测记录）：
- WebView2 启用 GPU 时启动即崩溃（需 `--disable-gpu` 兜底）——发版前至少在 release note 提示，
  或按初评建议给 WebView2 加显式降级参数；
- `tauri-plugin-opener` 偶发编译崩溃（重跑即过）——构建失败先重试再排查，勿当阻塞。

**验收标准**：验证机三件套全绿；tag 存在且指向发版 commit；release 产物可双击启动；
round 15 复评把交付计入 9.2。

**依赖**：验证机（本机禁 Rust 工具链）；主会话统一 commit/push。

### 2.2 自动发现关联键 · 纯前端 MVP（P0，成本 M）

**价值**：round 13/14 一致认定需求洞察 8.5→9.0 的下一档杠杆是
「从能起步走到非专家零规则也能自动关联」。scope=key 能力已落地（round 12），
但**用户必须自己写出正确的 keyPattern 正则**——这正是「专家能力」与「开箱即用」
之间剩下的最后一道门。

**代码勘察结论——engine 侧不需要动，可拆出纯前端 MVP**：

- engine 的 key 路径是**用户显式正则、非启发式**（`engine/src/cep.rs:32-35`
  `key_pattern: Option<String>` 文档注释明确「用户显式定义（非启发式）」；
  `cep.rs:913-929` key 作用域实现；`cep-wasm/Cargo.toml:19` 注释同口径）。
  要在引擎里做自动发现 = 新工程（扫描期对 raw 做候选键统计、新 DTO 字段、契约升级），
  违背「保守降级、不误分桶」铁律的设计初衷，1–2 周内不可行。
- **但前端已有嗅探所需的全部原料**：
  - 内存模式：`FilterMatch.events` 就是完整 `LogEvent`（`src/types.ts:4-10`，
    含 `raw` 原始整行）——`useLogStore.getState().matches` 直接可采样；
  - dbMode：命中是骨架（`raw=''`，`LogStreamView.tsx:421` 注释），但
    `fetchLinesByIds`（`src/io/dbStore.ts:303`，底层 `ws_lines` 行偏移 seek 直读）
    已是现成的按行号批量取原文通道——采样几百行毫秒级；
  - 展示位现成：`keyHint.ts`（关联键质量提示）+ `CepTimelinePanel.tsx:579-586`
    的 hint 渲染模式；一键应用入口现成：`NodeCanvasView.tsx:132`
    `setSequenceKeyPattern`。

**MVP 范围（纯 TS，零 engine 改动）**：
1. 新模块 `src/sequence/keySuggest.ts`（纯函数，可单测）：内置候选键模式族
   （`traceId=…`、`requestId/request_id`、`X-Request-Id`、`spanId`、
   8/16/32 位 hex、UUID 等常见形态），对采样行做频率分析；
2. 质量门槛复用 `keyStats` 的指纹思想（契约 §3.13.1 / `keyHint.ts:31-70`）：
   候选须「覆盖率够高 + distinct/total 比适中」（每事件一键=桶碎裂，零键=退化全局），
   只把通过门槛的候选按置信度排序展示；
3. UI：scope=key 的正则输入框旁加「💡 检测关联键」按钮 → 弹建议列表
   （候选正则 + 覆盖率/键数预览）→ 点击即填入 keyPattern（走既有 `setSequenceKeyPattern`）；
4. dbMode 下采样走 `fetchLinesByIds`（从 `DbFilterHits.lines` 取样，`dbStore.ts:134-136`），
   采样上限（如 500 行）+ 均匀抽样，避免只看文件头。

**风险**：低——**只建议、不自动生效**，采纳与否由用户点击决定，
不触碰「保守降级」铁律；建议错了的后果与用户手写错正则完全等价（keyHint 会兜底提示）。

**验收标准**：对 `sample/distributed/` 三服务日志，一键检测出
`traceId=([0-9a-f]{8})` 形态候选且置信度排序合理；内存模式与 dbMode 双路径可用；
`keySuggest` 纯函数单测覆盖（零命中/每行一键/健康候选三类指纹）；
tsc 0 错、vitest 全绿。

**依赖**：无外部依赖；与 §2.4 的导出开发线文件不重叠（其改 `io/exportActions.ts`、
本项新增 `sequence/keySuggest.ts` + 少量 `NodeCanvasView.tsx` 改动，注意后者是
共享文件，落地前与开发线协调）。

### 2.3 模板库扩容（P1，成本 S–M）

**价值**：模板库是 round 13 需求洞察并分的三支柱之一；当前 5 条模板
（`src/sequence/templates.ts:112-231`：超时未响应 / 失败→重试 / 心跳丢失 /
启动后崩溃 / 死锁征兆）全是**通用关键词模板**，pattern 是
`'error|fail|失败|异常'` 这类占位正则。round 13/14 点名的扩容方向是
「覆盖常见框架（Spring/log4j/nginx/Python…）」——让 Spring 用户打开模板库
就能看到**自己日志格式**的规则，而不是自己翻译占位符。

**代码勘察结论——扩容是纯数据工作，结构已就绪**：

- `RuleTemplate`（`templates.ts:44-53`）已支持 `scope?: 'global' | 'thread' | 'key'`
  ——线程分桶模板（Spring Boot 多线程）与关联键模板（微服务 trace）**分桶能力模板已可表达**；
- `TemplateNode`（`templates.ts:18-31`）已支持 `condition?`（节点条件表达式）与
  `count?`（循环计数）——如 `level == 'ERROR'`、log4j2 `A{2,3}` 重试计数都能表达；
- `createGroupFromTemplate`（`templates.ts:61-109`）负责脚手架生成，扩容不改它。

**唯一缺口**：`RuleTemplate` 无 `keyPattern` 字段——「分布式追踪」模板需要它才能
一键生成 scope=key + 正则的完整规则（当前用户还得手填正则，恰好可被 §2.2 的
建议能力补上，二者协同）。补一个可选字段 + `createGroupFromTemplate` 透传，
约 10 行。

**范围**：
1. 新增框架模板（建议 6–8 条）：Spring Boot（`Started … in N seconds`、
   `tomcatThreadPool`、连接重置→重试故事线，scope=thread）、logback/log4j2
   （`Batch failed`→重试→提交、级别条件 `level == 'ERROR'`）、
   Python（traceback/`asyncio` 超时、多进程 `Process-N` 线程分桶）、
   nginx（upstream timeout / 5xx 聚簇，scope=global）、
   分布式追踪（scope=key + keyPattern，需字段扩展）；
2. pattern 直接采用各框架**真实日志文本**（仓库已有素材：
   `sample/springboot/order-service.log`、`sample/log4j2/legacy-service.log`、
   `sample/distributed/`），模板即开即验；
3. 模板单测：每条模板可被 `createGroupFromTemplate` 消费且生成的规则能对
   对应 sample 跑出链（防止模板自嗨）。

**风险**：极低——纯增量数据 + 一个可选字段；唯一注意点是
`⌘K` 模板组列表变长后的检索体验（命令面板已有中文子串模糊匹配，可直接消化）。

**验收标准**：模板库 ≥ 11 条且覆盖上述框架；新模板在对应 sample 上
一键创建→匹配出链的全流程可复现；单测全绿。

**依赖**：`RuleTemplate.keyPattern` 字段扩展（本项自带）；与 §2.2 共享
「关联键」叙事但代码不冲突。

### 2.4 序列链 / 异常窗口导出（P0，本轮已落地）

**状态：已随本轮提交实现**（`formatSequenceResultsMarkdown`/`formatSequenceGroupMarkdown` + `exportSequenceResultsMarkdown`/`exportSequenceGroupMarkdown` 动作 + 命令面板与 GroupMatchesTab 双入口；每类明细上限 500、计数走真值口径）。待验证机 vitest 复核。

代码基础已全部就绪，实现路径清晰：
- 整链导出：`src/io/exportMd.ts` 的 `formatChainsMarkdown`（多链→完整文档，
  含元信息头，`exportMd.ts:77-102`）已是批量导出的现成拼装件；
- 逐链复制已上线：`exportActions.ts:75-95` `copyChainMarkdown` +
  `GroupMatchesTab.tsx:250-255` 的逐链复制按钮——证明「链→Markdown」数据通路无缺口；
- 异常窗口：`src/sequence/anomalyWindows.ts` 的
  `aggregateAnomalyWindows`/`AnomalyWindow`/`formatAnomalySummary`（含
  零散/成簇/密集爆发分级）已把异常聚合成窗口，导出只需把窗口 + 桶内事件
  （`windowAt` 定位）拼进 Markdown；
- 文件落盘与反馈模式：照抄 `exportMatchesMarkdown`（`exportActions.ts:134-179`：
  `beginBusy` + `saveTextFile` + toast + 每过滤器节选上限 `EXPORT_MAX_PER_FILTER`）
  即可，注意沿用「节选上限」防几十万行导出。

**验收标准（供该开发线对齐）**：CEP 面板/命令面板可把当前分组（或时间窗内）的
链 + 异常窗口导出为单个 .md；链按 `formatChainMarkdown` 逐条、异常按窗口分级汇总；
大体量下有节选上限与真实计数标注；dbMode 双路径可用。

**依赖**：与 §2.2 在 `NodeCanvasView.tsx`/面板组件上有少量 UI 邻接，
落地顺序上建议导出线先行（已进行中），keySuggest 后并入。

### 2.5 #43 跨目录会话模型（阻塞项，不排期）

round 13/14 均明确：**需先与用户对齐，才能动工**。当前按 basename 去重，
异目录同名文件会混淆（唯一文件身份问题）。这是产品语义决策（会话=目录？
文件身份如何定义？跨目录书签/过滤器如何归属？），不是纯技术补丁——
在用户给出口径前排期就是赌方向。**行动项只有一个：把对齐问题带给用户**
（建议下一轮评审会上提出，附上现有 `filterPersist.ts` 的「目录即工作区」
语义作为讨论起点）。

### 2.6 纵轴时间编辑写回源文件（P2，搁置）

**勘察结论——高风险低回报，明确建议搁置**：

- 现状：`logStore.ts:382-384` `updateEventTs` 仅内存修改（注释明确
  「仅内存修改，dbMode 不支持；同 ts 的全部事件一起移动」）；
  dbMode 能力边界明示「纵轴时间列不可编辑（数据不可变改）」（`loadMode.ts:33`）。
- 写回源文件意味着：**修改用户的日志原文件**——而日志在真实场景中常是只读的、
  服务器上拉下来的副本、或需要保持取证完整性（改了时间戳=污染证据）；
- 技术连锁：写回后 dbMode 行偏移表、命中缓存（`DbFilterHits`）、时间轴范围全部失效，
  需要重建或增量维护；CRLF/编码/尾行保真、多文件合并时的目标文件定位、
  撤销语义（可撤销删除是既有承诺）每一项都是坑；
- 分数拉动 <0.01 加权（核心 9.5→9.6 的零头），痛感低（内存模式已可编辑，
  dbMode 的价值恰恰是「原文件即数据库」的不可变设计）。

若未来确有需求，正确形态大概率不是「写回原文件」而是
「导出修正副本」（走既有 `saveTextFile` 通道，新文件落盘，原文件不动）——
成本低一个数量级且无取证风险。本轮不做，留作候选。

---

## 3. 建议本轮只做

**做三件事，顺序即优先级：**

1. **发版 + tag（§2.1）**——验证机三件套全绿后进位 `0.3.0`、打 tag、出 release。
   成本最低、拉动确定（交付 9.1→9.2，且为 round 15 复核 9.9 扫清唯一保留项）。
   **先做**，因为它同时强制关闭 `026d28b` 的 Rust 侧验证悬置。
2. **自动发现关联键 · 纯前端 MVP（§2.2）**——`keySuggest.ts` 嗅探 + 建议 + 一键填入。
   这是需求洞察 8.5→9.0 的主杠杆，且纯 TS、零 engine 依赖、只建议不自动生效，
   风险可控；本机（node/tsc/vite）即可完成全部开发与验证。
3. **模板库扩容（§2.3）**——6–8 条框架模板 + `RuleTemplate.keyPattern` 字段扩展。
   与 #2 同属「降门槛」叙事，合并起来才够得着需求洞察的下一档；纯数据工作，
   可作为 #2 之间的填充任务。

**不做 / 不重复做：**
- 序列链/异常窗口导出：已排期、开发中（§2.4），本计划不另开线，仅对齐验收口径；
- #43 跨目录会话模型：阻塞于用户对齐（§2.5），本轮动作仅是「把问题带给用户」；
- 纵轴时间编辑写回源文件：高风险（改用户原文件 + 取证污染）低回报（<0.01 加权），
  明确搁置（§2.6）；未来若做，改走「导出修正副本」形态。

**取舍逻辑**：本机无 Rust 工具链的约束下，三个「做」全部是纯 TS/流程动作，
engine 零改动；唯一需要验证机的部分（发版前的三件套）本就是发版流程的固有环节。
一轮做完，下一轮复评的期望落点：交付 9.2 + 需求洞察向 9.0 迈进 +
第三层兑现度 ~50%→~80%——综合有望从 9.8 进位 9.9。
