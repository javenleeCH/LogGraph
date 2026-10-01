# 全局代码检视：Web 与 Desktop 功能一致性

> 日期：2026-10-01
> 范围：`src/`（前端双后端）、`src-tauri/src/`（Rust 桌面命令）
> 方法：逐模块对照 `isTauri()` 分支、解析/过滤/序列/加载四条数据链路的两端实现

## 0. 架构结论

项目是 **Tauri v2 双后端**：
- `src/lib/tauri.ts::isTauri()` 用 `'__TAURI_INTERNALS__' in window` 运行时检测；
- 所有 `@tauri-apps/*` 均为**动态 import**，仅在该守卫内加载 —— 浏览器 `npm run dev` 不加载任何 Tauri 代码（这点做得很干净）；
- 数据层存在两条世界线：
  - **桌面（desktop / Tauri）**：Rust 解析器 + SQLite 瘦表（`dbMode`）+ rg 扫描 + 序列 CEP 下推；
  - **浏览器（web）**：JS `LogParser` + 纯内存 `events/rawLines` + `FilterEngine`（JS）+ `runSequenceMatching`（JS）。

**核心事实**：`dbMode` 只在 `FileTreePanel`「全选 + 加载」这一条路径下被置 `true`（`FileTreePanel.tsx:150` → `dbOpen` → `setLogDb`）。Web 端 `dbOpen` 永远返回 `null`（`dbStore.ts:47`），因此 **Web 永远走 `dbMode=false` 的内存路径**。整条 v2 db 层在 Web 端完全不存在。

---

## 1. 功能不一致清单（按严重度）

### 🔴 严重（同输入不同结果 / 能力缺失）

#### 1.1 过滤引擎不同：桌面 = Rust `regex` crate，Web = JS `RegExp`
- 桌面 `raw_search.rs` 用 `grep_regex`（底层 Rust `regex` crate）；`message` scope 二次校验用标准 `regex::Regex`（`db.rs:474`）。
- Web `FilterEngine.ts` 用 `new RegExp(f.pattern, 'g'|'gi')`。
- **确定差异**：
  - Rust `regex` crate **不支持后顾断言 `(?<=x)`、前瞻 `(?=x)`、反向引用 `\1`、条件/递归**；JS 全部支持。
  - 同一 filter 用了上述语法 → **Web 能匹配、Desktop 静默零命中**（`regex::Regex::new` 失败 → `.unwrap_or(false)`）。
  - `\b` 词边界：Rust 默认 **Unicode** 词边界，JS 是 **ASCII**。含多字节字符行上 `\b` 行为不同。
- 影响：对**同一个过滤器**，两端命中集合可能不同。这是最该修的一致性坑。
- **处理状态（2026-10-01，二次更新）**：**引擎已统一（原推荐方案 ①）**。新增 `filter-wasm/` crate 把标准 Rust `regex` crate 编译为 WASM（wasm-bindgen，产物在 `src/filters/wasm-filter/pkg/`，随仓库提交）；Web 端 `FilterEngine` 正则路径优先走该 wasm 引擎（`regexWasm.ts`），与桌面 `regex::Regex` **同一 crate、同默认 Unicode 模式**，结果逐字节一致。wasm 加载失败时回退 JS RegExp 并在 FilterEditor 显示回退提示（原 `regexCompat.ts` 预警已删除——引擎统一后不再需要）。`validateRegex` 也改为优先用 wasm 校验，保证「编辑时能过 ⇔ 桌面能编译」。构建：`npm run build:wasm`（需 wasm32 target + wasm-bindgen-cli）；冒烟：`npm run test:wasm`（12 项，验证环视/反向引用被拒、`\b`/`\d` Unicode 语义等桌面同款行为）。

#### 1.2 `message` scope 语义两端不同
- Web `FilterEngine.eventMatches`：`scope==='message'` 直接对 `ev.message` 做匹配（`FilterEngine.ts:54`）。
- 桌面 `db_filter`：`message` scope 先对**整行**做 rg 扫描（raw 的超集），再对每条候选**重新读文件 + `extract_timestamp` 裁出 message 域**二次校验（`db.rs:456-490`）。
- 二者 message 文本的来源不同：
  - Web 用 JS 解析器**预解析**的 `ev.message`；
  - 桌面用 Rust 解析器**当场重算**的 `message`。
- 已知偏差点（`parser/mod.rs:90-91` 自承）：JS 用 `raw.indexOf(matchStr)` 定位时间戳，`parser/mod.rs:92` 用真实匹配区间 `&raw[ext.end..]`。当时间戳串在行内重复出现时，两端的 `message` 起点不一致 → **同一 filter 在 `message` scope 下结果可能不同**。
- 此外桌面对「无时间戳行」会判 message 为空 → 不命中；Web 的 `ev.message` 取决于 JS 解析器兜底逻辑，可能非空 → 差异。
- **处理状态（2026-10-01）**：indexOf 偏差**已修复**。`extractTimestamp` 现返回真实匹配起始 `index`，`LogParser.parse` 改用 `raw.slice(extracted.index + matchStr.length)` 切后段，与 Rust `&raw[ext.end..]` 逐字符一致（时间戳区间均为 ASCII，字节/字符索引对齐）。该根因已消除。

#### 1.3 解析器是两套独立实现（Rust vs JS），仅靠人工对齐
- Rust `parser/mod.rs` 注释写「逐条对齐 JS」，但：
  - 单测期望值均为「按 JS 语义**人工推演**」（非与真实 JS 引擎对照）；
  - 已有**显式已知偏差**（1.2 的 indexOf 问题）；
  - `parse_rest`（thread/level/message 切分）两端各写一套正则（`LogParser.ts:42` vs `parser/line.rs:56`），集合/锚点/大小写规则虽尽力对齐，但任何一处漂移都不会被测试捕获。
- 唯一的交叉校验是 `?dualengine=1` 自检（`parseBridge.ts:162`），但**只在 URL 带参数时触发，且只 `console.error` 不修复**，生产环境等于没有。
- 风险：解析器漂移 → `ts/raw/message/level/thread` 不同 → 时间线、过滤、序列**全链路**结果漂移。
- **处理状态（2026-10-01）**：自检已**默认开启**。`dualEngineEnabled()` 在 `?dualengine=1` 或 **dev 构建**下自动启用；发现不一致时除 `console.error` 外，派发 `loggraph:parser-drift` 事件，由新增 `ParserDriftBanner` 组件在窗口顶部弹**非阻塞告警横幅**（红底）。开发态下任何 Rust/JS 解析漂移都会立刻可见，便于回归。生产构建不触发（避免重复解析开销）。

### 🟠 较重（能力/规模差异，非正确性）

#### 1.4 Web 拿不到 v2 的「大数据」能力（dbMode 缺失）
- Web 永远 `dbMode=false`：打开一个目录必须把**全部事件 + 全部 rawLines 装进内存**（`loadMultiple` → `setLog`）。
- 桌面「全选加载」走 dbMode：只持 `(line,ts)` 骨架，`raw`/`message` 按需从原文件 lazy 取（`LogStreamView.tsx` 上一轮已接），过滤走 rg。
- 同一大目录：桌面可上 GB 级，Web 会撞内存墙 / 卡死。**这是能力级不一致**，不是 bug，但需要用户知道「浏览器版处理不了超大目录」。

#### 1.5 Desktop 内部也存在数据模型不一致（加载方式决定 dbMode）
- `FileTreePanel` 全选 + 加载 → `dbMode`（骨架 + 惰性）；
- `FileTreePanel` 子集加载 / **拖拽文件夹**（`App.tsx:handleDirectory` → `loadMultiple`）/ 拖拽单文件 → 全部走内存 `setLog`。
- 即桌面用户**用不同方式加载同一目录**，得到的是不同数据模型（骨架 vs 全量），过滤/序列引擎也随之切换。建议统一：要么都走 dbMode，要么都走内存。

### 🟡 轻微（浏览器限制 / UX）

#### 1.6 文件夹拖拽 / 打开目录是 Chromium-only（Web 端）
- Web 文件夹拖拽依赖 `getAsFileSystemHandle` / `webkitGetAsEntry`（`fileLoader.ts`），**Firefox/Safari 不支持** → 这些浏览器下只能「打开日志」单文件，没有目录浏览。
- 桌面原生拖拽 / 系统对话框全平台可用。
- `Toolbar` 的「打开目录」按钮：Web 端在 Firefox 上因 `isFSASupported()=false` 而**直接隐藏**（`Toolbar.tsx:102`），与桌面始终可见不一致。

#### 1.7 `dbStore` 5 个函数缺少 isTauri 守卫（脆弱点）
- `runDbFilter / fetchEventIndex / fetchEventsInWindow / fetchContextLines / fetchLine` 没有 `if (!isTauri()) return ...`（`dropDbFilter / runDbSequences / dbOpen` 有）。
- 当前安全仅仅因为调用方都被 `dbMode` 卡住；一旦重构误在 Web 端调用，会在 `invoke` 处抛未经处理的异常。建议补齐守卫（返回空/0），与既有风格一致。

---

## 2. 做得好的地方（一致性已对齐）

为避免只挑刺，下列两端已妥善处理，可作为后续修复的基线：

- **CRLF**：Rust `split_lines`（`parser/mod.rs:53`，按 `\n` 切 + 剥一个尾部 `\r`）与 JS `text.split(/\r?\n/)` 逐行一致，并有矩阵单测；桌面 `db_filter` message 校验也 `strip_suffix('\r')`（`db.rs:470`）。✅
- **UTF-8 容错**：Rust `from_utf8_lossy`（非法字节→U+FFFD）对齐浏览器 `TextDecoder` 默认。✅
- **行号语义**：全局行号 = 原始行索引，排序前赋值，排序后稳定；`id` 可直接索引 `rawLines`（两端单测均验证）。✅
- **加载层抽象**：`dirLoader/fileLoader/parseBridge` 把 FSA vs Tauri 的差异收敛到少量 `isTauri()` 分支，UI 层（`Toolbar/FileTreePanel/App`）不直接碰平台 API。✅
- **工作区持久化**：`<目录>/.logGraph/filters.json` 两端同协议，桌面用 plugin-fs、Web 用 FSA，语义对称。✅
- **动态 import**：浏览器构建产物确实不含 Tauri 运行时（`grep` 确认无静态 `import @tauri-apps` 在守卫外）。✅

---

## 3. 其他全局检视发现（非 web/desktop 专项）

- **6 个既有 `parser::*` 测试失败**（最早那轮已发现，`syslog_values` 早 31 天、`epoch_maximal_runs` 误判 `Some`、`skipped_and_totals` 空行计数、3 个 `parser::line` 切分位置）。与 web/desktop 无关，但若要修 1.3 的解析器漂移，建议先让这些测试绿，否则无法作为对照基准。
- **`App.tsx` 自动保存副作用**：`events.length` 变化即触发 `saveFiltersNow`（`App.tsx:101-105`），只对「已绑工作区」生效，逻辑 OK，但放在 `App` 顶层而非 store action 内，略散。
- **`LogStreamView` 的 `lineText` 缓存**只在 `dbMode` 填充，非 dbMode 用 `ev.raw`——与 1.4 的内存路径一致，无问题。

---

## 4. 修复优先级建议

| 优先级 | 项 | 状态 | 建议 |
|---|---|---|---|
| P0 | 1.1 过滤引擎差异 | **✅ 已修复（引擎统一）** | Web 端正则过滤改用 wasm 版标准 Rust `regex` crate（`filter-wasm/` + `regexWasm.ts`），与桌面同一引擎同一语义；JS RegExp 仅作 wasm 加载失败时的兜底。原 regexCompat 预警方案已移除。 |
| P0 | 1.3 解析器漂移 | **已修复根因 + 增强自检** | indexOf 偏差已修（两端均用真实匹配区间）；`?dualengine=1` 自检在 dev 默认开启并弹告警横幅（`ParserDriftBanner`）。 |
| P1 | 1.2 message scope | 待处理 | 桌面 `db_filter` 的二次校验改为直接读 `ev.message` 同款来源，或让两端共用同一 message 提取函数，消除「重算 vs 预解析」分歧。 |
| P1 | 1.5 / 1.4 | 待处理 | 桌面统一加载路径（都走 dbMode 或都内存）；Web 端对超大目录给出明确提示/限制。 |
| P2 | 1.7 | 待处理 | `dbStore` 5 个函数补 `if (!isTauri()) return` 守卫。 |
| P2 | 3 (6 个测试) | 待处理 | 先修红测试，作为解析器对照基准。 |

---

## 5. 一页速览

```
加载：  Web = FSA/拖拽 → JS LogParser → 内存 setLog
        Desktop(全选) = dbOpen → dbMode(骨架+rg+惰性)
        Desktop(子集/拖拽) = Rust parse_dir/parse_log → 内存 setLog
过滤：  Web = wasm Rust regex (FilterEngine，与桌面同引擎；加载失败回退 JS RegExp)
        Desktop(dbMode) = rg(Rust regex) + message 二次校验(Rust regex)
序列：  Web = JS runSequenceMatching
        Desktop(dbMode) = Rust 下推(global+seq/and/or/not)，其余回退 JS
解析：  Web = src/parser/LogParser.ts
        Desktop = src-tauri/src/parser/*（独立实现，人工对齐，有已知偏差）
```

结论：**Web 与 Desktop 在「过滤结果」和「解析结果」上可能存在肉眼可见的差异**（引擎不同 + 解析器两套），这是当前最大的功能不一致；而在「大数据处理能力」上 Web 整体弱于 Desktop（缺 dbMode）。两者在 UI 交互、工作区持久化、CRLF/UTF-8 等基础设施上已对齐良好。
