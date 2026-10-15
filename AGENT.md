# AGENT.md — logGraph 项目约束与规定

> 任何 agent/协作者**动手前必读**。本文是项目架构与工程规则的唯一汇总入口；
> 接口细节以 `plans/engine-cli-api-contract.md`（冻结契约，版本化）为准。

## 1. 分层架构（最高优先级，违反即返工）

```
engine/   loggraph-engine  纯 Rust 库：全部业务语义（唯一实现）
cli/      loggraph CLI     薄壳：参数解析 / 进程边界(退出码) / 输出格式化
src-tauri/ loggraph-app    薄壳：窗口 / IPC 命令转发 / engine 错误→DTO / 二进制编码
src/      React UI         桌面模式走 IPC；浏览器模式走 TS 降级实现
```

**强制规则：**

- 依赖方向单向：`cli → engine`、`src-tauri → engine`、`src → src-tauri`。
  **engine 永不反向依赖任何壳**（不依赖 tauri、不打印 stdout、不写文件）。
- **壳层禁止实现任何业务语义**：匹配/扫描/时间戳/行解析/序列匹配/缓存策略/文件发现规则
  全部在 engine。壳层只做三件事：参数解析、进程边界（IPC/退出码/事件）、输出格式化。
  src-tauri 里的二进制 SoA 编码（encode_filter_batch 等）属"输出格式化"，允许留在壳层。
- **单一实现原则**：同一语义只允许存在一份 Rust 实现（在 engine）。
  历史教训：曾出现 3 份 walk、2 份 CEP 匹配器、2 份时间戳解析器并行漂移，
  修复只打在一份上造成桌面/CLI 行为分叉。新增能力前先查 engine 是否已有。

## 2. IPC ⇄ CLI 1:1 原则（DevTools→curl 模型）

**每一个 UI 发给 Tauri 的请求，必须有 1:1 的 CLI 子命令等价物**——任何 UI 操作
都能在终端原样复现，保证测试与维护。像 DevTools 里任何请求都能转成 curl。

- 新能力的完整交付 = **engine API + tauri 转发命令 + CLI 子命令**，三者一次落地，
  缺一不可（不允许"先只在壳层实现，以后再下沉"——那就是 v1.0 到 v1.1 之间
  db.rs 长到 1600 行的根因）。
- CLI 是一次性进程模型：session 类命令每次调用从纯输入重建（建库 ~0.3s/GB，可接受）。
  UI 的有状态会话（open → filters → lines…）在 CLI 里表现为 `--dir/--file/--queries`
  显式参数。
- 两壳调用**同一 engine 函数**，语义零漂移；漂移只在参数/输出格式层。

## 3. 契约与版本

- `plans/engine-cli-api-contract.md` 是四层共享的接口契约（.cep 规则文件 schema、
  错误码 E_*、JSON 输出形状、IPC 命令面）。**改任何跨层接口必须同步改契约**，
  增量以版本号标注（v1.2 起含 session API 与 1:1 原则）。
- serde 约定：IPC/JSON DTO 一律 camelCase（唯一例外 `line_number`，对齐 rg）；
  输入侧 `deny_unknown_fields`；错误走稳定 code（新增 code 须进契约 §3.10 表）。
- 错误模型：engine 公开函数一律 `EngineResult<T>`；壳层把 `EngineError` 转
  `ErrorDto{code,message,details?}`（tauri reject / CLI 退出码 2）。

## 4. 引擎内不变量（改动前先读注释）

- **零数据库**：无 SQLite/磁盘缓存；session 是纯内存快照（行偏移 + 命中缓存），
  原始文件是唯一事实源。
- **性能红线**（都有 perf.log 实测教训，回归即挂死）：
  - CEP 匹配全程借用事件切片（`EventSlices = HashMap<&str, &[SeqEvent]>`），
    禁止整表 `to_vec()`/`contains()` 线性扫描（曾造成 26 万头事件 × 33 万事件挂死）；
  - 百万级命中走二进制 SoA IPC（~12B/命中），不走 JSON；
  - 扫描用每 expr 独立正则 find_iter（prefilter SIMD 跳 miss），单遍多过滤器；
  - 建库是便宜通道：读 + 行偏移 + 计数 + 首/末行 ts，不做逐行 ts 索引。
- **JS 语义对齐**：engine 的 timestamp/line 解析逐条对齐前端
  `src/parser/timestampFormats.ts` / `LogParser.ts`（含 JS trim 字符集、
  `\d`/`\s` 翻译、Date.UTC 越界进位、epoch 无 lookaround 的极大数字段扫描等）。
  CEP 对齐 `src/sequence/SequenceMatcher.ts`。**改任一侧必须同步另一侧**，
  对齐清单见 `plans/rust-parser-design.md`。
- `.logGraph` 是应用工作区目录（filters.json / perf.log），**绝不当作日志源索引**
  （残留文件会污染格式探测）。所有枚举日志文件的路径必须排除它。
- 前端是文件清单的唯一权威（glob 排除 + 勾选在前端算好）；后端只按清单 retain。
- 无 ts 命中行用 `NO_TS = i64::MIN` 哨兵；时间线查询丢弃无 ts 命中。

## 5. Rust 工程规则

- 静态量用 `std::sync::LazyLock`（初始化器在声明处已知时）；
  `OnceLock` 仅保留给运行期输入场景；不引入 `once_cell`。
- 壳层 Cargo.toml **不得**为业务逻辑引依赖（regex/parking_lot 属 engine 侧）。
  src-tauri 合法依赖：tauri 系、serde、loggraph-engine。
- engine 可独立 `cargo test`；提交前跑 `cargo test --workspace`。
- 注释/文档用中文；性能敏感路径的注释（教训类）不可删。
- 布局：db 会话能力在 `engine/src/session.rs`；解析在 `engine/src/parser/`
  （timestamp + line + 流水线）；CEP 在 `engine/src/cep.rs`；rg 直扫在
  `engine/src/search.rs`；规则装载校验在 `engine/src/rules.rs`。

## 6. 验证清单（改动的最小证明）

1. `cargo test --workspace` 全绿（engine 单测是语义对齐的守卫，勿删断言）。
2. CLI 冒烟：`loggraph db open/filters/sequences/lines/corr/files <dir>` +
   `loggraph parse file/dir` 在真实目录上跑通（1:1 的意义就在这里）。
3. UI 表面（IPC 命令名/参数/返回形状）**不许破坏**——前端 `src/io/dbStore.ts`、
   `src/parser/parseBridge.ts` 依赖冻结的形状；改形状必须同步前端并说明。
4. 涉及跨层接口：契约文档同步更新（见 §3）。

## 7. 历史教训（为什么有这些规定）

- v1.0 原型期把扫描/索引/CEP 全写进 src-tauri（当时 SQLite）→ 契约 v1.1 抽出
  engine 后壳层副本没删，双维护 5 天漂移出行为分叉（timestamp 测试注释、
  CEP 挂死修复只打壳层副本）。**抽出后必须删除原实现，禁止双轨**。
- 一次性返回全量 events JSON 会打爆 WebView（~2GB）→ 分块传输协议
  （parse_dir prepare + dir_*_chunk）是传输层方案，解析核心仍属 engine。
- perf.log（`<root>/.logGraph/perf.log`）是性能诊断事实源，重大性能改动看它定位。
