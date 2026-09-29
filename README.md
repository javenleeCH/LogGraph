# logGraph

一个 **Perfetto / SmartPerf 风格**的日志时间线分析器。核心理念：

> 你可以定义**多条正则/关键词过滤器**，每条过滤器对应一条**堆叠的时间线轨道（lane）**，共享同一根时间轴。通过轨道间的**垂直对齐**，多个搜索结果之间基于时间维度的关联一目了然——无需像 Notepad++ 那样靠人工对照前后时间戳来判断。

## ✨ 特性

- **多过滤器轨道**：每个过滤器一条 lane，颜色区分，实时匹配计数。
- **共享时间轴**：所有 lane 共用同一时间标尺，垂直对齐即时间关联。
- **缩放 / 平移**：滚轮缩放（以鼠标为中心），拖拽平移。
- **游标（Scrubber）**：点击轴可放置贯穿所有 lane 的游标，显示时间标签。
- **关联高亮 + 连线**：选中某事件后，跨 lane 时间窗口内（默认可见范围的 2%，自适应）的事件自动高亮并连线。
- **详情面板**：选中事件的完整原始行 + 上下文行，关联行也高亮。
- **Minimap**：底部缩略图全局导航，可拖拽移动视口。
- **拖拽加载**：直接把 `.log` / `.txt` 文件拖进窗口。
- **键盘快捷键**（与 Perfetto 一致）：
  - `W` / `S` —— 以**鼠标所在位置**为中心放大 / 缩小
  - `A` / `D` —— 向左 / 向右平移（每次移动视图宽度的 20%）
  - `←` / `→` —— 在选中 lane 内前后跳转事件
  - `Esc` —— 取消选中 / 清除游标
- 滚轮缩放同样以鼠标所在位置为中心。
- **时间戳自动探测**：支持 `YYYY-MM-DD HH:mm:ss.SSS`、ISO 8601、syslog、`HH:mm:ss`、Unix epoch。

## 🚀 快速开始

```bash
npm install
npm run dev      # 开发服务器 http://localhost:5180
npm run build    # 生产构建到 dist/
```

## 🖥️ Tauri 桌面版

本项目已 Tauri 化（Tauri v2 + Rust + WebView2 / WKWebView）。桌面版与浏览器版共用同一套 React 代码，
`src/lib/tauri.ts` 在运行时检测是否处于 Tauri 容器，并据此切换文件读写后端：

| 能力 | 浏览器 | Tauri 桌面 |
|---|---|---|
| 打开日志 | `<input type=file>` | 系统文件对话框（`plugin-dialog`） |
| 拖拽加载 | HTML5 Drag & Drop | 原生文件拖放（`onDragDropEvent`） |
| 打开目录 | File System Access API | 系统目录对话框 + `plugin-fs` 递归枚举 |
| 过滤器持久化 | FSA + IndexedDB 句柄 | `plugin-fs` 读写 `filters.json` + localStorage 记路径 |
| **日志解析** | JS 引擎（`LogParser`） | **Rust 原生引擎（`parse_log` 命令，进程内读文件+解析，大文本不过 IPC）** |

### Rust 解析引擎（双通道架构）

桌面端的日志解析已移入 Rust（`src-tauri/src/parser/`），与 JS 引擎语义逐条对齐
（时间戳格式探测、thread/level 提取、行分割、稳定排序、skipped 统计）：

- 前端统一入口 `src/parser/parseBridge.ts`：Tauri 下 `invoke('parse_log', { path })`
  由 Rust `std::fs` 直读文件并解析（省去大文本过 IPC 桥的开销）；浏览器下原样走 JS 引擎；
- **失败自动回退**：invoke 失败 / 返回异常时降级为 `plugin-fs` 读文本 + JS 解析，功能永不中断；
- 浏览器端不加载任何 `@tauri-apps/*` 模块（构建产物已按需分包）；
- 设计与语义对齐清单见 [`plans/rust-parser-design.md`](plans/rust-parser-design.md)。

一致性自检：Tauri 环境下打开 `http://localhost:5180/?dualengine=1`，加载日志时
JS/Rust 双引擎并行解析并深度比对，差异输出到 DevTools console（以 Rust 结果为准）。

Rust 侧单测：`cd src-tauri && cargo test`。

前置要求：Rust 工具链（`rustc`/`cargo`）与平台对应的 WebView（Windows 10/11 自带 WebView2）。

```bash
npm install
npm run tauri:dev     # 桌面开发模式（自动起 vite + cargo build 后打开窗口）
npm run tauri:build   # 打包桌面安装包（产物在 src-tauri/target/release/bundle/）
```

Rust 侧入口在 `src-tauri/`（`main.rs` / `lib.rs` / `tauri.conf.json` / `capabilities/`）。
首次 `tauri:build` 会下载编译 Rust 依赖，耗时较长属正常现象。

打开浏览器后：
1. 点击 **「📂 打开日志」** 或把日志文件拖进窗口（可用 `sample/sample.log` 测试）。
2. 在左侧 **过滤器** 面板点击 **「+ 新增」**，输入关键词或正则。
3. 每条过滤器会生成一条轨道，匹配事件以彩色竖条标记在时间轴上。
4. 点击任意事件 → 跨轨道时间相近的事件自动高亮并连线，详情面板显示上下文。

## 📐 技术栈

| 关注点 | 选型 |
|---|---|
| 构建 | Vite + TypeScript |
| UI 框架 | React 18 |
| 时间线渲染 | 原生 HTML5 Canvas 2D（自定义 RAF 渲染循环）|
| 状态管理 | Zustand |
| 样式 | CSS Modules |
| 桌面打包 | Tauri v2（Rust + WebView2）|

## 🗂️ 项目结构

```
src/
  main.tsx                      # 入口
  App.tsx                       # 布局壳 + 拖拽加载（含 Tauri 原生拖放）
  types.ts                      # 核心数据模型
  store/logStore.ts             # Zustand 全局状态
  lib/tauri.ts                  # Tauri 运行时检测 + 动态加载
  parser/
    LogParser.ts                # 文本 -> LogEvent[]
    timestampFormats.ts         # 时间戳格式预设与自动探测
  filters/
    FilterEngine.ts             # 事件 <-> 过滤器匹配
  io/
    fileLoader.ts               # 文件加载（浏览器/Tauri 双后端）
    dirLoader.ts                # 目录枚举 + 多文件合并（双后端）
    filterPersist.ts            # 过滤器持久化（双后端）
  timeline/
    TimelineCanvas.tsx          # Canvas 宿主 + 交互
    renderers.ts               # 轴/lane/事件/minimap/连线绘制
    correlation.ts              # 跨 lane 时间邻近查找（二分）
    layout.ts                  # 布局常量
  components/
    Toolbar.tsx                 # 打开文件 + 范围信息
    FiltersSidebar.tsx          # 过滤器列表与编辑
    DetailPanel.tsx             # 选中事件详情 + 上下文行
src-tauri/                      # Tauri v2 Rust 脚手架
  Cargo.toml / build.rs
  src/main.rs / lib.rs
  tauri.conf.json               # 窗口 / 构建 / 打包配置
  capabilities/default.json     # 对话框 + 文件系统权限
  icons/                        # 应用图标（tauri icon 生成）
```

## 🔗 关联逻辑说明

选中事件（或激活游标）后，系统以该时间戳为中心，在 `[中心 - 半窗, 中心 + 半窗]` 范围内，用**二分查找**快速定位每个 lane 的事件并高亮。半窗大小默认**自适应**为当前可见时间范围的 2%——即放大查看时窗口自动收窄，概览时窗口自动放宽。可在 [`logStore`](src/store/logStore.ts:1) 中通过 `setCorrelationWindow` 切换为固定窗口。

## 📄 许可

MIT
