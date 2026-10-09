//! v2 数据层：原文件直扫 + 瘦 SQL（plans/v2-rg-sql-architecture.md）。
//!
//! 核心思想：**原始文件就是数据库**——过滤用 RegexSet 单遍批量直扫原文件
//!（文件级并行，全部 pattern 一次匹配），零预处理零冗余；SQL 只存衍生数据：
//! - `files`：文件清单 + 每文件首行全局行号 + 每行字节偏移（seek 直读用）
//! - `line_ts`：瘦 ts 索引（打开时一次性扫描，只抽时间戳，~16B/事件行）
//! - `filter_hits`：filter 命中结果（扫描后写入，供 CEP/渲染 SQL 查询）
//!
//! 上下文/详情：按行偏移 seek 直读原文件片段（不进 SQL，不整文件重读）。
//! 索引/视口行文本走 `tauri::ipc::Response` 二进制通道（SoA，前端零对象解析）。
//! 缓存指纹：目录内日志文件 (rel, size, mtime) 的 FNV；schemaVersion=3 不符自动重建。

use crate::parser::timestamp::{extract_timestamp, find_format, detect_timestamp_format, TsFormat};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

/// cache.db 路径（打开目录后设置）。每命令独立开连接：WAL 支持并发读，
/// 慢查询（如 db_corr_ids 的窗口扫描）不再持全局锁阻塞其它命令——
/// v3 之前全局单连接 Mutex，corr 查询持锁期间 db_lines_by_ids /
/// db_context_lines / db_line 全部排队，表现为视口/详情/原始行「没反应」。
static DB_CACHE_PATH: LazyLock<Mutex<Option<PathBuf>>> =
    LazyLock::new(|| Mutex::new(None));

/// 当前打开的目录（扫描根）
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

/// 命中条目（line + ts）：filter_hits JOIN 与 db_events_in_window 共用
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
CREATE TABLE IF NOT EXISTS filter_meta ( -- filter 定义指纹（命中则跳过 rg 重扫，直接复用 filter_hits）
  filter_id TEXT PRIMARY KEY,
  fp        TEXT NOT NULL
);
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
                // 老库升级：幂等补建 filter_meta（新增表，新库走 SCHEMA）
                let _ = conn.execute_batch(
                    "CREATE TABLE IF NOT EXISTS filter_meta (
                       filter_id TEXT PRIMARY KEY,
                       fp        TEXT NOT NULL
                     );",
                );
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

/// 字节级 JS trim（White_Space + U+FEFF 的 UTF-8 序列全集）。
/// msg 域精筛用——域匹配走 bytes regex，免整行 utf8 str 化。
fn js_trim_bytes(b: &[u8]) -> &[u8] {
    /// b[i..] 起始的空白序列长度（非 0 = 命中）
    #[inline]
    fn ws_at(b: &[u8], i: usize) -> usize {
        match b[i] {
            c if (0x09..=0x0d).contains(&c) || c == 0x20 => 1,
            // U+0085 / U+00A0
            0xc2 if i + 1 < b.len() && (b[i + 1] == 0x85 || b[i + 1] == 0xa0) => 2,
            // U+1680
            0xe1 if i + 2 < b.len() && b[i + 1] == 0x9a && b[i + 2] == 0x80 => 3,
            0xe2 if i + 2 < b.len() => {
                // U+2000-200A / U+2028 / U+2029 / U+202F（80 前缀）/ U+205F（81 前缀）
                let (a, c) = (b[i + 1], b[i + 2]);
                if (a == 0x80 && ((0x80..=0x8a).contains(&c) || c == 0xa8 || c == 0xa9 || c == 0xaf))
                    || (a == 0x81 && c == 0x9f)
                {
                    3
                } else {
                    0
                }
            }
            // U+3000
            0xe3 if i + 2 < b.len() && b[i + 1] == 0x80 && b[i + 2] == 0x80 => 3,
            // U+FEFF
            0xef if i + 2 < b.len() && b[i + 1] == 0xbb && b[i + 2] == 0xbf => 3,
            _ => 0,
        }
    }
    let mut s = 0usize;
    let mut e = b.len();
    while s < e {
        let n = ws_at(b, s);
        if n == 0 {
            break;
        }
        s += n;
    }
    while e > s {
        // 尾部按最长序列检查（先 3 后 2 后 1）
        let start = if e >= 3 && ws_at(b, e - 3) == 3 {
            Some(e - 3)
        } else if e >= 2 && ws_at(b, e - 2) == 2 {
            Some(e - 2)
        } else if ws_at(b, e - 1) == 1 {
            Some(e - 1)
        } else {
            None
        };
        match start {
            Some(st) => e = st,
            None => break,
        }
    }
    &b[s..e]
}

/// 单遍多过滤器扫描（文件级并行）。
/// - **每 expr 独立正则**对文件全文 find_iter：match 直接归属该 expr 的
///   filter 集（无二次确认）；regex 引擎 prefilter（memchr/Aho-Corasick
///   SIMD）跳过 miss 字节，与 rg 同款。expr 去重后 K 趟全文扫描（K =
/// 不同 pattern 数，prefilter 后每趟 ~0.3s/GB）。
/// - 命中 match → line_offsets 二分行号（库内偏移，免手扫）；同行多
///   match 由「上一个行号」去重（match 按位置升序）。
/// - message scope：expr 粗筛（msg ⊆ line，整行命中是必要条件）收集候选
///   行去重后精筛——ts 只在前 64B 前缀提取（**指定格式**单次调用，探测
///   失败/格式突变回退全格式），msg 域字节级匹配（免整行 utf8 转换）。
///   无 ts 行 message 域为空 → 不可能命中。
/// - ^/$ 以 multi_line 语义锚定行边界；CRLF 行尾 `$` 与 \r 相邻的边缘
///   差异不处理。
/// - 每文件单线程、行号升序 → 免 sort/dedup（msg 候选除外，跨 expr 需去重）。
/// 返回与 queries 同序的全局行号列表。
#[allow(clippy::type_complexity)]
fn scan_filters_once(
    root: &Path,
    files: &[(i64, String, u32, Vec<u64>)],
    queries: &[FilterQuery],
    ts_fmt: Option<&'static TsFormat>,
) -> Result<Vec<Vec<u32>>, String> {
    use std::collections::HashMap;

    // ---- pattern 编译（同 expr 多 filter 共享）----
    let mut raw_pats: Vec<String> = Vec::new();
    let mut raw_idx: HashMap<String, usize> = HashMap::new();
    // expr 序号 → (query 序号, 是否 message 需精筛)
    let mut raw_slots: Vec<Vec<(usize, bool)>> = Vec::new();
    let mut msg_pats: Vec<String> = Vec::new();
    let mut msg_idx: HashMap<String, usize> = HashMap::new();
    let mut msg_slots: Vec<Vec<usize>> = Vec::new();
    for (qi, q) in queries.iter().enumerate() {
        if q.pattern.is_empty() {
            continue;
        }
        // flags 用 group 形式 (?i:...)：裸 (?i) 在交替中会泄漏到后续分支
        let body = if q.is_regex {
            q.pattern.as_str()
        } else {
            &regex::escape(&q.pattern)
        };
        let expr = if q.case_sensitive {
            body.to_string()
        } else {
            format!("(?i:{body})")
        };
        let si = match raw_idx.get(&expr) {
            Some(&s) => s,
            None => {
                raw_pats.push(expr.clone());
                raw_slots.push(Vec::new());
                let s = raw_pats.len() - 1;
                raw_idx.insert(expr.clone(), s);
                s
            }
        };
        let is_msg = q.scope == "message";
        raw_slots[si].push((qi, is_msg));
        if is_msg {
            let ms = match msg_idx.get(&expr) {
                Some(&m) => m,
                None => {
                    msg_pats.push(expr.clone());
                    msg_slots.push(Vec::new());
                    let m = msg_pats.len() - 1;
                    msg_idx.insert(expr, m);
                    m
                }
            };
            msg_slots[ms].push(qi);
        }
    }
    if raw_pats.is_empty() {
        // 全部 pattern 为空 → 无可扫描（调用方已过滤，防御）
        return Ok(vec![Vec::new(); queries.len()]);
    }
    // 每 expr 独立正则（multi_line：^/$ 锚定行边界）
    let build = |pats: &[String]| -> Result<Vec<regex::bytes::Regex>, String> {
        pats.iter()
            .map(|p| {
                regex::bytes::RegexBuilder::new(p)
                    .multi_line(true)
                    .build()
                    .map_err(|e| format!("构建正则失败: {e}"))
            })
            .collect()
    };
    let regexes = build(&raw_pats)?;
    let msg_regexes = build(&msg_pats)?;

    // 每文件计时(读/迭代/精筛)聚合,函数尾部一次写入 perf.log
    let perf: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();

    // ---- 文件级并行（stride 交错，first_line 升序 → 大文件分散） ----
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files.len())
        .max(1);
    let files_ref: &[(i64, String, u32, Vec<u64>)] = files;
    let n_q = queries.len();
    let scan = |part: &[(i64, String, u32, Vec<u64>)]| -> Vec<Vec<u32>> {
        let mut buckets: Vec<Vec<u32>> = (0..n_q).map(|_| Vec::new()).collect();
        for (_fid, name, first_line, offsets) in part {
            let t_read = Instant::now();
            let Ok(bytes) = std::fs::read(root.join(name)) else {
                continue; // 读取失败跳过（与建库语义一致）
            };
            let ms_read = t_read.elapsed().as_millis();
            // 行起始偏移：优先库内 line_offsets（schema v3 必有）；
            // 空/越界（异常）→ 手扫 \n 兜底
            let starts: Vec<u64> = if !offsets.is_empty()
                && offsets[0] == 0
                && *offsets.last().unwrap() <= bytes.len() as u64
            {
                offsets.clone()
            } else {
                let mut v = vec![0u64];
                let mut i = 0usize;
                while i < bytes.len() {
                    match bytes[i..].iter().position(|&b| b == b'\n') {
                        Some(k) => {
                            i += k + 1;
                            v.push(i as u64);
                        }
                        None => break,
                    }
                }
                v
            };
            // 每 expr 独立 find_iter（prefilter SIMD 跳过 miss 字节）；
            // match 直接归属该 expr 的 filter 集；同行多 match 用 last_li 去重。
            let t_iter = Instant::now();
            let mut raw_hits = 0usize; // 粗筛命中数(同行去重后)
            let mut msg_candidates: Vec<(usize, u32)> = Vec::new();
            for (ei, re) in regexes.iter().enumerate() {
                let mut last_li = usize::MAX;
                for m in re.find_iter(&bytes) {
                    let li = starts.partition_point(|&s| s <= m.start() as u64) - 1;
                    if li == last_li {
                        continue;
                    }
                    last_li = li;
                    raw_hits += 1;
                    let global = first_line + li as u32;
                    let mut need_msg = false;
                    for &(qi, is_msg) in &raw_slots[ei] {
                        if is_msg {
                            need_msg = true;
                        } else {
                            buckets[qi].push(global);
                        }
                    }
                    if need_msg {
                        msg_candidates.push((li, global));
                    }
                }
            }
            let ms_iter = t_iter.elapsed().as_millis();
            let n_cand = msg_candidates.len(); // for 会 move,提前取
            let t_msg = Instant::now();
            // message 精筛：候选行去重（跨 expr 同行可能重复入列）后逐行
            // ts 提取 → msg 域匹配
            if !msg_regexes.is_empty() {
                msg_candidates.sort_unstable_by_key(|&(li, _)| li);
                msg_candidates.dedup_by_key(|e| e.0);
                for (li, global) in msg_candidates {
                    let s = starts[li] as usize;
                    let e = if li + 1 < starts.len() {
                        starts[li + 1] as usize - 1 // 剥 \n
                    } else {
                        bytes.len()
                    };
                    let mut line = &bytes[s..e];
                    if line.last() == Some(&b'\r') {
                        line = &line[..line.len() - 1];
                    }
                    // ts 只在前 64B 前缀找（截断回退到 UTF-8 字符边界，
                    // 避免 lossy 替换改变字节布局）；指定格式失败回退全格式
                    let mut plen = line.len().min(64);
                    while plen < line.len() && (line[plen] & 0xc0) == 0x80 {
                        plen -= 1;
                    }
                    let prefix = String::from_utf8_lossy(&line[..plen]);
                    let ext = match extract_timestamp(&prefix, ts_fmt) {
                        Some(x) => Some(x),
                        None if ts_fmt.is_some() => extract_timestamp(&prefix, None),
                        None => None,
                    };
                    let Some(ext) = ext else {
                        continue; // 无 ts → message 域为空
                    };
                    // msg 域 = 原始行 ts 之后（字节级匹配 + 字节级 trim，免整行 str 化）
                    let msg = js_trim_bytes(&line[ext.end..]);
                    for (mi, mre) in msg_regexes.iter().enumerate() {
                        if mre.is_match(msg) {
                            for &qi in &msg_slots[mi] {
                                buckets[qi].push(global);
                            }
                        }
                    }
                }
            }
            if let Ok(mut v) = perf.lock() {
                v.push(format!(
                    "scan {name} {:.1}MB read={ms_read}ms iter={ms_iter}ms msg={:?} hits={raw_hits} cand={n_cand}",
                    bytes.len() as f64 / 1048576.0,
                    t_msg.elapsed()
                ));
            }
        }
        buckets
    };
    let results: Vec<Vec<Vec<u32>>> = if threads <= 1 {
        vec![scan(files_ref)]
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|t| {
                    let part: Vec<(i64, String, u32, Vec<u64>)> = files_ref
                        .iter()
                        .skip(t)
                        .step_by(threads)
                        .cloned()
                        .collect();
                    scope.spawn(move || scan(&part))
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        })
    };
    let mut per_filter: Vec<Vec<u32>> = (0..n_q).map(|_| Vec::new()).collect();
    for b in results {
        for (qi, v) in b.into_iter().enumerate() {
            per_filter[qi].extend(v);
        }
    }
    // 每文件计时落地(一次写;目录无 .logGraph 时静默跳过——测试用例)
    if let Ok(logs) = perf.lock() {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join(".logGraph").join("perf.log"))
        {
            use std::io::Write;
            for l in logs.iter() {
                let _ = writeln!(f, "{l}");
            }
        }
    }
    Ok(per_filter)
}

/// filter 定义指纹：pattern/正则/大小写/scope 任一变化 → 缓存失效重扫。
/// （目录变化由 cache.db 整库重建保证，无需纳入。）
fn filter_def_fp(q: &FilterQuery) -> String {
    let mut h: u64 = 1469598103934665603;
    let part = format!(
        "{}\u{0}{}\u{0}{}\u{0}{}\n",
        q.pattern, q.is_regex, q.case_sensitive, q.scope
    );
    for b in part.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{h:016x}")
}

/// filter_hits ⋈ line_ts → (line, ts)[]（ts 升序）。rg 扫描后与缓存命中共用。
fn filter_hits_join(conn: &Connection, filter_id: &str) -> Result<Vec<HitEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT h.line, t.ts FROM filter_hits h
             JOIN line_ts t ON t.line = h.line
             WHERE h.filter_id = ?1
             ORDER BY t.ts, h.line",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![filter_id], |r| {
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

/// 批量过滤器查询结果（命令内聚合，最终编码为二进制 IPC 响应）：
/// (filter_id, (line, ts)[] 按 ts 升序)
type FilterBatchOut = Vec<(String, Vec<HitEntry>)>;

/// 结果编码（二进制，~12B/命中；百万级命中走 JSON 会到 100MB+ 且
/// 序列化/parse 双端数秒，故与 db_event_index_chunk 同走 Response 路径）：
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

/// 批量运行过滤器（recomputeMatches / 单 filter 编辑共用）：
/// 1. 逐个比对定义指纹——命中的直接 JOIN filter_hits（不扫描）；
/// 2. 未命中的**单遍扫描**全部文件（scan_filters_once：文件级并行 +
///    RegexSet 一次匹配所有 pattern），逐个事务覆盖写 filter_hits + 指纹；
/// 3. 全部 filter 的 JOIN 结果编码为二进制返回（含缓存命中）。
#[tauri::command]
pub async fn db_filters_batch(
    queries: Vec<FilterQuery>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let t0 = Instant::now();
        let conn = open_cache()?;
        let root = cache_root()?;
        perf_log(
            &root,
            &format!("---- db_filters_batch: {} queries ----", queries.len()),
        );

        let mut out: FilterBatchOut = Vec::new();
        let mut miss: Vec<FilterQuery> = Vec::new();
        for q in &queries {
            let def_fp = filter_def_fp(q);
            let cached: Option<String> = conn
                .query_row(
                    "SELECT fp FROM filter_meta WHERE filter_id = ?1",
                    params![q.filter_id],
                    |r| r.get(0),
                )
                .ok();
            if cached.as_deref() == Some(def_fp.as_str()) {
                out.push((q.filter_id.clone(), filter_hits_join(&conn, &q.filter_id)?));
            } else {
                miss.push(q.clone());
            }
        }
        perf_log(
            &root,
            &format!(
                "fingerprint: {} cached, {} miss {:?}",
                queries.len() - miss.len(),
                miss.len(),
                t0.elapsed()
            ),
        );
        if !miss.is_empty() {
            // 行偏移从库内 line_offsets 取（scan 反查行号用，免手扫全文）
            let t = Instant::now();
            let files: Vec<(i64, String, u32, Vec<u64>)> = files_snapshot(&conn)?
                .into_iter()
                .map(|(fid, name, first_line)| {
                    let off = load_line_offsets(&conn, fid).unwrap_or_default();
                    (fid, name, first_line, off)
                })
                .collect();
            // 时间戳格式探测（首个文件前 10 行）：msg 精筛免每行全格式尝试
            let ts_fmt = files.first().and_then(|(_fid, name, ..)| {
                std::fs::read(root.join(name)).ok().and_then(|b| {
                    let s = String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]);
                    let lines: Vec<&str> = s.split('\n').take(10).collect();
                    detect_timestamp_format(&lines)
                })
            });
            perf_log(
                &root,
                &format!(
                    "prep: {} files, fmt={:?} {:?}",
                    files.len(),
                    ts_fmt.map(|f| f.id),
                    t.elapsed()
                ),
            );
            let t = Instant::now();
            let per_filter = scan_filters_once(&root, &files, &miss, ts_fmt)?;
            let hits: Vec<usize> = per_filter.iter().map(|v| v.len()).collect();
            perf_log(
                &root,
                &format!("scan: hits={hits:?} {:?}", t.elapsed()),
            );
            for (qi, q) in miss.iter().enumerate() {
                let lines = &per_filter[qi];
                let t = Instant::now();
                // 事务覆盖写（同 filter_id 重定义 = 覆盖旧命中）
                conn.execute_batch("BEGIN")
                    .map_err(|e| e.to_string())?;
                let _ = conn.execute(
                    "DELETE FROM filter_hits WHERE filter_id = ?1",
                    params![q.filter_id],
                );
                // 批量 INSERT：500 行/句（1000 参数 < SQLite 32766 上限），
                // 350 万行从 ~5s 降到 ~1.5s；尾巴（<500）走单行 prepared
                let ins_sql = format!(
                    "INSERT OR IGNORE INTO filter_hits(filter_id, line) VALUES {}",
                    (0..500)
                        .map(|i| format!("(?{},?{})", i * 2 + 1, i * 2 + 2))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                {
                    let mut ins_full = conn.prepare(&ins_sql).map_err(|e| e.to_string())?;
                    let mut ins_one = conn
                        .prepare("INSERT OR IGNORE INTO filter_hits(filter_id, line) VALUES (?1, ?2)")
                        .map_err(|e| e.to_string())?;
                    let fid: &str = &q.filter_id;
                    let mut lv: Vec<i64> = Vec::with_capacity(500);
                    for chunk in lines.chunks(500) {
                        if chunk.len() == 500 {
                            lv.clear();
                            lv.extend(chunk.iter().map(|&l| l as i64));
                            let mut bind: Vec<&dyn rusqlite::ToSql> =
                                Vec::with_capacity(1000);
                            for k in 0..500 {
                                bind.push(&fid);
                                bind.push(&lv[k]);
                            }
                            ins_full
                                .execute(bind.as_slice())
                                .map_err(|e| e.to_string())?;
                        } else {
                            for &l in chunk {
                                ins_one
                                    .execute(params![q.filter_id, l as i64])
                                    .map_err(|e| e.to_string())?;
                            }
                        }
                    }
                }
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                perf_log(
                    &root,
                    &format!(
                        "insert {}: {} rows {:?}",
                        q.filter_id,
                        lines.len(),
                        t.elapsed()
                    ),
                );
                // 定义指纹随结果写入（失败仅失去缓存）
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO filter_meta(filter_id, fp) VALUES (?1, ?2)",
                    params![q.filter_id, filter_def_fp(q)],
                );
                let t = Instant::now();
                out.push((q.filter_id.clone(), filter_hits_join(&conn, &q.filter_id)?));
                perf_log(
                    &root,
                    &format!(
                        "join {}: {} rows {:?}",
                        q.filter_id,
                        out.last().map(|(_, h)| h.len()).unwrap_or(0),
                        t.elapsed()
                    ),
                );
            }
        }
        let t = Instant::now();
        let enc = encode_filter_batch(&out);
        let total_rows: usize = out.iter().map(|(_, h)| h.len()).sum();
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

/// 删除一个 filter 的命中（filter 被删时调用；命中可达百万行 → 阻塞线程池）
#[tauri::command]
pub async fn db_filter_drop(filter_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = db_cache_path().lock().map_err(|e| e.to_string())?.clone() else {
            return Ok(()); // 未打开视为无操作
        };
        // 写命令也要 busy_timeout：与 db_filters_batch 的 filter_hits 写事务并发时
        // 等待而非立即 SQLITE_BUSY
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA busy_timeout=5000;")
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM filter_hits WHERE filter_id = ?1",
            params![filter_id],
        )
        .map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM filter_meta WHERE filter_id = ?1",
            params![filter_id],
        );
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
    fn scan_filters_once_batch() {
        let dir = tmp_dir("scan_batch");
        let a_text =
            "2024-01-01 10:00:00.000 alpha hello\nplain line no ts\n2024-01-01 10:00:01.000 world hello\n";
        let b_text = "2024-01-01 10:00:02.000 alpha hello\n";
        std::fs::write(dir.join("a.log"), a_text).unwrap();
        std::fs::write(dir.join("b.log"), b_text).unwrap();
        // a.log split('\n') 4 段（含尾空段）→ 全局行 0..=3；b.log 从行 4 起。
        // 2 文件按 stride 分 2 线程，handle 序合并 → 行号升序稳定。
        let files = vec![
            (1i64, "a.log".to_string(), 0u32, scan_offsets(a_text)),
            (2, "b.log".to_string(), 4, scan_offsets(b_text)),
        ];
        let q = |id: &str, pattern: &str, is_regex: bool, cs: bool, scope: &str| FilterQuery {
            filter_id: id.into(),
            pattern: pattern.into(),
            is_regex,
            case_sensitive: cs,
            scope: scope.into(),
        };
        // 多 filter 单遍：raw/message/字面量/正则混合，结果正确分桶
        let queries = vec![
            q("msg", "hello", false, true, "message"), // msg 域 → 0,2,4
            q("raw", "plain", false, true, "raw"),     // 整行 → 1
            q("re", "wor.d", true, true, "message"),   // 正则 msg → 2
        ];
        let r = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(r[0], vec![0, 2, 4]);
        assert_eq!(r[1], vec![1]);
        assert_eq!(r[2], vec![2]);
        // 大小写不敏感（(?i) 折叠）：message + raw 两种 scope
        let queries = vec![
            q("m", "HELLO", false, false, "message"),
            q("r", "ALPHA", false, false, "raw"),
        ];
        let r = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(r[0], vec![0, 2, 4]);
        assert_eq!(r[1], vec![0, 4]);
        // 时间戳部分不属于 message 域
        let r = scan_filters_once(&dir, &files, &[q("t", "10:00:00", false, true, "message")], None)
            .unwrap();
        assert!(r[0].is_empty());
        // 无 ts 行的 message 域视为空 → 不可能命中（即使整行含 pattern）
        let r = scan_filters_once(&dir, &files, &[q("p", "plain", false, true, "message")], None)
            .unwrap();
        assert!(r[0].is_empty());
        // 同 pattern 多 filter 共享 set 位，raw/message 各自分桶
        let queries = vec![
            q("a", "hello", false, true, "raw"),
            q("b", "hello", false, true, "message"),
        ];
        let r = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(r[0], vec![0, 2, 4]);
        assert_eq!(r[1], vec![0, 2, 4]);
        // ^/$ 按行边界锚定（multi_line）：「no ts」仅在行 1 行尾
        let r = scan_filters_once(&dir, &files, &[q("a", "no ts$", true, true, "raw")], None)
            .unwrap();
        assert_eq!(r[0], vec![1]);
        // 空行（两文件尾空段 = 全局行 3、5）：^$ 只命中空行
        let r = scan_filters_once(&dir, &files, &[q("e", "^$", true, true, "raw")], None)
            .unwrap();
        assert_eq!(r[0], vec![3, 5]);
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

    #[test]
    fn filter_def_fp_stability() {
        let base = FilterQuery {
            filter_id: "f1".into(),
            pattern: "ERROR".into(),
            is_regex: false,
            case_sensitive: false,
            scope: "raw".into(),
        };
        assert_eq!(filter_def_fp(&base), filter_def_fp(&base)); // 稳定
        // 任一定义字段变化 → 指纹变化（缓存失效）；filter_id 不参与
        for mut q in [
            FilterQuery { pattern: "WARN".into(), ..base.clone() },
            FilterQuery { is_regex: true, ..base.clone() },
            FilterQuery { case_sensitive: true, ..base.clone() },
            FilterQuery { scope: "message".into(), ..base.clone() },
        ] {
            q.filter_id = "other".into();
            assert_ne!(filter_def_fp(&base), filter_def_fp(&q));
        }
        let other_id = FilterQuery { filter_id: "f2".into(), ..base.clone() };
        assert_eq!(filter_def_fp(&base), filter_def_fp(&other_id));
    }

    #[test]
    fn filter_hits_join_orders_by_ts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // 行号/时间戳乱序插入 → JOIN 输出必须 ts 升序
        for (line, ts) in [(30, 300), (10, 200), (20, 100)] {
            conn.execute(
                "INSERT INTO line_ts(line, ts) VALUES (?1, ?2)",
                params![line, ts],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO filter_hits(filter_id, line) VALUES ('f1', ?1)",
                params![line],
            )
            .unwrap();
        }
        let out = filter_hits_join(&conn, "f1").unwrap();
        assert_eq!(
            out.iter().map(|h| (h.line, h.ts)).collect::<Vec<_>>(),
            vec![(20, 100), (10, 200), (30, 300)]
        );
        assert!(filter_hits_join(&conn, "nope").unwrap().is_empty());
    }

    /// 大规模基准(用户实测复现):`cargo test --release bench_db_filters_scale -- --ignored --nocapture`
    /// 复刻 db_filters_batch 首次 miss 全链路(建库→snapshot→scan→INSERT→JOIN→encode),
    /// 分阶段计时——扫描方式已四轮大改而总耗时不变,瓶颈在固定环节,用数据定位。
    #[test]
    #[ignore]
    fn bench_db_filters_scale() {
        use std::time::Instant;
        let dir = std::env::temp_dir().join("loggraph_bench_scale");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 8 文件 × 80 万行 × ~95B ≈ 600MB / 640 万行;55% 行含 alpha → ~352 万命中
        let t0 = Instant::now();
        let variants: Vec<String> = (0..2000u32)
            .map(|i| {
                let msg = if i % 100 < 55 {
                    format!("processing request payload alpha id={i} seq={} done", i * 7)
                } else {
                    format!("idle tick beta gamma id={i} seq={}", i * 7)
                };
                format!(
                    "2024-06-01 10:{:02}:{:02}.{:03} INFO  [worker-{}] {}\n",
                    (i / 60) % 60,
                    i % 60,
                    i % 1000,
                    i % 8,
                    msg
                )
            })
            .collect();
        for f in 0..8u32 {
            let mut buf = String::with_capacity(80_000_000);
            for _ in 0..400 {
                for v in &variants {
                    buf.push_str(v);
                }
            }
            std::fs::write(dir.join(format!("app{f}.log")), &buf).unwrap();
        }
        println!("[bench] 生成 640 万行/600MB: {:?}", t0.elapsed());

        // ---- 建库(复刻 db_open)----
        let db_path = dir.join("bench.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-262144;",
        )
        .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let t1 = Instant::now();
        let tx = conn.unchecked_transaction().unwrap();
        {
            let mut ins_file = tx
                .prepare("INSERT INTO files(fid, name, first_line, line_offsets) VALUES (?1, ?2, ?3, ?4)")
                .unwrap();
            let mut ins_ts = tx
                .prepare("INSERT OR IGNORE INTO line_ts(line, ts) VALUES (?1, ?2)")
                .unwrap();
            let mut total_lines: u32 = 0;
            for (i, f) in (0..8u32).enumerate() {
                let rel = format!("app{f}.log");
                let text = read_file_lossy(&dir.join(&rel)).unwrap();
                let fid = (i + 1) as i64;
                let first_line = total_lines;
                let mut offsets: Vec<u8> = Vec::with_capacity(64 + text.len() / 16 * 8);
                let bytes = text.as_bytes();
                let mut pos = 0usize;
                let mut line_no = 0u32;
                loop {
                    let start = pos;
                    let end = match bytes[pos..].iter().position(|&b| b == b'\n') {
                        Some(k) => pos + k,
                        None => bytes.len(),
                    };
                    offsets.extend_from_slice(&(start as u64).to_le_bytes());
                    let line = text[start..end].strip_suffix('\r').unwrap_or(&text[start..end]);
                    if let Some(ext) = extract_timestamp(line, None) {
                        ins_ts
                            .execute(params![(first_line + line_no) as i64, ext.ts])
                            .unwrap();
                    }
                    if end == bytes.len() {
                        break;
                    }
                    pos = end + 1;
                    line_no += 1;
                }
                ins_file
                    .execute(params![fid, rel, first_line as i64, offsets])
                    .unwrap();
                total_lines += line_no + 1;
            }
        }
        tx.commit().unwrap();
        println!("[bench] 建库(ts 扫描 640 万行): {:?}", t1.elapsed());

        // ---- db_filters_batch 复刻 ----
        let root = dir.as_path();
        let t2 = Instant::now();
        let files: Vec<(i64, String, u32, Vec<u64>)> = files_snapshot(&conn)
            .unwrap()
            .into_iter()
            .map(|(fid, name, first_line)| {
                let off = load_line_offsets(&conn, fid).unwrap_or_default();
                (fid, name, first_line, off)
            })
            .collect();
        let ts_fmt = files.first().and_then(|(_fid, name, ..)| {
            std::fs::read(root.join(name)).ok().and_then(|b| {
                let s = String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]);
                let lines: Vec<&str> = s.split('\n').take(10).collect();
                detect_timestamp_format(&lines)
            })
        });
        println!(
            "[bench] snapshot+offsets+格式探测: {:?} (fmt={:?})",
            t2.elapsed(),
            ts_fmt.map(|f| f.id)
        );

        let queries = vec![
            FilterQuery {
                filter_id: "rawA".into(),
                pattern: "alpha".into(),
                is_regex: false,
                case_sensitive: false,
                scope: "raw".into(),
            },
            FilterQuery {
                filter_id: "msgP".into(),
                pattern: "payload".into(),
                is_regex: false,
                case_sensitive: false,
                scope: "message".into(),
            },
        ];
        let t3 = Instant::now();
        let per_filter = scan_filters_once(root, &files, &queries, ts_fmt).unwrap();
        println!(
            "[bench] scan(raw alpha + message payload,命中 {}/{}): {:?}",
            per_filter[0].len(),
            per_filter[1].len(),
            t3.elapsed()
        );
        assert!(
            per_filter[0].len() > 3_000_000,
            "raw 命中应 ~352 万,实际 {}",
            per_filter[0].len()
        );
        assert!(
            per_filter[1].len() > 3_000_000,
            "msg 命中应 ~352 万,实际 {}",
            per_filter[1].len()
        );

        let t4 = Instant::now();
        for (qi, q) in queries.iter().enumerate() {
            let lines = &per_filter[qi];
            conn.execute_batch("BEGIN").unwrap();
            let _ = conn.execute(
                "DELETE FROM filter_hits WHERE filter_id = ?1",
                params![q.filter_id],
            );
            let ins_sql = format!(
                "INSERT OR IGNORE INTO filter_hits(filter_id, line) VALUES {}",
                (0..500)
                    .map(|i| format!("(?{},?{})", i * 2 + 1, i * 2 + 2))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            {
                let mut ins_full = conn.prepare(&ins_sql).unwrap();
                let mut ins_one = conn
                    .prepare("INSERT OR IGNORE INTO filter_hits(filter_id, line) VALUES (?1, ?2)")
                    .unwrap();
                let fid: &str = &q.filter_id;
                let mut lv: Vec<i64> = Vec::with_capacity(500);
                for chunk in lines.chunks(500) {
                    if chunk.len() == 500 {
                        lv.clear();
                        lv.extend(chunk.iter().map(|&l| l as i64));
                        let mut bind: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(1000);
                        for k in 0..500 {
                            bind.push(&fid);
                            bind.push(&lv[k]);
                        }
                        ins_full.execute(bind.as_slice()).unwrap();
                    } else {
                        for &l in chunk {
                            ins_one.execute(params![q.filter_id, l as i64]).unwrap();
                        }
                    }
                }
            }
            conn.execute_batch("COMMIT").unwrap();
        }
        println!("[bench] INSERT 2×352 万行: {:?}", t4.elapsed());

        let t5 = Instant::now();
        let mut out: FilterBatchOut = Vec::new();
        for q in &queries {
            out.push((q.filter_id.clone(), filter_hits_join(&conn, &q.filter_id).unwrap()));
        }
        println!("[bench] JOIN(2 filter): {:?}", t5.elapsed());

        let t6 = Instant::now();
        let bytes = encode_filter_batch(&out);
        println!("[bench] encode: {:?} ({} MB)", t6.elapsed(), bytes.len() / 1048576);

        println!("[bench] 链路总耗时(scan 起): {:?}", t2.elapsed());
        std::fs::remove_dir_all(&dir).ok();
    }
}
