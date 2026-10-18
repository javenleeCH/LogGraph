//! CEP 引擎的 WebAssembly 构建（消除前端 TS 双实现 `SequenceMatcher.ts`）。
//!
//! 关键：直接复用 `engine/src/cep.rs` 与 `engine/src/expr.rs` **同一份源文件**
//! （`#[path]` 包含），因此 Web（wasm）与 桌面（native）跑的是**逐字节一致**
//! 的 CEP 实现。任何语义改动只需改 `engine/src/cep.rs` 一处，两端同时生效。
//!
//! `engine/src/error.rs` 带 grep/ignore 等非 wasm 依赖，这里只提供 `cep.rs`
//! 实际需要的 `EngineResult` 类型别名（最小定义）。

mod error {
    /// `cep.rs` 仅需该类型别名；完整的 error 模块带非 wasm 依赖，不可用。
    pub type EngineResult<T> = Result<T, String>;
}

#[path = "../../engine/src/expr.rs"]
mod expr;

#[path = "../../engine/src/cep.rs"]
mod cep;

use wasm_bindgen::prelude::*;

/// 入口：对一组 group 跑序列匹配。
///
/// - `groups_json`：`GroupSpec[]` 的 JSON（对齐前端 `FilterGroup.sequence`）。
/// - `events_json`：`{ filterId: SeqEvent[] }` 的 JSON（事件源；不存在的 filter 视为空）。
///
/// 返回 `RunSeqResponse` 的 JSON：`{ "fallback": bool, "results": { groupId: SeqResult } }`。
/// 解析失败时 `fallback = true`、`results` 为空，调用方整体回退。
#[wasm_bindgen]
pub fn run_sequences_json(groups_json: &str, events_json: &str) -> String {
    let groups: Vec<cep::GroupSpec> = match serde_json::from_str(groups_json) {
        Ok(g) => g,
        Err(_) => {
            return serde_json::json!({ "fallback": true, "results": {} }).to_string();
        }
    };
    let store: cep::EventStore<'_> = match serde_json::from_str(events_json) {
        Ok(s) => s,
        Err(_) => {
            return serde_json::json!({ "fallback": true, "results": {} }).to_string();
        }
    };
    let resp = cep::run_sequences(&groups, &store);
    serde_json::to_string(&resp).unwrap_or_else(|_| {
        serde_json::json!({ "fallback": true, "results": {} }).to_string()
    })
}
