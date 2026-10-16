//! v4 数据层壳层：REST 式无状态命令（ws_*）+ 二进制编码 + 缓存落盘。
//!
//! 业务逻辑（便宜通道建库 / 过滤扫描 / 行偏移 seek 直读 / 序列匹配）在
//! loggraph-engine `session`；本层只做进程边界四件事：
//! - IPC 参数自描述转发（每请求携带 dir + ctx，无服务端会话状态）
//! - Tauri 事件推送（建库进度，壳层专属）
//! - SoA 二进制编码（输出格式化，前端 dbStore.ts 零对象解析）
//! - `.logGraph` 缓存工件落盘 + perf.log 写入（引擎不碰文件系统副作用；
//!   写失败只降速不变错）
//!
//! ctx 由 `ws_info` 产出、客户端持有回传；引擎按 ctx 零 I/O 重建请求级
//! 工作视图（快照语义，详见 engine session 模块文档）。

use loggraph_engine::cep::{GroupSpec, RunSeqResponse};
use loggraph_engine::session::{FilterBatchOut, FilterQuery, Session, WsCtx};
use std::path::{Path, PathBuf};
use std::time::Instant;

// ---- 工具 ----

/// 按 ctx 重建请求级工作视图（所有有 ctx 命令的公共入口）
fn open_ws(root: &Path, ctx: &WsCtx) -> Result<Session, String> {
    Session::from_ctx(root, ctx).map_err(|e| e.to_string())
}

/// 性能诊断日志（追加写 <root>/.logGraph/perf.log，ms 时间戳；失败静默）
fn perf_log(root: &Path, msg: &str) {
    use std::io::Write;
    let dir = root.join(".logGraph");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("perf.log"))
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

/// 落盘引擎缓存工件（.off 偏移表 / .bin 命中集）：建父目录 + 临时文件 +
/// 原子改名；失败静默（只影响下次延迟，不影响正确性）。
fn persist_cache(root: &Path, items: Vec<(PathBuf, Vec<u8>)>) {
    for (path, bytes) in items {
        let Some(parent) = path.parent() else { continue };
        if std::fs::create_dir_all(parent).is_err() {
            continue;
        }
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    let _ = root; // 保留参数形状（工件路径已绝对化）
}

// ---- 二进制编码（IPC 专属输出格式化） ----

/// 过滤结果编码（二进制，~12B/命中；百万级命中走 JSON 会到 100MB+ 且
/// 序列化/parse 双端数秒，故走 Response 路径）：
/// ```text
/// [filterCount u32]
/// 每 filter: [idLen u32][id utf8][hitCount u32][pad u32]
///            [line u32 × n][ts f64 × n]   （平行数组，ts 升序）
/// ```
#[allow(clippy::cast_precision_loss)]
fn encode_filter_batch(results: &FilterBatchOut) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        4 + results
            .iter()
            .map(|(id, h)| 16 + id.len() + h.len() * 12)
            .sum::<usize>(),
    );
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
    let mut out = Vec::with_capacity(8 + rows.iter().map(|(_, t)| 8 + t.len()).sum::<usize>());
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

/// 建工作区上下文（REST 化后唯一付整读价的入口；`files`：相对路径清单
/// （None=目录全集），前端是文件清单的唯一权威）。返回 ctx（客户端持有，
/// 后续请求回传）。emit `ws_build_progress` 报告逐文件进度。
#[tauri::command]
pub async fn ws_info(
    app: tauri::AppHandle,
    dir: String,
    files: Option<Vec<String>>,
) -> Result<WsCtx, String> {
    use tauri::Emitter;

    tauri::async_runtime::spawn_blocking(move || -> Result<WsCtx, String> {
        let t0 = Instant::now();
        let root = PathBuf::from(&dir);

        let ctx = Session::build_ctx(&root, files.as_deref(), |loaded, total, current| {
            let _ = app.emit(
                "ws_build_progress",
                serde_json::json!({ "loaded": loaded, "total": total, "current": current }),
            );
        })
        .map_err(|e| e.to_string())?;

        // .logGraph 工作区目录（缓存 + filters.json 持久化 + perf 日志）；
        // 引擎不产生文件系统副作用，由壳层在成功后创建
        std::fs::create_dir_all(root.join(".logGraph"))
            .map_err(|e| format!("创建工作区目录失败: {e}"))?;

        perf_log(
            &root,
            &format!(
                "info: {} files, {} lines, skipped {}, skeleton {} MB, {:?}",
                ctx.file_count,
                ctx.total_lines,
                ctx.skipped,
                ctx.files.iter().map(|f| f.line_count as usize * 8).sum::<usize>() / 1048576,
                t0.elapsed()
            ),
        );
        Ok(ctx)
    })
    .await
    .map_err(|e| format!("ws_info 任务失败: {e}"))?
}

/// 批量运行过滤器（RAM 指纹 → `.logGraph` 命中盘缓存 → miss 单遍批量直扫）。
/// ctx 定位工作区；二进制 SoA 响应格式不变。
#[tauri::command]
pub async fn ws_filters(
    dir: String,
    ctx: WsCtx,
    queries: Vec<FilterQuery>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let t0 = Instant::now();
        let root = PathBuf::from(&dir);
        let ws = open_ws(&root, &ctx)?;
        perf_log(
            &root,
            &format!("---- ws_filters: {} queries ----", queries.len()),
        );

        let outcome = ws.filters_batch(&queries).map_err(|e| e.to_string())?;
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
        persist_cache(&root, ws.take_persistable());

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
    .map_err(|e| format!("ws_filters 任务失败: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---- 按需取数（行偏移 seek 直读原文件；偏移单文件懒建 + 盘缓存复用） ----

/// 单行文本（tooltip/复制用）：行偏移 seek 直读，不整文件重读
#[tauri::command]
pub async fn ws_line(dir: String, ctx: WsCtx, no: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let root = PathBuf::from(&dir);
        let ws = open_ws(&root, &ctx)?;
        let text = ws.line(no).map_err(|e| e.to_string())?;
        persist_cache(&root, ws.take_persistable());
        Ok(text)
    })
    .await
    .map_err(|e| format!("ws_line 任务失败: {e}"))?
}

/// 视口行文本：按全局行号集合取行（任意顺序；内部排序去重 + gap≤64 段读）。
/// 返回原始字节：`[count: u32][pad: u32] + 每行 [line: u32][len: u32][utf-8 bytes]`
#[tauri::command]
pub async fn ws_lines(dir: String, ctx: WsCtx, ids: Vec<u32>) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let root = PathBuf::from(&dir);
        let ws = open_ws(&root, &ctx)?;
        let rows = ws.lines_by_ids(&ids);
        persist_cache(&root, ws.take_persistable());
        Ok(encode_lines_by_ids(&rows))
    })
    .await
    .map_err(|e| format!("ws_lines 任务失败: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 序列匹配（CEP 下推）：`queries` 先行 warm 命中缓存（盘缓存命中则免重扫），
/// 再把 (line, ts) 命中作为事件流喂给引擎匹配核心。
/// 覆盖范围与 fallback 语义（引擎 `GroupSpec::is_supported`）：scope=global、
/// 边类型 ∈ {seq, and, or, not}、未用 nodeConditions/nodeCounts/opt/periodic；
/// 任一不满足 → fallback=true（前端整体回退 TS 引擎）。
#[tauri::command]
pub async fn ws_sequences(
    dir: String,
    ctx: WsCtx,
    queries: Vec<FilterQuery>,
    groups: Vec<GroupSpec>,
) -> Result<RunSeqResponse, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<RunSeqResponse, String> {
        let t0 = Instant::now();
        let root = PathBuf::from(&dir);
        let ws = open_ws(&root, &ctx)?;
        if !queries.is_empty() {
            let outcome = ws.filters_batch(&queries).map_err(|e| e.to_string())?;
            for line in &outcome.scan_perf {
                perf_log(&root, line);
            }
            persist_cache(&root, ws.take_persistable());
        }
        let r = ws.run_sequences(&groups);
        perf_log(&root, &format!("sequences: {} groups, {:?}", groups.len(), t0.elapsed()));
        Ok(r)
    })
    .await
    .map_err(|e| format!("ws_sequences 任务失败: {e}"))?
}

// ---- 系统交互（无 ctx；路径自描述） ----

/// 在系统文件管理器中定位该文件（Windows 选中显示；macOS -R；Linux 打开父目录）。
/// `Command` 不经 shell 拼接，路径无注入面。
#[tauri::command]
pub fn ws_reveal_path(path: String) -> Result<(), String> {
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
pub fn ws_open_path(path: String) -> Result<(), String> {
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
            ("f1".into(), vec![HitEntry { line: 3, ts: 1704103200000 }]),
            (
                "f2".into(),
                vec![
                    HitEntry { line: 1, ts: 100 },
                    HitEntry { line: 7, ts: i64::MIN }, // NO_TS 走 f64 编码
                ],
            ),
        ];
        let b = encode_filter_batch(&out);
        // count
        assert_eq!(u32::from_le_bytes(b[0..4].try_into().unwrap()), 2);
        // f1: [idLen][id][hitCount][pad][lines][ts]
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 2);
        assert_eq!(&b[8..10], b"f1");
        assert_eq!(u32::from_le_bytes(b[10..14].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(b[18..22].try_into().unwrap()), 3);
        assert_eq!(
            f64::from_le_bytes(b[22..30].try_into().unwrap()),
            1704103200000.0
        );
        // f2 紧随（o=30）：idLen/id、hitCount=2、lines=[1,7]、ts=[100, NO_TS]
        let o = 30;
        assert_eq!(u32::from_le_bytes(b[o..o + 4].try_into().unwrap()), 2);
        assert_eq!(&b[o + 4..o + 6], b"f2");
        assert_eq!(u32::from_le_bytes(b[o + 6..o + 10].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(b[o + 14..o + 18].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(b[o + 18..o + 22].try_into().unwrap()), 7);
        assert_eq!(f64::from_le_bytes(b[o + 22..o + 30].try_into().unwrap()), 100.0);
        // NO_TS = i64::MIN → f64 下溢为大负数（非 NaN）
        assert!(f64::from_le_bytes(b[o + 30..o + 38].try_into().unwrap()) < -9.2e18);
        assert_eq!(b.len(), o + 38);
    }

    #[test]
    fn encode_lines_layout() {
        let rows = vec![(5u32, "中文".to_string()), (0, String::new())];
        let b = encode_lines_by_ids(&rows);
        assert_eq!(u32::from_le_bytes(b[0..4].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 5);
        let len = u32::from_le_bytes(b[12..16].try_into().unwrap()) as usize;
        assert_eq!(&b[16..16 + len], "中文".as_bytes());
        let o = 16 + len;
        assert_eq!(u32::from_le_bytes(b[o..o + 4].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(b[o + 4..o + 8].try_into().unwrap()), 0);
        assert_eq!(b.len(), o + 8);
    }
}
