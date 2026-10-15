//! v4 数据层壳层：引擎会话转发 + 二进制编码 + perf 日志落盘。
//!
//! 业务逻辑（便宜通道建库 / 过滤扫描 / 行偏移 seek 直读）在 loggraph-engine
//! `session`；本层只做进程边界三件事：IPC 参数转发、Tauri 事件推送（壳层专属）、
//! SoA 二进制编码（输出格式化，前端 dbStore.ts 零对象解析）与 perf.log 写入
//! （引擎不碰文件系统副作用）。命令名 / 参数 / 响应形状与 v1 完全一致。
//!
//! 会话句柄生命周期属壳层（`MEM_DB` 静态）；引擎 `Session` 为纯库类型。

use loggraph_engine::session::{FileInfo, FilterBatchOut, FilterQuery, Session};
use parking_lot::RwLock;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::Instant;

// ---- DTO ----

/// 打开结果（camelCase 形状不变；cache_hit 恒 false 兼容字段）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbOpenResult {
    /// 兼容字段：纯内存无缓存，恒 false
    pub cache_hit: bool,
    pub total_lines: u32,
    pub skipped: u32,
    pub file_count: u32,
    pub timestamp_format_id: Option<String>,
    /// 时间轴范围（epoch ms）；目录无任何 ts → None（前端退回非 dbMode）
    pub range_start: Option<i64>,
    pub range_end: Option<i64>,
}

// ---- 会话句柄 ----

static MEM_DB: LazyLock<RwLock<Option<Arc<Session>>>> = LazyLock::new(|| RwLock::new(None));

/// 取当前会话的 Arc 快照：读锁瞬时持有，命令执行期间不阻塞其它命令
pub(crate) fn current_db() -> Result<Arc<Session>, String> {
    MEM_DB.read().clone().ok_or_else(|| "目录未打开".into())
}

/// 性能诊断日志（追加写 <root>/.logGraph/perf.log，ms 时间戳；失败静默）
fn perf_log(root: &Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(".logGraph").join("perf.log"))
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

// ---- 二进制编码（IPC 专属输出格式化） ----

/// 过滤结果编码（二进制，~12B/命中；百万级命中走 JSON 会到 100MB+ 且
/// 序列化/parse 双端数秒，故走 Response 路径）：
/// ```text
/// [filterCount u32]
/// 每 filter: [idLen u32][id utf8][hitCount u32][pad u32]
///            [line u32 × n][ts f64 × n]   （平行数组，ts 升序）
/// ```
fn encode_filter_batch(results: &FilterBatchOut) -> Vec<u8> {
    let cap = 4 + results
        .iter()
        .map(|(id, hits)| 12 + id.len() + hits.len() * 12)
        .sum::<usize>();
    let mut out = Vec::with_capacity(cap);
    out.extend_from_slice(&(results.len() as u32).to_le_bytes());
    for (id, hits) in results {
        out.extend_from_slice(&(id.len() as u32).to_le_bytes());
        out.extend_from_slice(id.as_bytes());
        out.extend_from_slice(&(hits.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for h in hits {
            out.extend_from_slice(&h.line.to_le_bytes());
        }
        for h in hits {
            out.extend_from_slice(&(h.ts as f64).to_le_bytes());
        }
    }
    out
}

/// 视口行编码：`[count: u32][pad: u32] + 每行 [line: u32][len: u32][utf-8 bytes]`
fn encode_lines_by_ids(rows: &[(u32, String)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(8 + rows.len() * 24);
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for (line, text) in rows {
        out.extend_from_slice(&line.to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(text.as_bytes());
    }
    out
}

// ---- 命令 ----

/// 打开目录（引擎便宜通道建库；`files`：相对路径清单（None=目录全集），
/// 前端是文件清单的唯一权威）。
#[tauri::command]
pub async fn db_open(
    app: tauri::AppHandle,
    dir: String,
    files: Option<Vec<String>>,
) -> Result<DbOpenResult, String> {
    use tauri::Emitter;

    tauri::async_runtime::spawn_blocking(move || {
        let t0 = Instant::now();
        let root = std::path::PathBuf::from(&dir);

        let session = Session::open(&root, files.as_deref(), |loaded, total, current| {
            let _ = app.emit(
                "db_build_progress",
                serde_json::json!({ "loaded": loaded, "total": total, "current": current }),
            );
        })
        .map_err(|e| e.to_string())?;

        // .logGraph 工作区目录（filters.json 持久化 + perf 日志）；
        // 引擎不产生文件系统副作用，由壳层在会话成功后创建
        std::fs::create_dir_all(root.join(".logGraph"))
            .map_err(|e| format!("创建工作区目录失败: {e}"))?;

        let info = session.info();
        // 骨架字节数（内存基准：offsets；命中缓存另计）
        let skeleton = session.skeleton_bytes();
        perf_log(
            &root,
            &format!(
                "open: {} files, {} lines, skipped {}, skeleton {} MB, {:?}",
                info.file_count,
                info.total_lines,
                info.skipped,
                skeleton / 1048576,
                t0.elapsed()
            ),
        );

        *MEM_DB.write() = Some(Arc::new(session));
        Ok(DbOpenResult {
            cache_hit: false,
            total_lines: info.total_lines,
            skipped: info.skipped,
            file_count: info.file_count,
            timestamp_format_id: info.timestamp_format_id,
            range_start: info.range_start,
            range_end: info.range_end,
        })
    })
    .await
    .map_err(|e| format!("db_open 任务失败: {e}"))?
}

/// 批量运行过滤器（指纹缓存 → miss 单遍批量直扫 → 二进制编码返回）。
#[tauri::command]
pub async fn db_filters_batch(
    queries: Vec<FilterQuery>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let t0 = Instant::now();
        let db = current_db()?;
        let root = db.root().to_path_buf();
        perf_log(
            &root,
            &format!("---- db_filters_batch: {} queries ----", queries.len()),
        );

        let outcome = db.filters_batch(&queries).map_err(|e| e.to_string())?;
        perf_log(
            &root,
            &format!("fingerprint: {} cached, {} miss", outcome.cached, outcome.miss),
        );
        for line in &outcome.scan_perf {
            perf_log(&root, line);
        }
        let total_rows: usize = outcome.out.iter().map(|(_, h)| h.len()).sum();
        perf_log(
            &root,
            &format!(
                "store+join: {} miss filters, hits {:?}",
                outcome.miss,
                outcome.out.iter().map(|(_, h)| h.len()).collect::<Vec<_>>()
            ),
        );

        let t = Instant::now();
        let enc = encode_filter_batch(&outcome.out);
        perf_log(
            &root,
            &format!(
                "encode: {} rows, {} MB {:?}",
                total_rows,
                enc.len() / 1048576,
                t.elapsed()
            ),
        );
        perf_log(&root, &format!("total(rust): {:?}", t0.elapsed()));
        Ok(enc)
    })
    .await
    .map_err(|e| format!("db_filters_batch 任务失败: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 删除一个 filter 的命中（filter 被删时调用）
#[tauri::command]
pub async fn db_filter_drop(filter_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = current_db()?;
        db.drop_filter(&filter_id);
        Ok(())
    })
    .await
    .map_err(|e| format!("db_filter_drop 任务失败: {e}"))?
}

// ---- 按需取数（行偏移 seek 直读原文件） ----

/// 单行文本（tooltip/复制用）：行偏移 seek 直读，不整文件重读
#[tauri::command]
pub async fn db_line(no: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = current_db()?;
        db.line(no).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("db_line 任务失败: {e}"))?
}

/// 视口行文本：按全局行号集合取行（任意顺序；内部排序去重 + gap≤64 段读）。
/// 返回原始字节：`[count: u32][pad: u32] + 每行 [line: u32][len: u32][utf-8 bytes]`
#[tauri::command]
pub async fn db_lines_by_ids(ids: Vec<u32>) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let db = current_db()?;
        Ok(encode_lines_by_ids(&db.lines_by_ids(&ids)))
    })
    .await
    .map_err(|e| format!("db_lines_by_ids 任务失败: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 关联窗口下推：filter_ids 任一命中的行中，ts ∈ [start, end] 的全局行号
#[tauri::command]
pub async fn db_corr_ids(
    filter_ids: Vec<String>,
    start: i64,
    end: i64,
) -> Result<Vec<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = current_db()?;
        Ok(db.corr_ids(&filter_ids, start, end))
    })
    .await
    .map_err(|e| format!("db_corr_ids 任务失败: {e}"))?
}

/// 关闭（切换目录时）
#[tauri::command]
pub fn db_close() -> Result<(), String> {
    *MEM_DB.write() = None;
    Ok(())
}

/// 文件清单（first_line 升序）。无限上下文滚动需要知道每个文件的行号区间与绝对路径。
#[tauri::command]
pub async fn db_files() -> Result<Vec<FileInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = current_db()?;
        Ok(db.file_infos())
    })
    .await
    .map_err(|e| format!("db_files 任务失败: {e}"))?
}

/// 在系统文件管理器中定位该文件（Windows 选中显示；macOS -R；Linux 打开父目录）。
/// `Command` 不经 shell 拼接，路径无注入面。
#[tauri::command]
pub fn db_reveal_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".into());
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").args(["-R", &path]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open")
        .arg(std::path::Path::new(&path)
            .parent()
            .ok_or("无父目录")?)
        .spawn();
    r.map(|_| ()).map_err(|e| format!("打开目录失败: {e}"))
}

/// 用系统默认应用打开该文件。
#[tauri::command]
pub fn db_open_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".into());
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd")
        // start 的 "" 是标题占位；cmd /C 按整串拼接执行，路径必须自带引号
        .args(["/C", &format!("start \"\" \"{path}\"")])
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&path).spawn();
    r.map(|_| ()).map_err(|e| format!("打开文件失败: {e}"))
}

// ---- 编码协议回归测试（IPC 边界不变量；业务逻辑测试在 engine） ----

#[cfg(test)]
mod tests {
    use super::*;
    use loggraph_engine::session::HitEntry;

    #[test]
    fn encode_filter_batch_layout() {
        let out: FilterBatchOut = vec![
            ("f1".into(), vec![HitEntry { line: 3, ts: 1700000000000 }]),
            ("f2".into(), vec![]),
        ];
        let b = encode_filter_batch(&out);
        assert_eq!(u32::from_le_bytes(b[0..4].try_into().unwrap()), 2);
        // f1: idLen=2, "f1", hitCount=1, pad
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 2);
        assert_eq!(&b[8..10], b"f1");
        let mut p = 10usize;
        assert_eq!(u32::from_le_bytes(b[p..p + 4].try_into().unwrap()), 1);
        p += 4;
        assert_eq!(u32::from_le_bytes(b[p..p + 4].try_into().unwrap()), 0);
        p += 4;
        assert_eq!(u32::from_le_bytes(b[p..p + 4].try_into().unwrap()), 3);
        p += 4;
        assert_eq!(
            f64::from_le_bytes(b[p..p + 8].try_into().unwrap()),
            1700000000000.0
        );
        // f2: idLen=2, "f2", hitCount=0, pad
        p += 8;
        assert_eq!(u32::from_le_bytes(b[p..p + 4].try_into().unwrap()), 2);
        assert_eq!(&b[p + 4..p + 6], b"f2");
        assert_eq!(u32::from_le_bytes(b[p + 6..p + 10].try_into().unwrap()), 0);
        assert_eq!(b.len(), 4 + (12 + 2 + 12) + (12 + 2));
    }

    #[test]
    fn encode_lines_by_ids_layout_and_empty() {
        // 空 → 与历史行为一致：8 零字节（count=0 + pad=0）
        assert_eq!(encode_lines_by_ids(&[]), vec![0u8; 8]);
        let rows = vec![(7, "héllo".to_string())];
        let b = encode_lines_by_ids(&rows);
        assert_eq!(u32::from_le_bytes(b[0..4].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 7);
        // len 为 utf-8 字节数（é 2 字节）
        assert_eq!(u32::from_le_bytes(b[12..16].try_into().unwrap()), 6);
        assert_eq!(&b[16..22], "héllo".as_bytes());
    }
}
