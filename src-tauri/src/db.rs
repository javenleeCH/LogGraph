//! SQLite 数据驻留层（P3 一步到位方案，plans/perf-optimization-design.md）。
//!
//! 架构：日志全量数据（行文本/事件）驻留 SQLite（`.logGraph/cache.db`），
//! 前端只持轻量索引（lineTs Float64Array + sortedLines Uint32Array ≈ 12B/行）。
//! 过滤下推 Rust（FTS5 trigram 子串 / regex 扫描），只回传命中行号数组。
//!
//! 缓存指纹：目录内所有日志文件的 (相对路径, 大小, mtime) 集合。
//! 二次打开指纹一致 → 直接挂库（秒开）；否则重建（进度经 `db_build_progress` 事件）。
//!
//! message 语义：parse_rest 的结果是 rest 的连续子串（头部剥除 + 两端 trim），
//! 存「行内字节偏移 [msg_off, msg_end)」，匹配时对 line[msg_off..msg_end] 判定，
//! 与 JS event.message 完全等价。

use crate::parser::timestamp::{build_re, extract_timestamp, find_format};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// ---- 建库用正则缓存（OnceLock；复用 line.rs 模式串，避免每行 Regex::new）----
// 教训：parse_rest_offsets 初版直接调 build_re()（每次编译），700 万行 × 3 次
// = 2100 万次正则编译，建库耗时几分钟起 —— 必须缓存。

fn thread_head_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"^\[([^\]]+)\]\s*"))
}

fn bare_level_head_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"^([A-Z]+)\s+"))
}

fn bracket_level_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"(?:\[|\()([A-Za-z]+)(?:\]|\))\s*"))
}

/// 全局连接（命令短小，Mutex 串行足够）
fn db_conn() -> &'static Mutex<Option<Connection>> {
    static C: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

// ---- DTO ----

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbOpenResult {
    /// true=命中缓存直接挂载；false=本次重建
    pub cache_hit: bool,
    pub total_lines: u32,
    pub total_events: u32,
    pub skipped: u32,
    pub file_count: u32,
    pub timestamp_format_id: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbEventRow {
    /// 全局行号
    pub line: u32,
    pub ts: i64,
    pub thread: Option<String>,
    pub level: Option<String>,
    pub source_file: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbContextRow {
    pub no: u32,
    pub text: String,
    pub ts: Option<i64>,
    pub thread: Option<String>,
    pub level: Option<String>,
    pub source_file: Option<String>,
}

// ---- 工具 ----

fn is_log_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".log", ".txt", ".out", ".csv", ".tsv"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn walk_log_files(dir: &Path, prefix: &str, depth: u32, out: &mut Vec<String>) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
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
            walk_log_files(&path, &rel, depth + 1, out);
        } else if is_log_file_name(&name) {
            out.push(rel);
        }
    }
}

/// 单文件 (size, mtime_ms)
fn file_meta(path: &Path) -> Option<(u64, u64)> {
    let st = std::fs::metadata(path).ok()?;
    let mtime = st
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((st.len(), mtime))
}

/// 目录指纹：所有日志文件 (rel, size, mtime) 的 FNV-1a
fn dir_fingerprint(root: &Path, names: &[String]) -> String {
    let mut h: u64 = 1469598103934665603;
    for rel in names {
        let (size, mtime) = file_meta(&root.join(rel)).unwrap_or((0, 0));
        let part = format!("{rel}::{size}::{mtime}\n");
        for b in part.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(1099511628211);
        }
    }
    format!("{h:016x}")
}

fn read_file_lossy(path: &Path) -> Result<String, std::io::Error> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// js trim 字符集判断（对齐 line.rs）
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

// ---- schema ----

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  fid INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS lines (
  no INTEGER PRIMARY KEY,   -- 全局行号（rawLines 下标）
  fid INTEGER NOT NULL REFERENCES files(fid),
  text TEXT NOT NULL        -- 原始整行
);
CREATE TABLE IF NOT EXISTS events (
  line INTEGER PRIMARY KEY REFERENCES lines(no),
  ts INTEGER NOT NULL,
  msg_off INTEGER NOT NULL, -- message 行内字节偏移 [off, end)
  msg_end INTEGER NOT NULL,
  thread TEXT,
  level TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
  text, content='', tokenize="trigram"
);
"#;

// ---- db_open：指纹校验 / 重建 ----

#[tauri::command]
pub async fn db_open(app: tauri::AppHandle, dir: String) -> Result<DbOpenResult, String> {
    use tauri::Emitter;

    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&dir);
        if !root.is_dir() {
            return Err(format!("目录不存在: {dir}"));
        }
        let mut names: Vec<String> = Vec::new();
        walk_log_files(&root, "", 0, &mut names);
        names.sort();
        if names.is_empty() {
            return Err("该目录下没有可识别的日志文件（.log/.txt/.out/.csv/.tsv）".into());
        }
        let fp = dir_fingerprint(&root, &names);

        let cache_dir = root.join(".logGraph");
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("创建缓存目录失败: {e}"))?;
        let db_path = cache_dir.join("cache.db");

        // ---- 尝试命中已有缓存 ----
        if db_path.exists() {
            if let Ok(conn) = Connection::open(&db_path) {
                let ok: bool = conn
                    .query_row(
                        "SELECT value FROM meta WHERE key='fingerprint'",
                        [],
                        |r| r.get::<_, String>(0),
                    )
                    .map(|v| v == fp)
                    .unwrap_or(false);
                if ok {
                    let total_lines: u32 = conn
                        .query_row("SELECT COUNT(*) FROM lines", [], |r| r.get(0))
                        .unwrap_or(0);
                    let total_events: u32 = conn
                        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
                        .unwrap_or(0);
                    let skipped: u32 = conn
                        .query_row(
                            "SELECT value FROM meta WHERE key='skipped'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    let file_count: u32 = conn
                        .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
                        .unwrap_or(0);
                    let fmt: Option<String> = conn
                        .query_row(
                            "SELECT value FROM meta WHERE key='formatId'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .ok()
                        .filter(|s| !s.is_empty());
                    *db_conn().lock().map_err(|e| e.to_string())? = Some(conn);
                    return Ok(DbOpenResult {
                        cache_hit: true,
                        total_lines,
                        total_events,
                        skipped,
                        file_count,
                        timestamp_format_id: fmt,
                    });
                }
            }
        }

        // ---- 重建 ----
        for suffix in ["", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{}", db_path.display(), suffix));
            let _ = std::fs::remove_file(&p);
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开缓存库失败: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-262144;")
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("建表失败: {e}"))?;

        let total = names.len();
        let mut total_lines: u32 = 0;
        let mut skipped: u32 = 0;
        let mut fmt_id: Option<String> = None;

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut ins_file = tx
                .prepare("INSERT INTO files(fid, name) VALUES (?1, ?2)")
                .map_err(|e| e.to_string())?;
            let mut ins_line = tx
                .prepare("INSERT INTO lines(no, fid, text) VALUES (?1, ?2, ?3)")
                .map_err(|e| e.to_string())?;
            let mut ins_ev = tx
                .prepare("INSERT INTO events(line, ts, msg_off, msg_end, thread, level) VALUES (?1,?2,?3,?4,?5,?6)")
                .map_err(|e| e.to_string())?;
            let mut ins_fts = tx
                .prepare("INSERT INTO lines_fts(rowid, text) VALUES (?1, ?2)")
                .map_err(|e| e.to_string())?;

            for (i, rel) in names.iter().enumerate() {
                let text = match read_file_lossy(&root.join(rel)) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let _ = app.emit(
                    "db_build_progress",
                    serde_json::json!({ "loaded": i + 1, "total": total, "current": rel }),
                );

                let fid = (i + 1) as i64;
                ins_file.execute(params![fid, rel]).map_err(|e| e.to_string())?;

                // 格式探测：仅首个文件探测（与 JS 单文件路径一致的简化；
                // 多文件混合格式时 extract_timestamp(None) 已做逐行回退）
                if i == 0 {
                    // 探测样本：前 100 非空行
                    let sample: Vec<&str> = text
                        .split('\n')
                        .take(100)
                        .map(|l| l.strip_suffix('\r').unwrap_or(l))
                        .filter(|l| !js_trim(l).is_empty())
                        .collect();
                    fmt_id = crate::parser::timestamp::detect_timestamp_format(&sample)
                        .map(|f| f.id.to_string());
                }
                let fmt = fmt_id.as_deref().and_then(find_format);

                for raw in text.split('\n') {
                    let line = raw.strip_suffix('\r').unwrap_or(raw);
                    let no = total_lines as i64;
                    ins_line
                        .execute(params![no, fid, line])
                        .map_err(|e| e.to_string())?;
                    // FTS 只入非空行（省索引体积）
                    if !js_trim(line).is_empty() {
                        ins_fts
                            .execute(params![no, line])
                            .map_err(|e| e.to_string())?;
                    }

                    if js_trim(line).is_empty() {
                        skipped += 1;
                    } else if let Some(ext) = extract_timestamp(line, fmt) {
                        let rest = &line[ext.end..];
                        let (thread, level, msg_off, msg_end) =
                            parse_rest_offsets(rest, ext.end as u32);
                        ins_ev
                            .execute(params![
                                no,
                                ext.ts,
                                msg_off as i64,
                                msg_end as i64,
                                thread,
                                level
                            ])
                            .map_err(|e| e.to_string())?;
                    } else {
                        skipped += 1;
                    }
                    total_lines += 1;
                }
            }
        }
        let _ = tx.execute("INSERT INTO lines_fts(lines_fts) VALUES('optimize')", []);
        tx.commit().map_err(|e| e.to_string())?;

        // 元数据
        let total_events: u32 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let file_count = names.len() as u32;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('fingerprint', ?1)",
            params![fp],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('skipped', ?1)",
            params![skipped.to_string()],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('formatId', ?1)",
            params![fmt_id.clone().unwrap_or_default()],
        )
        .map_err(|e| e.to_string())?;

        *db_conn().lock().map_err(|e| e.to_string())? = Some(conn);

        Ok(DbOpenResult {
            cache_hit: false,
            total_lines,
            total_events,
            skipped,
            file_count,
            timestamp_format_id: fmt_id,
        })
    })
    .await
    .map_err(|e| format!("db_open 任务失败: {e}"))?
}

/// parse_rest 的偏移版本：返回 (thread, level, msg_off, msg_end)。
/// off/end 为整行内字节偏移；语义复刻 line.rs::parse_rest。
fn parse_rest_offsets(
    rest: &str,
    ts_end: u32,
) -> (Option<String>, Option<String>, u32, u32) {
    let mut msg = js_trim(rest);
    // rest 头部 trim 掉的字节数 → 整行偏移
    let head_trim = rest.len() - msg.len();
    let mut base = ts_end as usize + head_trim;

    let mut thread: Option<String> = None;
    let mut level: Option<String> = None;

    // 1. [Thread] 剥除
    if let Some(caps) = thread_head_re().captures(msg) {
        thread = Some(caps[1].to_string());
        let whole = caps.get(0).unwrap();
        let next = js_trim(&msg[whole.end()..]);
        base += whole.end() + (msg.len() - whole.end() - next.len());
        msg = next;
    }

    // 2. 裸写 level（∈ LEVELS，大小写敏感）
    let mut bare_used = false;
    if let Some(caps) = bare_level_head_re().captures(msg) {
        let word = caps.get(1).unwrap().as_str();
        if crate::parser::line::is_level_word(word) {
            level = Some(word.to_string());
            let whole = caps.get(0).unwrap();
            let next = js_trim(&msg[whole.end()..]);
            base += whole.end() + (msg.len() - whole.end() - next.len());
            msg = next;
            bare_used = true;
        }
    }

    // 3. 括号 level（最左，upper 校验）
    if !bare_used {
        if let Some(caps) = bracket_level_re().captures(msg) {
            let word = caps.get(1).unwrap().as_str();
            let upper = word.to_uppercase();
            if crate::parser::line::is_level_word(&upper) {
                level = Some(upper);
                let whole = caps.get(0).unwrap();
                let next = js_trim(&msg[whole.end()..]);
                base += whole.end() + (msg.len() - whole.end() - next.len());
                msg = next;
            }
        }
    }

    let msg_off = base as u32;
    let msg_end = base as u32 + msg.len() as u32;
    (thread, level, msg_off, msg_end)
}

// ---- 索引拉取（前端轻量索引，分块） ----

/// 行号按 ts 升序的事件行列表（事件流 = 前端 LogEvent[] 的骨架）。
/// 前端循环拉满 totalEvents 后组装：id=line, ts 由 db_events_ts 补齐。
#[tauri::command]
pub fn db_sorted_lines_chunk(offset: u32, max: u32) -> Result<Vec<u32>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let mut stmt = conn
        .prepare("SELECT line FROM events ORDER BY ts, line LIMIT ?1 OFFSET ?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![max as i64, offset as i64], |r| r.get::<_, u32>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 事件 ts 列表：与 db_sorted_lines_chunk 同序（ORDER BY ts, line），
/// 返回 (line, ts) 对，前端一次拿齐 id+ts（每块 ≤6 万条，~1MB 级）。
#[tauri::command]
pub fn db_event_index_chunk(
    offset: u32,
    max: u32,
) -> Result<Vec<(u32, i64)>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let mut stmt = conn
        .prepare("SELECT line, ts FROM events ORDER BY ts, line LIMIT ?1 OFFSET ?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![max as i64, offset as i64], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

// ---- 过滤下推 ----

/// 过滤参数（对齐前端 Filter 的匹配相关字段）
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterQuery {
    pub pattern: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    /// raw=整行匹配；message=时间戳后正文匹配
    pub scope: String,
}

/// 运行一个过滤器，返回命中的**全局行号**升序列表。
/// - 子串 + raw + 大小写敏感 + ≥3字符 → FTS5 trigram 倒排（毫秒级）
/// - 其余（regex / message scope / 不敏感 / 短子串）→ Rust 全表扫描（regex crate / contains）
/// 注意：此命令返回**全量命中**（不分页）——命中数通常远小于总行数；
/// 若命中数巨大（如空 pattern），调用方应避免（空 pattern 前端本来就不跑）。
#[tauri::command]
pub async fn db_filter(q: FilterQuery) -> Result<Vec<u32>, String> {
    let q = q.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = db_conn().lock().map_err(|e| e.to_string())?;
        let Some(conn) = guard.as_ref() else {
            return Err("cache.db 未打开".into());
        };

        // 快路径：FTS5 trigram（仅 大小写敏感 + raw + ≥3 字符）
        // （trigram 分词器大小写敏感；不敏感路径走扫描 + to_lowercase）
        if !q.is_regex && q.scope == "raw" && q.case_sensitive && q.pattern.chars().count() >= 3 {
            let phrase = format!("\"{}\"", q.pattern.replace('"', "\"\""));
            let mut stmt = conn
                .prepare("SELECT rowid FROM lines_fts WHERE lines_fts MATCH ?1 ORDER BY rowid")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![phrase], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows.flatten() {
                out.push(r as u32);
            }
            return Ok(out);
        }

        // 通用扫描路径
        let re = if q.is_regex {
            let flags = if q.case_sensitive { "" } else { "(?i)" };
            Some(
                regex::Regex::new(&format!("{flags}{}", q.pattern))
                    .map_err(|e| format!("非法正则: {e}"))?,
            )
        } else {
            None
        };
        let needle = if q.case_sensitive {
            q.pattern.clone()
        } else {
            q.pattern.to_lowercase()
        };

        let sql = if q.scope == "message" {
            "SELECT l.no, l.text, e.msg_off, e.msg_end FROM lines l JOIN events e ON e.line = l.no"
        } else {
            "SELECT l.no, l.text, 0, length(l.text) FROM lines l"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut hits: Vec<u32> = Vec::new();
        for r in rows.flatten() {
            let (no, text, off, end) = r;
            let hay: &str = if q.scope == "message" {
                text.get(off as usize..end as usize).unwrap_or("")
            } else {
                text.as_str()
            };
            let hit = if let Some(re) = &re {
                re.is_match(hay)
            } else if q.case_sensitive {
                hay.contains(&needle)
            } else {
                hay.to_lowercase().contains(&needle)
            };
            if hit {
                hits.push(no as u32);
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| format!("db_filter 任务失败: {e}"))?
}

// ---- 按需取数 ----

/// 视口事件：ts ∈ [start, end] 的所有事件（含 thread/level/sourceFile），按 ts 升序。
#[tauri::command]
pub fn db_events_in_window(start: i64, end: i64) -> Result<Vec<DbEventRow>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let mut stmt = conn
        .prepare(
            "SELECT e.line, e.ts, e.thread, e.level,
                    (SELECT f.name FROM files f JOIN lines l ON l.fid = f.fid WHERE l.no = e.line)
             FROM events e WHERE e.ts BETWEEN ?1 AND ?2 ORDER BY e.ts, e.line",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![start, end], |r| {
            Ok(DbEventRow {
                line: r.get(0)?,
                ts: r.get(1)?,
                thread: r.get(2)?,
                level: r.get(3)?,
                source_file: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 上下文行：全局行号 [from, to] 闭区间（DetailPanel 异步拉取），按行号升序。
#[tauri::command]
pub fn db_context_lines(from: u32, to: u32) -> Result<Vec<DbContextRow>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let mut stmt = conn
        .prepare(
            "SELECT l.no, l.text, e.ts, e.thread, e.level, f.name
             FROM lines l
             LEFT JOIN events e ON e.line = l.no
             LEFT JOIN files f ON f.fid = l.fid
             WHERE l.no BETWEEN ?1 AND ?2 ORDER BY l.no",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from as i64, to as i64], |r| {
            Ok(DbContextRow {
                no: r.get(0)?,
                text: r.get(1)?,
                ts: r.get(2)?,
                thread: r.get(3)?,
                level: r.get(4)?,
                source_file: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 单行文本（tooltip / 链步骤展示等按需取）
#[tauri::command]
pub fn db_line(no: u32) -> Result<String, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    conn.query_row("SELECT text FROM lines WHERE no = ?1", params![no as i64], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

/// 关闭（切换目录时）
#[tauri::command]
pub fn db_close() -> Result<(), String> {
    *db_conn().lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
