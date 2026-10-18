# logGraph 产品复评 · 第五轮（2026-10-18）

> 视角：资深产品经理 / 从用户价值出发。
> 前置：第四轮技术四件后 **8.9**（见 `product-rescore-2026-10-17-round3.md` §12）。
> 本轮只做一件事：**消除 CEP 双实现**（第四轮点名的"冲 9 分第一障碍"）。

---

## 0. 一句话结论

**第四轮说"消掉 CEP 双实现是 8.6→9.0 的必经之路"——这条路这轮走通了。**

`src/sequence/SequenceMatcher.ts`（前端 TS 全功能 CEP 副本）不再是 active 实现。Web 端现在通过
**同一份 `engine/src/cep.rs`** 的 wasm 构建（`cep-wasm/`）跑 CEP，与桌面 native 引擎逐字节一致。
能力每下沉一次同步面就扩大一圈的死结，被 `#[path]` 共享源文件彻底解开——**改 `cep.rs` 一处，native 与
wasm 两端同时生效**，不再需要人工同步两套算法 + 两套测试。

综合 **8.9 → 9.0**（加权，四舍五入）。卡在 9.2+ 的不再是"双实现"这一大类，而是其中**残余的一笔**
（跨行 filter 聚合仍两端各一份，见 §4）。

---

## 1. 打分（四轮对比 → 五轮）

| 维度 | 四轮 | **五轮** | 变化 | 核心依据 |
|---|---|---|---|---|
| 需求洞察 | 8.0 | **8.0** | — | 方向未变 |
| 核心能力完成度 | 9.0 | **9.1** | ↑0.1 | Web 与桌面跑同一引擎，web↔desktop CEP 结果终于一致（消除一类"桌面能跑、网页不同"的隐性不一致） |
| 工程与性能 | 9.2 | **9.4** | ↑0.2 | **消除主 CEP 双实现**：前端 TS 副本转为冻结兜底，native/wasm 同源 |
| 用户体验与引导 | 9.0 | **9.0** | — | 行为无变化；一致性是隐性质量收益，未单独计分 |
| 交付与可持续 | 8.8 | **8.8** | — | updater 仍待私钥入 Secrets（用户侧动作） |
| **综合** | **8.9** | **9.0** | **↑0.1** | 加权 9.0，跨过"9 分门槛" |

> 加权：核心能力 30% / 工程 20% / UX 20% / 交付 20% / 需求 10% = **9.0**。
> 工程未回到 9.5：跨行 filter 的拆分/聚合（`session.rs` ↔ `FilterEngine.ts`+`dbStore.ts`）双实现
> 是第三轮引入、本轮**未动**的一笔，仍是唯一剩余的 active 双实现（§4）。

---

## 2. 本轮兑现了什么（代码证据）

### ✅ 新增 `cep-wasm/` crate —— 与桌面引擎同源
- `cep-wasm/src/lib.rs` 通过 `#[path = "../../engine/src/cep.rs"]` + `expr.rs` **逐字节复用**引擎源；
  仅提供 `error` 的 `EngineResult` 最小别名（完整 error 模块带 grep/ignore 非 wasm 依赖）。
- `wasm32-unknown-unknown` 构建（rust-lld，无需 MSVC）→ `wasm-bindgen --target web` 生成
  `src/sequence/wasm-cep/pkg/`（`.d.ts/.js/_bg.wasm` 共 4 件，**随仓库提交**，clone 免装 wasm 工具链）。
- 暴露 `run_sequences_json(groups, events) -> JSON`，签名对齐引擎 `RunSeqResponse`。

### ✅ Node 直跑 wasm 真实验证（`scripts/test-wasm-cep.mjs`，10/10 通过）
不靠"编译通过"糊弄，直接在 Node 加载 wasm 跑断言：
- seq 边窗口内成链 + 未覆盖事件归零 ✓
- not 边窗口内出现禁止目标 → 检出违规 ✓
- `scope=thread` 按桶隔离（t1 成链 / t2 无配对不成链）✓
- `nodeConditions` 二次过滤（仅 level=E 的 B 参与，level=W 计入未覆盖）✓

### ✅ 前端接线（`src/sequence/cepWasm.ts` + `logStore.ts`）
- `cepWasm.ts`：fire-and-forget 加载 + `runCepWasm()` wasm 优先、TS 回退（与 `regexWasm.ts` 同款策略）；
  提供 `isCepWasmFallback()` 供 UI 提示（本期未接 UI，预留）。
- `logStore.recomputeSequences`：Web 分支 + dbMode 的 tsGroups 分支改为 **wasm 优先**，TS 仅安全网。
- `SequenceMatcher.ts` 头部标注**弃用冻结副本**：语义只改 `engine/src/cep.rs`，勿在此并行维护。

### ✅ 验证全绿
- wasm 运行时 10/10；`tsc --noEmit` 0 错；`vitest` 75/75；`cargo check -p loggraph-engine` 通过。
- 双推 `origin`(GitCode) + `github`，commit `becaa0c`。

---

## 3. 为什么这是"真消除"而非"又加一层"

第三轮下沉 CEP 能力时，前端为了 dbMode 不整组回退，自己又抄了一份跨行聚合——同步点 +1，工程分
因此 9.3→9.2。但那笔是**小**的（仅跨行拆分/聚合）。本轮消除的是**大**的：整个 `SequenceMatcher.ts`
（seq/not/and/or/opt/periodic + thread 分桶 + nodeCounts + nodeConditions，约 600 行 TS）曾是
`cep.rs`（约 1600 行 Rust）的平行实现，任何语义调整都要双改 + 双测。

现在 `SequenceMatcher.ts` 是**冻结副本**：新功能只进 `cep.rs`，TS 不再演进。native 与 wasm 编译
**同一份** `cep.rs`，不存在"同步"这件事。这正是第四轮说的"唯一解"。

---

## 4. 仍未解决（决定能否上 9.2+）

| 项 | 状态 | 影响 |
|---|---|---|
| **跨行 filter 聚合双实现**（session.rs ↔ FilterEngine.ts + dbStore.ts） | ❌ 仍双份 | 第三轮引入的唯一剩余 active 双实现；下次消它即可把工程分推回 9.5 |
| `SequenceMatcher.ts` 冻结副本未删除 | ⚠ | wasm 未在生产环境充分验证前保留安全网；验证后可删，彻底清零 TS 双实现痕迹 |
| updater 私钥未入 GitHub Secrets | ❌ 用户侧 | CI 签不了名、latest.json 不产出，更新通道不生效（第四轮已接线，待密钥） |
| v0.2.2 仍标 Pre-release / v0.2.1 空壳 release | ⚠ 网页手工 | 本机无 token/gh 不可用，需用户在 GitHub 网页取消 v0.2.2 的 Pre-release 标记、删 v0.2.1 空壳 |
| 加载模式透明化（P1④：dbMode vs 内存能力边界） | ❌ | 用户仍无法归因"为何某能力在此模式不可用" |

---

## 5. 下一步（五轮之后）

1. **消掉跨行 filter 聚合双实现**（现唯一剩余 active 双实现，第一优先级）。可把聚合逻辑也下沉进
   `cep.rs`/引擎，前端只调引擎；工程分回到 9.5，9.2+ 顺理成章。
2. **把 updater 私钥加进 GitHub Secrets**（用户动作）→ 更新通道真正生效，交付分可 8.8→9.0+。
3. 网页两处手工：取消 v0.2.2 Pre-release（进 `latest`）、删 v0.2.1 空壳。
4. （可选）`SequenceMatcher.ts` 在 wasm 经生产验证后删除，UI 接 `isCepWasmFallback()` 提示。

---

## 6. 分数之外的一句话

第四轮把"从只能看，到能改"交给了用户；这轮把"web 与桌面看到的是同一份真相"交给了代码。
剩下那笔跨行聚合双实现，是 9.2 之前唯一该消的——它消掉，9 分才是被单一事实来源支撑的 9。
