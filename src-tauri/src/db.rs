//! v2 数据层：rg 直扫 + 瘦 SQL（plans/v2-rg-sql-architecture.md）。
//!
//! 核心思想：**原始文件就是数据库**——搜索用 grep-searcher（rg 内核）直扫原文件，
//! 零预处理零冗余；SQL 只存衍生数据：
//! - `files`：文件清单 + 每文件首行全局行号 + 每行字节偏移（seek 直读用）
//! - `line_ts`：瘦 ts 索引（打开时一次性扫描，只抽时间戳，~16B/事件行）
//! - `filter_hits`：filter 命中结果（rg 扫描后写入，供 CEP/渲染 SQL 查询）
//!
//! 上下文/详情：按行偏移 seek 直读原文件片段（不进 SQL，不整文件重读）。
//! 索引/视口行文本走 `tauri::ipc::Response` 二进制通道（SoA，前端零对象解析）。
//! 缓存指纹：目录内日志文件 (rel, size, mtime) 的 FNV；schemaVersion=3 不符自动重建。

use crate::parser::timestamp::{extract_timestamp, find_format, detect_timestamp_format};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// cache.db 路径（打开目录后设置）。每命令独立开连接：WAL 支持并发读，
/// 慢查询（如 db_corr_ids 的窗口扫描）不再持全局锁阻塞其它命令——
/// v3 之前全局单连接 Mutex，corr 查询持锁期间 db_lines_by_ids /
/// db_context_lines / db_line 全部排队，表现为视口/详情/原始行「没反应」。
static DB_CACHE_PATH: LazyLock<Mutex<Option<PathBuf>>> =
    LazyLock::new(|| Mutex::new(None));

/// 当前打开的目录（rg 扫描根）
static DB_ROOT: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn db_cache_path() -> &'static Mutex<Option<PathBuf>> {
    &DB_CACHE_PATH
}

fn db_root() -> &'static Mutex<Option<PathBuf>> {
    &DB_ROOT
}

/// 打开一个独立 cache.db 连接。
/// journal_mode=WAL 是库级持久属性（建库时设置），新连接自动继承；
/// 写命令之间靠 busy_timeout 串行等待，读写互不阻塞（WAL snapshot）。
pub(crate) fn open_cache() -> Result<Connection, String> {
    let Some(path) = db_cache_path().lock().map_err(|e| e.to_string())?.clone() else {
        return Err("cache.db 未打开".into());
    };
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA cache_size=-65536; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn cache_root() -> Result<PathBuf, String> {
    db_root()
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "cache.db 未打开".into())
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


// ---- 行偏移 seek 读取（schema v3）----

/// files.line_offsets BLOB → u64 数组
fn decode_line_offsets(blob: &[u8]) -> Result<Vec<u64>, String> {
    if blob.len() % 8 != 0 {
        return Err("line_offsets 长度非法（非 8 字节对齐）".into());
    }
    Ok(blob
        .chunks_exact(8)
        .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
        .collect())
}

/// 按行偏移 seek 读取一个文件 [lo, hi] 闭区间的行（不整文件重读）。
/// 返回行文本列表（已去 \r\n），下标 0 = 第 lo 行。
fn read_line_range(path: &Path, offsets: &[u64], lo: u32, hi: u32) -> Result<Vec<String>, String> {
    let (lo, hi) = (lo as usize, hi as usize);
    if lo > hi || hi >= offsets.len() {
        return Err(format!("行号越界: {lo}..={hi}（文件共 {} 行）", offsets.len()));
    }
    let start = offsets[lo];
    let end = if hi + 1 < offsets.len() {
        offsets[hi + 1]
    } else {
        std::fs::metadata(path).map_err(|e| e.to_string())?.len()
    };
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    // 块边界都落在行首（\n 单字节）→ UTF-8 安全；lossy 与整文件读语义一致
    let text = String::from_utf8_lossy(&buf);
    let mut out: Vec<String> = text
        .split('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s).to_string())
        .collect();
    // 块以 \n 结尾时 split 会多出一个尾空段 → 裁到目标行数
    out.truncate(hi - lo + 1);
    Ok(out)
}

/// 升序行号 → 读取段列表：相邻行号 gap<=max_gap 合并为一段（减少 seek 次数）。
/// 段读取会带出 gap 内的行（调用方只挑需要的，多余行无害）。
fn merge_line_segments(sorted: &[u32], max_gap: u32) -> Vec<(u32, u32)> {
    let mut segs: Vec<(u32, u32)> = Vec::new();
    for &n in sorted {
        match segs.last_mut() {
            Some((_, hi)) if n <= *hi + max_gap => *hi = (*hi).max(n),
            _ => segs.push((n, n)),
        }
    }
    segs
}

// ---- schema（v3 瘦表：files 增加 line_offsets 行偏移 BLOB）----

const SCHEMA_VERSION: &str = "3";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  fid          INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- 相对路径
  first_line   INTEGER NOT NULL,       -- 该文件首行的全局行号
  line_offsets BLOB                    -- 每行起始字节偏移（u64 LE 数组）；行 i 字节区间 = [off[i], off[i+1] 或文件尾)
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
                    // meta 缓存优先（免 COUNT(*) 全索引扫描）；缺省兜底 COUNT
                    let total_events: u32 = conn
                        .query_row(
                            "SELECT value FROM meta WHERE key='totalEvents'",
                            [],
                            |r| r.get::<_, String>(0),
                        )
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or_else(|| {
                            conn.query_row("SELECT COUNT(*) FROM line_ts", [], |r| r.get(0))
                                .unwrap_or(0)
                        });
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
                    *db_cache_path().lock().map_err(|e| e.to_string())? = Some(db_path.clone());
                    *db_root().lock().map_err(|e| e.to_string())? = Some(root);
                    drop(conn); // 连接不驻留：后续命令各自独立开连接（WAL 并发读）
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

        // ---- ts 扫描（v3 建库：只抽时间戳 + 记录每行字节偏移，不剥 thread/level）----
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
                .prepare("INSERT INTO files(fid, name, first_line, line_offsets) VALUES (?1, ?2, ?3, ?4)")
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
                let first_line = total_lines;

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

                // 单趟行扫描：抽时间戳 + 记录每行起始字节偏移（与 split('\n') 分段语义一致，
                // 尾部换行会产生一个末尾空行段）
                let mut offsets: Vec<u8> = Vec::with_capacity(64 + text.len() / 16 * 8);
                let bytes = text.as_bytes();
                let mut pos = 0usize;
                loop {
                    let start = pos;
                    let end = match bytes[pos..].iter().position(|&b| b == b'\n') {
                        Some(k) => pos + k,
                        None => bytes.len(),
                    };
                    offsets.extend_from_slice(&(start as u64).to_le_bytes());
                    let line_no = first_line + (offsets.len() as u32 / 8 - 1);
                    let line = text[start..end].strip_suffix('\r').unwrap_or(&text[start..end]);
                    if js_trim(line).is_empty() {
                        skipped += 1;
                    } else if let Some(ext) = extract_timestamp(line, fmt) {
                        ins_ts
                            .execute(params![line_no as i64, ext.ts])
                            .map_err(|e| e.to_string())?;
                    }
                    if end == bytes.len() {
                        break;
                    }
                    pos = end + 1;
                }
                ins_file
                    .execute(params![fid, rel, first_line as i64, offsets])
                    .map_err(|e| e.to_string())?;
                total_lines += (offsets.len() / 8) as u32;
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
            ("totalEvents", total_events.to_string()),
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

        *db_cache_path().lock().map_err(|e| e.to_string())? = Some(db_path.clone());
        *db_root().lock().map_err(|e| e.to_string())? = Some(root);
        drop(conn); // 已 WAL checkpoint；连接不驻留，后续命令独立开连接

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

/// 全局行号 → (fid, 文件路径, 文件内行号)。files_snapshot 已按 first_line 升序，二分定位。
pub(crate) fn locate_line(
    conn: &Connection,
    root: &Path,
    global_line: u32,
) -> Result<(i64, PathBuf, u32), String> {
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
    let (fid, name, first_line) = &files[lo];
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
    Ok((*fid, root.join(name), global_line - first_line))
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

/// message scope 二次校验：行首时间戳之后的部分才是 message 域。
/// 候选行号排序去重后按文件分组（files 按 first_line 升序 → 双指针推进），
/// 每文件只整读一次、行游标单调前进——O(总字节) 替代旧版
/// O(hits × 文件大小) 的逐行整文件重读。正则只编译一次（旧版每 hit 编译一次）。
fn message_scope_filter(
    hits: &[u32],
    conn: &Connection,
    root: &Path,
    q: &FilterQuery,
) -> Result<Vec<u32>, String> {
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let files = files_snapshot(conn)?;
    let mut sorted = hits.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    enum Matcher {
        Re(regex::Regex),
        Literal,
        Never,
    }
    let matcher = if q.is_regex {
        let flags = if q.case_sensitive { "" } else { "(?i)" };
        match regex::Regex::new(&format!("{flags}{}", q.pattern)) {
            Ok(re) => Matcher::Re(re),
            // 与旧版一致：正则编译失败 → 永不命中（不能回落到字面量）
            Err(_) => Matcher::Never,
        }
    } else {
        Matcher::Literal
    };
    let needle = if q.case_sensitive {
        q.pattern.clone()
    } else {
        q.pattern.to_lowercase()
    };

    let mut kept: Vec<u32> = Vec::with_capacity(sorted.len());
    let mut i = 0usize;
    let mut fi = 0usize; // 当前文件索引（files 与 sorted 均升序 → 双指针）
    while i < sorted.len() {
        let line = sorted[i];
        while fi + 1 < files.len() && files[fi + 1].2 <= line {
            fi += 1;
        }
        let (_fid, name, first_line) = &files[fi];
        let file_limit = files.get(fi + 1).map(|f| f.2).unwrap_or(u32::MAX);
        // 该文件内的连续候选段 [i, j)
        let mut j = i;
        while j < sorted.len() && sorted[j] < file_limit {
            j += 1;
        }
        if line < *first_line {
            // 落在文件间隙（防御，正常不会发生）
            i = j;
            continue;
        }
        let text = match read_file_lossy(&root.join(name)) {
            Ok(t) => t,
            Err(_) => {
                // 读失败：该文件候选全部丢弃（与旧版逐行 continue 等价）
                i = j;
                continue;
            }
        };
        // 单趟：目标行（文件内行号）升序，游标单调前进
        let mut ti = i;
        for (local, raw) in text.split('\n').enumerate() {
            if ti >= j {
                break;
            }
            let want = (sorted[ti] - first_line) as usize;
            if local < want {
                continue;
            }
            if local > want {
                break; // 文件行数不足（文件已变化）→ 剩余候选丢弃
            }
            let line_str = raw.strip_suffix('\r').unwrap_or(raw);
            // 时间戳提取失败（无 ts 行）→ message 域为空 → 不可能命中
            if let Some(ext) = extract_timestamp(line_str, None) {
                let msg = js_trim(&line_str[ext.end..]);
                let hit = match &matcher {
                    Matcher::Re(re) => re.is_match(msg),
                    Matcher::Literal if q.case_sensitive => {
                        msg.contains(q.pattern.as_str())
                    }
                    Matcher::Literal => msg.to_lowercase().contains(&needle),
                    Matcher::Never => false,
                };
                if hit {
                    kept.push(sorted[ti]);
                }
            }
            ti += 1;
        }
        i = j;
    }
    Ok(kept)
}

/// 运行一个过滤器：rg 引擎直扫原文件 → 命中全局行号 → 写 filter_hits →
/// JOIN line_ts 返回 (line, ts)[]（按 ts 升序）。
/// filter 编辑 = 同 filter_id 覆盖重写（事务内 DELETE+INSERT）。
#[tauri::command]
pub async fn db_filter(q: FilterQuery) -> Result<Vec<HitEntry>, String> {
    let q = q.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_cache()?;
        let root = cache_root()?;

        // 1) rg 引擎扫描（raw scope 直接用；message scope = 整行扫描的超集 + 二次校验）
        let mut hits = crate::raw_search::search_dir(
            &root,
            &conn,
            &q.pattern,
            q.is_regex,
            q.case_sensitive,
        )?;
        if q.scope == "message" {
            hits = message_scope_filter(&hits, &conn, &root, &q)?;
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

/// 删除一个 filter 的命中（filter 被删时调用；命中可达百万行 → 阻塞线程池）
#[tauri::command]
pub async fn db_filter_drop(filter_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = db_cache_path().lock().map_err(|e| e.to_string())?.clone() else {
            return Ok(()); // 未打开视为无操作
        };
        // 写命令也要 busy_timeout：与 db_filter 的 filter_hits 写事务并发时
        // 等待而非立即 SQLITE_BUSY
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA busy_timeout=5000;")
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM filter_hits WHERE filter_id = ?1",
            params![filter_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("db_filter_drop 任务失败: {e}"))?
}

/// 读取一个文件的行偏移数组（schema v3 必有；缺失/损坏返回 Err）
fn load_line_offsets(conn: &Connection, fid: i64) -> Result<Vec<u64>, String> {
    let blob: Vec<u8> = conn
        .query_row(
            "SELECT line_offsets FROM files WHERE fid = ?1",
            params![fid],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    decode_line_offsets(&blob)
}

// ---- 按需取数（行偏移 seek 直读原文件）----


/// 单行文本（tooltip/复制用）：行偏移 seek 直读，不整文件重读
#[tauri::command]
pub async fn db_line(no: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_cache()?;
        let root = cache_root()?;
        let (fid, path, local) = locate_line(&conn, &root, no)?;
        let offsets = load_line_offsets(&conn, fid)?;
        read_line_range(&path, &offsets, local, local)?
            .into_iter()
            .next()
            .ok_or_else(|| format!("行号越界: {no}"))
    })
    .await
    .map_err(|e| format!("db_line 任务失败: {e}"))?
}

/// 视口事件（ts 窗口内全部事件行）：时间线骨架渲染用——直接查 line_ts（不需要 filter）。
#[tauri::command]
pub async fn db_events_in_window(start: i64, end: i64) -> Result<Vec<HitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_cache()?;
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
    })
    .await
    .map_err(|e| format!("db_events_in_window 任务失败: {e}"))?
}

/// 事件索引分块（键集分页，复合索引免排序），按 (ts, line) 升序。
/// 返回**原始字节**（SoA 布局，前端 typed array 直读、零对象解析）：
/// `[count: u32][pad: u32][ts: count × f64 LE][line: count × u32 LE]`
/// ts 以 f64 编码（epoch ms < 2^53，无损）；ts/line 数组平行同序。
/// after_ts 为 None 表示「无下界」（首块）；非首块传上一块最后一条的 (ts, line)。
///
/// 性能要点：**不能**把首块哨兵写成 `WHERE (?1 IS NULL OR ts > ?1 ...)` ——
/// `?1 IS NULL` 谓词让 SQLite 无法在编译期确定 `ts > ?1` 可作索引下界，
/// 查询计划退化为整表 SCAN（EXPLAIN QUERY PLAN 实测：OR 谓词 = SCAN vs
/// 纯范围谓词 = SEARCH），第 k 块都要扫过前 k-1 块的行 → O(N²/chunk)，
/// 表现为「载入索引越到后面越慢」。首块/续块拆成两条 SQL：
/// - 首块：无 WHERE，纯 `ORDER BY ts, line LIMIT ?`（顺索引扫，天然最优）
/// - 续块：行值比较 `(ts, line) > (?1, ?2)`（复合索引两列下界定位，SEEK 一次）
#[tauri::command]
pub async fn db_event_index_chunk(
    after_ts: Option<i64>,
    after_line: u32,
    max: u32,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let conn = open_cache()?;
        let sql = if after_ts.is_none() {
            // 首块：无下界
            "SELECT line, ts FROM line_ts ORDER BY ts, line LIMIT ?1"
        } else {
            // 续块：行值比较（复合索引 (ts, line) 下界定位；
            // 与 ts > ?1 OR (ts = ?1 AND line > ?2) 语义等价）
            "SELECT line, ts FROM line_ts WHERE (ts, line) > (?1, ?2) ORDER BY ts, line LIMIT ?3"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        // 绑定值先落地为局部变量：`&(expr)` 临时值会在语句结束被释放，
        // Vec<&dyn ToSql> 悬垂（borrow checker 报 temporary value freed）
        let max_v = max as i64;
        let line_v = after_line as i64;
        let bind: Vec<&dyn rusqlite::ToSql> = match &after_ts {
            None => vec![&max_v],
            Some(ts) => vec![ts, &line_v, &max_v],
        };
        let rows = stmt
            .query_map(bind.as_slice(), |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut ts_bytes: Vec<u8> = Vec::new();
        let mut line_bytes: Vec<u8> = Vec::new();
        let mut count: u32 = 0;
        for r in rows.flatten() {
            ts_bytes.extend_from_slice(&(r.1 as f64).to_le_bytes());
            line_bytes.extend_from_slice(&r.0.to_le_bytes());
            count += 1;
        }
        let mut out = Vec::with_capacity(8 + ts_bytes.len() + line_bytes.len());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&ts_bytes);
        out.extend_from_slice(&line_bytes);
        Ok(out)
    })
    .await
    .map_err(|e| format!("db_event_index_chunk 任务失败: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 视口行文本：按全局行号集合取行（任意顺序；内部排序去重）。
/// 替代旧版「min/max 行号区间」契约——多文件时间交叠时区间会横跨数百万行，
/// 一次回传全区间行；id 契约只回视口实际需要的行。
/// 同文件行号 gap<=64 合并成一整段 seek 读取（段内多余行无害，调用方按需取用）。
/// 返回原始字节：`[count: u32][pad: u32] + 每行 [line: u32][len: u32][utf-8 bytes]`
#[tauri::command]
pub async fn db_lines_by_ids(ids: Vec<u32>) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if ids.is_empty() {
            return Ok(vec![0u8; 8]);
        }
        let conn = open_cache()?;
        let root = cache_root()?;
        let files = files_snapshot(&conn)?;
        let mut sorted = ids;
        sorted.sort_unstable();
        sorted.dedup();

        let mut rows: Vec<(u32, String)> = Vec::with_capacity(sorted.len());
        let mut i = 0usize;
        let mut fi = 0usize; // files 与 sorted 均升序 → 双指针
        while i < sorted.len() {
            let line = sorted[i];
            while fi + 1 < files.len() && files[fi + 1].2 <= line {
                fi += 1;
            }
            let (fid, name, first_line) = &files[fi];
            let file_limit = files.get(fi + 1).map(|f| f.2).unwrap_or(u32::MAX);
            let mut j = i;
            while j < sorted.len() && sorted[j] < file_limit {
                j += 1;
            }
            if line < *first_line {
                i = j;
                continue;
            }
            let locals: Vec<u32> = sorted[i..j].iter().map(|&l| l - first_line).collect();
            let segs = merge_line_segments(&locals, 64);
            let offsets = match load_line_offsets(&conn, *fid) {
                Ok(o) => o,
                Err(_) => {
                    i = j;
                    continue;
                }
            };
            for (lo, hi) in segs {
                if let Ok(texts) = read_line_range(&root.join(name), &offsets, lo, hi) {
                    for (k, text) in texts.into_iter().enumerate() {
                        rows.push((first_line + lo + k as u32, text));
                    }
                }
            }
            i = j;
        }

        let mut out: Vec<u8> = Vec::with_capacity(8 + rows.len() * 24);
        out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for (line, text) in &rows {
            out.extend_from_slice(&line.to_le_bytes());
            out.extend_from_slice(&(text.len() as u32).to_le_bytes());
            out.extend_from_slice(text.as_bytes());
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("db_lines_by_ids 任务失败: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 关联窗口下推：filter_ids 任一命中的行中，ts ∈ [start, end] 的全局行号。
/// 替代旧版 JS 全量扫 matches（每次视图变化 O(总命中数)）。
/// line_ts (ts,line) 覆盖索引范围扫（窗口行）驱动，每行对 filter_hits
/// 主键做 EXISTS 点查（命中即短路，免 CROSS JOIN + DISTINCT 的去重开销）；
/// 窗口外的大 filter 命中完全不触碰。
#[tauri::command]
pub async fn db_corr_ids(
    filter_ids: Vec<String>,
    start: i64,
    end: i64,
) -> Result<Vec<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if filter_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = open_cache()?;
        let placeholders = (3..filter_ids.len() + 3)
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT t.line FROM line_ts t \
             WHERE t.ts BETWEEN ?1 AND ?2 \
               AND EXISTS (SELECT 1 FROM filter_hits h \
                           WHERE h.filter_id IN ({placeholders}) AND h.line = t.line)"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(filter_ids.len() + 2);
        bind.push(&start);
        bind.push(&end);
        for s in &filter_ids {
            bind.push(s);
        }
        let rows = stmt
            .query_map(bind.as_slice(), |r| r.get::<_, u32>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows.flatten() {
            out.push(r);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("db_corr_ids 任务失败: {e}"))?
}

/// 关闭（切换目录时）
#[tauri::command]
pub fn db_close() -> Result<(), String> {
    *db_cache_path().lock().map_err(|e| e.to_string())? = None;
    *db_root().lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// 文件清单（DetailPanel 无限上下文用：行号 → 所属文件定位 + 右键打开）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbFileInfo {
    /// 该文件首行的全局行号
    pub first_line: u32,
    /// 相对路径（显示用）
    pub name: String,
    /// 绝对路径（reveal / 外部打开用）
    pub path: String,
}

/// 文件清单（first_line 升序）。无限上下文滚动需要知道每个文件的行号区间与绝对路径。
#[tauri::command]
pub async fn db_files() -> Result<Vec<DbFileInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_cache()?;
        let root = cache_root()?;
        Ok(files_snapshot(&conn)?
            .into_iter()
            .map(|(_fid, name, first_line)| DbFileInfo {
                first_line,
                path: root.join(&name).to_string_lossy().into_owned(),
                name,
            })
            .collect())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "loggraph-db-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 与建库扫描一致的偏移计算（split('\n') 分段语义）
    fn scan_offsets(text: &str) -> Vec<u64> {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut pos = 0usize;
        loop {
            out.push(pos as u64);
            let end = match bytes[pos..].iter().position(|&b| b == b'\n') {
                Some(k) => pos + k,
                None => bytes.len(),
            };
            if end == bytes.len() {
                break;
            }
            pos = end + 1;
        }
        out
    }

    #[test]
    fn offsets_match_split_semantics() {
        assert_eq!(scan_offsets("a"), vec![0]);
        assert_eq!(scan_offsets("a\n"), vec![0, 2]); // 尾换行 → 末尾空行段
        assert_eq!(scan_offsets("a\n\n"), vec![0, 2, 3]);
        assert_eq!(scan_offsets(""), vec![0]);
        assert_eq!(scan_offsets("中文\nb"), vec![0, 7]); // 多字节 UTF-8 边界
    }

    #[test]
    fn read_line_range_variants() {
        let dir = tmp_dir("range");
        let p = dir.join("t1.log");
        std::fs::write(&p, "l0\r\nl1\nl2\n\nl4").unwrap(); // CRLF + 空行 + 无尾换行
        let off = scan_offsets("l0\r\nl1\nl2\n\nl4");
        assert_eq!(read_line_range(&p, &off, 0, 0).unwrap(), vec!["l0"]);
        assert_eq!(
            read_line_range(&p, &off, 0, 4).unwrap(),
            vec!["l0", "l1", "l2", "", "l4"]
        );
        assert_eq!(read_line_range(&p, &off, 3, 3).unwrap(), vec![""]);
        assert_eq!(read_line_range(&p, &off, 4, 4).unwrap(), vec!["l4"]); // 尾行: end=文件尾
        assert!(read_line_range(&p, &off, 0, 5).is_err()); // 越界
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn merge_segments_groups_neighbors() {
        assert_eq!(merge_line_segments(&[], 64), vec![]);
        assert_eq!(merge_line_segments(&[1, 2, 3], 64), vec![(1, 3)]);
        assert_eq!(merge_line_segments(&[1, 100], 64), vec![(1, 1), (100, 100)]);
        assert_eq!(merge_line_segments(&[1, 64], 64), vec![(1, 64)]); // gap=63 ≤ 64
        assert_eq!(
            merge_line_segments(&[1, 66], 64),
            vec![(1, 1), (66, 66)] // gap=65 > 64
        );
        // 乱序输入按序段内扩展（调用方保证升序，这里只验证单调性假设下的行为）
        assert_eq!(merge_line_segments(&[5, 6, 7], 64), vec![(5, 7)]);
    }

    #[test]
    fn message_scope_single_pass() {
        let dir = tmp_dir("msg");
        std::fs::write(
            dir.join("a.log"),
            "2024-01-01 10:00:00.000 alpha hello\nplain line no ts\n2024-01-01 10:00:01.000 world hello\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("b.log"),
            "2024-01-01 10:00:02.000 alpha hello\n",
        )
        .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO files(fid, name, first_line, line_offsets) VALUES (1, 'a.log', 0, x'')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files(fid, name, first_line, line_offsets) VALUES (2, 'b.log', 4, x'')",
            [],
        )
        .unwrap();
        // a.log split('\n') = 4 段（含尾空段）→ 全局行 0..=3；b.log 从行 4 起
        let mk = |pattern: &str, case_sensitive: bool, is_regex: bool| FilterQuery {
            filter_id: "f".into(),
            pattern: pattern.into(),
            is_regex,
            case_sensitive,
            scope: "message".into(),
        };
        // 候选：0(a:alpha ✓) 1(a:无ts ✗) 2(a:world ✓) 3(a:空段 ✗) 4(b:alpha ✓)
        let hits = vec![0u32, 1, 2, 3, 4];
        let kept = message_scope_filter(&hits, &conn, &dir, &mk("hello", true, false)).unwrap();
        assert_eq!(kept, vec![0, 2, 4]);
        // 大小写不敏感
        let kept = message_scope_filter(&hits, &conn, &dir, &mk("HELLO", false, false)).unwrap();
        assert_eq!(kept, vec![0, 2, 4]);
        // message 域不含时间戳部分：匹配时间串里的内容不应命中
        let kept = message_scope_filter(&hits, &conn, &dir, &mk("10:00:00", true, false)).unwrap();
        assert!(kept.is_empty());
        // 乱序/重复候选 → 输出等价（排序去重）
        let hits = vec![4u32, 0, 2, 0];
        let kept = message_scope_filter(&hits, &conn, &dir, &mk("hello", true, false)).unwrap();
        assert_eq!(kept, vec![0, 2, 4]);
        // 正则
        let kept = message_scope_filter(&hits, &conn, &dir, &mk("wor.d", true, true)).unwrap();
        assert_eq!(kept, vec![2]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corr_ids_sql_and_plan() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO line_ts(line, ts) VALUES (10, 100), (11, 200), (12, 300)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO filter_hits(filter_id, line) VALUES ('f1', 10), ('f1', 12), ('f2', 11)",
            [],
        )
        .unwrap();
        let sql = "SELECT t.line FROM line_ts t \
                   WHERE t.ts BETWEEN ?1 AND ?2 \
                     AND EXISTS (SELECT 1 FROM filter_hits h \
                                 WHERE h.filter_id IN (?3) AND h.line = t.line)";
        // 结果正确性：ts∈[150,350] 且 f1 命中 → 仅行 12
        let mut stmt = conn.prepare(sql).unwrap();
        let rows: Vec<u32> = stmt
            .query_map(params![150i64, 350i64, "f1"], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(rows, vec![12]);
        // 查询计划：line_ts 必须走 (ts,line) 覆盖索引（SEARCH），不得全表 SCAN
        let mut plan_stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plans: Vec<String> = plan_stmt
            .query_map(params![150i64, 350i64, "f1"], |r| {
                r.get::<_, String>(3)
            })
            .unwrap()
            .flatten()
            .collect();
        let all = plans.join(" | ");
        assert!(
            all.contains("SEARCH") && all.contains("idx_line_ts_ts"),
            "query plan 走了全表扫描: {all}"
        );
    }
}
