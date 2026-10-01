//! v2 数据层：rg 直扫 + 瘦 SQL（plans/v2-rg-sql-architecture.md）。
//!
//! 核心思想：**原始文件就是数据库**——搜索用 grep-searcher（rg 内核）直扫原文件，
//! 零预处理零冗余；SQL 只存衍生数据：
//! - `files`：文件清单 + 每文件首行全局行号（行号映射）
//! - `line_ts`：瘦 ts 索引（打开时一次性扫描，只抽时间戳，~16B/事件行）
//! - `filter_hits`：filter 命中结果（rg 扫描后写入，供 CEP/渲染 SQL 查询）
//!
//! 上下文/详情：按行号 mmap 直读原文件片段（不进 SQL）。
//! 缓存指纹：目录内日志文件 (rel, size, mtime) 的 FNV；schemaVersion=2 不符自动重建。

use crate::parser::timestamp::{extract_timestamp, find_format, detect_timestamp_format};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 全局连接
pub(crate) fn db_conn() -> &'static Mutex<Option<Connection>> {
    static C: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// 当前打开的目录（rg 扫描根）
fn db_root() -> &'static Mutex<Option<PathBuf>> {
    static D: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(None))
}

// ---- DTO ----

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbOpenResult {
    pub cache_hit: bool,
    pub total_lines: u32,
    pub total_events: u32,
    pub skipped: u32,
    pub file_count: u32,
    pub timestamp_format_id: Option<String>,
}

/// db_filter 命中条目（line + ts）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HitEntry {
    pub line: u32,
    pub ts: i64,
}

/// 上下文行（mmap 直读原文件 + line_ts 查 ts）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbContextRow {
    pub no: u32,
    pub text: String,
    pub ts: Option<i64>,
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

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

// ---- schema（v2 瘦表）----

const SCHEMA_VERSION: &str = "2";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  fid        INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,   -- 相对路径
  first_line INTEGER NOT NULL        -- 该文件首行的全局行号
);
CREATE TABLE IF NOT EXISTS line_ts ( -- 瘦 ts 索引（~16B/事件行）
  line INTEGER PRIMARY KEY,          -- 全局行号
  ts   INTEGER NOT NULL              -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_line_ts_ts ON line_ts(ts, line);
CREATE TABLE IF NOT EXISTS filter_hits (  -- filter 命中结果（rg 扫描后写入）
  filter_id TEXT NOT NULL,
  line      INTEGER NOT NULL,
  PRIMARY KEY (filter_id, line)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_hits_line ON filter_hits(line);
"#;

// ---- db_open：指纹校验 / ts 扫描 ----

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

        // ---- 尝试命中缓存（指纹 + schema 版本双校验）----
        if db_path.exists() {
            if let Ok(conn) = Connection::open(&db_path) {
                let ok: bool = conn
                    .query_row(
                        "SELECT value FROM meta WHERE key='fingerprint'",
                        [],
                        |r| r.get::<_, String>(0),
                    )
                    .map(|v| v == fp)
                    .unwrap_or(false)
                    && conn
                        .query_row(
                            "SELECT value FROM meta WHERE key='schemaVersion'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .map(|v| v == SCHEMA_VERSION)
                        .unwrap_or(false);
                if ok {
                    let total_events: u32 = conn
                        .query_row("SELECT COUNT(*) FROM line_ts", [], |r| r.get(0))
                        .unwrap_or(0);
                    let total_lines: u32 = (conn
                        .query_row(
                            "SELECT first_line FROM files ORDER BY fid DESC LIMIT 1",
                            [],
                            |r| r.get::<_, i64>(0),
                        )
                        .unwrap_or(0) as u32)
                        .saturating_add(
                            // 最后一个文件的行数未知 → 用 line_ts 最大行近似不安全；
                            // 总行数在扫描时写入 meta
                            0,
                        );
                    let total_lines: u32 = conn
                        .query_row(
                            "SELECT value FROM meta WHERE key='totalLines'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(total_lines);
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
                    *db_root().lock().map_err(|e| e.to_string())? = Some(root);
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

        // ---- ts 扫描（v2 建库：只抽时间戳，不剥 thread/level）----
        for suffix in ["", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{}", db_path.display(), suffix));
            let _ = std::fs::remove_file(&p);
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开缓存库失败: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-262144;",
        )
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
                .prepare("INSERT INTO files(fid, name, first_line) VALUES (?1, ?2, ?3)")
                .map_err(|e| e.to_string())?;
            let mut ins_ts = tx
                .prepare("INSERT OR IGNORE INTO line_ts(line, ts) VALUES (?1, ?2)")
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
                ins_file
                    .execute(params![fid, rel, total_lines as i64])
                    .map_err(|e| e.to_string())?;

                // 格式探测：仅首个文件（与 v1 一致的简化；探测失败逐行回退全格式）
                if i == 0 {
                    let sample: Vec<&str> = text
                        .split('\n')
                        .take(100)
                        .map(|l| l.strip_suffix('\r').unwrap_or(l))
                        .filter(|l| !js_trim(l).is_empty())
                        .collect();
                    fmt_id =
                        detect_timestamp_format(&sample).map(|f| f.id.to_string());
                }
                let fmt = fmt_id.as_deref().and_then(find_format);

                for raw in text.split('\n') {
                    let line = raw.strip_suffix('\r').unwrap_or(raw);
                    if js_trim(line).is_empty() {
                        skipped += 1;
                    } else if let Some(ext) = extract_timestamp(line, fmt) {
                        ins_ts
                            .execute(params![total_lines as i64, ext.ts])
                            .map_err(|e| e.to_string())?;
                    }
                    total_lines += 1;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        let total_events: u32 = conn
            .query_row("SELECT COUNT(*) FROM line_ts", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let file_count = names.len() as u32;
        // 元数据（指纹 + 版本 + 统计）
        for (k, v) in [
            ("fingerprint", fp.clone()),
            ("schemaVersion", SCHEMA_VERSION.to_string()),
            ("skipped", skipped.to_string()),
            ("totalLines", total_lines.to_string()),
            ("formatId", fmt_id.clone().unwrap_or_default()),
        ] {
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)",
                params![k, v],
            )
            .map_err(|e| e.to_string())?;
        }
        // WAL checkpoint（一次性批量写，归并清零 wal）
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

        *db_conn().lock().map_err(|e| e.to_string())? = Some(conn);
        *db_root().lock().map_err(|e| e.to_string())? = Some(root);

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

// ---- 文件布局查询（行号映射，rg 扫描与上下文读取共用）----

/// files 表快照：(fid, name, first_line)，first_line 升序
fn files_snapshot(conn: &Connection) -> Result<Vec<(i64, String, u32)>, String> {
    let mut stmt = conn
        .prepare("SELECT fid, name, first_line FROM files ORDER BY first_line")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as u32))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 全局行号 → (文件路径, 文件内行号)。files_snapshot 已按 first_line 升序，二分定位。
pub(crate) fn locate_line(
    conn: &Connection,
    root: &Path,
    global_line: u32,
) -> Result<(PathBuf, u32), String> {
    let files = files_snapshot(conn)?;
    if files.is_empty() {
        return Err("files 表为空".into());
    }
    // 二分：找最后一个 first_line <= global_line 的文件
    let mut lo = 0usize;
    let mut hi = files.len();
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if files[mid].2 <= global_line {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (_fid, name, first_line) = &files[lo];
    if global_line < *first_line {
        return Err(format!(
            "行号 {global_line} 越界（首个文件起始 {first_line}）"
        ));
    }
    // 该文件行数上限 = 下一文件 first_line（或无界）
    if let Some((_, _, next_first)) = files.get(lo + 1) {
        if global_line >= *next_first {
            return Err(format!("行号 {global_line} 落在文件间隙"));
        }
    }
    Ok((root.join(name), global_line - first_line))
}

// ---- 过滤：rg 直扫 + filter_hits 写入 ----

/// 过滤参数（对齐前端 Filter 匹配字段）
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterQuery {
    pub filter_id: String,
    pub pattern: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    /// raw=整行；message=时间戳后正文（首版：命中后按行首时间戳偏移二次校验）
    pub scope: String,
}

/// 运行一个过滤器：rg 引擎直扫原文件 → 命中全局行号 → 写 filter_hits →
/// JOIN line_ts 返回 (line, ts)[]（按 ts 升序）。
/// filter 编辑 = 同 filter_id 覆盖重写（事务内 DELETE+INSERT）。
#[tauri::command]
pub async fn db_filter(q: FilterQuery) -> Result<Vec<HitEntry>, String> {
    let q = q.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = db_conn().lock().map_err(|e| e.to_string())?;
        let Some(conn) = guard.as_ref() else {
            return Err("cache.db 未打开".into());
        };
        let root_guard = db_root().lock().map_err(|e| e.to_string())?;
        let Some(root) = root_guard.as_ref() else {
            return Err("cache.db 未打开".into());
        };

        // 1) rg 引擎扫描（raw scope 直接用；message scope = 整行扫描的超集 +
        //    逐行按「时间戳后正文」二次校验）
        let mut hits = crate::raw_search::search_dir(
            root,
            conn,
            &q.pattern,
            q.is_regex,
            q.case_sensitive,
        )?;
        if q.scope == "message" {
            // 行首时间戳之后的部分才是 message 域：对每个候选行重读并校验。
            // 命中数通常远小于总行数，逐行读取代价可接受。
            let mut kept: Vec<u32> = Vec::with_capacity(hits.len());
            for line in &hits {
                let Ok((path, local)) = locate_line(conn, root, *line) else {
                    continue;
                };
                let Ok(text) = read_file_lossy(&path) else {
                    continue;
                };
                let Some(raw_line) = text.split('\n').nth(local as usize) else {
                    continue;
                };
                let line_str = raw_line.strip_suffix('\r').unwrap_or(raw_line);
                // 时间戳提取失败（无 ts 行）→ message 域为空 → 不可能命中
                if let Some(ext) = extract_timestamp(line_str, None) {
                    let msg = js_trim(&line_str[ext.end..]);
                    let hit = if q.is_regex {
                        let flags = if q.case_sensitive { "" } else { "(?i)" };
                        regex::Regex::new(&format!("{flags}{}", q.pattern))
                            .map(|re| re.is_match(msg))
                            .unwrap_or(false)
                    } else if q.case_sensitive {
                        msg.contains(q.pattern.as_str())
                    } else {
                        msg.to_lowercase().contains(&q.pattern.to_lowercase())
                    };
                    if hit {
                        kept.push(*line);
                    }
                }
            }
            hits = kept;
        }

        // 2) 写 filter_hits（事务覆盖）
        conn.execute_batch("BEGIN")
            .map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM filter_hits WHERE filter_id = ?1",
            params![q.filter_id],
        );
        {
            let mut ins = conn
                .prepare("INSERT OR IGNORE INTO filter_hits(filter_id, line) VALUES (?1, ?2)")
                .map_err(|e| e.to_string())?;
            for h in &hits {
                ins.execute(params![q.filter_id, *h as i64])
                    .map_err(|e| e.to_string())?;
            }
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

        // 3) JOIN line_ts → (line, ts) 按 ts 升序（filter_hits 有 line 主键索引，走 idx）
        let mut stmt = conn
            .prepare(
                "SELECT h.line, t.ts FROM filter_hits h
                 JOIN line_ts t ON t.line = h.line
                 WHERE h.filter_id = ?1
                 ORDER BY t.ts, h.line",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![q.filter_id], |r| {
                Ok(HitEntry {
                    line: r.get(0)?,
                    ts: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows.flatten() {
            out.push(r);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("db_filter 任务失败: {e}"))?
}

/// 删除一个 filter 的命中（filter 被删时调用）
#[tauri::command]
pub fn db_filter_drop(filter_id: String) -> Result<(), String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(()); // 未打开视为无操作
    };
    conn.execute(
        "DELETE FROM filter_hits WHERE filter_id = ?1",
        params![filter_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 按需取数（mmap/直读原文件）----

/// 上下文行：全局行号 [from, to] 闭区间。逐文件读取片段（不跨文件合并，
/// 前端按行号排序展示）。返回按行号升序。
#[tauri::command]
pub fn db_context_lines(from: u32, to: u32) -> Result<Vec<DbContextRow>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let root_guard = db_root().lock().map_err(|e| e.to_string())?;
    let Some(root) = root_guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    if to < from {
        return Ok(Vec::new());
    }

    let files = files_snapshot(conn)?;
    // ts 查询：区间行号 → ts（一次查齐）
    let mut ts_stmt = conn
        .prepare("SELECT line, ts FROM line_ts WHERE line BETWEEN ?1 AND ?2")
        .map_err(|e| e.to_string())?;
    let ts_map: std::collections::HashMap<u32, i64> = ts_stmt
        .query_map(params![from as i64, to as i64], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    let mut out: Vec<DbContextRow> = Vec::new();
    for (_fid, name, first_line) in &files {
        // 该文件与 [from, to] 的交集
        let file_end = files
            .iter()
            .filter(|(_, _, fl)| *fl > *first_line)
            .map(|(_, _, fl)| *fl)
            .min()
            .unwrap_or(u32::MAX);
        let lo = from.max(*first_line);
        let hi = to.min(file_end.saturating_sub(1));
        if lo > hi {
            continue;
        }
        let Ok(text) = read_file_lossy(&root.join(name)) else {
            continue;
        };
        // 只遍历该文件相关行（split 惰性 + 行计数）
        for (local, raw) in text.split('\n').enumerate() {
            let global = first_line + local as u32;
            if global < lo {
                continue;
            }
            if global > hi {
                break;
            }
            let line = raw.strip_suffix('\r').unwrap_or(raw);
            out.push(DbContextRow {
                no: global,
                text: line.to_string(),
                ts: ts_map.get(&global).copied(),
            });
        }
    }
    out.sort_by_key(|r| r.no);
    Ok(out)
}

/// 单行文本（tooltip 等）
#[tauri::command]
pub fn db_line(no: u32) -> Result<String, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let root_guard = db_root().lock().map_err(|e| e.to_string())?;
    let Some(root) = root_guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let (path, local) = locate_line(conn, root, no)?;
    let text = read_file_lossy(&path).map_err(|e| e.to_string())?;
    text.split('\n')
        .nth(local as usize)
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .ok_or_else(|| format!("行号越界: {no}"))
}

/// 视口事件（ts 窗口内全部事件行，含该行是否有某 filter 命中标记可选）：
/// 时间线骨架渲染用——直接查 line_ts（不需要 filter）。
#[tauri::command]
pub fn db_events_in_window(start: i64, end: i64) -> Result<Vec<HitEntry>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    let mut stmt = conn
        .prepare("SELECT line, ts FROM line_ts WHERE ts BETWEEN ?1 AND ?2 ORDER BY ts, line")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![start, end], |r| {
            Ok(HitEntry {
                line: r.get(0)?,
                ts: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 事件索引分块（键集分页，复合索引免排序）：返回 (line, ts)，按 (ts, line) 升序。
/// after_ts 为 None 表示「无下界」（首块）；非首块传上一块最后一条的 (ts, line)。
#[tauri::command]
pub fn db_event_index_chunk(
    after_ts: Option<i64>,
    after_line: u32,
    max: u32,
) -> Result<Vec<(u32, i64)>, String> {
    let guard = db_conn().lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Err("cache.db 未打开".into());
    };
    // after_ts IS NULL → 首块无下界；否则键集分页 (ts, line) 游标
    let mut stmt = conn
        .prepare(
            "SELECT line, ts FROM line_ts
             WHERE (?1 IS NULL OR ts > ?1 OR (ts = ?1 AND line > ?2))
             ORDER BY ts, line LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![after_ts, after_line as i64, max as i64], |r| {
            Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 关闭（切换目录时）
#[tauri::command]
pub fn db_close() -> Result<(), String> {
    *db_conn().lock().map_err(|e| e.to_string())? = None;
    *db_root().lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
