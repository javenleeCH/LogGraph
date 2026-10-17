# logGraph 引擎 / CLI / Tauri / Web 接口契约（v1.3 = v1.2 + §11 REST 化重写，已确认）

> 目的：冻结四层架构下引擎 Rust API、CLI 命令面、
>
> `.cep`
>
>  规则文件 schema、
> JSON 输出 schema、Tauri IPC 命令面与能力边界。
> 代码以本文件为准（v1.1 已确认，D1–D11 见 §10 决议记录）；与原型的差异见 §9。
> 原则：
>
> **零数据库依赖**
>
> （无 SQLite），全程流式扫描，内存中只保留命中行。
> **单一事实源**
>
> ：
>
> `.cep`
>
>  规则文件是四层共享的规则载体；引擎结果 DTO 是
> Tauri / Web / CLI 共享的结果载体（字段名两端一致）。
> **Agent 优先**
>
> ：一切机器可读输出走 
>
> `--json`
>
> ，结构稳定、键序确定、
> 错误带稳定 code；人类输出只是 JSON 的另一种渲染。
> 基础、稳定、实用；第一版宁缺毋滥，不支持的能力
>
> **显式 fallback**
>
> ，不静默。



***

## 0. 总则

### 0.1 术语



| 术语               | 含义                                                   |
| ---------------- | ---------------------------------------------------- |
| filter           | 一条命名搜索模式（关键词或正则），产生一个事件流                             |
| group            | 一组 filter 引用 + 边集合，构成一个序列匹配单元                        |
| edge             | group 内两个 filter 间的时序约束（seq/not/and/or/opt/periodic） |
| 链 /chain         | 一次完整匹配：按边推进、逐步消耗事件得到的 Step 序列                        |
| 事件 /event        | 一条带 epoch ms 时间戳的命中行（`SeqEvent`）                     |
| 未覆盖事件 /uncovered | 命中但未被任何链消耗的事件（anomaly 候选）                            |
| 规则文件 / `.cep` 文件 | 本契约 §3 约束的 JSON 文档，`loggraph cep -R` 的输入             |

### 0.2 稳定性承诺



* **Stable**：本文件标 ✅ 的语义在 v1.x 内冻结（含 JSON 字段名与错误 code）。

* **Experimental**：标 ⚠️ 的语义可在 minor 版本调整，调整前会在 changelog 标注。

* v1 不支持的特性（§8）在文件中**允许出现**，引擎按 §3.9 给出警告并 fallback，

  这样规则文件可以先于引擎能力写好（前向兼容靠 `version` 字段，§3.2）。

### 0.3 命名与编码规范



* JSON 字段命名一律 **camelCase**。唯一例外：`line_number` 保持 snake\_case

  （对齐 `rg --json` 先例，见决策点 D4）。

* 时间戳一律 **epoch 毫秒**（JSON number，i64）；人类可读时间串只出现在

  文本输出（§4.7）与 UI，不出现在任何 JSON 契约里。

* 行号 1-based；`Infinity` 不出现在 JSON（`nodeCounts.max` 缺省即无上界）。

* 字符串编码：文件按 UTF-8 读（容忍并剥离 BOM）；命中行若含无效 UTF-8，

  替换为 U+FFFD 后输出。CLI stdout/stderr 一律 UTF-8

  （Windows 旧控制台乱码属终端问题，二进制不做转码）。

* 未知字段一律**拒绝**（serde `deny_unknown_fields` + schema

  `additionalProperties: false`）：拼错字段名必须报错，不允许静默取默认值。



***

## 1. 分层架构

### 1.1 布局与依赖方向



```mermaid
flowchart TB
    subgraph 壳层
        CLI["cli/  loggraph-cli<br/>二进制 loggraph"]
        TAURI["src-tauri/  薄壳<br/>窗口 + IPC 命令转发"]
    end
    ENGINE["engine/  loggraph-engine<br/>search + parser + cep + pipeline + rules<br/>纯 Rust 库，无 tauri / 无 DB"]
    WEB["src/  React Web UI<br/>浏览器模式：filter-wasm + TS SequenceMatcher"]
    CEPFILE[".cep 规则文件<br/>(JSON, §3)"]

    CLI --> ENGINE
    TAURI --> ENGINE
    WEB -- "Tauri 模式：invoke" --> TAURI
    WEB -- "浏览器模式：本地实现" --> WEB
    CEPFILE --> CLI
    CEPFILE --> TAURI
    CEPFILE --> WEB
```

规则（强制）：



* 依赖方向单向：`cli → engine`、`src-tauri → engine`、`src → src-tauri`(IPC)。

  **engine 不反向依赖任何壳**，不依赖 tauri /rusqlite/ 任何 UI 类型。

* engine 可独立 `cargo test`、可被 WASM 侧或任意前端以 FFI 嵌入。

* 壳层只做三件事：参数解析 / 进程边界（IPC、退出码）/ 输出格式化。

  **业务语义（含规则校验）全部在 engine**，CLI 与 Tauri 不各自实现一份。

### 1.2 各层职责边界



| 层       | crate / 目录                 | 职责                              | 禁止                       |
| ------- | -------------------------- | ------------------------------- | ------------------------ |
| 引擎      | `engine/`（loggraph-engine） | 搜索、遍历、时间戳、CEP 匹配、规则装载与校验        | 依赖 tauri / DB；打印到 stdout |
| CLI     | `cli/`（loggraph）           | clap 参数、退出码映射、文本 / JSON 渲染      | 实现任何匹配语义                 |
| Tauri 壳 | `src-tauri/`               | 窗口、IPC 命令、engine 错误 → 可序列化 DTO  | 实现任何匹配语义                 |
| Web     | `src/`                     | React UI；桌面模式走 IPC，浏览器模式走 TS 实现 | 直接链 Rust（除 wasm 包）       |

### 1.3 Web 双模式

同一份 React 代码跑两种后端：



* **Tauri 模式（桌面）**：`invoke('engine_*')` → engine，能力全集。

* **浏览器模式**：`filter-wasm`（regex 过滤）+ `src/sequence/SequenceMatcher.ts`

  （TS 版序列匹配）。TS 实现是浏览器**降级路径**，语义上允许落后于引擎，

  但**结果 DTO 字段必须与 §5.2 一致**（同为 `SequenceMatchResult` 形状）。

模式探测：`window.__TAURI__` 存在 → Tauri 模式。UI 不感知差异的接口

（如 `.cep` 文件导入导出）两端行为一致。

### 1.4 共享契约面（四层都依赖的东西）



| 契约                  | 定义处         | 消费方                                              |
| ------------------- | ----------- | ------------------------------------------------ |
| `.cep` 规则文件 schema  | §3          | CLI `-R`、Tauri `engine_run_cep`、UI 导入导出、外部 agent |
| 规则校验错误对象            | §3.10       | CLI `validate`、Tauri、UI 表单校验                     |
| 结果 DTO（SeqResult 等） | §2.4 / §5.2 | CLI `--json`、Tauri IPC 返回、UI store、TS matcher    |
| 时间戳格式 id 集          | §2.3        | parser 双实现（Rust/TS）对齐                            |



***

## 2. Rust 引擎 API（loggraph-engine）

### 2.1 错误模型（统一替代当前的 `String` 错误）



```rust
#[derive(Debug, thiserror::Error, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum EngineError {
    #[error("非法正则/模式 {input:?}: {source}")]
    InvalidPattern { input: String, source: grep_regex::Error },

    #[error("非法 glob {glob:?}: {source}")]
    InvalidGlob { glob: String, source: ignore::Error },

    #[error("读取/扫描 {path} 失败: {source}")]
    Io { path: PathBuf, source: std::io::Error },

    #[error("规则文件 JSON 语法错误: {0}")]
    RulesSyntax(serde_json::Error),          // E_RULES_SYNTAX

    #[error("规则文件不符合 schema: {issues:?}")]
    RulesSchema { issues: Vec<RuleIssue> },  // E_RULES_SCHEMA（聚合）

    #[error("规则文件语义错误: {issues:?}")]
    RulesSemantic { issues: Vec<RuleIssue> },// E_RULES_SEMANTIC（聚合）

    #[error("不支持的规则文件版本: {found}, 引擎支持 {supported:?}")]
    RulesVersion { found: u32, supported: Vec<u32> }, // E_RULES_VERSION

    #[error("{path} 下未找到可搜索文件")]
    NoFiles { path: PathBuf },               // E_NO_FILES
}
pub type EngineResult<T> = Result<T, EngineError>;
```



* 所有公开函数返回 `EngineResult<T>`；`thiserror` 仅 derive，不增运行时负担。

* **序列化形状（Tauri / `--json` 错误输出共用）**：

  `{ "code": "E_PATTERN", "message": "非法正则…", "details": {…可选} }`，

  `code` 取值见 §3.10 错误码表；CLI 层打印 message 后映射退出码（§4.6）。

* 引擎内部 panic 一律视为 bug（E\_INTERNAL 由壳层兜底捕获，不进契约）。

### 2.2 search 模块（rg 直扫 + 目录遍历）



```rust
pub struct Pattern {
    pub pattern: String,
    pub case_sensitive: bool,   // false = -i
    pub is_regex: bool,         // false = 字面量（元字符自动转义）
}
impl Pattern {
    pub fn literal(s: impl Into<String>) -> Self;   // case_sensitive = true
    pub fn regex(s: impl Into<String>) -> Self;
    pub fn case_insensitive(self) -> Self;
    pub fn compile(&self) -> EngineResult<RegexMatcher>;
}

pub struct Hit       { pub line_number: u64, pub text: String } // 1-based，去行尾
pub struct FileHits  { pub path: PathBuf, pub hits: Vec<Hit> }  // 文件内按行号升序
pub struct SearchStats {
    pub files_searched: usize,
    pub files_with_matches: usize,
    pub matched_lines: u64,
    pub elapsed_ms: u128,
}

pub struct WalkOptions {
    pub hidden: bool,          // --hidden；默认跳过隐藏
    pub no_ignore: bool,       // --no-ignore
    pub globs: Vec<String>,    // -g，! 前缀排除
    pub exts: Vec<String>,     // 扩展名白名单；空 = 不限制
}
impl Default for WalkOptions;   // 全 false / 空

pub fn walk(root: &Path, opts: &WalkOptions) -> EngineResult<Vec<PathBuf>>;
pub fn search_file(path: &Path, pat: &Pattern) -> EngineResult<FileHits>;
pub fn search_all(paths: &[PathBuf], pat: &Pattern)
    -> EngineResult<(Vec<FileHits>, SearchStats)>;
```

语义约定（✅ Stable）：



* `walk`：`root` 为文件 → `vec![root]`；目录 → 递归，尊重

  `.gitignore` / `.ignore` / `.rgignore` / 全局 gitignore /

  `$GIT_DIR/info/exclude`，默认跳过隐藏。返回路径 = `root` 拼接后的路径

  （`root` 写相对则相对、写绝对则绝对）。同一目录快照下顺序确定，

  但**不承诺排序规则**（需要排序的消费方自行排）。

* `search_all`：按文件并行（`thread::scope`），**输出顺序与输入 `paths` 一致**，

  文件内按行号升序。

* 默认 Unicode 行模式；命中二进制（行内 NUL）该文件即停（rg 默认行为）。

* CRLF：按 LF 切行，`text` 统一去掉尾部 `\r`。

* 字面量对 regex 元字符自动转义（`\ . + * ? ( ) | [ ] { } ^ $`）。

### 2.3 parser 模块（时间戳探测 / 提取）



```rust
pub struct TsFormat { pub id: &'static str }   // 见下 5 种
pub struct ExtractedTimestamp {
    pub ts: i64,            // epoch ms
    pub start: usize,       // 匹配字节区间（0-based，行内）
    pub end: usize,
    pub format_id: &'static str,
}

pub fn formats() -> &'static [TsFormat];
pub fn find_format(id: &str) -> Option<&'static TsFormat>;
pub fn detect_timestamp_format(sample: &[&str]) -> Option<&'static TsFormat>;
pub fn extract_timestamp(line: &str, fmt: Option<&TsFormat>)
    -> Option<ExtractedTimestamp>;
// fmt=None → 按优先级逐格式尝试；某格式命中但 parse 失败则继续下一个。
```

格式与优先级（顺序即优先级，**勿调整**；TS 侧 `timestampFormats.ts` 必须同表）：



| # | id             | 形态                                 | 说明                  |
| - | -------------- | ---------------------------------- | ------------------- |
| 1 | `iso-local-ms` | `2024-01-01 12:00:00.123`          | 无时区，按本地墙钟直接解释       |
| 2 | `iso-8601`     | `2024-01-01T12:00:00+08:00` / `…Z` | 带偏移，换算 UTC          |
| 3 | `syslog`       | `Jan 02 12:00:00`                  | 无年份 → 取**当前年**      |
| 4 | `time-only-ms` | `12:00:00.123`                     | 日期锚定 **1970-01-01** |
| 5 | `epoch`        | `1704067200123` / `1704067200`     | 13 位 ms / 10 位 s    |

探测算法（✅ Stable）：能 regex 匹配最多行的格式获胜，**严格大于**才替换

（平局保留在前者）。`run_cep` 用前 200 条命中行做一次探测；探测格式

parse 失败的行，逐行回退全格式尝试（§2.5）。

### 2.4 cep 模块（序列匹配纯算法）



```rust
// 请求 DTO（camelCase 反序列化，deny_unknown_fields）
pub struct GroupSpec {
    pub group_id: String,
    pub filter_ids: Vec<String>,
    pub scope: String,                       // "global" | "thread"
    pub edges: Vec<EdgeSpec>,
    pub node_conditions: Option<HashMap<String, String>>,
    pub node_counts: Option<HashMap<String, NodeCountSpec>>,
}
pub struct EdgeSpec {
    pub id: String,
    pub from_filter_id: String,
    pub to_filter_id: Option<String>,        // §3.5：and/or 时不提供
    pub to_filter_ids: Option<Vec<String>>,  // and/or 多目标
    pub kind: Option<String>,                // seq|not|and|or|opt|periodic；缺省 seq
    pub max_gap_ms: i64,
    pub period_ms: Option<i64>,              // 仅 periodic
}
pub struct NodeCountSpec { pub min: Option<i64>, pub max: Option<i64> }

// 事件（输入/输出共用）
pub struct SeqEvent {
    pub id: u32,                 // 全局唯一物理行身份（见 §2.5 分配规则）
    pub ts: i64,                 // epoch ms
    pub raw: String,
    pub message: String,
    pub thread: Option<String>,
}

// 结果 DTO（camelCase 序列化；字段见 §5.2 JSON 示例）
pub struct Step        { pub edge_id: Option<String>, pub filter_id: String, pub event: SeqEvent }
pub struct MatchedChain{ pub chain_index: u32, pub steps: Vec<Step>,
                         pub start_ts: i64, pub end_ts: i64, pub thread: Option<String> }
pub struct EdgeStat    { pub edge_id: String, pub matched_count: u32, pub miss_count: u32,
                         pub late_count: Option<u32>, pub jitter_count: Option<u32> }
pub struct NotViolation{ pub edge_id: String, pub from_event: SeqEvent, pub to_event: SeqEvent }
pub struct Heartbeat   { /* periodic 心跳断言（engine ≥ 0.2.1 起填充 segments/gaps/jitters） */ }
pub struct ThreadStats { pub total_events: usize, pub with_thread: usize,
                         pub distinct_threads: usize }   // camelCase: totalEvents / withThread / distinctThreads
pub struct SeqResult {
    pub group_id: String,
    pub chains: Vec<MatchedChain>,
    pub uncovered_events: Vec<SeqEvent>,
    pub edge_stats: Vec<EdgeStat>,
    pub not_violations: Vec<NotViolation>,
    pub heartbeats: Vec<Heartbeat>,
    pub total_chains: usize,
    pub total_uncovered: usize,
    pub covered_marks: BTreeMap<String, Vec<(u32, u32)>>,
    pub thread_stats: ThreadStats,   // 不论 scope 是否 thread 都产出，见 §3.10
}
pub struct RunSeqResponse { pub fallback: bool, pub results: BTreeMap<String, SeqResult> }
// BTreeMap：--json 输出按 groupId 字典序，agent 可依赖键序

pub type EventStore = HashMap<String, Vec<SeqEvent>>; // filter_id → 按 (ts,id) 升序

impl GroupSpec { pub fn is_supported(&self) -> bool }
pub fn match_group(spec: &GroupSpec, store: &EventStore) -> EngineResult<SeqResult>;
pub fn run_sequences(groups: &[GroupSpec], store: &EventStore) -> RunSeqResponse;
```

语义（✅ Stable，忠实现有实现）：



* **NOT 边**为纯断言、不消耗事件：对每个 from 事件检查窗口

  `(tsFrom, tsFrom + maxGapMs]` 内是否出现 to 事件，出现即记一条

  `NotViolation`，`missCount` +1。

* **推进边**（seq/and/or）解析为推进链（拓扑 + DFS 枚举；环从各节点各试一次）。

  窗口内多目标就绪时取 **ts 最早**；ts 相同按 **filterId 字典序**。

  and/or 边的链延续锚点 = `toFilterIds[0]`（与 UI 惯例一致）。

* 同一物理行被多过滤器命中时，CEP 内为**同一 `id`（消耗互相可见）**。

* 链产出后按 `(startTs, endTs)` 排序，`chainIndex` 排序后 **1-based** 重编号。

* `uncoveredEvents` = group 的 filterIds 中未被任何链消耗的事件，按 `(ts, id)` 升序。

* `is_supported() = false` 的 group 不计算；任一 group 不支持 → 整个

  `RunSeqResponse.fallback = true`（§3.9 W 码）。

### 2.5 pipeline 模块（无数据库一条龙）



```rust
pub struct FilterDef {
    pub id: String,
    pub pattern: String,
    pub case_sensitive: bool,   // serde 缺省 false（与 UI 默认一致）
    pub is_regex: bool,         // serde 缺省 false
}
pub struct PipelineStats {
    pub files: usize,
    pub filter_hits: HashMap<String, u64>,   // 每过滤器命中行数
    pub events_with_ts: u64,                 // 进入 CEP 的事件数
    pub ts_format: Option<String>,           // 探测结果；None = 全失败
    pub no_ts: u64,                          // 命中但无时间戳、被丢弃
}
pub fn run_cep(
    paths: &[PathBuf],
    filters: &[FilterDef],
    groups: &[GroupSpec],
) -> EngineResult<(RunSeqResponse, PipelineStats)>;
```

流程（✅ Stable）：



1. 每过滤器一次 `search_all`（同一份 `paths`）。

2. 用前 200 条命中行探测一次 ts 格式（§2.3）。

3. 事件 `id` 分配：key = `(文件在 paths 中的下标, 1-based 行号)` → 全局自增

   `u32`（从 1 起）；同一物理行多过滤器命中共用同一 id。ts 提取：先按探测

   格式，失败逐行回退全格式；仍失败计入 `noTs` 并丢弃（不进 CEP）。

4. `run_sequences`。

### 2.6 rules 模块（规则文件装载与校验）

规则文件的**完整契约见 §3**（本节只定 API 形状）。校验分三层，全部在引擎：



```rust
pub struct RulesFile {
    pub version: u32,             // 当前恒 1
    pub filters: Vec<FilterDef>,
    pub groups: Vec<GroupSpec>,
}

pub struct RuleIssue {
    pub code: IssueCode,          // E_RULES_SCHEMA | E_RULES_SEMANTIC | W_*
    pub rule: Option<&'static str>, // "S04" 等，见 §3.8/§3.9
    pub path: String,             // "$.groups[0].edges[1].toFilterId"
    pub message: String,          // 人类可读，含具体值
}

pub struct RuleReport { pub errors: Vec<RuleIssue>, pub warnings: Vec<RuleIssue> }

/// 只校验不构造：聚合返回全部问题（不 fail-fast），供 validate 命令 / UI 表单用
pub fn validate_rules(json: &str) -> RuleReport;

/// 校验 + 构造：任一 error → Err(RulesSchema / RulesSemantic / RulesVersion)
pub fn parse_rules(json: &str) -> EngineResult<RulesFile>;
```



* 三层校验顺序：JSON 语法（`E_RULES_SYNTAX`）→ 结构（schema，`E_RULES_SCHEMA`）

  → 语义（`E_RULES_SEMANTIC`，S 码）。语法错误时后两层不执行。

* `parse_rules` 供 `run_cep` 调用方使用；CLI 的 `-R` 路径必须先过它。

***

## 3. `.cep` 规则文件契约（★ 本版核心补充）

### 3.1 文件身份

| 项 | 约定 |
| --- | --- |
| 扩展名 | 推荐 `.cep.json`（双扩展名，编辑器自动按 JSON 处理）；`.cep`、`.json` 也接受。引擎**不按扩展名拒绝**，按内容解析（D8） |
| 编码 | UTF-8，无 BOM（带 BOM 引擎剥离） |
| 内容 | 单个 JSON 文档（非 NDJSON、无注释） |
| 用途 | `loggraph cep -R`、Tauri `engine_run_cep`、UI 导入导出、agent 生成 |
| 定位 | **规则载体，不是 UI 工程文件**：只含计算所需字段 + 少量展示元数据（`label`/`description`，引擎忽略）。颜色 / 折叠 / 视图状态归 UI 自己的工程文件 |

### 3.2 顶层结构

```json
{
  "$schema": "https://loggraph.dev/schemas/cep-rules-1.schema.json",
  "version": 1,
  "description": "启动阶段健康检查规则（可选，引擎忽略）",
  "filters": [ { "id": "…", "pattern": "…" } ],
  "groups":   [ { "groupId": "…", "filterIds": ["…"], "edges": [] } ]
}
```

| 字段 | 类型 | 必填 | 缺省 | 说明 |
| --- | --- | --- | --- | --- |
| `$schema` | string(uri) | 否 | — | 指向 §3.7 schema；写入后编辑器获得补全 / 校验，引擎不校验其值 |
| `version` | integer | 否 | `1` | 规则文件格式版本。引擎遇到不支持的版本报 `E_RULES_VERSION`（S11），**不猜测降级** |
| `description` | string ≤2000 | 否 | — | 人类备注，引擎忽略 |
| `filters` | array | **是** | — | 1..1024 条 |
| `groups` | array | 否 | `[]` | 0..1024 条。空 groups = 纯多模式扫描（只要 stats 与每过滤器命中数） |

### 3.3 `filters[]`（过滤器定义）

| 字段 | 类型 | 必填 | 缺省 | 约束 / 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | **是** | — | `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`，全局唯一（S01） |
| `label` | string ≤64 | 否 | — | 展示名（UI 元数据，引擎忽略） |
| `pattern` | string | **是** | — | 1..4096 字符；非空（空模式匹配一切，属脚枪） |
| `isRegex` | boolean | 否 | `false` | `false` = 字面量，元字符自动转义（§2.2） |
| `caseSensitive` | boolean | 否 | `false` | 缺省不区分大小写（与 UI Filter 默认一致；注意与 rg 相反，CLI 的 `-i` 是反向开关） |
| — | — | — | — | **无 `scope` 字段**：引擎按整行 raw 匹配；UI 的 `scope:"message"` 过滤器导出时必须提示（§3.12） |

`isRegex: true` 时 `pattern` 必须能被 Rust `regex` crate 编译（S08），
失败报 `E_PATTERN` 系错误并指到 `$.filters[i].pattern`。

### 3.4 `groups[]`（序列匹配单元）

| 字段 | 类型 | 必填 | 缺省 | 约束 / 说明 |
| --- | --- | --- | --- | --- |
| `groupId` | string | **是** | — | id 格式同上，全局唯一（S02） |
| `label` | string ≤64 | 否 | — | 展示名，引擎忽略 |
| `scope` | enum | 否 | `"global"` | `global` \| `thread`。`thread` = 按 `thread` 字段分桶隔离匹配（engine ≥ 0.2.1 起支持） |
| `filterIds` | string[] | **是** | — | 1..256 项，去重；每项 ∈ `filters[].id`（S03）。**边只能引用这里声明的 filter**（S04） |
| `edges` | Edge[] | **是** | — | 0..256 条；可为空（该 group 只产出 uncovered 事件清单） |
| `nodeCounts` | map | 否 | `{}` | 见 §3.6（engine ≥ 0.2.1 起支持） |
| `nodeConditions` | map | 否 | `{}` | 见 §3.6（engine ≥ 0.2.1 起支持） |
| `maxChains` | integer ≥1 | 否 | —（不限） | 返回链数上限（UI 防大目录载荷爆炸）。截断时 `totalChains`/`totalUncovered` 仍报全量真值，`coveredMarks` 回传全量 lane 标记 |

### 3.5 `groups[].edges[]`（边定义与 kind 语义）

| 字段 | 类型 | 必填 | 缺省 | 约束 / 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | **是** | — | id 格式同上，**跨 group 全局唯一**（S05） |
| `kind` | enum | 否 | `"seq"` | `seq` \| `not` \| `and` \| `or` \| `opt` \| `periodic` |
| `fromFilterId` | string | **是** | — | ∈ 所在 group 的 `filterIds`（S04） |
| `toFilterId` | string | 条件 | — | seq/not/opt/periodic **必填**；and/or **禁止**（S06） |
| `toFilterIds` | string[] | 条件 | — | and/or **必填**（2..16 项去重）；其余 kind **禁止**（S06） |
| `maxGapMs` | integer | **是** | — | ≥ 0。窗口语义 `(tsFrom, tsFrom + maxGapMs]`；`0` = 空窗口（seq 永不命中 /not 恒通过），合法但不推荐 |
| `periodMs` | integer | 条件 | — | 仅 periodic **必填**（>0）；其余 kind **禁止**（S07） |

kind 语义表（✅ 与 §2.4 实现一一对应）：

| kind | EPL 类比 | 语义 | v1 |
| --- | --- | --- | --- |
| `seq` | `A -> B within W` | 窗口 W 内出现最早就绪的 B 即推进；窗口耗尽 / 另一 A 插队 → 断裂 | ✅ |
| `not` | `A -> not B within W` | 纯断言不消耗：W 内出现 B → 记 `NotViolation` | ✅ |
| `and` | `A -> B and C within W` | 窗口内 B、C **都**出现才推进（各自消耗） | ✅ |
| `or` | `A -> (B or C) within W` | 窗口内任一出现即推进（取最早就绪者） | ✅ |
| `opt` | `A -> B? -> C` | B 可缺省：链可直接跳过（有 B 用 B，贪心长路径） | ❌ W02 |
| `periodic` | `every A where timer:within(P±δ)` | 期望周期 P 的心跳断言：间隔 ∈ [P−δ, P+δ] 为正常；缺口/抖动入 `heartbeats` | ✅ engine ≥ 0.2.1 |

### 3.6 `nodeCounts` / `nodeConditions`（节点级约束，engine ≥ 0.2.1 起支持）

```json
{
  "groupId": "startup",
  "filterIds": ["A", "B", "C"],
  "edges": [],
  "nodeCounts":     { "B": { "min": 2, "max": 5 }, "C": { "min": 3 } },
  "nodeConditions": { "B": "level == 'E' && msg.includes('IPC')" }
}
```

* `nodeCounts`：filterId → `{ min?, max? }`，整型 ≥1，至少给一个端；
  缺省端 = `min:1` / `max:∞`；须 `min ≤ max`（S10）。语义 = EPL `A{2,5}`
  （该 filter 在链中此步重复出现 N 次）。
* `nodeConditions`：filterId → 表达式串（1..512 字符），对 filter 匹配事件
  二次过滤；表达式语法子集见 `plans/epl-cep-spec.md` P2-B（TS 侧
  `src/sequence/expr.ts` 为参照实现）。
* 两者的键 ∈ 所在 group 的 `filterIds`（S09）。
* **engine ≥ 0.2.1 起支持**：文件允许写（前向兼容），引擎按语义计算；
  `validate` 不再对这两个字段（及 `scope:thread` / `kind:periodic`）报 W01/W03/W04/W05。

### 3.7 完整 JSON Schema（draft 2020-12）

> 实现时原样落盘为 `schemas/cep-rules-1.schema.json` 并 `include_str!` 进
> engine（`loggraph schema` 命令输出同一份，保证三者不漂移）。
> 引擎侧校验以 §3.8 S 码为准，schema 是编辑器 / 外部工具的第一道防线。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://loggraph.dev/schemas/cep-rules-1.schema.json",
  "title": "logGraph CEP rules file (version 1)",
  "description": "约束 loggraph cep -R 规则文件。引用完整性等语义校验由引擎额外执行（契约 §3.8）。",
  "type": "object",
  "additionalProperties": false,
  "required": ["filters"],
  "properties": {
    "$schema":    { "type": "string", "format": "uri" },
    "version":    { "type": "integer", "const": 1, "default": 1 },
    "description":{ "type": "string", "maxLength": 2000 },
    "filters": {
      "type": "array", "minItems": 1, "maxItems": 1024,
      "items": { "$ref": "#/$defs/filter" }
    },
    "groups": {
      "type": "array", "maxItems": 1024, "default": [],
      "items": { "$ref": "#/$defs/group" }
    }
  },
  "$defs": {
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$"
    },
    "filter": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "pattern"],
      "properties": {
        "id":           { "$ref": "#/$defs/id" },
        "label":        { "type": "string", "maxLength": 64 },
        "pattern":      { "type": "string", "minLength": 1, "maxLength": 4096 },
        "isRegex":      { "type": "boolean", "default": false },
        "caseSensitive":{ "type": "boolean", "default": false }
      }
    },
    "group": {
      "type": "object",
      "additionalProperties": false,
      "required": ["groupId", "filterIds", "edges"],
      "properties": {
        "groupId":   { "$ref": "#/$defs/id" },
        "label":     { "type": "string", "maxLength": 64 },
        "scope":     { "enum": ["global", "thread"], "default": "global" },
        "filterIds": {
          "type": "array", "minItems": 1, "maxItems": 256,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/id" }
        },
        "edges": {
          "type": "array", "maxItems": 256,
          "items": { "$ref": "#/$defs/edge" }
        },
        "nodeCounts": {
          "type": "object", "maxProperties": 256,
          "propertyNames": { "$ref": "#/$defs/id" },
          "additionalProperties": { "$ref": "#/$defs/nodeCount" }
        },
        "nodeConditions": {
          "type": "object", "maxProperties": 256,
          "propertyNames": { "$ref": "#/$defs/id" },
          "additionalProperties": { "$ref": "#/$defs/expr" }
        }
      }
    },
    "edge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "fromFilterId", "maxGapMs"],
      "properties": {
        "id":           { "$ref": "#/$defs/id" },
        "kind":         { "enum": ["seq", "not", "and", "or", "opt", "periodic"],
                          "default": "seq" },
        "fromFilterId": { "$ref": "#/$defs/id" },
        "toFilterId":   { "$ref": "#/$defs/id" },
        "toFilterIds":  {
          "type": "array", "minItems": 2, "maxItems": 16,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/id" }
        },
        "maxGapMs":     { "type": "integer", "minimum": 0 },
        "periodMs":     { "type": "integer", "exclusiveMinimum": 0 }
      },
      "allOf": [
        { "if": { "required": ["kind"],
                  "properties": { "kind": { "enum": ["and", "or"] } } },
          "then": { "required": ["toFilterIds"],
                    "not": { "required": ["toFilterId"] } } },
        { "if": { "properties": { "kind":
                    { "enum": ["seq", "not", "opt", "periodic"] } } },
          "then": { "required": ["toFilterId"],
                    "not": { "required": ["toFilterIds"] } } },
        { "if": { "required": ["kind"],
                  "properties": { "kind": { "const": "periodic" } } },
          "then": { "required": ["periodMs"] } },
        { "if": { "properties": { "kind":
                    { "enum": ["seq", "not", "and", "or", "opt"] } } },
          "then": { "not": { "required": ["periodMs"] } } }
      ]
    },
    "nodeCount": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "min": { "type": "integer", "minimum": 1 },
        "max": { "type": "integer", "minimum": 1 }
      },
      "anyOf": [ { "required": ["min"] }, { "required": ["max"] } ]
    },
    "expr": { "type": "string", "minLength": 1, "maxLength": 512 }
  }
}
```

（`if` 条件的空缺省语义已核对：`kind` 缺省按 `seq` 走第二 / 四分支。）

***

## 3.8 语义校验规则（S 码，引擎侧强制）

> 输出形状见 §3.10；`path` 定位到最小 JSON 节点。同一问题只报一次、
> 不重复报。下表 "层"= 校验所属层：结构层（schema 镜像）/ 语义层（typed）。

| 码 | 层 | 规则 | 失败示例 |
| --- | -- | --- | --- |
| S01 | 语义 | `filters[].id` 全局唯一 | 两个 filter 都叫 `error` |
| S02 | 语义 | `groups[].groupId` 全局唯一 | 两个 group 都叫 `startup` |
| S03 | 语义 | `groups[].filterIds[]` ⊆ 已声明 filter | filterIds 引用了不存在的 `X` |
| S04 | 语义 | 边端点（from + to）∈ 所在 group 的 filterIds | 边引用了 group 外的 filter |
| S05 | 语义 | `edges[].id` **跨 group** 全局唯一 | 两个 group 里都有 `e1` |
| S06 | 语义 | kind ↔ 目标字段匹配（§3.5 表） | `and` 边只给了 `toFilterId` |
| S07 | 语义 | `periodic` ↔ `periodMs` 匹配（§3.5 表） | `seq` 边带 `periodMs` |
| S08 | 语义 | `isRegex:true` 的 pattern 可编译 | `([unclosed` |
| S09 | 语义 | `nodeCounts`/`nodeConditions` 键 ∈ 所在 group 的 filterIds | 键 `Z` 不在 filterIds |
| S10 | 语义 | nodeCount `1 ≤ min ≤ max`（缺省端 min=1 /max=∞） | `{ "min": 5, "max": 2 }` |
| S11 | 版本 | `version` ∈ 引擎支持集（当前 `{1}`）；非整数 → schema 层 | `"version": 2` |

校验顺序与聚合（✅ Stable）：

1. **语法层**（E_RULES_SYNTAX）：JSON 解析失败即终止，一条 issue。
2. **版本闸门**（S11）：解析成功后立即检查 `version`。缺省 = 1。
   不支持的版本**立即终止**（后面的结构校验对未知版本没有意义），
   报 `E_RULES_VERSION`。非整数类型（如 `"1"`、`1.5`）归 schema 层。
3. **结构层**（E_RULES_SCHEMA）：镜像 §3.7 schema 的手写校验
   （未知字段 / 必填 / 类型 / 枚举 / id 正则 / 边界 / 去重），**聚合全部**
   问题后一次性返回。kind↔字段条件（S06/S07）**不在此层**—— 结构层不懂
   kind 缺省语义，统一在语义层做（schema 里的 `allOf` 是编辑器用的）。
4. **语义层**（E_RULES_SEMANTIC）：typed 反序列化成功后执行 S01–S10，
   聚合全部问题。S08 失败的错误码是 `E_PATTERN`（不是 E_RULES_SEMANTIC），
   但 issue 仍带 `rule: "S08"`。

前层失败 → 后层跳过（语义层跑在干净结构上，报错才有意义）。

### 3.9 警告规则（W 码：v1 不支持 → fallback，永不阻断）

| 码 | 触发 | 处理 |
| --- | --- | --- |
| W01 | `scope: "thread"` | ⚠️ 已支持：engine ≥ 0.2.1 按 thread 分桶隔离匹配，不再触发 fallback / 告警 |
| W02 | `kind: "opt"` 边 | ⚠️ 已支持：engine ≥ 0.2.0 支持 opt 边（复用 seq 推进，缺失即跳过），不再触发 fallback |
| W03 | `kind: "periodic"` 边 | ⚠️ 已支持：engine ≥ 0.2.1 起心跳断言填入 `heartbeats`，不再触发 fallback / 告警 |
| W04 | `nodeCounts` 非空 | ⚠️ 已支持：engine ≥ 0.2.1 起节点循环计数生效，不再触发 fallback / 告警 |
| W05 | `nodeConditions` 非空 | ⚠️ 已支持：engine ≥ 0.2.1 起节点条件表达式生效，不再触发 fallback / 告警 |

* 警告不进 `RuleReport.errors`，不阻断 parse；`cep` 运行时 stderr 提示一次
  并在 `--json` 顶层带 `"fallback": true`。
* 消息模板（历史示例，engine ≥ 0.2.1 起不再产生）：`nodeCounts 引擎 v1 不支持，该 group 将不计算（fallback）`。

### 3.10 RuleIssue 与错误码总表

```json
{ "code": "E_RULES_SCHEMA", "rule": "S04",
  "path": "$.groups[0].edges[1].toFilterId",
  "message": "边端点 \"Z\" 不在 group \"startup\" 的 filterIds 中" }
```

| code | 层 | 场景 | CLI 退出码 |
| --- | -- | --- | --- |
| `E_RULES_SYNTAX` | 语法 | JSON 解析失败 | 2 |
| `E_RULES_VERSION` | 版本 | S11 | 2 |
| `E_RULES_SCHEMA` | 结构 | 未知字段 / 类型 / 枚举 / 边界 | 2 |
| `E_RULES_SEMANTIC` | 语义 | S01–S07、S09、S10 | 2 |
| `E_PATTERN` | 语义 | S08 正则编译失败 | 2 |
| `E_GLOB` | 遍历 | `-g` 非法 glob | 2 |
| `E_IO` | 运行 | 文件读失败、walk io 错误 | 2 |
| `E_NO_FILES` | 遍历 | 路径下无可搜索文件 | 2 |

（`E_NO_FILES` 是否单独成码：单独成码 ——agent 需要区分 "目录空" 与
"权限 / 路径错误"，处理建议不同：前者提示用户换路径，后者直接失败。）

### 3.11 完整示例（合法，含 v1 保留字段）

```json
{
  "$schema": "https://loggraph.dev/schemas/cep-rules-1.schema.json",
  "version": 1,
  "description": "示例：启动链 + 禁止性断言 + v1 保留字段",
  "filters": [
    { "id": "startup", "label": "启动完成", "pattern": "Startup phase complete" },
    { "id": "upstream", "label": "上游恢复", "pattern": "Upstream recovered", "isRegex": false },
    { "id": "reset", "label": "连接重置", "pattern": "reset by peer", "isRegex": true, "caseSensitive": false }
  ],
  "groups": [
    {
      "groupId": "startup_chain",
      "label": "启动健康链",
      "scope": "global",
      "filterIds": ["startup", "upstream", "reset"],
      "edges": [
        { "id": "e1", "kind": "seq", "fromFilterId": "startup",
          "toFilterId": "upstream", "maxGapMs": 20000 },
        { "id": "e2", "kind": "not", "fromFilterId": "startup",
          "toFilterId": "reset", "maxGapMs": 20000 }
      ]
    },
    {
      "groupId": "future_features",
      "filterIds": ["startup", "upstream"],
      "edges": [
        { "id": "e3", "kind": "opt", "fromFilterId": "startup",
          "toFilterId": "upstream", "maxGapMs": 10000 }
      ],
      "nodeCounts":     { "startup": { "min": 1, "max": 3 } },
      "nodeConditions": { "upstream": "level == 'I'" }
    }
  ]
}
```

上面第二个 group 在 engine ≥ 0.2.1 下完全受支持：文件合法可保存、可交换，
引擎按 `nodeCounts`/`nodeConditions`/`opt` 语义计算，不再触发 W02/W04/W05 告警、
也不会 `fallback`。**支持性写法与合法性写法分开**（旧版 v1 才需要担心告警），
这正是 v1 文件能前向迁移到 v2 的原因。

### 3.12 UI 映射（导入导出）

| UI 概念 | `.cep` 字段 | 说明 |
| --- | --- | --- |
| Filter（含 scope/regex/case） | `filters[]` | UI Filter 的 `scope:"message"` 无法表达：**导出时弹窗提示**"该过滤器按整行匹配"（引擎按 raw 匹配，§3.3） |
| Filter name | `label` | 缺省用 `id` |
| Filter 匹配模式 | `pattern` + `isRegex` | literal → `isRegex:false`；regex → `true` |
| Filter 大小写 | `caseSensitive` | UI 默认不敏感 = `.cep` 缺省一致 |
| Group / 头节点 | `groups[]` | UI 拓扑图邻接表展开为 `edges[]` |
| Edge kind | `kind` | UI 创建 and/or 边时只填 `toFilterIds` |
| 节点数量约束（如 3..5） | `nodeCounts` | engine ≥ 0.2.1 起运行时生效，无需降级 |
| 表达式条件 | `nodeConditions` | 同上，engine ≥ 0.2.1 起生效 |
| 颜色 / 折叠 / 视图 | —（不进 `.cep`） | 存 UI 工程文件（如 `.lgui.json`，v1 不定） |

### 3.13 `threadStats`（thread 解析质量，✅ engine ≥ 0.2.1）

**背景**：`thread` 不是日志里的独立字段，而是**位置启发式**的解析产物
（`parse_rest` 只认紧跟时间戳的 `[...]`）。实测 9 种常见格式只有 1 种能解析出
thread（log4j2 那种线程写在最前的写法）；level 写在 thread 之前的 Spring Boot /
Logback 两种主流写法、以及 nginx / syslog / Python logging 全部解析不出。

解析不出时所有事件落进同一个空桶 `∅`，`scope: "thread"` 就**静默退化成 global**
——行为保守（等价于没开分桶），但调用方会误以为在按线程隔离，从而相信那些跨线程
串出来的伪链。故引擎**不论 scope 是否为 thread** 都回传以下统计（纯可观测性，
不改变任何匹配语义）：

```json
"threadStats": { "totalEvents": 1200, "withThread": 0, "distinctThreads": 0 }
```

| 字段 | 含义 |
| --- | --- |
| `totalEvents` | 参与本组匹配的事件总数（与分桶、`uncoveredEvents` 用的是同一批事件） |
| `withThread` | 其中解析出非空 thread 的事件数 |
| `distinctThreads` | distinct thread 数（`∅` 桶不计入） |

调用方据此可判读两种指纹（覆盖率由消费端算，引擎不回传浮点，避免跨端比较分歧）：

| 指纹 | 含义 | 后果 |
| --- | --- | --- |
| `withThread === 0` | 全部落 `∅` 单桶 | `scope:"thread"` ≡ 全局，链会跨线程串出伪链 |
| `distinctThreads / withThread ≈ 1` | 几乎每个事件一个桶 | 疑似把 traceId/requestId 当成 thread；链必须在桶内成立 ⇒ **全部漏报（零链）** |

**误抓远比漏解析危险**：漏解析只是退化成全局（结果保守可用），误抓会把流拆碎导致
链永远凑不齐。因此**禁止**用"取消行首锚定、到处找方括号"来提高覆盖率——那只是把
假阴性换成更坏的假阳性。若要改进解析，须同步修改引擎 `parser/line.rs::parse_rest`
与前端 `parser/LogParser.ts::parseRest`（逐行对齐的两份同款实现）。

前端展示位：CEP 面板每个分组块的头部（`scope === 'thread'` 时才显示，全局作用域下
分桶不生效、提示纯属噪音），实现见 `src/sequence/threadHint.ts`。

### 3.14 跨行 filter（✅ engine ≥ 0.2.2 起引擎内自聚合并下推）

`FilterQuery.pattern` **允许含 `\n`**：多行 filter 即"同一行必须同时满足多个条件"
（换行分隔 AND，行首 `!` 表示排除）。引擎侧处理分三步：

1. **拆分**（`session.rs::split_sub_conditions`，端口自前端
   `src/filters/FilterEngine.ts::splitSubConditions`）：剥 `!` 前缀、
   trim 首尾空白、跳过空行、纯 `!` 行丢弃。
2. **下推**：每个子条件作为独立 `FilterQuery` 参与扫描，id 为 `fid\0i`
   （分隔符 `SUB_ID_SEP = '\0'`，与前端 `dbStore.ts::SUB_ID_SEP` **逐字节一致**）。
   —— 正因分隔符一致，引擎的条目与前端 ws_filters 路径产出的条目**共享同一份
   命中缓存**，不重复扫描。
3. **聚合**（`session.rs::aggregate_sub_hits`，端口自 `dbStore.ts::aggregateSubHits`）：
   正向子条件行集取交集 − 排除子条件行集并集；以最短正向子条件为基，ts 取基列表同行值。
   结果按原始 `fid` 入缓存 ⇒ `ws_sequences` 直接用 `fid` 取命中。

| 输入 | 引擎行为 | 与前端一致性 |
| --- | --- | --- |
| 单行 pattern | 直通（不拆分，逐字节同旧行为） | ✅ |
| `abc\ndef` | 交集：同时含 abc 与 def 的行 | ✅ |
| `abc\n!def` | 含 abc 但不含 def 的行 | ✅ |
| 含 `\n` 但拆分后全为排除（无正向锚） | 跳过，视为无命中 | ✅ 与前端同源（需全量行基集，目录模式拿不到） |
| 全空白 pattern | 跳过，视为无命中 | ✅ |

**为什么这条重要**：此前含跨行 filter 的 group 只能整组回退前端 TS 引擎
（引擎只有 `fid\0i` 子条目、拿不到整条命中），CEP 在 dbMode 下因此有整块能力缺口。
引擎内聚合后，`ws_sequences` 的 `queries` 可直接提交原始跨行 pattern。

**改动约束**：`splitSubConditions` / `aggregateSubHits` 在两端各有一份实现
（引擎 `session.rs` ↔ 前端 `FilterEngine.ts`+`dbStore.ts`），
**改任一侧都必须同步改另一侧并两端补测试**——分叉会让同一 filter 在 UI 与
引擎算出不同命中，且表现为"某几条链莫名对不上"，极难定位。

### 3.15 自签更新通道（✅ engine ≥ 0.2.2，桌面端）

用户装了之后感知不到新版本是真问题，但**代码签名证书要花钱且与代码质量无关**，
那条路明确不做。二者并不冲突：Tauri updater 用 **minisign 密钥对自签名**，
密钥自生成、零成本，与操作系统信任链的代码签名是两回事。

| 角色 | 存放位置 | 说明 |
| --- | --- | --- |
| 公钥 | `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` | 可公开，客户端用它校验产物签名 |
| 私钥 | GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` | **绝不可进仓库**；丢失即无法再签名，更新通道永久失效 |
| 清单 | tauri-action 随 release 产出 `latest.json` | 含各平台产物 URL 与签名 |

**为什么 release 不能是 Pre-release**：updater 的 endpoint 是
`https://github.com/javenleeCH/LogGraph/releases/latest/download/latest.json`，
而 Pre-release **不进 `latest`**——标记成 Pre-release 会让更新清单 404。
未签名是分发层面的放行问题（已写入 release notes），不是版本成熟度问题，
两者不要混为一谈，故 `prerelease: false`。

**刻意不自动重启**：下载安装完成后只提示重启，不调用 relaunch。用户可能正
开着日志在分析，中途重启会打断工作——让他们自己决定何时重启。

入口：⌘K 命令面板 → 「更新」→「检查更新…」（实现 `src/io/updater.ts`）。
Web 版无更新通道（刷新即最新），调用时明确提示而非静默失败。

***

## 4. CLI 命令面（`loggraph`，D7）

> clap derive 实现；`--version` 输出语义化版本；所有子命令共用 §4.6 退出码。
> 面向 agent / 脚本的稳定参数集如下，**新增参数须默认值不改变行为**。

### 4.1 `loggraph search <PATH> <PATTERN>`

rg 习惯（默认正则、默认忽略隐藏、尊重 gitignore）：

| 参数 | 短 | 说明 |
| --- | --- | --- |
| `PATH` | — | 文件或目录；目录递归 |
| `PATTERN` | — | **默认按正则**（Rust regex 语法） |
| `--fixed-strings` | `-F` | 按字面量匹配 |
| `--ignore-case` | `-i` | 忽略大小写（默认区分） |
| `--hidden` / `--no-ignore` | — | 同 rg |
| `--glob <GLOB>` | `-g` | 可多次，`!` 前缀排除（D2：无默认扩展名过滤，推荐 `-g "*.log"`） |
| `--json` | — | §5.1 机器输出 |

示例：`loggraph search . "FATAL|PANIC" -g "*.log" --json`

### 4.2 `loggraph cep <PATH> -R <RULES>`

| 参数 | 短 | 说明 |
| --- | --- | --- |
| `PATH` | — | 文件或目录 |
| `--rules <FILE>` | `-R` | `.cep` 规则文件（§3）；读取后先 `parse_rules`，失败即 §3.10 码 + 退出码 2 |
| `--json` | — | §5.2 机器输出 |
| `--fail-on-violation` | — | 存在 NOT 违规 → 退出码 1（默认关，D5：agent 要数据不要门槛） |
| `--fail-on-unsupported` | — | `fallback=true` → 退出码 3（默认关，D10） |
| `--hidden` / `--no-ignore` / `-g` | — | 同 search |

### 4.3 `loggraph validate <RULES_FILE>`（D9）

* 只校验不扫日志：语法 → 版本 → 结构 → 语义，聚合全部问题（§3.8）。
* 文本输出：每问题一行 `[S04] $.groups[0].edges[1].toFilterId: 边端点 "Z" …`，
  末行 `错误 N，警告 M`；`--json` 输出 §5.3。
* 退出码：合法 0；有错误 1；文件本身读不到 2。

### 4.4 `loggraph schema [cep]`（D9）

* 输出内嵌 schema（§3.7 同一份）为**紧凑单行 JSON**（`schema` 子命令专供
  agent / 工具管道，紧凑格式便于 `| jq` 后再处理）。
* 当前仅 `cep` 一种；其他值 → stderr 错误 + 退出码 2。
* 用途：写规则前先拿 schema、或喂给 LLM 生成规则文件。

### 4.5 帮助与版本

* `loggraph` 无参 = `--help`（clap 默认）；`--help` 含各退出码表（§4.6）。
* `--version` = 引擎 + 契约版本（如 `loggraph 0.2.0 (cep-rules v1)`）。

### 4.6 退出码（✅ Stable，对齐 rg，D3）

| 码 | search | cep | validate | schema |
| - | --- | --- | --- | --- |
| 0 | 有命中 | 正常完成 | 规则合法 | 输出成功 |
| 1 | 无命中 | `--fail-on-violation` 且存在违规 | 存在校验错误 | — |
| 2 | 错误（E_*） | 错误（E_*） | 文件读取失败 | 未知 schema 名 |
| 3 | — | `--fail-on-unsupported` 且 fallback | — | — |

* 0/1 语义与 rg 一致（无命中不是错误）；2 统一表示 "本次没跑成"；
  3 专表 "跑成了但结果不完整（v1 能力边界）"。
* 错误信息一律 stderr；stdout 只承载结果（可安全管道）。

### 4.7 文本输出格式（人类输出）

* search：`{path}:{line}:{text}`，随后 stderr 一行统计
  （`命中文件 3/120，命中行 42，耗时 15 ms`）。
* cep：按 group 分段（`══ group <groupId>[（<label>）] ══` 分隔行），
  链内每 Step 一行 `{UTC 时间} {filterId} {raw}`；NOT 违规
  `NOT 违规 edge={id}：{from raw} ← 禁止窗口内出现 {to raw}`；
  边统计 `edge {id}：匹配 N，断裂/违规 M`；统计与警告走 stderr。
* 文本输出里的时间戳 = `YYYY-MM-DD HH:MM:SS.mmm`（**UTC**，D6：
  避免机器上时区配置影响输出稳定性；JSON 恒 epoch ms）。
* 文本格式**不承诺稳定**（agent 请用 `--json`）。

***

## 5. JSON 输出契约（CLI `--json` 与 Tauri IPC 共用形状）

> 序列化统一 serde：字段 camelCase、`deny_unknown_fields`（输入侧）、
> 序列化侧不输出 null 字段（Option = None 时整个键不出现）。
> **键序 = 声明序**（serde 默认），消费方不应依赖键序但引擎保持确定。

### 5.1 `search --json`

```json
{
  "files": [
    { "path": "logs/app.log",
      "hits": [ { "line_number": 12, "text": "12:00:00.123 FATAL db down" } ] }
  ],
  "stats": {
    "filesSearched": 120,
    "filesWithMatches": 3,
    "matchedLines": 42,
    "elapsedMs": 15
  }
}
```

* `files` 含**全部**被扫文件（零命中文件也保留空 `hits` 数组），
  顺序 = `walk` 输出序（§2.2：同一快照下确定）。
* `line_number` snake_case（D4）；`elapsedMs` 为 `u128` 截断至 `u64` 序列化。

### 5.2 `cep --json`

```json
{
  "response": {
    "fallback": false,
    "results": {
      "startup_chain": {
        "groupId": "startup_chain",
        "chains": [
          {
            "chainIndex": 1,
            "steps": [
              { "edgeId": "e1", "filterId": "startup",
                "event": { "id": 12, "ts": 1704067205100,
                           "raw": "09:00:05.100 [main] INFO  Startup phase complete",
                           "message": "Startup phase complete", "thread": "main" } },
              { "edgeId": "e1", "filterId": "upstream",
                "event": { "id": 19, "ts": 1704067224500,
                           "raw": "09:00:24.500 [net-1] INFO  Upstream recovered",
                           "message": "Upstream recovered", "thread": "net-1" } }
            ],
            "startTs": 1704067205100,
            "endTs": 1704067224500,
            "thread": null
          }
        ],
        "uncoveredEvents": [],
        "edgeStats": [
          { "edgeId": "e1", "matchedCount": 1, "missCount": 0,
            "lateCount": null, "jitterCount": null },
          { "edgeId": "e2", "matchedCount": 0, "missCount": 0,
            "lateCount": null, "jitterCount": null }
        ],
        "notViolations": [
          { "edgeId": "e2",
            "fromEvent": { "id": 12, "ts": 1704067205100,
                           "raw": "09:00:05.100 [main] INFO  Startup phase complete",
                           "message": "Startup phase complete", "thread": "main" },
            "toEvent":   { "id": 15, "ts": 1704067208800,
                           "raw": "09:00:08.800 [net-0] WARN  Connection reset by peer",
                           "message": "Connection reset by peer", "thread": "net-0" } }
        ],
        "heartbeats": [],
        "totalChains": 1,
        "totalUncovered": 0,
        "coveredMarks": {},
        "threadStats": { "totalEvents": 3, "withThread": 3, "distinctThreads": 3 }
      }
    }
  },
  "stats": {
    "files": 1,
    "filterHits": { "startup": 1, "upstream": 1, "reset": 1 },
    "eventsWithTs": 3,
    "tsFormat": "time-only-ms",
    "noTs": 0
  }
}
```

* `results` 是 **groupId → SeqResult** 的 map；JSON 里按 groupId 字典序输出
  （Rust `BTreeMap`），agent 可依赖。
* `thread: null` / `lateCount: null`：null 与缺省不同（字段存在、值未知 / 无）。
  `heartbeats` 由 periodic 边填充（engine ≥ 0.2.1 起支持；更早版本恒 `[]`）。
* `totalChains`/`totalUncovered`：全量真值。未设 `maxChains` 时分别等于
  `chains.length`/`uncoveredEvents.length`；截断后链表被裁但统计保真。
* `coveredMarks`：仅设 `maxChains` 截断时非空——`filterId → [[事件id, 链号], …]`
* `threadStats`：thread 解析质量，**不论 scope 是否 thread 都产出**（§3.13）。
  全量 lane 标记（含被截掉的链），供 UI 时间线标链用；未截断为 `{}`，
  调用方自行从 `chains` 推导。
* `fallback: true` 时被跳过的 group **不在 `results` 里**（不是空结果占位），
  其余 group 照常计算。

### 5.3 `validate --json`

```json
{
  "valid": false,
  "errors": [
    { "code": "E_RULES_SEMANTIC", "rule": "S04",
      "path": "$.groups[0].edges[1].toFilterId",
      "message": "边端点 \"Z\" 不在 group \"startup\" 的 filterIds 中" }
  ],
  "warnings": [ ]
  // engine ≥ 0.2.1 起 W01/W03/W04/W05 不再产生：上面 group[1] 的
  // scope=thread / periodic / nodeCounts / nodeConditions 均正常计算，无告警。
}
```

* 合法文件：`{ "valid": true, "errors": [], "warnings": [...] }`
  （警告不阻断合法性）。
* `rule` 在结构层问题（未知字段等）时缺省（无 S 码可标）。

***

## 6. Tauri IPC 命令面（`engine_*`，src-tauri）

> 数据层命令面为 `ws_*`（v1.3 REST 化，无会话状态，§11）与 `parser::*`；
> `engine_*` 是直扫族平行面。三条命令族并存。

### 6.1 命令清单（v1 全集）

| 命令 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `engine_search` | `{ root, pattern, walk }` | `{ files, stats }`（§5.1） | rg 直扫；UI 搜索框 |
| `engine_run_cep` | `{ root, rulesJson, walk }` | `{ response, stats }`（§5.2） | rulesJson = `.cep` 文件全文（UI 负责读文件） |
| `engine_validate_rules` | `{ rulesJson }` | §5.3 `RuleReport` | UI 表单实时校验 |
| `engine_walk` | `{ root, walk }` | `Vec<String>` | 目录清单（UI 选择器） |

* `pattern` = §2.2 `Pattern` DTO（camelCase）；`walk` = §2.2 `WalkOptions`
  DTO。参数校验在 engine（壳层只转发）。
* **错误统一走 Tauri reject**：`ErrorDto { code, message, details? }`
  （§2.1 序列化形状）；UI 按码分支（`E_RULES_VERSION` → 提示升级等）。

### 6.2 参数与返回 DTO（TypeScript 侧形状）

```typescript
interface EngineSearchRequest {
  root: string;                       // 文件或目录
  pattern: { pattern: string; caseSensitive: boolean; isRegex: boolean };
  walk:   { hidden: boolean; noIgnore: boolean; globs: string[]; exts: string[] };
}
// 返回 = §5.1 形状；cep 返回 = §5.2 形状；字段名与 Rust DTO 一一对应
```

### 6.3 错误传播

```rust
#[tauri::command]
fn engine_run_cep(req: RunCepRequest) -> Result<RunCepOutcome, ErrorDto> {
    // 壳层零逻辑：parse_rules → walk → run_cep，错误 e.to_dto()
}
```

* `details` 仅规则类错误携带：`{ "issues": [RuleIssue…] }`（§3.10）。
* panic 兜底：tauri 层 `catch_unwind` 不做（v1），engine 无 unwrap 业务路径。

### 6.4 迁移策略（UI 现有调用 → engine_*）（⚠️ 已被 §11.4 替代，保留作历史记录）

| 现命令 | 迁移到 | 差异 |
| --- | --- | --- |
| `parser::parse_log` / `parse_dir` | （无，废弃） | 旧全量解析路径；UI 直接消费 `engine_search` |
| `parser::dir_lines_chunk` / `dir_events_chunk` / `dir_cache_drop` | `engine_search` | 分块 + 缓存机制废弃；命中行直接全量返回（零命中文件也返回） |
| `db_open` / `db_event_index_chunk` / `db_filters_batch` / `db_events_in_window` / `db_lines_by_ids` / `db_files` / `db_reveal_path` / `db_open_path` / `db_close` | `engine_run_cep` | SQLite 索引整条链路废弃（引擎无 DB） |
| `sequence::db_run_sequences` | `engine_run_cep` | TS SequenceMatcher 输入改从 `engine_search` 结果构造 |

UI 切换顺序（每步独立可发布）：搜索屏 → 文件树 → CEP 屏 → 删除旧命令。

旧命令在全部 UI 切换完成前**保持可用**（不设过渡期截止日期）。

### 6.5 进度与取消（v1 边界）

v1 无流式进度 / 取消命令（引擎单次调用同步完成；大目录靠 `-g` 收敛）。

`engine_walk` 先行返回清单，UI 可据此展示 "将扫描 N 文件"。

（扩展位：v2 可加 `on_progress` 事件 + `engine_cancel`，见 §8。）

***

## 7. Agent 使用指南（契约自描述）

* 拿 schema：`loggraph schema cep > cep.schema.json`
* 校验草稿：`loggraph validate my-rules.cep.json`（退出码 0 再进下一步）
* 跑分析：`loggraph cep <path> -R my-rules.cep.json --json`
* 判读：`jq '.response.results.<groupId>.chains | length'`；
  违规 `.response.results.<groupId>.notViolations`；
  未覆盖事件 `.response.results.<groupId>.uncoveredEvents`。
* **用 `scope:"thread"` 的规则必读** `.response.results.<groupId>.threadStats`
  （§3.13）：`withThread === 0` 表示**分桶根本没生效、结果等同全局**，此时
  结论不可按线程解读（会串出跨线程伪链）；`distinctThreads ≈ withThread`
  表示疑似把 traceId/requestId 当成了 thread，零链是拆分所致而非真的没发生。
* 错误处理：stderr 首行 `错误: …`，随后每问题一行 `  [S04] $.path: message`；
  agent 按 §3.10 code 分支，`path` 直接可定位 JSON 节点。
* 前向兼容：新增字段会 bump `version`；agent 遇 `E_RULES_VERSION`
  应提示升级引擎而不是改文件。

***

## 8. v1 能力边界（明确不做）

| 项 | 状态 | 备注 |
| --- | --- | --- |
| 跨行 filter 下推 CEP | ✅ 支持（engine ≥ 0.2.2，引擎内拆分 + 聚合，见 §3.14） |
| 自签更新通道（updater） | ✅ 支持（engine ≥ 0.2.2，minisign 自签，见 §3.15） |
| **代码签名证书** | ❌ | Authenticode / Developer ID 要花钱且与代码质量无关，不做。代价是首次运行需人工放行 SmartScreen / Gatekeeper（已写入 release notes） |
| 线程域序列（`scope:"thread"`） | ✅ 支持（engine ≥ 0.2.1，按 thread 分桶隔离匹配） |
| thread 字段的格式自适应解析 | ❌ | 位置启发式：只认紧跟时间戳的 `[...]`。多数格式解析不出 ⇒ 分桶退化为全局，**质量回传 `threadStats`（§3.13）而非自动适配** |
| `opt` 边 | ✅ 支持（engine ≥ 0.2.0，复用 seq 推进，缺失即跳过） |
| `periodic` 边 /heartbeats | ✅ 支持（engine ≥ 0.2.1，缺口/抖动入 `heartbeats`） |
| nodeCounts / nodeConditions | ✅ 支持（engine ≥ 0.2.1，节点循环计数 / 条件表达式） |
| 多文件跨行窗口（按文件分桶） | ❌ | v1 全局时间轴（文件按 walk 序拼接） |
| 流式进度 / 取消 | ❌ | §6.5 |
| 输出重定向 / 文件监听（watch） | ❌ | CLI 一次一跑 |
| 规则文件热重载 | ❌ | 每次 `-R` 重新读 |
| 时区配置（TZ env / 手动指定） | ❌ | D6：文本输出恒 UTC |
| 中文分词 / 编码猜测（GBK 等） | ❌ | UTF-8 假定（§0.3） |

**v1 输出容量上限**：单文件命中行无上限（流式）；`search_all` 的
`files` 数组 = 全部被扫文件（超大目录内存 = O(文件数 × 空数组开销)，
可接受）；CEP 事件 = 命中行（非全量），超大命中集内存压力由用户侧
`-g` / 更窄 pattern 控制。

***

## 9. 与原型的差异（按本契约改造的清单）

| # | 现状（原型） | 目标（本契约） | 影响 |
| -- | --- | --- | --- |
| 1 | engine 错误为 `String` | `EngineError` + code（§2.1） | CLI/Tauri 可分支 |
| 2 | `Pattern` 无 deny_unknown_fields | 加（§0.3） | IPC 输入收紧 |
| 3 | `search --json` 输出裸数组 | `{ files, stats }` 信封（§5.1） | 破坏性，见下 |
| 4 | `SearchStats` 序列化 snake_case | camelCase（§5.1） | 破坏性，见下 |
| 5 | CLI 无 `validate`/`schema` | 新增（§4.3/§4.4） | 纯增量 |
| 6 | CLI 无 cep 子命令 | `cep -R`（§4.2） | 新功能 |
| 7 | CLI exit code 无语义 | 0/1/2/3（§4.6） | 脚本兼容性提升 |
| 8 | EdgeSpec.toFilterId: String 必填 | Option + toFilterIds（§3.5） | 结构性，见下 |
| 9 | rules 文件无 version/$schema/label | v1 契约（§3.2） | `sample/cep-rules.example.json` 同步改 |
| 10 | Tauri 无 engine_* 命令 | §6.1 四命令 | 平行新增，不动旧的 |
| 11 | run_sequences 返回 HashMap | BTreeMap（§2.4） | JSON 键序确定 |
| 12 | CLI 文本输出本地时间 | UTC（§4.7，D6） | 跨机器一致 |

**破坏性变更声明**（v1 未发布，直接改，不留兼容层）：

* `search --json` 裸数组 → `{files, stats}` 信封（#3、#4）。
* `EdgeSpec.toFilterId` 类型 String → Option（#8）：and/or 边从此
  只用 `toFilterIds`。旧 TS 侧 `SequenceEdge.toFilterId` 仍是 string 必填
  （TS 侧是另一套 DTO，随 UI 迁移一起改）。

其余均为加法或不改变外部行为的内部重构。

***

## 10. 决议记录（D1–D11 已于 2026-10-09 全部按建议确认）

* **D1 默认匹配模式**：CLI 位置参数默认正则（rg 习惯）✅已定；规则文件
  filter 默认字面量（UI 习惯，`isRegex` 缺省 false）✅已定。两者不一致是
  刻意的：CLI 对齐 rg、文件对齐 UI。
* **D2 默认扩展名**：不限制（rg 语义）✅已定；日志场景在文档 / 示例里
  推荐 `-g "*.log"`。
* **D3 退出码**：对齐 rg（search 无命中 = 1）✅已定。
* **D4 `line_number` 命名**：保持 snake_case（`rg --json` 先例）✅已定，
  其余全 camelCase。
* **D5 NOT 违规退出码**：`--fail-on-violation` 开关、默认关 ✅已定
  （agent 要数据不要门槛；CI 需要门槛自己开）。
* **D6 时间戳显示**：文本输出转 UTC 串，JSON 恒 epoch ms ✅已定。
* **D7 二进制名**：`loggraph`（Windows 下 loggraph.exe）✅已定。
* **D8 扩展名**：推荐 `.cep.json`，`.cep`/`.json` 均接受，不按扩展名
  拒绝 ✅已定。
* **D9 新增 `validate`/`schema` 子命令**：✅已定（agent/CI 入口，实现
  成本≈0）。
* **D10 `--fail-on-unsupported`（fallback → 3）**：✅已定，默认关。
* **D11 数量上限**：✅已定，filters 1024 / groups 1024 / group 内
  filterIds 256 / edges 256 / toFilterIds 16 / nodeCounts (nodeConditions)
  256，按 §3.7 所列值冻结；后续调整走 minor 版本。

---

## 11. v1.2 附录 → v1.3 REST 化重写（2026-10-15）

> v1.2 将会话 API 下沉引擎并确立 IPC⇄CLI 1:1；v1.3 在此基础上做
> **REST 化重构**：命令无状态自描述，客户端携带上下文（ctx），
> 服务端（Tauri / CLI）零跨请求状态。本节为当前有效版本。

### 11.0 REST 原则（v1.3 确立）

* **请求自描述**：每个命令携带完整定位信息（`dir` + `ctx` + 业务参数），
  服务端不持有任何跨请求状态（无会话句柄、无 `MEM_DB`、无隐式 current）。
* **ctx 客户端持有**：`ws_info`（唯一付整读价的入口）返回 `WsCtx`
  （文件表 + 行数/范围/格式 id 的快照），客户端保存并在后续请求回传。
  引擎信任回传布局（快照语义：活日志追加不炸、不做 mtime 校验拒绝）；
  结构性损坏（空文件表 / first_line 非升序 / 未知格式 id）→ `E_USAGE`。
* **大产物走透明内容寻址磁盘缓存**（`.logGraph/` 下，可删、只影响延迟）：
  +- 行偏移表 `index/<fnv64(name)>.off`：单文件懒建（`ws_line`/`ws_lines`
    seek 直读用），头部 size/mtime/行数三验防陈旧；
  +- filter 命中集 `cache/filters/<hex(fnv(ctx_sig+定义指纹))>.bin`：
    键即校验，miss 重扫；`ctx_sig = fnv(root + Σ(name,firstLine,lineCount,size))`。
  +- 引擎零写副作用：产物经 `Session::take_persistable()` 以数据返回，
    壳层尽力落盘（建父目录 + 临时文件 + 原子改名；失败只降速不变错）。
* 删除的命令（v1.2 存在，v1.3 移除）：`db_open`/`db_close`/`db_filter_drop`
  （指纹寻址缓存免清理）/`db_corr_ids`（前端本地按窗口过滤命中集）。
  `db_files` 同步移除：文件清单由 ctx.files 客户端推导（firstLine/name
  已在 ctx，path = dir + name 拼接）。

### 11.1 引擎会话 API（`engine::session`，v1.3 形状）

`Session` 为纯 Rust 库类型（无 tauri 依赖、零文件写副作用、可独立
`cargo test`），是**请求级工作视图**（非跨请求句柄）：

| 方法 | 语义 |
| --- | --- |
| `Session::build_ctx(root, files, emit)` | 便宜通道建库（并行读 + 计数 + 首/末行 ts；排除 `.logGraph`）→ `WsCtx`；`files=None` 全集；`emit(loaded,total,current)` 逐文件进度。行偏移不驻留（统一懒建） |
| `Session::from_ctx(root, &ctx)` | 按回传 ctx 零 I/O 重建请求级视图（快照语义，结构损坏报错） |
| `ctx()` | 导出 ctx（`build_ctx` 内部即由它产出） |
| `filters_batch(&queries)` | RAM 指纹 → `.logGraph` 命中盘缓存 → miss 单遍批量直扫；`(out, cached, miss, scan_perf)`；扫描结果入待落盘队列 |
| `line(no)` / `lines_by_ids(&ids)` | 行偏移 seek 直读；偏移懒建（盘缓存三验 → 现读现建并入队） |
| `corr_ids(&fids, start, end)` | 命中并集按 ts 窗口过滤（引擎保留；IPC 已删，CLI 用） |
| `file_infos()` | 文件清单（firstLine/name/path）；CLI `ws files` 用 |
| `run_sequences(&groups)` | filter 命中 → `SeqEvent` 流 → `cep::run_sequences` |
| `take_persistable()` | 取走待落盘缓存工件（绝对路径 → 字节），壳层 drain 后写 |
| `skeleton_bytes()` | 骨架内存基准（行数 × 8，懒建口径） |

`WsCtx`（camelCase serde，客户端不透明持有、原样回传）：

```json
{
  "files": [{ "name": "app.log", "firstLine": 0, "lineCount": 12345, "size": 987654 }],
  "totalLines": 12345, "skipped": 1, "fileCount": 1,
  "timestampFormatId": "iso-local-ms",
  "rangeStart": 1704103200000, "rangeEnd": 1704103201000
}
```

* `FilterQuery`（camelCase Deserialize）：`filterId` / `pattern` / `isRegex`
  / `caseSensitive` / `scope`（`raw`|`message`）。注意 scope 语义与 `.cep`
  规则文件不同（§3.3 规则文件 raw-only）；会话路径两种 scope 均支持。
* `NO_TS = i64::MIN`：无时间戳命中哨兵；`filters_batch` 返回的命中流中
  无 ts 命中被丢弃（IPC 二进制编码同理）。
* perf 诊断行由 `filters_batch` 返回（`scan_perf`），壳层负责写
  `<root>/.logGraph/perf.log`。
* 错误：行号越界 / 目录不存在 / 清单为空 / ctx 损坏 → `E_USAGE`；
  会话扫描正则编译失败 → `E_PATTERN`（`PatternBuild`）。

### 11.2 解析 API（`engine::parser`，自壳层下沉；v1.2 起不变）

`parse_log` / `parse_dir` 的解析核心全部在引擎：`js_trim` /
`parse_rest`（thread/level/message，`parser/line.rs`）/ 时间戳探测提取
（`parser/timestamp.rs`，5 格式）/ `parse_text_full` / `parse_dir_files`
（枚举→逐文件解析→全局 id 重编→sourceFile→全局 ts 稳定排序；目录枚举
**统一排除 `.logGraph`**，与 session 建库一致）。壳层 `parser` 模块仅剩
命令转发 + prepare/chunk 分块缓存。

### 11.3 IPC⇄CLI 1:1 原则（v1.3 REST 形状）

**每个 UI→Tauri IPC 请求都有 1:1 的 CLI 等价命令**（DevTools→curl 模型）：
Tauri 与 CLI 是同一引擎 API 的两种传输层，任何 UI 动作都可从命令行复现
（可测试性优先）。两侧同为无状态请求（客户端携带 dir + ctx）。映射表：

| Tauri IPC | CLI 等价 | 说明 |
| --- | --- | --- |
| `ws_info {dir, files?}` | `loggraph ws info <DIR> [--file <REL>]...` | 回 WsCtx JSON（唯一付整读价入口；进度事件 `ws_build_progress` 仅 IPC 有） |
| `ws_filters {dir, ctx, queries}` | `loggraph ws filters <DIR> -q <FILE\|-> [--ctx <FILE\|->]` | 回 `{"filters":[{filterId,hits:[{line,ts}]}]}`；总命中 0 → 退出码 1；二进制 SoA 编码是 IPC 专属输出格式化，CLI 输出 JSON |
| `ws_sequences {dir, ctx, queries, groups}` | `loggraph ws sequences <DIR> -q <Q> -g <G> [--ctx]` | queries 先行 warm 命中缓存再跑 CEP；回 RunSeqResponse。**queries 可直接传跨行 pattern**（见 §3.14） |
| `ws_line {dir, ctx, no}` | `loggraph ws line <DIR> --no <N> [--ctx]` | 回行文本 |
| `ws_lines {dir, ctx, ids}` | `loggraph ws lines <DIR> --ids 3,17,42 [--ctx]` | 回 `[{line,text}]` |
| （已删 `db_corr_ids`） | `loggraph ws corr <DIR> -q <Q> -f <IDS> --start <MS> --end <MS> [--ctx]` | 引擎 `corr_ids` 保留供 CLI；回行号数组，空 → 退出码 1 |
| （已删 `db_files`） | `loggraph ws files <DIR>` | CLI 便利命令（内部 build_ctx）；IPC 侧由前端从 ctx.files 推导 |
| `parse_log` | `loggraph parse file <PATH> [--format-id <ID>]` | 回 ParseResult JSON |
| `parse_dir` | `loggraph parse dir <DIR> [--full]` | 回 DirMeta（--full 附 events+rawLines） |
| `ws_reveal_path {path}` / `ws_open_path {path}` | — | 纯 OS 进程边界（explorer/open） |
| `dir_lines_chunk` / `dir_events_chunk` / `dir_cache_drop` | `parse dir --full` | 分块传输协议（防 WebView OOM）是 IPC 专属；CLI 单进程直接全量输出 |

* CLI `--ctx` 可选：提供 → 零 I/O 按 ctx 重建（**建议管道复用**：
  `ws info DIR > ctx.json` 后各命令免整读）；缺省 → 内部 build_ctx 重建
  （付整读价，行为与旧 v1.2 CLI 等价但每命令都付一次）。
  `--file` 子集过滤仅在 `ws info` 上（子集属于 ctx 内容，先 info 后复用）。
* `-q`/`-g`/`--ctx` JSON 输入：`FilterQuery` 数组 / `GroupSpec` 数组 /
  `WsCtx`（与 IPC 载荷同形状，camelCase；GroupSpec 走 §3.7 schema 的
  `deny_unknown_fields`），`-` = stdin。
* **CLI 不再"每命令重建会话即重扫"**：命中集盘缓存跨进程复用——
  首次 `ws filters` 扫描落盘后，后续同 ctx 同定义（含不同 filter_id，
  指纹不含 id）直接命中，`ws filters` 计时 ≈ UI 首搜。

### 11.4 §6.4 废弃计划的替代（v1.2 → v1.3 演进）

§6.4 原计划（v1.1）将 `db_*`/`parser::*` 命令废弃、UI 全面切 `engine_*`。
v1.2 作废该计划改为下沉薄转发；v1.3 进一步 REST 化：`db_*` → `ws_*`
（无状态 + ctx），与 `engine_*` 直扫族、`parser::*` 解析族并存——
dbMode（目录工作区）与无库直扫（search/cep）是两种互补工作流。

### 11.5 v1.2 新增错误码

| 码 | 变体 | 场景 |
| --- | --- | --- |
| `E_USAGE` | `Usage { message }` | 行号越界、目录不存在、文件清单为空、`--ids`/JSON 输入解析失败 |
| `E_PATTERN`（新增来源） | `PatternBuild { input, source }` | 会话过滤扫描的正则编译失败（regex::bytes 路径；与 `InvalidPattern` 同码） |