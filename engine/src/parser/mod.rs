//! 日志解析：时间戳格式探测与提取（5 种格式，语义对齐前端 timestampFormats.ts）
//! + 行后段解析（thread/level/message）+ 全文件/全目录解析流水线。
//! 纯函数、零数据库依赖。
//!
//! v1.2 自 src-tauri 壳层下沉：解析是业务语义，壳层（Tauri/CLI）只做转发与传输。

pub mod line;
pub mod timestamp;

pub use line::{detect_log_family, js_trim, parse_rest, parse_rest_fam, LogFamily, RestParsed};
pub use timestamp::{
    detect_timestamp_format, extract_timestamp, find_format, formats, TsFormat,
};

use serde::Serialize;
use std::path::Path;

/// 单条日志事件（对齐 TS LogEvent；serde camelCase 序列化，None 字段缺省键）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    /// 行索引（排序前赋值的原始行号，多文件合并由调用方重编）
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
    /// 单文件解析恒 None；多文件合并由解析流水线赋值
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
}

/// 解析结果（= JS ParseResult + rawLines）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub events: Vec<LogEvent>,
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

/// 核心解析流程（纯函数，对齐 LogParser.parse）。
pub fn parse_text_full(text: &str, forced: Option<&TsFormat>) -> ParseResult {
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

    let mut events: Vec<LogEvent> = Vec::new();
    let mut skipped: u32 = 0;

    // 探测日志布局族（基于样本后段），用于 thread 的家族感知提取（见 line.rs；契约 §3.13）
    let family = {
        let mut rests: Vec<String> = Vec::new();
        for l in lines.iter().take(200) {
            if js_trim(l).is_empty() {
                continue;
            }
            if let Some(e) = extract_timestamp(l, format) {
                rests.push(l[e.end..].to_string());
            }
        }
        let refs: Vec<&str> = rests.iter().map(|s| s.as_str()).collect();
        detect_log_family(&refs)
    };

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
        let parsed = parse_rest_fam(rest, family);
        events.push(LogEvent {
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

    ParseResult {
        events,
        raw_lines: lines.into_iter().map(|l| l.to_string()).collect(),
        timestamp_format_id: format.map(|f| f.id.to_string()),
        skipped,
        total_lines,
    }
}

/// 增量解析辅助：在 `[from_byte, end)` 的字节切片 `buf` 中定位「完整新行段」的
/// 消费长度。
///
/// 调用方保证 `from_byte` 总是位于某个已消费 `\n` **之后**，因此 `buf[0]` 必是一条
/// 新行的起点（不存在行首残段）。唯一可能不完整的是 **buf 尾部**正在写入、尚未落
/// 换行符的那一行。
///
/// 返回 `Some(end)`：`end` 为最后一个 `\n` 的位置 +1（含该换行），`buf[..end]` 即本次
/// 可安全解析的完整行段；其后的残行留给下次轮询。`None` 表示区间内没有任何完整新行
/// （只有未换行的残行），调用方不前进偏移，等换行符落盘后下个轮询再读。
///
/// 纯函数、无 IO，便于单元自测；文件读字节与偏移运算在 Tauri 壳层完成。
pub fn find_complete_segment(buf: &[u8]) -> Option<usize> {
    let last_nl = buf.iter().rposition(|&b| b == b'\n')?;
    Some(last_nl + 1)
}

/// 读文件并做 lossy UTF-8 解码（非法字节 → U+FFFD，与浏览器 TextDecoder 默认行为一致）。
pub fn read_file_lossy(path: &Path) -> Result<String, std::io::Error> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---- 日志集发现（目录工作区规则） ----

/// 判断文件名是否为可识别的日志文件（对齐前端 isLogFileName 宽松匹配）
pub fn is_log_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".log", ".txt", ".out", ".csv", ".tsv"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 递归枚举目录下日志文件（相对路径，'/' 分隔）。
/// `.logGraph` 是应用工作区目录（filters.json / perf 日志），绝不当作日志源索引：
/// 其中的残留文件会参与格式探测，一旦格式不符会让整个目录的时间戳解析失效。
pub fn walk_log_files(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<String>) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 无权限/不存在 → 跳过（前端行为一致）
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            if name == ".logGraph" {
                continue;
            }
            walk_log_files(&path, &rel, depth + 1, out);
        } else if is_log_file_name(&name) {
            out.push(rel);
        }
    }
}

// ---- 目录批量解析 ----

/// 目录解析元数据（不含大数据体；大数据体由调用方分块取用）
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirMeta {
    pub total_events: u32,
    pub total_lines: u32,
    pub skipped: u32,
    pub file_count: u32,
    /// 目录中读取失败被跳过（权限/二进制/编码异常）的文件数；漏报也应可观测
    pub file_errors: u32,
    /// 全部文件探测格式一致才透出，否则 None
    pub timestamp_format_id: Option<String>,
    pub file_names: Vec<String>,
}

/// 目录批量解析产物：meta + 事件/原始行数据体
#[derive(Debug, Clone)]
pub struct DirParseResult {
    pub meta: DirMeta,
    pub events: Vec<LogEvent>,
    pub raw_lines: Vec<String>,
}

/// 批量解析目录：枚举 + 逐文件解析 + 全局 id 重编 + sourceFile 赋值
/// + 全局按 ts 稳定排序。emit(loaded, total, current) 报告逐文件进度。
pub fn parse_dir_files(
    root: &Path,
    mut emit: impl FnMut(usize, usize, &str),
) -> crate::error::EngineResult<DirParseResult> {
    if !root.is_dir() {
        return Err(crate::error::EngineError::Usage {
            message: format!("目录不存在: {}", root.display()),
        });
    }
    let mut names: Vec<String> = Vec::new();
    walk_log_files(root, "", 0, &mut names);
    names.sort();
    if names.is_empty() {
        return Err(crate::error::EngineError::Usage {
            message: "该目录下没有可识别的日志文件（.log/.txt/.out/.csv/.tsv）".into(),
        });
    }
    let total = names.len();

    let mut all_events: Vec<LogEvent> = Vec::new();
    let mut all_raw_lines: Vec<String> = Vec::new();
    let mut total_lines: u32 = 0;
    let mut skipped: u32 = 0;
    let mut format_ids: Vec<Option<String>> = Vec::new();
    let mut file_names: Vec<String> = Vec::new();
    let mut file_errors: u32 = 0;

    for (i, rel) in names.iter().enumerate() {
        let full = root.join(rel);
        let text = match read_file_lossy(&full) {
            Ok(t) => t,
            Err(_) => {
                file_errors += 1; // 读取失败：计数而非静默丢弃（漏报也应可观测）
                continue;
            }
        };
        let parsed = parse_text_full(&text, None);
        emit(i + 1, total, rel);
        file_names.push(rel.clone());
        format_ids.push(parsed.timestamp_format_id.clone());
        total_lines = total_lines.saturating_add(parsed.total_lines);
        skipped = skipped.saturating_add(parsed.skipped);

        // 全局 id 重编（baseId = 已累计行数）+ sourceFile 赋值
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
    let timestamp_format_id = if !format_ids.is_empty() && format_ids.windows(2).all(|w| w[0] == w[1])
    {
        format_ids[0].clone()
    } else {
        None
    };

    let total_events = all_events.len() as u32;
    Ok(DirParseResult {
        meta: DirMeta {
            total_events,
            total_lines,
            skipped,
            file_count: file_names.len() as u32,
            file_errors,
            timestamp_format_id,
            file_names,
        },
        events: all_events,
        raw_lines: all_raw_lines,
    })
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
        // 尾换行 → split 3 段（末尾空行）；空行与无时间戳行均计入 skipped（JS split 同，
        // 与 split_lines_matrix / detect_fallback_100_limit 的尾空行语义一致）
        let text = "12:00:00.000 ok\nplain line without timestamp\n";
        let r = parse_text_full(text, None);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.skipped, 2);
        assert_eq!(r.total_lines, 3);
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
    fn find_complete_segment_boundaries() {
        // buf 起点必为行首（调用方保证 from_byte 在已消费 \n 之后）：
        // A/B 完整，C 为写入中残行 → 只消费到最后一个 \n，取 "A\nB\n"
        let buf = b"A\nB\nC";
        assert_eq!(find_complete_segment(buf), Some(4));
        assert_eq!(&buf[..4], b"A\nB\n");

        // 尾换行：单行 A 带换行 → 取 "A\n"
        let buf2 = b"A\n";
        assert_eq!(find_complete_segment(buf2), Some(2));
        assert_eq!(&buf2[..2], b"A\n");

        // 仅残行（无尾部换行）→ 完整新行尚未落盘 → None（不前进偏移，下次重试）
        let buf3 = b"A";
        assert_eq!(find_complete_segment(buf3), None);

        // 完全无换行 → None
        let buf4 = b"no newline at all";
        assert_eq!(find_complete_segment(buf4), None);

        // 整段即完整 → 取全部
        let buf5 = b"A\nB\n";
        assert_eq!(find_complete_segment(buf5), Some(4));
        assert_eq!(&buf5[..4], b"A\nB\n");

        // CRLF：\r\n 中换行符是 \n，段边界落在 \n 后（\r 留在段内，split_lines 会剥）
        let buf6 = b"A\r\nB";
        assert_eq!(find_complete_segment(buf6), Some(3));
        assert_eq!(&buf6[..3], b"A\r\n");
    }

    #[test]
    fn read_file_lossy_replaces_invalid_utf8() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("loggraph_engine_test_{}.log", std::process::id()));
        std::fs::write(&path, b"2024-01-01 10:00:00.000 \xff\xfe broken\n").unwrap();
        let text = read_file_lossy(&path).unwrap();
        assert!(text.starts_with("2024-01-01 10:00:00.000 "));
        assert!(text.contains('\u{fffd}')); // 非法字节 → U+FFFD
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn walk_log_files_excludes_loggraph_workspace() {
        let dir = std::env::temp_dir().join(format!(
            "loggraph-engine-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join(".logGraph")).unwrap();
        std::fs::write(dir.join("a.log"), "x\n").unwrap();
        std::fs::write(dir.join(".logGraph").join("perf.log"), "junk\n").unwrap();
        let mut names = Vec::new();
        walk_log_files(&dir, "", 0, &mut names);
        names.sort();
        assert_eq!(names, vec!["a.log".to_string()]); // .logGraph 工作区被排除
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parse_dir_files_merges_and_resorts() {
        let dir = std::env::temp_dir().join(format!(
            "loggraph-engine-pdir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.log"), "2024-01-01 10:00:02.000 late\n").unwrap();
        std::fs::write(dir.join("b.log"), "2024-01-01 10:00:01.000 early\n").unwrap();
        let r = parse_dir_files(&dir, |_, _, _| {}).unwrap();
        assert_eq!(r.meta.file_count, 2);
        assert_eq!(r.meta.file_errors, 0); // 两个文件均可读
        assert_eq!(r.meta.total_events, 2);
        assert_eq!(r.events[0].message, "early"); // 全局按 ts 排序
        assert_eq!(r.events[0].source_file.as_deref(), Some("b.log"));
        // 全局行号重编：a.log 行 0，b.log 行 2（a 尾空段占 1 行）
        assert_eq!(r.events[0].id, 2);
        assert_eq!(r.raw_lines[2], "2024-01-01 10:00:01.000 early");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
