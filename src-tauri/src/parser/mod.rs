//! `parse_log` 命令：Rust 原生日志解析引擎入口。
//!
//! 与 JS 引擎（src/parser/LogParser.ts）语义逐条对齐，对齐清单见 plans/rust-parser-design.md：
//! - 行分割等价 `text.split(/\r?\n/)`；
//! - 探测样本 = 前 100 行中的非空行（JS trim 语义）；
//! - 空行与无法提取时间戳的行计入 skipped；
//! - 事件 id = 原始行号（排序前赋值），最终按 ts 稳定排序；
//! - rawLines 与 JS split 结果逐行一致（DetailPanel 上下文索引用）；
//! - 探测失败时逐行尝试全部格式（JS extractTimestamp(undefined) 同）。

pub mod line;
pub mod timestamp;

use self::line::{js_trim, parse_rest};
use self::timestamp::{detect_timestamp_format, extract_timestamp, find_format, TsFormat};
use serde::Serialize;

/// 单条日志事件（对齐 TS LogEvent；serde camelCase 序列化，None 字段缺省键）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEventDto {
    /// 行索引（排序前赋值的原始行号，多文件合并由前端重编）
    pub id: u32,
    /// epoch 毫秒
    pub ts: i64,
    /// 原始整行（不含换行符）
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// 时间戳之后的正文
    pub message: String,
    /// 单文件解析恒 None；多文件合并由前端赋值（保持两引擎合并逻辑统一）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
}

/// 解析结果（= JS ParseResult + rawLines，前端零适配）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParseResultDto {
    pub events: Vec<LogEventDto>,
    /// 与 JS text.split(/\r?\n/) 逐行一致
    pub raw_lines: Vec<String>,
    pub timestamp_format_id: Option<String>,
    pub skipped: u32,
    pub total_lines: u32,
}

/// 等价 JS `text.split(/\r?\n/)`：按 \n 切分后每段剥一个尾部 \r。
/// 单独 \r 不切分；"a\r\r\nb" → ["a\r", "b"]，与 JS 正则行为一致。
pub fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// 核心解析流程（纯函数，对齐 LogParser.parse，供命令与单测共用）。
pub fn parse_text_full(text: &str, forced: Option<&TsFormat>) -> ParseResultDto {
    let lines = split_lines(text);
    let total_lines = lines.len() as u32;

    // 未指定格式 → 预扫描探测（前 100 行的非空行；对齐 JS slice(0,100).filter(l=>l.trim())）
    let format = forced.or_else(|| {
        let sample: Vec<&str> = lines
            .iter()
            .take(100)
            .filter(|l| !js_trim(l).is_empty())
            .copied()
            .collect();
        detect_timestamp_format(&sample)
    });

    let mut events: Vec<LogEventDto> = Vec::new();
    let mut skipped: u32 = 0;

    for (i, raw) in lines.iter().enumerate() {
        // 空行（JS trim 语义）→ skipped
        if js_trim(raw).is_empty() {
            skipped += 1;
            continue;
        }
        // 提取时间戳（探测失败 format=None 时逐行尝试全部格式，与 JS 一致）
        let Some(ext) = extract_timestamp(raw, format) else {
            skipped += 1;
            continue;
        };
        // rest = 时间戳匹配区间之后的剩余。
        // 注：JS 用 raw.indexOf(matchStr) 定位（matchStr 在行内更早重复出现时会定位到错误位置），
        // 此处用真实匹配区间 —— 仅构造性输入下不同，已文档化（plans/rust-parser-design.md §5.2）。
        let rest = &raw[ext.end..];
        let parsed = parse_rest(rest);
        events.push(LogEventDto {
            id: i as u32,
            ts: ext.ts,
            raw: raw.to_string(),
            thread: parsed.thread,
            level: parsed.level,
            message: parsed.message,
            source_file: None,
        });
    }

    // 按 ts 稳定排序（sort_by_key 稳定 = ES2019+ 的 JS sort 稳定；同 ts 保持原行序）
    events.sort_by_key(|e| e.ts);

    ParseResultDto {
        events,
        raw_lines: lines.into_iter().map(|l| l.to_string()).collect(),
        timestamp_format_id: format.map(|f| f.id.to_string()),
        skipped,
        total_lines,
    }
}

/// 读文件并做 lossy UTF-8 解码（非法字节 → U+FFFD，与浏览器 TextDecoder 默认行为一致）。
/// 用 std::fs 直读：不经 plugin-fs 的 IPC 桥（scope 只约束插件命令，本命令为应用自有命令）。
fn read_file_lossy(path: &str) -> Result<String, std::io::Error> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 统一解析命令：`path`（原生读文件+解析，推荐）与 `text`（直接解析文本）二选一，path 优先。
/// 重活放 spawn_blocking 线程池，不阻塞 IPC/async 执行器。
#[tauri::command]
pub async fn parse_log(
    path: Option<String>,
    text: Option<String>,
    format_id: Option<String>,
) -> Result<ParseResultDto, String> {
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
            read_file_lossy(p)
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

// ---- 目录批量解析（P2：141 文件 × 5.1MB 场景，1 次 IPC 替代 141 次）----

/// 多文件合并结果（= 前端 MultiLoadResult.meta 部分 + 全局事件流）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirParseResultDto {
    /// 全局事件流（id 已重编为全局行号，sourceFile 已赋值，按 ts 升序）
    pub events: Vec<LogEventDto>,
    /// 全局 rawLines（与前端 mergeParsedInputs 语义一致）
    pub raw_lines: Vec<String>,
    /// 参与合并的文件相对名（与 events.sourceFile 一致）
    pub file_names: Vec<String>,
    pub total_lines: u32,
    pub skipped: u32,
    /// 各文件格式 id 集合大小为 1 时给出该 id，否则 None（与 JS meta 逻辑一致）
    pub timestamp_format_id: Option<String>,
}

/// 判断文件名是否为可识别的日志文件（对齐前端 isLogFileName 宽松匹配）
fn is_log_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".log", ".txt", ".out", ".csv", ".tsv"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 递归枚举目录下日志文件（相对路径，'/' 分隔；与前端 listLogFiles 的 name 对齐）
fn walk_log_files(dir: &std::path::Path, prefix: &str, depth: u32, out: &mut Vec<String>) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 无权限/不存在 → 跳过（前端行为一致）
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            walk_log_files(&path, &rel, depth + 1, out);
        } else if is_log_file_name(&name) {
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            out.push(rel);
        }
    }
}

/// 批量解析目录：枚举 + 逐文件解析 + 全局 id 重编 + sourceFile 赋值 + 全局按 ts 排序，
/// 全程 Rust 进程内完成（前端零合并拷贝），结果一次 IPC 返回。
/// 进度经 Tauri event `parse_dir_progress` 推送 { loaded, total, current }。
#[tauri::command]
pub async fn parse_dir(
    app: tauri::AppHandle,
    dir: String,
) -> Result<DirParseResultDto, String> {
    use tauri::Emitter;

    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&dir);
        if !root.is_dir() {
            return Err(format!("目录不存在: {dir}"));
        }
        // 枚举（排序与前端 localeCompare 近似：按名称字典序）
        let mut names: Vec<String> = Vec::new();
        walk_log_files(&root, "", 0, &mut names);
        names.sort();
        if names.is_empty() {
            return Err("该目录下没有可识别的日志文件（.log/.txt/.out/.csv/.tsv）".into());
        }
        let total = names.len();

        let mut all_events: Vec<LogEventDto> = Vec::new();
        let mut all_raw_lines: Vec<String> = Vec::new();
        let mut total_lines: u32 = 0;
        let mut skipped: u32 = 0;
        let mut format_ids: Vec<Option<String>> = Vec::new();
        let mut file_names: Vec<String> = Vec::new();

        for (i, rel) in names.iter().enumerate() {
            let full = root.join(rel);
            let text = match read_file_lossy(full.to_str().unwrap_or_default()) {
                Ok(t) => t,
                Err(_) => continue, // 读取失败跳过（前端降级行为一致）
            };
            let parsed = parse_text_full(&text, None);
            let _ = app.emit(
                "parse_dir_progress",
                serde_json::json!({ "loaded": i + 1, "total": total, "current": rel }),
            );
            file_names.push(rel.clone());
            format_ids.push(parsed.timestamp_format_id.clone());
            total_lines = total_lines.saturating_add(parsed.total_lines);
            skipped = skipped.saturating_add(parsed.skipped);

            // 全局 id 重编（baseId = 已累计行数）+ sourceFile 赋值（Rust 侧完成，
            // 事件对象只存一份 name 引用，序列化后前端天然共享字符串池）
            let base_id = all_raw_lines.len() as u32;
            for l in parsed.raw_lines {
                all_raw_lines.push(l);
            }
            for mut ev in parsed.events {
                ev.id = base_id.saturating_add(ev.id);
                ev.source_file = Some(rel.clone());
                all_events.push(ev);
            }
        }

        // 全局按 ts 稳定排序（与 JS mergeParsedInputs 相同语义）
        all_events.sort_by_key(|e| e.ts);

        // 格式 id：全部相同才透出（前端 meta 逻辑）
        let timestamp_format_id = if !format_ids.is_empty() && format_ids.windows(2).all(|w| w[0] == w[1]) {
            format_ids[0].clone()
        } else {
            None
        };

        Ok(DirParseResultDto {
            events: all_events,
            raw_lines: all_raw_lines,
            file_names,
            total_lines,
            skipped,
            timestamp_format_id,
        })
    })
    .await
    .map_err(|e| format!("目录解析任务执行失败: {e}"))?
}

// ---- 单元测试（cargo test；期望值均按 JS 语义人工推演）----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_matrix() {
        // 与 JS "x".split(/\r?\n/) 行为矩阵一致
        assert_eq!(split_lines(""), vec![""]);
        assert_eq!(split_lines("a"), vec!["a"]);
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_lines("a\r\nb"), vec!["a", "b"]);
        assert_eq!(split_lines("a\rb"), vec!["a\rb"]); // 单独 \r 不切
        assert_eq!(split_lines("a\r\r\nb"), vec!["a\r", "b"]); // 只剥一个 \r
        assert_eq!(split_lines("a\n"), vec!["a", ""]); // 尾换行 → 末尾空行
        assert_eq!(split_lines("a\n\nb"), vec!["a", "", "b"]);
        assert_eq!(split_lines("中文\n行"), vec!["中文", "行"]);
    }

    #[test]
    fn parse_basic_with_meta() {
        let text = "2024-01-01 10:00:00.000 [T1] INFO hello\n2024-01-01 10:00:01.000 [T1] WARN world\n";
        let r = parse_text_full(text, None);
        assert_eq!(r.total_lines, 3); // 末尾换行 → 第 3 行为空
        assert_eq!(r.skipped, 1);
        assert_eq!(r.timestamp_format_id.as_deref(), Some("iso-local-ms"));
        assert_eq!(
            r.raw_lines,
            vec![
                "2024-01-01 10:00:00.000 [T1] INFO hello",
                "2024-01-01 10:00:01.000 [T1] WARN world",
                ""
            ]
        );
        assert_eq!(r.events.len(), 2);

        let e0 = &r.events[0];
        assert_eq!(e0.id, 0);
        assert_eq!(e0.ts, 1704103200000); // Date.UTC(2024,0,1,10,0,0,0)
        assert_eq!(e0.raw, "2024-01-01 10:00:00.000 [T1] INFO hello");
        assert_eq!(e0.thread.as_deref(), Some("T1"));
        assert_eq!(e0.level.as_deref(), Some("INFO"));
        assert_eq!(e0.message, "hello");
        assert_eq!(e0.source_file, None);

        let e1 = &r.events[1];
        assert_eq!(e1.id, 1);
        assert_eq!(e1.ts, 1704103201000);
        assert_eq!(e1.level.as_deref(), Some("WARN"));
        assert_eq!(e1.message, "world");
    }

    #[test]
    fn ids_are_original_line_indices() {
        // 空行占行号：第二个事件 id=2（JS 用全局行号索引 rawLines，必须一致）
        let text = "12:00:00.000 a\n\n12:00:02.000 b\n";
        let r = parse_text_full(text, None);
        assert_eq!(r.total_lines, 4);
        assert_eq!(r.skipped, 2);
        assert_eq!(r.timestamp_format_id.as_deref(), Some("time-only-ms"));
        let ids: Vec<u32> = r.events.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![0, 2]);
        assert_eq!(r.events[0].ts, 43200000); // Date.UTC(1970,0,1,12)
        assert_eq!(r.events[1].ts, 43202000);
        // id 可直接索引 rawLines（DetailPanel 上下文依赖）
        assert_eq!(r.raw_lines[2], "12:00:02.000 b");
    }

    #[test]
    fn stable_sort_same_ts() {
        // 同 ts 保持原行序（Rust sort_by_key 稳定 = ES2019+ JS sort 稳定）
        let text = "12:00:00.000 b\n12:00:00.000 a\n";
        let r = parse_text_full(text, None);
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.events[0].id, 0);
        assert!(r.events[0].raw.ends_with("b"));
        assert_eq!(r.events[1].id, 1);
        assert!(r.events[1].raw.ends_with("a"));
    }

    #[test]
    fn sort_by_ts_across_lines() {
        // 乱序输入 → 按 ts 升序修正（便于前端二分查找）
        let text = "12:00:05.000 late\n12:00:01.000 early\n";
        let r = parse_text_full(text, None);
        assert_eq!(r.events[0].id, 1); // early 行 ts 更小 → 排前
        assert!(r.events[0].raw.ends_with("early"));
        assert!(r.events[1].raw.ends_with("late"));
    }

    #[test]
    fn skipped_and_totals() {
        let text = "12:00:00.000 ok\nplain line without timestamp\n";
        let r = parse_text_full(text, None);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.skipped, 1);
        assert_eq!(r.total_lines, 2);
    }

    #[test]
    fn crlf_equals_lf() {
        let lf = "2024-01-01 10:00:00.000 a\n2024-01-01 10:00:01.000 b\n";
        let crlf = "2024-01-01 10:00:00.000 a\r\n2024-01-01 10:00:01.000 b\r\n";
        assert_eq!(parse_text_full(lf, None), parse_text_full(crlf, None));
    }

    #[test]
    fn bom_prefixed_line() {
        // BOM 保留在 raw 中；正则无锚点仍能命中时间戳（与浏览器 readAsText 行为一致）
        let text = "\u{feff}2024-01-01 10:00:00.000 a";
        let r = parse_text_full(text, None);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].ts, 1704103200000);
        assert!(r.events[0].raw.starts_with('\u{feff}'));
        assert_eq!(r.events[0].message, "a");
    }

    #[test]
    fn forced_format() {
        // 强制 epoch：正常命中
        let fmt = find_format("epoch").unwrap();
        let r = parse_text_full("1710000000000 x", Some(fmt));
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].ts, 1710000000000);
        assert_eq!(r.events[0].message, "x");
        assert_eq!(r.timestamp_format_id.as_deref(), Some("epoch"));

        // 强制 time-only：epoch 行不匹配 → skipped（不回退尝试其他格式，JS 同）
        let fmt2 = find_format("time-only-ms").unwrap();
        let r2 = parse_text_full("1710000000000 x", Some(fmt2));
        assert_eq!(r2.events.len(), 0);
        assert_eq!(r2.skipped, 1);
        assert_eq!(r2.timestamp_format_id.as_deref(), Some("time-only-ms"));
    }

    #[test]
    fn empty_input() {
        let r = parse_text_full("", None);
        assert_eq!(r.total_lines, 1); // "".split() = [""]
        assert_eq!(r.skipped, 1);
        assert!(r.events.is_empty());
        assert_eq!(r.raw_lines, vec![""]);
        assert_eq!(r.timestamp_format_id, None);
    }

    #[test]
    fn detect_fail_falls_back_to_all_formats_per_line() {
        // 前 100 非空行无一命中任何格式 → 探测返回 null；
        // 但后续行逐行尝试全部格式（JS extractTimestamp(undefined) 同）
        let mut text = String::new();
        for _ in 0..100 {
            text.push_str("plain filler line\n");
        }
        text.push_str("1710000000000 real event\n");
        let r = parse_text_full(&text, None);
        assert_eq!(r.timestamp_format_id, None);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].id, 100);
        assert_eq!(r.events[0].ts, 1710000000000);
        assert_eq!(r.events[0].message, "real event");
        // 100 填充行（无时间戳）+ 尾部换行产生的 1 个空行 → skipped = 101
        assert_eq!(r.total_lines, 102);
        assert_eq!(r.skipped, 101);
    }

    #[test]
    fn read_file_lossy_replaces_invalid_utf8() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("loggraph_test_{}.log", std::process::id()));
        std::fs::write(&path, b"2024-01-01 10:00:00.000 \xff\xfe broken\n").unwrap();
        let text = read_file_lossy(path.to_str().unwrap()).unwrap();
        assert!(text.starts_with("2024-01-01 10:00:00.000 "));
        assert!(text.contains('\u{fffd}')); // 非法字节 → U+FFFD
        let _ = std::fs::remove_file(&path);
    }
}
