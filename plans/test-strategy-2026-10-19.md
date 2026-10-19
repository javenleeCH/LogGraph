# logGraph 测试方案（2026-10-19）

> 视角：测试架构设计，从「每次改动的最小证明」出发。
> 依据：AGENT.md（分层/契约/验证清单）、`plans/` 既有设计、源码与测试的**实测盘点**（2026-10-19，本机复现 vitest 122 / tsc 0）。
> 性质：可落地的测试体系设计，含新增事项、CI 改造、门禁与里程碑。

---

## 0. 一句话结论

当前测试是「**重逻辑、轻交互、欠契约、无度量**」：逻辑层（引擎 + 前端纯函数）守卫充足甚至偏强，但
**UI/状态层零覆盖、CLI/IPC 契约层近乎为零、wasm 冒烟未进 CI、无覆盖率门禁**——而这恰恰是最近改动
最密集（性能优化 / tail / 虚拟化）的地方，回归全靠手点。

方案核心：**把现有逻辑层优势固化为基线，优先补齐「契约 + 交互 + 度量」三块真空**，用可复用的
`sample/` 真实数据与既有脚本（`verify-samples.mjs` / wasm 冒烟）做杠杆，让每次 commit 有自动证明。

---

## 0.1 执行进度（2026-10-19 晚，本会话落地）

| 事项 | 状态 | 说明 |
|---|---|---|
| P0-X verify-samples 挂 CI | ✅ | package.json `test:samples` + ci.yml rust job「构建 CLI + 样本数据验收」；CI 实测绿 |
| P0-1 expr.ts 单测 | ✅ | `src/sequence/expr.test.ts`（20 用例）|
| P0-2 templates.ts 单测 | ✅ | `src/sequence/templates.test.ts`（8 用例）|
| P0-3 logStore 切片测试 | ✅ | `src/store/logStore.test.ts`（7 用例，tail 增量等价）|
| **P1-1 CLI 契约测试** | ✅ CI 绿 | `cli/tests/contract.rs`（assert_cmd，10 用例：退出码 0/1/2 + JSON 信封 + parse/cep/validate/schema/search/ws）；本机 rustup 真编译后修复 6 处（3 编译 + 3 运行断言），10/10 本地绿，GitHub CI 绿 |
| **P2-1 覆盖率门禁** | ✅ 前端 / ✅ Rust | 前端 vitest `@vitest/coverage-v8`，阈值 lines 35/statements 34/functions 30/branches 35（基线 Stmts 36.5/Branch 37.6/Funcs 32.5/Lines 37.1，四语义核心目录）；Rust `cargo-llvm-cov` 已由 report-only 升级为**真实门禁** `engine lines ≥ 85`（基线 88.34% 实测，90 红/85 绿本地验证，GitHub CI 绿）|
| **三实现一致性差分** | ✅ | `src/filters/regexConsistency.test.ts`（3 用例）：wasm 就绪 vs JS 兜底路径命中集一致，appendMatches 增量两态一致 |
| **P1-4 引擎性质测试（proptest）** | ✅ CI 待确认 | `engine/tests/properties.rs`（7 性质）：CEP 序列匹配 soundness（256 随机用例验证「覆盖∪未覆盖==参与全集、无虚算/双计/漏算 + 链内保序 + 时间窗不逆序」）+ parser/expr/rules 全量性与确定性；proptest dev-dep；本机全绿且覆盖抬至 88.47% |
| **P1-3 wasm 冒烟进 CI** | ✅ | `test:wasm:all` 聚合 3 冒烟脚本（regex 12 + cep 10 + filter 4 = 26 断言）；ci.yml 前端 job 增加「重建 filter wasm + wasm 冒烟」步骤；本机复刻 CI 链路验证 26/26 绿，两 wasm 二进制随源码同步重建提交 |

> vitest 计数：P0 后 157 → 加差分 3 → 本机 170 passed（keyScope 4 为本地旧 wasm 已知失败，CI 重建后绿）。
> Rust 计数：engine 128 单测 + 7 性质 + cli 10 契约 = 全绿；覆盖基线 engine lines 88.47%（proptest 抬升）。

---

## 1. 设计原则（对齐 AGENT.md，不可违背）

1. **测试跟随单一实现原则**：业务语义只在 engine 测一次，壳层不重复测业务——壳层只测
   「参数解析 / 进程边界 / 输出格式化」。
2. **契约以 CLI 为准（1:1 原则）**：CLI 是 UI 的 curl 等价物；契约测试以真实 CLI 二进制 +
    `sample/` 数据为基准，UI 侧测试不重复契约语义。
3. **零数据库、原始文件是事实源**：测试用 `sample/` 真实日志 + 生成器，不造模拟库；
   期望值来自样本「故事线」，不从输出反推快照。
4. **性能红线是测试对象**：O(N²) 隐患、SoA 二进制编码、perf.log 均需防回归断言。
5. **测试金字塔**：大量底层单测、适量契约/集成、少量 E2E/性能，控制维护成本。

---

## 2. 现状盘点（实测）

| 层 | 源码规模 | 测试 | 判断 |
|---|---|---|---|
| 引擎语义 (Rust engine) | 8,268 行 | **133**（cep 24 / rules 30 / parser 44 / session 17 / expr 6 / search 4 / filter_agg 4） | ✅ 充足，壁垒守得住 |
| 前端纯逻辑 (vitest, node 环境) | 15 文件 / 1,562 行 | **122** | ✅ 充足 |
| wasm 冒烟（4 脚本） | — | **26 断言**（regex 11 / cep 10 / filter-agg 5；seq-restore 待确认） | ⚠️ 有断言，**未进 CI** |
| CLI 契约层 | 873 行 | **1**（仅 utc_formatting） | ❌ 近乎为零 |
| IPC/壳层 (src-tauri) | 787 行 | **2** | ❌ 近乎为零 |
| 状态机 logStore.ts | 1,932 行 | **0** | ❌ 真空 |
| React UI 组件 | 8,599 行（15+ 文件） | **0** | ❌ 真空 |

**CI 现状**（`.github/workflows/ci.yml`）：
- frontend job：`tsc -b` + `npm test`（vitest）+ `npm run build` —— **不跑 wasm 冒烟、不跑 verify-samples、无覆盖率**。
- rust job：`cargo test -p loggraph-engine -p loggraph-cli`（src-tauri 因 webkit2gtk 不进 CI）—— 无覆盖率。

**已有可复用资产（被低估）**：
- `sample/`：分布式三件套（auth/gateway/order，跨服务）、springboot、log4j2、cep-rules 样例、filters-crossline。这是 CLI/集成测试的天然基线。
- `scripts/verify-samples.mjs`：**现成的 CLI 端到端验收**（跑真实二进制 + sample 故事线断言，退出码 0/1），**但未挂进 package.json / CI** —— 最高杠杆的自动化，接入成本极低。
- `scripts/test-wasm-*.mjs`、`gen-large.mjs`、`gen-perf-data.mjs`。

---

## 3. 分层测试策略（金字塔 L0–L4）

```
        ┌───────────────┐
        │  L4 性能门禁    │  少量：O(N²) 防回归、perf.log 基准阈值
        ├───────────────┤
        │  L3 E2E(桌面)  │  少量：Playwright/CDP 真实构建，release 前
        ├───────────────┤
        │  L2 集成/冒烟  │  适量：verify-samples(CLI)、UI 组件冒烟、wasm 集成
        ├───────────────┤
        │  L1 契约测试   │  CLI 契约、IPC DTO/SoA、wasm 对齐
        ├───────────────┤
        │  L0 单元测试   │  大量：引擎语义 + 前端纯逻辑（当前主力）
        └───────────────┘
```

- **L0（存量强，补漏）**：引擎 133 / 前端纯逻辑 122 已是金字塔底座，稳固。缺口仅三处纯逻辑（见 §4 P0）。
- **L1（当前最弱，重点补）**：CLI/IPC 契约、wasm 行为对齐。这是「1:1 原则」的执行端，缺测试 = 契约裸奔。
- **L2（复用现成资产，接入最省）**：把 `verify-samples.mjs` 挂 CI；UI 组件冒烟只覆盖最重的 3 个组件。
- **L3（沿用既有通道）**：product-review 附 A 已建立 Playwright/CDP 通道，脚本化为 `test:e2e`，release 前跑。
- **L4（防工程退化）**：性能红线（CEP 大结果集、tail 长时、SoA 编码）用生成数据 + 阈值断言。

---

## 4. 缺口 → 新增测试事项

### P0 · 先守核心（纯逻辑，低成本高风险，本周）

| # | 事项 | 目标 | 测什么 | 验收标准 |
|---|---|---|---|---|
| P0-1 | **expr.ts 解析器单测** | `src/sequence/expr.ts`（269 行，CEP 表达式核心，**零覆盖**） | 操作符优先级 / 括号 / 字段比较 / 单位换算 / 非法表达式报错 | 新增 `expr.test.ts`，主要分支全覆盖；vitest 122 → 130+ |
| P0-2 | **模板库单测** | `src/sequence/templates.ts`（231 行，A 类刚并分） | 每个模板生成的过滤器 / 分组 / 连边结构正确、pattern 占位可替换、无缺边 | 新增 `templates.test.ts`，模板结构冻结 |
| P0-3 | **logStore 状态机切片测试** | `src/store/logStore.ts`（1932 行，最近改动最密） | ① filters 增删与 matches 一致性；② **tail 增量等价**：`appendMatches` 结果与全量 `recomputeMatches` 逐项一致（呼应 638f0b3）；③ `corrRaf` / `tailRecomputeTimer` 防抖复位无泄漏 | 抽纯 reducer 或独立 zustand 实例测试；增量等价至少覆盖「纯追加 / 时钟回拨回退」两条路径 |

> P0-3 注意：logStore 顶层有模块级 `corrRaf`/定时器并摸 `window`，**不要**直接整库测；把纯逻辑抽成可测函数（`mergeEventsByTs`/`appendMatches` 已有雏形），store 层只测调度与状态迁移。

### P1 · 契约守护与自动化（下周）

| # | 事项 | 目标 | 测什么 | 验收标准 |
|---|---|---|---|---|
| P1-1 | **CLI 契约测试** | `cli/src/main.rs`（873 行，现仅 1 测） | clap 参数解析、`E_*` 错误 → 退出码 2、输出 JSON 形状、`--ctx` 复用 | 用 `assert_cmd`（子进程跑真实二进制 + `sample/`），覆盖 AGENT.md §6 冒烟命令（ws info/filters/sequences/line/lines/corr/files + parse file/dir）；rust 测试显著增加 |
| P1-2 | **IPC/SoA 契约测试** | `src-tauri/src/ws.rs` 的纯编码模块 | DTO serde（camelCase、`deny_unknown_fields`）、ErrorDto 映射、二进制 SoA 编码**往返** | 仿 cep-wasm 的 keyStats JSON 往返风格；只测纯编码 mod，不测 tauri 运行态 |
| P1-3 | **wasm 冒烟进 CI** | `.github/workflows/ci.yml` 新增 wasm job | `rustup target add wasm32-unknown-unknown` + `build:wasm` + `test:wasm*` | wasm 行为纳入 CI 守护，26 断言常绿 |

### P2 · 度量门禁与交互冒烟（渐进）

| # | 事项 | 目标 | 测什么 | 验收标准 |
|---|---|---|---|---|
| P2-1 | **覆盖率门禁** | vitest + Rust | 关键路径模块行覆盖阈值 | 前端接入 `@vitest/coverage-v8`，对 `src/sequence` `src/filters` `src/parser` `src/io` 设阈值；Rust 用 `cargo-llvm-cov` 对 engine 核心设阈值；低于阈值 CI 红。**先定基线再设阈值**，避免一开始就红 |
| P2-2 | **UI 组件冒烟** | 最重 3 组件：`LogStreamView`(1714) / `CommandPalette`(777) / `NodeCanvasView`(609) | 渲染不崩 + 基础交互（命令面板开关、过滤器增删、画布节点渲染） | 给 vitest 按文件加 `@vitest-environment jsdom` + `@testing-library/react`；冒烟级即可，不追全交互 |

> 原则：UI 测试成本高，**只守「渲染不崩 + 关键路径交互」**，不做像素/全交互回归；交互细节回归靠 L3 E2E。

### 最高杠杆一档（建议优先于上述任何单项）

| # | 事项 | 理由 | 验收 |
|---|---|---|---|
| P0-X | **把 `verify-samples.mjs` 挂进 CI**（加 npm script `test:samples`，前端 job 一并跑） | 现成资产、零新代码，一次把「解析→CEP→跨行 filter」的真实数据验收自动化；当前完全靠手动 | CI 前端 job 含 `test:samples`，退出码 0 即绿 |

---

## 5. CI 流水线改造（ci.yml 目标形态）

```yaml
jobs:
  frontend:      # tsc + vitest(带覆盖) + build + test:samples
    - npx tsc -b
    - npm test            # vitest + @vitest/coverage-v8 门禁
    - npm run build
    - npm run test:samples   # verify-samples.mjs（新增）
  rust:
    - cargo test -p loggraph-engine -p loggraph-cli
    - cargo llvm-cov ...      # 覆盖率门禁（engine 核心模块）
  wasm:            # 新增
    - rustup target add wasm32-unknown-unknown
    - npm run build:wasm && npm run build:wasm:cep
    - npm run test:wasm:regex && npm run test:wasm:cep && npm run test:wasm:filter
```

- **release.yml 不动**（自签 updater 已端到端验证）；E2E（桌面构建 + Playwright/CDP）做成**可选/manual** job，release 前手动触发，不拖慢常规流水线。

---

## 6. 里程碑

- **M1（本周）**：P0-X（verify-samples 挂 CI）+ P0-1/2/3 三项纯逻辑单测 → 逻辑/契约关键路径回归自动化。
- **M2（下周）**：P1-1/2/3（CLI 契约 + IPC/SoA + wasm 进 CI）+ P2-1 覆盖率门禁（先定基线）。
- **M3（渐进）**：P2-2 UI 冒烟 + L4 性能门禁 + L3 E2E 脚本化。

---

## 7. 风险与边界（诚实声明）

1. **本机 Linux 无 Rust 工具链**：engine/CLI/wasm 测试本地无法复现，**由 CI 兜底**；本地能守的只有前端（vitest/tsc）。已在十四轮注明。
2. **src-tauri 依赖 tauri/webkit2gtk**：运行态无法单测，只测纯编码 mod；真机行为靠 L3 E2E（需在用户 Windows 环境跑）。
3. **UI 测试**：只冒烟不追全交互，避免测试变成第二份难维护的「UI 债」。
4. **覆盖率门禁**：先跑出基线再设阈值，防「为过门禁注水 / 一开始就红」。

---

## 8. 整体验收标准（一次 commit 的最小证明）

每次改动合入前，CI 全绿即视为「已证明」：
- `tsc -b` 0 错；vitest（含新增）全绿且覆盖达阈值；`npm run build` 通过；
- `test:samples`（CLI 真实数据验收）通过；
- `cargo test` engine+cli 全绿（含覆盖阈值）；
- wasm 冒烟全绿；
- 触及性能红线（tail/CEP/SoA）的改动需附 L4 基准对比。

> 与 AGENT.md §6「验证清单」对齐，只是把「人肉冒烟」升级为「CI 自动证明」。
