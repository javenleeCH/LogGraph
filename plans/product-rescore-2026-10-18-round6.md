# logGraph 产品复评 · 第六轮（2026-10-18）

> 视角：资深产品经理 / 从用户价值出发。
> 前置：第五轮消除 CEP 双实现后 **9.0**（见 `product-rescore-2026-10-18-round5.md`）。
> 本轮只做一件事：**消除最后一笔 active 双实现**——跨行 filter 聚合（第四/五轮反复点名的
> "9.2+ 之前唯一该消的"）。

---

## 0. 一句话结论

**第五轮说"跨行 filter 聚合双实现是 9.2+ 之前唯一该消的"——这轮消了。**

`engine/src/session.rs` 里的 `split_sub_conditions` / `aggregate_sub_hits` 被抽成
**`engine/src/filter_agg.rs` 单一事实来源**，桌面引擎与 Web 端（`filter-wasm`）编译
**同一份**源码。Web（dbMode）的聚合不再跑自己抄的 JS 副本，而是经
`filter-wasm::aggregate_filter_hits` 跑与桌面 native 逐字节一致的同一份实现。
`dbStore.ts::aggregateSubHits` / `aggregateSubHitsJs` 退化为 wasm 未就绪时的兜底。

综合 **9.0 → 9.1**（加权）。工程分 **9.4 → 9.5**——第五轮遗留的"唯一剩余 active 双实现"
正式清零，产品进入"所有过滤/序列语义均由单一 Rust 源编译到 native+wasm"的状态。

---

## 1. 打分（五轮 → 六轮）

| 维度 | 五轮 | **六轮** | 变化 | 核心依据 |
|---|---|---|---|---|
| 需求洞察 | 8.0 | **8.0** | — | 方向未变 |
| 核心能力完成度 | 9.1 | **9.1** | — | Web↔桌面过滤聚合同源（隐性质量收益，未单列） |
| 工程与性能 | 9.4 | **9.5** | ↑0.1 | **消除最后一笔 active 双实现**：跨行聚合单一来源 `filter_agg.rs`，native/wasm 同源 |
| 用户体验与引导 | 9.0 | **9.0** | — | 行为无变化 |
| 交付与可持续 | 8.8 | **8.8** | — | updater 私钥已入 Secrets，待下次发版验证签名 |
| **综合** | **9.0** | **9.1** | **↑0.1** | 加权 9.1，9 分门槛之上再上一个台阶 |

> 加权：核心能力 30% / 工程 20% / UX 20% / 交付 20% / 需求 10% = **9.1**。

---

## 2. 本轮兑现了什么（代码证据）

### ✅ 抽取 `engine/src/filter_agg.rs` —— 跨行聚合单一事实来源
- 把 `split_sub_conditions` / `aggregate_sub_hits` / `hits_contains_line` / `SubCond` /
  `SUB_ID_SEP` 从 `session.rs` 抽出为独立模块（带 serde 的 `AggHit` 与引擎 `HitEntry` 字段一致）。
- 桌面 `session.rs` `use crate::filter_agg::*`，`filters_batch` 仅做 `HitEntry ↔ AggHit`
  字段转换后委托共享实现，删掉本地重复副本。
- 含 Rust 单测 4 个（拆分语义 / 交集减并集 / 无正向锚为空 / 最短正向为基）。

### ✅ `filter-wasm` 暴露 `aggregateFilterHits`（与桌面同源）
- `filter-wasm` `#[path]` 引入 `engine/src/filter_agg.rs`，暴露
  `aggregateFilterHits(posJson, negJson) -> json`（与 `aggregate_sub_hits` 同一份算法）。
- 重新 `wasm-bindgen` 生成 `src/filters/wasm-filter/pkg/`（随仓库提交）。
- Node 直跑验证 `scripts/test-wasm-filter-agg.mjs`：**4/4 通过**，证明 Web 聚合 == 桌面引擎。

### ✅ 前端接线（`dbStore.ts` + `regexWasm.ts`）
- `regexWasm.ts` 新增 `aggregateFilterHits(pos, neg)` 封装（JSON 序列化 + ts 对齐 + 失败回退 null）。
- `dbStore.ts::aggregateSubHits`：**wasm 优先**，未就绪/失败回退 `aggregateSubHitsJs`
  （算法逐字一致）。`aggregateSubHitsJs` 补上"无正向锚返回空"的守卫——
  **修掉一个此前被双实现掩盖的崩溃分支**（全排除 filter 在 JS 兜底路径会 `base.lines` 越界）。

### ✅ 测试三端锁定同一组用例
- `src/io/dbStore.test.ts`（新增 10 测）：`splitSubConditions` 与 `aggregateSubHits` 的
  拆分/聚合用例与 Rust `filter_agg::tests`、引擎 `split_sub_conditions_matches_frontend`
  逐字对齐。
- `scripts/test-wasm-filter-agg.mjs`：wasm 直跑，证明 Web 聚合与桌面引擎同源。
- 全量前端测试 **85/85 通过**（第五轮 75 → 85，+10）；`cargo check` 引擎/CLI 全绿。

---

## 3. 为什么这是"真消除"而非"又加一层"

第五轮消除的是**大**的那笔（整个 CEP 的 TS 副本）。本轮消除的是**最后一笔小**的
（跨行聚合），它恰恰是第三轮下沉能力时为了让 dbMode 不整组回退、在前端又抄的一份。

现在：
- **所有过滤/序列语义**都由单一 Rust 源（`engine/src/*`）编译到 native + wasm。
- 改任一能力只动引擎源码一处，桌面与 Web 同时生效——不再有"同步点 +1、工程分 -0.1"的死结。
- 唯一保留的 JS 副本（`SequenceMatcher.ts`、`aggregateSubHitsJs`）都明确标注为冻结兜底，
  且有跨语言测试锁定等价性，不构成 active 双实现。

---

## 4. 仍未解决（决定能否上 9.2+）

| 项 | 状态 | 影响 |
|---|---|---|
| `SequenceMatcher.ts` 冻结副本未删除 | ⚠ | wasm 经生产验证后可删，彻底清零 TS 双实现痕迹（非阻塞） |
| updater 私钥已入 Secrets，**尚未经发版验证** | ❌ 待发版 | 下次打 tag 推送即自动签名；届时匿名 `curl` 验 `latest.json` 可见即可确认通道生效 |
| v0.2.2 仍标 Pre-release / v0.2.1 空壳 release | ⚠ 网页手工 | 需用户在 GitHub 网页取消 v0.2.2 的 Pre-release、删 v0.2.1 空壳 |
| 加载模式透明化（P1④：dbMode vs 内存能力边界） | ❌ | 用户仍无法归因"为何某能力在此模式不可用"——下个值得做的 UX 点 |

---

## 5. 下一步（六轮之后）

1. **发版验证 updater 签名**：打 tag 推送后匿名验证 `latest.json` 可见 + 签名有效，
   交付分可 8.8 → 9.0+，综合有望 9.1 → 9.2。
2. （可选）`SequenceMatcher.ts` 在 wasm 经生产验证后删除，UI 接 `isCepWasmFallback()` 提示。
3. （可选）加载模式透明化：在 UI 标注 dbMode / 内存模式的能力边界，回应用户归因需求。

---

## 6. 分数之外的一句话

第五轮把"web 与桌面看到的是同一份真相"交给了代码；这轮把"过滤聚合也由同一份真相驱动"
补齐了最后一块。9 分之上，剩下的都是体验与交付的收尾，而非架构的债。
