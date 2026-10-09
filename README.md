# logGraph

一个 **Perfetto / SmartPerf 风格**的日志时间线分析器。核心理念：

> 你可以定义**多条正则/关键词过滤器**，每条过滤器对应一条**堆叠的时间线轨道（lane）**，共享同一根时间轴。通过轨道间的**垂直对齐**，多个搜索结果之间基于时间维度的关联一目了然——无需像 Notepad++ 那样靠人工对照前后时间戳来判断。

在此之上，logGraph 还支持把过滤器组织成**分组（group）**，用类 EPL/CEP 的**序列模式**（顺序 / 禁止 / 汇聚 / 分支 / 周期 / 可选 / 循环计数…）在时间轴上自动匹配事件链，实现故障规则的图形化编排与自动检测。

架构分三层：**引擎（纯 Rust：rg 直扫 + CEP）+ Tauri 薄壳 + React UI**。引擎同时提供**命令行 CLI**，第一版**零数据库依赖**（不引入 SQLite，扫描/解析/匹配全程流式、内存中只留命中行）；桌面端对超大日志目录（GB 级）另有 **rg 直扫 + 瘦 SQL** 的可选驻留路径。

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

### 引擎 CLI（无数据库）

- **rg 同内核全家桶**：`ignore`（尊重 `.gitignore` / `.ignore` / `.rgignore` / 全局 gitignore / `info/exclude`，默认跳过隐藏文件）+ `grep-searcher`（mmap + SIMD + memchr）+ `grep-regex`，速度与语义对齐命令行 rg。
- **rg 没有的 CEP**：一条命令完成「多过滤器扫描 → 时间戳提取 → 序列模式匹配」，直接输出匹配链 / NOT 违规 / 边统计。
- **开关**：`-i` 忽略大小写、`-F` 纯文本（默认正则）、`-g` glob（`!` 排除，可多次）、`--hidden`、`--no-ignore`、`--json` 结构化输出。
- 规则样例见 [`sample/cep-rules.example.json`](sample/cep-rules.example.json)。

### 大规模日志（桌面端 dbMode）

- **原始文件即数据库**：目录「全选 + 加载」进入 dbMode——rg 内核（`grep-searcher`）直扫原文件做过滤，SQLite 只存瘦索引与命中结果，**绝不存文本**。
- **指纹缓存**：`<目录>/.logGraph/cache.db` 记录文件指纹（路径+大小+mtime），目录未变化时**二次打开 < 0.5s**。
- **量级参考**（720MB / 141 文件 / 约 500 万事件行）：首次建索引 2~5s（带进度）、过滤 ~1s（与 rg 命令行同速）、选中事件上下文按行号 mmap 直读毫秒级。
- **纯前端性能**：渲染脏标记 + 视口二分裁剪（静止 0 CPU、交互 O(可见)）、单 filter 增量重算 + 分块异步调度（百万行编辑过滤器不阻塞主线程）、minimap 离屏预渲染。

### 工作区与交互

- **目录即工作区**：打开目录自动持久化 / 恢复用户状态到 `<目录>/.logGraph/`（浏览器与桌面同协议）。
- **文件树面板**：左侧目录内日志文件树，支持单选 / 多选 / 全选加载（全选走 dbMode 大数据路径）。
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
npm run tauri:build  # 打包桌面安装包（产物在 src-tauri/target/release/bundle/）

npm run test:wasm  # wasm 正则引擎冒烟测试（12 项）

# 引擎 CLI（纯 Rust，无数据库）
cargo run -p loggraph-cli -- search sample -i "ERROR|FATAL"
cargo run -p loggraph-cli -- cep sample -R sample/cep-rules.example.json
cargo install --path cli   # 安装 loggraph 命令到 PATH

cargo test -p loggraph-engine   # 引擎单测（19 项）
cd src-tauri && cargo test      # 桌面侧单测
```

### CLI 用法

```bash
# 搜索（默认正则，与 rg 一致；-F 切字面量）
loggraph search <文件或目录> <模式> [-i] [-F] [-g '<glob>'] [--hidden] [--no-ignore] [--json]

# CEP：规则文件描述过滤器与分组/边
loggraph cep <文件或目录> -R <rules.json> [--json]
```

`rules.json` 格式（camelCase，与 UI 数据模型一致）：

```json
{
  "filters": [
    { "id": "A", "pattern": "启动完成", "isRegex": false, "caseSensitive": true }
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
| 工作区持久化 | 所选目录内 `.logGraph/filters.json`（FSA readwrite 授权） | 所选目录内 `.logGraph/`（`filters.json` + `cache.db`，plugin-fs） |
| 日志解析 | JS 引擎（`LogParser`） | **Rust 原生引擎**（单文件 `parse_log` / 目录 `parse_dir`，进程内读文件+解析，大文本不过 IPC） |
| 正则过滤 | **wasm 版 Rust `regex`**（与桌面同引擎；加载失败回退 JS RegExp） | **Rust `regex`**（dbMode 下 rg 直扫） |
| 超大目录 | ✗（全量驻留内存，有内存墙） | ✓ **dbMode：rg 直扫 + 瘦 SQL** |

前置要求：Rust 工具链（`rustc`/`cargo`）与平台对应的 WebView（Windows 10/11 自带 WebView2）。

### Rust 解析引擎（双通道架构）

桌面端的日志解析在 Rust（`src-tauri/src/parser/`），与 JS 引擎语义逐条对齐（时间戳格式探测、
thread/level 提取、行分割、稳定排序、skipped 统计）：

- 前端统一入口 `src/parser/parseBridge.ts`：Tauri 下 `invoke('parse_log' | 'parse_dir')`
  由 Rust `std::fs` 直读文件并解析（目录批量解析 + 全局排序在 Rust 侧一次完成，单次 IPC，
  分块传输防 OOM）；浏览器下原样走 JS 引擎；
- **失败自动回退**：invoke 失败 / 返回异常时降级为 `plugin-fs` 读文本 + JS 解析，功能永不中断；
- 浏览器端不加载任何 `@tauri-apps/*` 模块（动态 import，构建产物按需分包）；
- 设计与语义对齐清单见 [`plans/rust-parser-design.md`](plans/rust-parser-design.md)。

### v2 大数据架构：rg 直扫 + 瘦 SQL（dbMode）

> 设计与实施记录见 [`plans/v2-rg-sql-architecture.md`](plans/v2-rg-sql-architecture.md)。
> 背景：v1「SQL 存全量文本」实测失败——720MB 日志建库膨胀到 3GB+、建库数分钟；
> 用户裁决「SQL 存全是本末倒置」，改为**原始文件即数据库**。

- **瘦索引** `line_ts`（全局行号 → 时间戳，约 16B/事件行）+ `files` 表：500 万行 ≈ 80MB
  （v1 的 3GB 缩小 37 倍）；打开目录时一次性 ts 扫描（带进度），指纹命中则免扫直接挂库。
- **过滤命中** `filter_hits(filter_id, line)`（约 20B/命中）：每次过滤器运行后 rg 直扫落库，
  供时间线渲染（视口窗口查询）与序列匹配消费；编辑过滤器 = 事务内重扫重插。
- **过滤 = rg**：`raw_search.rs` 基于 `grep-searcher`（rg 内核：mmap + SIMD + memchr）多文件并行
  直扫原文件，敏感 / 不敏感 / 正则同速；`message` scope 命中后按时间戳区间二次校验。
- **上下文按需读**：选中事件 → 按行号 mmap 直读原文件上下文（默认 ±8 行，可调 4~64），毫秒级，文本永不入库。
- **序列下推**：`db_run_sequences` 在 Rust 侧从 `filter_hits JOIN line_ts` 取事件流跑贪心链匹配
  （覆盖 global 作用域 + seq/and/or/not 边）；thread 分桶 / 节点条件 / 循环计数 / opt / periodic
  自动回退前端 TS 引擎。
- **dbMode 下双视图可用**：表格流惰性取行文本，时间线视口窗口查询，不强制单一视图。
- schema 版本不符自动删库重建，用户无感。

实测对比（720MB 目录）：

| 操作 | v1（SQL 存一切，已废弃） | v2（rg + 瘦 SQL） |
|---|---|---|
| 磁盘占用 | 3GB + 3GB wal | ~80MB |
| 首次打开 | 数分钟建库 | 2~5s（带进度） |
| 二次打开 | 秒级 | **< 0.5s** |
| 新建 / 编辑过滤器 | 数秒~数十秒 | **~1s**（rg 同速） |

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
| 引擎 CLI | clap v4（`loggraph` 命令，search / cep 两个子命令） |
| 桌面打包 | Tauri v2（Rust + WebView2 / WKWebView） |
| 桌面数据层 | grep-searcher（rg 内核直扫）+ rusqlite（可选瘦 SQL 驻留） |
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
    dbStore.ts                  # dbMode 桥接（db_open / db_filter / 按需上下文）
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
engine/                         # 纯 Rust 引擎（无 tauri、第一版无数据库）
  src/
    search.rs                   # rg 直扫（grep-searcher + grep-regex）+ ignore 遍历
    parser/timestamp.rs         # 时间戳探测/提取（5 格式）
    cep.rs                      # CEP 序列匹配纯算法（seq/not/and/or…）
    pipeline.rs                 # 无数据库流水线：扫描→时间戳→CEP
  examples/                     # rg_scan / walk_list 实测
cli/                            # 引擎 CLI（loggraph 命令，clap v4）
src-tauri/
  src/
    parser/                     # Rust 解析引擎（parse_log / parse_dir，语义对齐 JS）
    raw_search.rs               # rg 直扫引擎（grep-searcher 封装）
    db.rs                       # 瘦 SQL（指纹缓存 / line_ts / filter_hits / 按需取数）
    sequence.rs                 # 序列下推（db_run_sequences，待改为转发 engine）
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
