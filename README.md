# logGraph

一个 **Perfetto / SmartPerf 风格**的日志时间线分析器。核心理念：

> 你可以定义**多条正则/关键词过滤器**，每条过滤器对应一条**堆叠的时间线轨道（lane）**，共享同一根时间轴。通过轨道间的**垂直对齐**，多个搜索结果之间基于时间维度的关联一目了然——无需像 Notepad++ 那样靠人工对照前后时间戳来判断。

在此之上，logGraph 还支持把过滤器组织成**分组（group）**，用类 EPL/CEP 的**序列模式**（顺序 / 禁止 / 汇聚 / 分支 / 周期 / 可选 / 循环计数…）在时间轴上自动匹配事件链，实现故障规则的图形化编排与自动检测。

架构分三层：**引擎（纯 Rust：rg 直扫 + CEP）+ Tauri 薄壳 + React UI**。引擎同时提供**命令行 CLI**，全程**零数据库依赖**（扫描/解析/匹配全程流式、内存中只留命中行）；桌面端对超大日志目录（GB 级）用**纯内存瘦索引**驻留（行偏移 + 事件 SoA + 命中行号，无磁盘缓存）。

## ✨ 特性

### 时间线分析

- **多过滤器轨道**：每个过滤器一条 lane，颜色区分，实时匹配计数。
- **共享时间轴**：所有 lane 共用同一时间标尺，垂直对齐即时间关联。
- **缩放 / 平移**：滚轮缩放（以鼠标为中心），拖拽平移。
- **游标（Scrubber）**：点击轴可放置贯穿所有 lane 的游标，显示时间标签。
- **关联高亮 + 连线**：选中某事件后，跨 lane 时间窗口内（默认可见范围的 2%，自适应）的事件自动高亮并连线。
- **Minimap**：底部缩略图全局导航，可拖拽移动视口。
- **时间戳自动探测**：支持 `YYYY-MM-DD HH:mm:ss.SSS`、ISO 8601、syslog、`HH:mm:ss`、Unix epoch。

### 多视图

- **表格流 / 时间线** 一键切换：表格流（LogStreamView）按过滤器分列展示命中行，dbMode 下行文本惰性按需加载。
- **节点画布（分组编辑器）**：基于 ReactFlow（`@xyflow/react` v12），带 MiniMap / 框选 / 网格吸附，用于编排过滤器分组与序列关系。

### 过滤器分组与序列匹配（EPL / CEP 风格）

- **六种边类型**：`seq`（顺序 `A -> B within W`）、`not`（禁止 `not B within W`）、`and`（多目标汇聚）、`or`（分支）、`periodic`（自环周期心跳断言，含延迟 / 抖动统计）、`opt`（可选事件 `B?`，缺省不断裂）。
- **节点能力**：循环计数 `A{3}` / `A{2,5}`（节点角标）、节点级条件表达式（在 filter 命中集上二次过滤，双击节点编辑）。
- **作用域**：`global` 全局时间轴 / `thread` 按线程字段分桶隔离（等价 `PARTITION BY`），杜绝多线程交织误配。
- **结果消费**：详情面板「匹配结果」Tab 展示匹配链 / 异常列表，支持检索与 focusEvent 定位回时间线。
- **建边手势**：拖拽 = `seq`，`Shift` = AND，`Alt` = OR，`Ctrl/⌘` = OPT，自环 = periodic。
- 设计文档见 [`plans/pattern-family-spec.md`](plans/pattern-family-spec.md)、[`plans/epl-cep-spec.md`](plans/epl-cep-spec.md)。

#### 节点条件表达式（字段与语法全集）

节点约束弹窗（画布上**双击节点**）的「条件表达式」在 filter 命中集上做二次过滤：filter 是粗筛（正则），表达式是细筛（事件字段级）。语法为 EPL 事件内部条件的子集，零依赖递归下降实现（[`src/sequence/expr.ts`](src/sequence/expr.ts)）。

**字段**（6 个实际字段，8 个可用名；别名等价）：

| 字段 | 别名 | 类型 | 含义 |
|---|---|---|---|
| `raw` | — | string | 原始整行（含时间戳 / 级别等前缀） |
| `msg` | `message` | string | 正文（剥离时间戳与级别后的消息体） |
| `thread` | — | string | 线程名；未解析出为空串（用 `thread == ''` 判空） |
| `level` | — | string | 日志级别；未解析出为空串 |
| `ts` | — | number | 毫秒级 Unix 时间戳 |
| `sourceFile` | `file` | string | 来源文件名（多文件合并时区分来源） |

**运算符**（优先级从低到高）：

| 运算符 | 语义 |
|---|---|
| `\|\|` | 逻辑或（优先级最低） |
| `&&` | 逻辑与 |
| `==` / `!=` | 严格相等 / 不等（字符串精确比较，大小写敏感） |
| `>` `<` `>=` `<=` | 数值比较（两侧 `Number()` 转换，主要用于 `ts`） |
| `( ... )` | 括号提升优先级 |

**方法调用**（只能挂在字段上，参数必须是一个字符串字面量）：

| 方法 | 语义 |
|---|---|
| `field.includes('x')` | 子串包含（`contains` 为其别名，完全等价） |
| `field.startsWith('x')` | 前缀匹配 |
| `field.endsWith('x')` | 后缀匹配 |

**字面量**：`'…'` / `"…"` 字符串（支持 `\` 转义）；`123` / `1.5` 数字。

**求值语义**：

- 表达式为真 → 事件参与序列链；为假 → 从该节点的匹配集中剔除。
- 求值异常（如未知字段）按 **false** 处理——保守策略：条件错 = 不匹配。
- 表达式非法时编译返回 null → 该节点按「不过滤」处理；弹窗内实时标红并给出错误原因与命中预览。

**示例**：

```
level == 'E' && msg.includes('IPC timeout')
thread != 'pool-4' || msg.startsWith('FATAL')
ts >= 1760000000000 && raw.contains('handshake')
level == '' || msg.endsWith('!')
```

### 引擎 CLI（无数据库）

- **rg 同内核全家桶**：`ignore`（尊重 `.gitignore` / `.ignore` / `.rgignore` / 全局 gitignore / `info/exclude`，默认跳过隐藏文件）+ `grep-searcher`（mmap + SIMD + memchr）+ `grep-regex`，速度与语义对齐命令行 rg。
- **rg 没有的 CEP**：一条命令完成「多过滤器扫描 → 时间戳提取 → 序列模式匹配」，直接输出匹配链 / NOT 违规 / 边统计。
- **开关**：`-i` 忽略大小写、`-F` 纯文本（默认正则）、`-g` glob（`!` 排除，可多次）、`--hidden`、`--no-ignore`、`--json` 结构化输出。
- 规则样例见 [`sample/cep-rules.example.json`](sample/cep-rules.example.json)。

### 大规模日志（桌面端 dbMode）

- **原始文件即数据库**：目录「全选 + 加载」进入 dbMode——打开只做便宜通道（并行读 +
  行偏移 + 行数 + 首/末行时间戳），内存只驻留行偏移表与每过滤器 (line, ts) 命中缓存，
  **绝不存文本、无逐行事件索引**；命中行的 ts 在过滤扫描时内联解析（只对命中行付费）。
- **无磁盘缓存**：不写任何索引文件——重开目录即全量重建，800MB / 1016 万行实测 **0.21s**。
- **量级参考**（800MB / 8 文件 / 1016 万行 / 33.9 万命中 × 2 过滤器）：打开 0.21s、
  点击加载 → 命中显示 1.73s（含渲染）、单遍批量过滤（含内联 ts + 关联 + 编码）0.32s、
  数据层驻留 ~75MB（行偏移 48MB + 命中 26MB）；选中事件上下文按行偏移 seek 直读毫秒级。
- **纯前端性能**：渲染脏标记 + 视口二分裁剪（静止 0 CPU、交互 O(可见)）、单 filter 增量重算 + 分块异步调度（百万行编辑过滤器不阻塞主线程）、minimap 离屏预渲染。

### 工作区与交互

- **目录即工作区**：打开目录自动持久化 / 恢复用户状态到 `<目录>/.logGraph/`（浏览器与桌面同协议）。
- **文件树面板**：左侧目录内日志文件树，支持单选 / 多选 / 全选加载；**部分勾选同样走 dbMode**（子集建库，屏蔽任意文件检索速度与全选一致）。
- **排除规则（glob）**：文件树头部漏斗按钮，每行一条（如 `*.gz`、`debug/**`）；不含 `/` 对文件名匹配，含 `/` 对相对路径匹配（`**` 跨目录、`*` 不跨，对齐 rg `-g '!pat'`）。命中的文件 / 目录整棵子树不参与枚举与加载，规则持久化到工作区；前端是文件清单唯一权威（Rust 建库只接收最终清单，无第二套 glob）。
- **⌘K / Ctrl+K 命令面板**：高频操作收敛到一个可搜索入口（中文子串模糊匹配 + 英文关键词）。
- **Toast 反馈 + 可撤销删除**：删除过滤器 / 分组可在通知条一键撤销；剪贴板不可用时弹手动复制兜底。
- **拖拽加载**：直接把 `.log` / `.txt` 等文件或整个文件夹拖进窗口。
- **键盘快捷键**（与 Perfetto 一致）：
  - `W` / `S` —— 以**鼠标所在位置**为中心放大 / 缩小
  - `A` / `D` —— 向左 / 向右平移（Perfetto 式平滑弹簧动画，按住加速）
  - `←` / `→` —— 在选中 lane 内前后跳转事件
  - `Esc` —— 取消选中 / 清除游标
  - `Ctrl/⌘ + K` —— 命令面板；`Ctrl/⌘ + C` —— 复制选中行原文；`?` —— 快捷键速查

## 🚀 快速开始

```bash
npm install
npm run dev        # 开发服务器 http://localhost:5180
npm run build      # 生产构建到 dist/

npm run tauri:dev  # 桌面开发模式（自动起 vite + cargo build 后打开窗口）
npm run tauri:build  # 构建 release 便携版（--no-bundle，产物 src-tauri/target/release/logGraph.exe，单文件直接运行）

npm run test:wasm  # wasm 正则引擎冒烟测试（12 项）

# 引擎 CLI（纯 Rust，无数据库）
cargo run -p loggraph-cli -- search sample -i "ERROR|FATAL"
cargo run -p loggraph-cli -- cep sample -R sample/cep-rules.example.json
cargo install --path cli   # 安装 loggraph 命令到 PATH

cargo build --release -p loggraph-cli  # 性能基准请用 release（debug 慢一个数量级）

cargo test -p loggraph-engine   # 引擎单测（42 项：search/parser/cep/rules）
cd src-tauri && cargo test      # 桌面侧单测
```

### CLI 用法

```bash
# 搜索（默认正则，与 rg 一致；-F 切字面量）
loggraph search <文件或目录> <模式> [-i] [-F] [-g '<glob>'] [--hidden] [--no-ignore] [--json]

# CEP：`.cep.json` 规则文件描述过滤器与分组/边（先过 schema 校验）
loggraph cep <文件或目录> -R <rules.cep.json> [--json] [--fail-on-violation] [--fail-on-unsupported]

# 规则文件校验（语法 + schema + 语义 S01–S10 / W01–W05）
loggraph validate <rules.cep.json> [--json]

# 导出规则 JSON Schema（管道给补全/LSP 用）
loggraph schema cep
```

**退出码**：`0` 成功（含校验通过）｜`1` 无命中 / 校验失败 / `--fail-on-violation` 触发｜`2` 错误（E_IO、E_RULES_* 等，错误信息走 stderr）｜`3` `--fail-on-unsupported` 触发（v1 不支持的特性走了 fallback）。

`.cep.json` 格式（camelCase + `$schema`/`version` 声明，完整契约见 `plans/engine-cli-api-contract.md` §3，示例见 `sample/cep-rules.example.json`）：

```json
{
  "$schema": "https://loggraph.dev/schemas/cep-rules-1.schema.json",
  "version": 1,
  "filters": [
    { "id": "A", "label": "启动完成", "pattern": "启动完成", "isRegex": false, "caseSensitive": true }
  ],
  "groups": [
    {
      "groupId": "g1", "filterIds": ["A", "B"], "scope": "global",
      "edges": [
        { "id": "e1", "fromFilterId": "A", "toFilterId": "B",
          "kind": "seq", "maxGapMs": 20000 }
      ]
    }
  ]
}
```

打开应用后：
1. 点击 **「📂 打开日志」** 或把日志文件拖进窗口（可用 `sample/sample.log` 测试）；也可以 **「打开目录」** 加载整个日志目录（左侧文件树可单选 / 全选加载）。
2. 在左侧 **过滤器** 面板点击 **「+ 新增」**，输入关键词或正则。
3. 每条过滤器会生成一条轨道，匹配事件以彩色竖条标记在时间轴上；表格流视图下按过滤器分列展示。
4. 点击任意事件 → 跨轨道时间相近的事件自动高亮并连线，详情面板显示上下文。
5. （进阶）创建**分组**并把过滤器加入，在节点画布上连边编排序列规则 → 详情面板「匹配结果」Tab 查看匹配链与异常。

## 🖥️ Tauri 桌面版

本项目已 Tauri 化（Tauri v2 + Rust + WebView2 / WKWebView）。桌面版与浏览器版共用同一套 React 代码，
`src/lib/tauri.ts` 在运行时检测是否处于 Tauri 容器，并据此切换文件读写后端：

| 能力 | 浏览器 | Tauri 桌面 |
|---|---|---|
| 打开日志 | `<input type=file>` | 系统文件对话框（`plugin-dialog`） |
| 拖拽加载 | HTML5 Drag & Drop | 原生文件拖放（`onDragDropEvent`） |
| 打开目录 | File System Access API | 系统目录对话框 + `plugin-fs` 递归枚举 |
| 工作区持久化 | 所选目录内 `.logGraph/filters.json`（FSA readwrite 授权） | 所选目录内 `.logGraph/`（`filters.json` + perf 日志，plugin-fs） |
| 日志解析 | JS 引擎（`LogParser`） | **Rust 原生引擎**（单文件 `parse_log` / 目录 `parse_dir`，进程内读文件+解析，大文本不过 IPC） |
| 正则过滤 | **wasm 版 Rust `regex`**（与桌面同引擎；加载失败回退 JS RegExp） | **Rust `regex`**（dbMode 下批量直扫） |
| 超大目录 | ✗（全量驻留内存，有内存墙） | ✓ **dbMode：regex 直扫 + 内存瘦索引** |

前置要求：Rust 工具链（`rustc`/`cargo`）与平台对应的 WebView（Windows 10/11 自带 WebView2）。

### Rust 解析引擎（双通道架构）

桌面端的日志解析在 Rust（loggraph-engine `parser` 模块，v1.2 自壳层下沉；壳层仅转发），与 JS 引擎语义逐条对齐（时间戳格式探测、
thread/level 提取、行分割、稳定排序、skipped 统计）：

- 前端统一入口 `src/parser/parseBridge.ts`：Tauri 下 `invoke('parse_log' | 'parse_dir')`
  由 Rust `std::fs` 直读文件并解析（目录批量解析 + 全局排序在 Rust 侧一次完成，单次 IPC，
  分块传输防 OOM）；浏览器下原样走 JS 引擎；
- **失败自动回退**：invoke 失败 / 返回异常时降级为 `plugin-fs` 读文本 + JS 解析，功能永不中断；
- 浏览器端不加载任何 `@tauri-apps/*` 模块（动态 import，构建产物按需分包）；
- 设计与语义对齐清单见 [`plans/rust-parser-design.md`](plans/rust-parser-design.md)。

### 大数据架构：原始文件即数据库（dbMode）

> 设计与实施记录见 [`plans/engine-cli-api-contract.md`](plans/engine-cli-api-contract.md)（v1.2：
> 引擎会话/解析下沉 + IPC⇄CLI 1:1）与 [`plans/rust-parser-design.md`](plans/rust-parser-design.md)。
> 演进：v1「SQL 存全量文本」建库膨胀 3GB+、数分钟（已废弃）→ v2 瘦 SQL 索引 →
> v3 纯内存驻留 → **v4 无逐行索引**——打开只做便宜通道，索引里没有的信息扫描时顺手就有。

- **打开 = 便宜通道**：worker 池并行 `fs::read` 原始字节 + 行偏移表 + 行数/空行统计 +
  每文件首/末行时间戳（时间轴范围 = 全局 min/max）。无逐行 ts 提取、无排序、
  无直查表、无 IPC 传输、无 JS 物化——800MB / 1016 万行实测 **210ms**。
- **过滤 = 并行直扫原文件**（`grep-searcher`：mmap + SIMD + memchr），命中行的 ts
  在扫描时内联解析（`line_ts_of`，仅命中行付费）；命中缓存 `filter_id → (line, ts)`
  升序驻留，指纹命中免重扫。真实数据（3.3% 命中率）扫描与 v3 无 ts 版持平。
- **上下文按需读**：选中事件 → 按行偏移 seek 直读原文件上下文（默认 ±8 行），毫秒级，
  文本永不驻留。
- **序列下推**：`ws_sequences` 直接从命中缓存取 (line, ts) 事件流跑贪心链匹配
  （global + seq/and/or/not 边）；复杂条件自动回退前端 TS 引擎。
- **命中/视口行文本走二进制通道**（`tauri::ipc::Response`，SoA 布局，前端零对象解析）。
- **dbMode 下双视图可用**：表格流惰性取行文本，时间线视口裁剪，不强制单一视图。

实测（800MB / 8 文件 / 1016 万行，release，桌面 app 端到端）：

| 操作 | v3（逐行事件索引） | v4（便宜通道 + 内联 ts） |
|---|---|---|
| 打开目录（Rust `ws_info`） | 4.18s（提取+排序全量 ts） | **0.21s**（20×） |
| 点击「加载」→ 命中显示（含渲染） | ~9s（索引 IPC + JS 物化） | **1.73s**（5.2×） |
| 首轮过滤扫描（2 过滤器，33.9 万命中） | ~0.31s | 0.32s（持平） |
| 常驻内存（数据层） | ~145MB（事件 SoA+直查表） | **~48MB**（行偏移，-67%） |

bench（600MB / 640 万行，`cargo test --release -- --ignored bench_ws_filters_scale`）：
建库 2.79s（串行）→ 1.26s（文件级并行）→ **0.167s**（便宜通道）；命中数逐字节不变。

### Web / Desktop 引擎一致性

两端「过滤结果」「解析结果」曾存在肉眼可见差异（JS `RegExp` vs Rust `regex` 引擎不同、
两套独立解析器），现已统一并增强自检（检视报告见
[`plans/web-desktop-consistency-review.md`](plans/web-desktop-consistency-review.md)）：

- **正则引擎统一**：新增 `filter-wasm/` crate 把标准 Rust `regex` crate 编译为 WASM
  （产物 `src/filters/wasm-filter/pkg/`，随仓库提交），浏览器端正则过滤优先走该引擎——
  与桌面**同一 crate、同一默认 Unicode 模式**，环视 / 反向引用两端同样拒绝，`\b`/`\d`
  语义逐字节一致；wasm 加载失败自动回退 JS RegExp 并在过滤器编辑条显示回退提示。
  重新编译需 `rustup target add wasm32-unknown-unknown` + `wasm-bindgen-cli`，然后
  `npm run build:wasm`。
- **双引擎解析自检**：`?dualengine=1` 或 **dev 构建**默认开启——JS/Rust 双引擎并行解析并深度
  比对，差异除输出 DevTools console 外，还会在窗口顶部弹红色非阻塞告警横幅
  （`ParserDriftBanner`），开发态解析漂移立刻可见；生产构建不触发（避免重复解析开销）。

## 📐 技术栈

| 关注点 | 选型 |
|---|---|
| 构建 | Vite 8 + TypeScript 5.9 |
| UI 框架 | React 19 |
| 时间线渲染 | 原生 HTML5 Canvas 2D（脏标记渲染 + 视口二分裁剪） |
| 节点画布 | @xyflow/react v12（ReactFlow） |
| 状态管理 | Zustand 5 |
| 样式 | CSS Modules |
| 核心引擎 | Rust：`ignore` + `grep-searcher` + `grep-regex` + `regex`（第一版无数据库） |
| 引擎 CLI | clap v4（`loggraph` 命令：search / cep / validate / schema 四个子命令） |
| 桌面打包 | Tauri v2（Rust + WebView2 / WKWebView） |
| 桌面数据层 | Rust `regex` 直扫（multi_line + prefilter）+ 内存 SoA 索引（`parking_lot` 锁，无数据库） |
| Web 正则引擎 | wasm-bindgen 编译的 Rust `regex` crate |

## 🗂️ 项目结构

```
src/
  main.tsx                      # 入口
  App.tsx                       # 布局壳 + 拖拽加载（含 Tauri 原生拖放）+ wasm 预热
  types.ts                      # 核心数据模型（过滤器 / 分组 / 序列边 / 事件）
  store/
    logStore.ts                 # Zustand 全局状态（含 dbMode 数据驻留）
    uiStore.ts                  # Toast / 忙碌指示 / 通知
    undoable.ts                 # 可撤销删除（过滤器 / 分组）
  lib/tauri.ts                  # Tauri 运行时检测 + 动态加载
  parser/
    LogParser.ts                # 文本 -> LogEvent[]
    parseBridge.ts              # 解析桥（JS/Rust 双通道 + 双引擎自检）
    timestampFormats.ts         # 时间戳格式预设与自动探测
  filters/
    FilterEngine.ts             # 事件 <-> 过滤器匹配（增量重算 + 分块异步）
    regexWasm.ts                # wasm 版 Rust regex 加载 / 编译 / 校验
    wasm-filter/pkg/            # wasm 产物（随仓库提交）
  sequence/
    expr.ts                     # 节点条件表达式
    SequenceMatcher.ts          # 序列链匹配（六种边 + thread 分桶 + 循环计数）
  io/
    openLogFlow.ts              # 打开日志统一入口（单文件 / 目录）
    fileLoader.ts               # 文件加载（浏览器/Tauri 双后端）
    dirLoader.ts                # 目录枚举 + 多文件合并（双后端）
    filterPersist.ts            # 工作区持久化 .logGraph（双后端）
    dbStore.ts                  # dbMode 桥接（ws_info / ws_filters / 按需上下文；REST 客户端持有 ctx）
  timeline/
    TimelineCanvas.tsx          # Canvas 宿主 + 交互（脏标记渲染）
    renderers.ts                # 轴/lane/事件/minimap/连线绘制
    correlation.ts              # 跨 lane 时间邻近查找（二分）
    zoomPanAnimator.ts          # 缩放/平移弹簧动画（W/S/A/D 按键）
    layout.ts                   # 布局常量
  components/
    Toolbar.tsx                 # 顶栏（视图切换 / 命令面板入口 / 状态栏）
    FileTreePanel.tsx           # 日志文件树（全选加载 → dbMode）
    FilterBar / FilterChips     # 过滤器编辑 / 启停 chips
    SidePanel.tsx               # 左侧栏（文件树 + 过滤器/分组列表）
    LogStreamView.tsx           # 表格流视图（按过滤器分列）
    DetailPanel.tsx             # 选中事件详情 + 上下文 + 匹配结果 Tab
    GroupMatchesTab.tsx         # 匹配链 / 异常列表 / 检索 / focusEvent
    NodeCanvasView.tsx          # 分组编辑页（节点画布 + 边编辑弹窗）
    flow/                       # ReactFlow 画布 / 节点 / 边组件
    CommandPalette.tsx          # ⌘K 命令面板
    ToastHost.tsx               # Toast 通知 + 忙碌指示
    ParserDriftBanner.tsx       # 双引擎解析漂移告警横幅
    ManualCopyDialog.tsx        # 复制兜底（剪贴板不可用手动复制）
engine/                         # 纯 Rust 引擎（无 tauri、零数据库、零文件写副作用）
  src/
    search.rs                   # rg 直扫（grep-searcher + grep-regex）+ ignore 遍历
    parser/                     # 时间戳探测/提取（5 格式）+ 行解析 + 目录流水线
    session.rs                  # 目录工作区：ctx 快照（build_ctx/from_ctx）+ 过滤扫描
                                 # + `.logGraph` 透明内容寻址缓存 + 行偏移懒建 + CEP 事件源
    cep.rs                      # CEP 序列匹配纯算法（seq/not/and/or…）
    pipeline.rs                 # 无数据库流水线：扫描→时间戳→CEP
    rules.rs                    # .cep 规则文件装载与三层校验
cli/                            # 引擎 CLI（loggraph 命令，clap v4；ws 子命令与 IPC 1:1）
src-tauri/
  src/
    parser/                     # 解析命令转发（parse_log / parse_dir，语义对齐 JS）
    ws.rs                       # 数据层 REST 命令（ws_info / ws_filters / ws_lines / …，
                                 # 无状态：dir+ctx 自描述；缓存工件落盘 + perf 日志）
    engine_api.rs               # engine_* 直扫命令转发（search / cep / rules / walk）
  tauri.conf.json               # 窗口 / 构建 / 打包配置
  capabilities/default.json     # 对话框 + 文件系统权限
filter-wasm/                    # wasm crate：Rust regex 编译给浏览器端
plans/                          # 设计文档与改动计划（架构 / 规格 / 检视）
scripts/test-wasm-regex.mjs     # wasm 正则冒烟测试
```

## 🔗 关联逻辑说明

选中事件（或激活游标）后，系统以该时间戳为中心，在 `[中心 - 半窗, 中心 + 半窗]` 范围内，用**二分查找**快速定位每个 lane 的事件并高亮。半窗大小默认**自适应**为当前可见时间范围的 2%——即放大查看时窗口自动收窄，概览时窗口自动放宽。可在 [`logStore`](src/store/logStore.ts) 中通过 `setCorrelationWindow` 切换为固定窗口。

## 📄 许可

MIT
