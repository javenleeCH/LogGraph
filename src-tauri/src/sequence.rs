//! v2 / PR-4：序列匹配加速路径（CEP 下推，plans/engine-cli-api-contract.md）。
//!
//! 匹配核心在 loggraph-engine `cep`（零拷贝切片推进）；本命令把会话
//! filter 命中缓存（扫描时内联解析的 (line, ts)）作为事件流下推给引擎，
//! 避免把全量命中事件回传前端再用 TS 引擎匹配（大数据加速路径）。
//!
//! 覆盖范围与 fallback 语义（引擎 `GroupSpec::is_supported`）：
//! - scope = global（命中事件无 thread/level/message，thread 分桶无意义）
//! - 边类型 ∈ {seq, and, or, not}
//! - 未使用 nodeConditions / nodeCounts / opt / periodic
//! 任何不满足上述条件的 group 触发**整体回退**，由前端 TS 引擎
//! (`runSequenceMatching`) 处理，保证行为不变。

use crate::db::current_db;
use loggraph_engine::cep::{GroupSpec, RunSeqResponse};

/// 入口命令：对每个 group 跑加速匹配；任一不支持 → fallback=true（前端整体回退 TS）。
/// CEP 匹配可达百万级事件 → 阻塞线程池执行，不占主线程。
#[tauri::command]
pub async fn db_run_sequences(groups: Vec<GroupSpec>) -> Result<RunSeqResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = current_db()?;
        Ok(db.run_sequences(&groups))
    })
    .await
    .map_err(|e| format!("db_run_sequences 任务失败: {e}"))?
}
