//! `parse_log` / `parse_dir` 命令：解析引擎薄壳层。
//!
//! 解析核心（行分割 / 时间戳探测与提取 / thread+level 行解析 / 多文件合并
//! 重编）在 loggraph-engine `parser`；本层只做进程边界：IPC 参数转发、
//! 进度事件推送（`parse_dir_progress`）与 prepare/chunk 分块传输缓存
//! （进程内状态，属壳层会话）。
//!
//! 分块协议（141 文件 × 5.1MB 场景防 OOM）：parse_dir 只解析+缓存+回元数据
//! （prepare）；前端循环 dir_lines_chunk / dir_events_chunk 按 offset 分块
//! 拉取；dir_cache_drop 释放。内存峰值 ≈ Rust 缓存 + 单块 JSON，无巨型中间串。

use loggraph_engine::parser::{
    find_complete_segment, find_format, parse_dir_files, parse_text_full, read_file_lossy, DirMeta,
    LogEvent, ParseResult,
};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// 统一解析命令：`path`（原生读文件+解析，推荐）与 `text`（直接解析文本）二选一，path 优先。
/// 重活放 spawn_blocking 线程池，不阻塞 IPC/async 执行器。
#[tauri::command]
pub async fn parse_log(
    path: Option<String>,
    text: Option<String>,
    format_id: Option<String>,
) -> Result<ParseResult, String> {
    // formatId 校验（当前前端不传，预留用户强制格式）
    let forced = match format_id.as_deref() {
        None => None,
        Some(id) => Some(find_format(id).ok_or_else(|| format!("未知时间戳格式 id: {id}"))?),
    };

    // 空串视同未提供
    let file_path = path.filter(|p| !p.is_empty());
    let inline_text = text.filter(|t| !t.is_empty());
    if file_path.is_none() && inline_text.is_none() {
        return Err("parse_log 需要 path 或 text 参数".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let content = if let Some(p) = &file_path {
            read_file_lossy(Path::new(p))
        } else if let Some(t) = &inline_text {
            Ok(t.clone())
        } else {
            Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "无输入"))
        };
        content
            .map(|text| parse_text_full(&text, forced))
            .map_err(|e| format!("读取日志文件失败: {e}"))
    })
    .await
    .map_err(|e| format!("解析任务执行失败: {e}"))?
}

// ---- 实时 tail：增量解析文件尾部（C 阶段一：单文件实时跟随） ----

/// 增量解析结果（段内事件 id 相对段首，前端按全局 rawLines 长度重基）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalParseResult {
    pub events: Vec<LogEvent>,
    pub raw_lines: Vec<String>,
    /// 已消费到的字节偏移（含最后那个 '\n'）；调用方下次从该偏移续读
    pub new_offset: u64,
    pub skipped: u32,
    pub timestamp_format_id: Option<String>,
}

/// 实时 tail：从 `from_byte` 读文件到末尾，仅解析其中**完整的新行**，
/// 返回新事件 + 新消费偏移。半行（写入中、未换行）留给下次轮询。
///
/// 与 `parse_log` 同走 spawn_blocking，不阻塞 IPC。无新完整行时返回空且
/// `new_offset == from_byte`（调用方不前进，避免重复/丢行）。
#[tauri::command]
pub async fn parse_log_incremental(
    path: String,
    from_byte: u64,
) -> Result<IncrementalParseResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let end = std::fs::metadata(p)
            .map_err(|e| format!("stat 失败: {e}"))?
            .len();
        if from_byte >= end {
            return Ok(IncrementalParseResult {
                events: Vec::new(),
                raw_lines: Vec::new(),
                new_offset: end,
                skipped: 0,
                timestamp_format_id: None,
            });
        }
        let mut file = std::fs::File::open(p).map_err(|e| format!("打开失败: {e}"))?;
        use std::io::{Read, Seek, SeekFrom};
        file.seek(SeekFrom::Start(from_byte))
            .map_err(|e| format!("seek 失败: {e}"))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("读取失败: {e}"))?;
        match find_complete_segment(&buf) {
            None => Ok(IncrementalParseResult {
                events: Vec::new(),
                raw_lines: Vec::new(),
                new_offset: from_byte, // 仅残行：不前进，等换行落盘
                skipped: 0,
                timestamp_format_id: None,
            }),
            Some(end) => {
                let segment = String::from_utf8_lossy(&buf[..end]);
                let parsed = parse_text_full(&segment, None);
                Ok(IncrementalParseResult {
                    events: parsed.events,
                    raw_lines: parsed.raw_lines,
                    new_offset: from_byte + end as u64,
                    skipped: parsed.skipped,
                    timestamp_format_id: parsed.timestamp_format_id,
                })
            }
        }
    })
    .await
    .map_err(|e| format!("增量解析任务执行失败: {e}"))?
}

// ---- 目录批量解析（prepare + 分块拉取） ----

/// prepare 阶段缓存；events / raw_lines 由 dir_chunk 从头部按 offset 切片返回
struct DirParseCache {
    events: Vec<LogEvent>,
    raw_lines: Vec<String>,
}

fn dir_cache() -> &'static Mutex<Option<DirParseCache>> {
    static CACHE: LazyLock<Mutex<Option<DirParseCache>>> =
        LazyLock::new(|| Mutex::new(None));
    &CACHE
}

/// 批量解析目录（prepare 阶段）：引擎枚举 + 逐文件解析 + 全局 id 重编 +
/// sourceFile 赋值 + 全局按 ts 排序，结果缓存在进程内，只回元数据
/// （大数据体由 dir_chunk 分块拉取）。
/// 进度经 Tauri event `parse_dir_progress` 推送 { loaded, total, current }。
#[tauri::command]
pub async fn parse_dir(app: tauri::AppHandle, dir: String) -> Result<DirMeta, String> {
    use tauri::Emitter;

    tauri::async_runtime::spawn_blocking(move || -> Result<DirMeta, String> {
        let root = PathBuf::from(&dir);
        let r = parse_dir_files(&root, |loaded, total, current| {
            let _ = app.emit(
                "parse_dir_progress",
                serde_json::json!({ "loaded": loaded, "total": total, "current": current }),
            );
        })
        .map_err(|e| e.to_string())?;

        // 缓存（覆盖旧的；连续加载时旧缓存被丢弃）
        *dir_cache().lock() = Some(DirParseCache {
            events: r.events,
            raw_lines: r.raw_lines,
        });
        Ok(r.meta)
    })
    .await
    .map_err(|e| format!("目录解析任务执行失败: {e}"))?
}

/// 取一块 rawLines（offset 起最多 max 条；不足 max = 已到尾）。
/// 返回空数组 = 该序列传输完成。
#[tauri::command]
pub fn dir_lines_chunk(offset: u32, max: u32) -> Result<Vec<String>, String> {
    let guard = dir_cache().lock();
    let Some(cache) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let start = (offset as usize).min(cache.raw_lines.len());
    let end = (start + max as usize).min(cache.raw_lines.len());
    Ok(cache.raw_lines[start..end].to_vec())
}

/// 取一块事件（offset 起最多 max 条；事件已按 ts 升序）。
/// 返回空数组 = 该序列传输完成。两序列都完成时由前端调 dir_cache_drop 释放。
#[tauri::command]
pub fn dir_events_chunk(offset: u32, max: u32) -> Result<Vec<LogEvent>, String> {
    let guard = dir_cache().lock();
    let Some(cache) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let start = (offset as usize).min(cache.events.len());
    let end = (start + max as usize).min(cache.events.len());
    Ok(cache.events[start..end].to_vec())
}

/// 丢弃缓存（前端拉取完成后调用；重新 prepare 也会覆盖）。
#[tauri::command]
pub fn dir_cache_drop() -> Result<(), String> {
    *dir_cache().lock() = None;
    Ok(())
}

// ---- 分块传输协议测试（壳层职责；解析语义测试在 engine） ----

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: u32, ts: i64) -> LogEvent {
        LogEvent {
            id,
            ts,
            raw: format!("line{id}"),
            thread: None,
            level: None,
            message: format!("line{id}"),
            source_file: None,
        }
    }

    /// 分块边界：offset 钳制、不足 max 截断、空缓存 → 空数组、drop 后 → 空数组
    #[test]
    fn dir_chunk_protocol_boundaries() {
        *dir_cache().lock() = Some(DirParseCache {
            events: vec![ev(0, 100), ev(1, 200), ev(2, 300)],
            raw_lines: vec!["a".into(), "b".into(), "c".into()],
        });

        assert_eq!(dir_lines_chunk(0, 2).unwrap(), vec!["a".to_string(), "b".to_string()]);
        // offset 越界 → 空数组（传输完成信号）
        assert_eq!(dir_lines_chunk(99, 2).unwrap(), Vec::<String>::new());
        // 不足 max → 截断到尾
        assert_eq!(dir_lines_chunk(1, 50).unwrap(), vec!["b".to_string(), "c".to_string()]);

        let evs = dir_events_chunk(1, 1).unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].id, 1);

        dir_cache_drop().unwrap();
        assert_eq!(dir_lines_chunk(0, 2).unwrap(), Vec::<String>::new());
        assert_eq!(dir_events_chunk(0, 2).unwrap(), Vec::<LogEvent>::new());
    }
}
