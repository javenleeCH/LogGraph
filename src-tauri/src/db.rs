//! v4 数据层：纯内存驻留，无逐行事件索引。
//!
//! 原始文件是唯一事实源。打开目录只做**便宜通道**（并行读 + 行偏移 + 行数/
//! 空行统计 + 首/末行 ts → 时间轴范围），不做逐行 ts 提取/排序/直查表——
//! 过滤扫描本就重读原文件，命中行的 ts 在扫描时内联解析（`line_ts_of`），
//! 索引里没有的信息扫描时顺手就有。
//!
//! 驻留结构：
//! - `files`：文件清单 + 每文件首行全局行号 + 每行字节偏移（seek 直读用）
//! - `range`：时间轴范围（各文件首/末行 ts 的全局 min/max）
//! - `filter_hits`：filter_id → 升序 (line, ts) 命中（`Mutex<HashMap>`，扫描后写入）
//!
//! 上下文/详情：按行偏移 seek 直读原文件片段（不整文件重读）。
//! 命中/视口行文本走 `tauri::ipc::Response` 二进制通道（SoA，前端零对象解析）。
//! 无磁盘缓存——每次打开目录全量重建（便宜通道实测 ~0.3s/GB 级）。

use crate::parser::timestamp::{detect_timestamp_format, extract_timestamp, TsFormat};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use parking_lot::{Mutex, RwLock};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

// ---- DTO ----

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

/// 命中条目（line + ts）：过滤扫描内联解析写入 filter_hits（ts = NO_TS 表示该行无 ts）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HitEntry {
    pub line: u32,
    pub ts: i64,
}

/// 过滤参数（对齐前端 Filter 匹配字段）
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterQuery {
    pub filter_id: String,
    pub pattern: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    /// raw=整行；message=时间戳后正文
    pub scope: String,
}

// ---- 内存库 ----

/// 命中行的「无时间戳」哨兵（该行时间线上无位置）
const NO_TS: i64 = i64::MIN;

pub(crate) struct FileEntry {
    /// 相对路径
    pub name: String,
    /// 该文件首行的全局行号
    pub first_line: u32,
    /// 每行起始字节偏移；行 i 字节区间 = [off[i], off[i+1] 或文件尾)
    pub offsets: Arc<Vec<u64>>,
}

/// filter 命中缓存：filter_id → 升序 (line, ts) 命中 + 定义指纹（命中则免重扫）
#[derive(Default)]
struct FilterCache {
    hits: HashMap<String, Arc<Vec<HitEntry>>>,
    fps: HashMap<String, String>,
}

/// 打开目录后的内存库。骨架（files/行偏移/行数）建库后不可变；
/// filter 命中缓存在内层 Mutex 中增删。
pub(crate) struct MemDb {
    root: PathBuf,
    /// first_line 升序
    pub(crate) files: Vec<FileEntry>,
    pub(crate) total_lines: u32,
    pub(crate) skipped: u32,
    /// 时间轴范围：各文件首/末行 ts 的全局 min/max（无任何 ts → None）。
    /// 逐行事件索引已移除——命中 ts 在过滤扫描时内联解析（见 line_ts_of）。
    pub(crate) range: Option<(i64, i64)>,
    pub(crate) fmt: Option<&'static TsFormat>,
    filters: Mutex<FilterCache>,
}

static MEM_DB: LazyLock<RwLock<Option<Arc<MemDb>>>> = LazyLock::new(|| RwLock::new(None));

/// 取当前库的 Arc 快照：读锁瞬时持有，命令执行期间不阻塞其它命令
pub(crate) fn current_db() -> Result<Arc<MemDb>, String> {
    MEM_DB
        .read()
        .clone()
        .ok_or_else(|| "目录未打开".into())
}

/// 全局行号 → (文件下标, 绝对路径, 文件内行号)。files 按 first_line 升序，二分定位。
fn locate(db: &MemDb, global_line: u32) -> Result<(usize, PathBuf, u32), String> {
    let files = &db.files;
    if files.is_empty() {
        return Err("文件清单为空".into());
    }
    let mut lo = 0usize;
    let mut hi = files.len();
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if files[mid].first_line <= global_line {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let f = &files[lo];
    if global_line < f.first_line {
        return Err(format!(
            "行号 {global_line} 越界（首个文件起始 {}）",
            f.first_line
        ));
    }
    if let Some(next) = files.get(lo + 1) {
        if global_line >= next.first_line {
            return Err(format!("行号 {global_line} 落在文件间隙"));
        }
    }
    Ok((lo, db.root.join(&f.name), global_line - f.first_line))
}

/// 命中(含 NO_TS) → 有效 (line, ts)[]，按 (ts, line) 升序。无 ts 命中被丢弃
/// （时间线上无位置，与旧版事件 SoA JOIN 语义一致）。
pub(crate) fn hits_with_ts(hits: &[HitEntry]) -> Vec<HitEntry> {
    let mut out: Vec<HitEntry> = hits.iter().filter(|h| h.ts != NO_TS).cloned().collect();
    out.sort_unstable_by_key(|h| (h.ts, h.line));
    out
}

/// 取某 filter 的命中快照（Arc clone，锁瞬时持有）
pub(crate) fn filter_hits(db: &MemDb, filter_id: &str) -> Option<Arc<Vec<HitEntry>>> {
    db.filters
        .lock()
        .hits
        .get(filter_id)
        .cloned()
}

/// 测试 fixture：最小内存库（无文件骨架，命中由 set_filter_hits 注入）
#[cfg(test)]
pub(crate) fn test_db() -> MemDb {
    MemDb {
        root: PathBuf::from("."),
        files: Vec::new(),
        total_lines: 0,
        skipped: 0,
        range: None,
        fmt: None,
        filters: Mutex::new(FilterCache::default()),
    }
}

/// 测试 fixture：写入 filter 命中（(line, ts) 集合）
#[cfg(test)]
pub(crate) fn set_filter_hits(db: &MemDb, filter_id: &str, hits: &[(u32, i64)]) {
    let v: Vec<HitEntry> = hits
        .iter()
        .map(|&(line, ts)| HitEntry { line, ts })
        .collect();
    db.filters
        .lock()
        .hits
        .insert(filter_id.to_string(), Arc::new(v));
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
            // .logGraph 是本应用的工作区目录（filters.json / perf 日志），
            // 绝不当作日志源索引：其中的残留文件会参与格式探测（首个文件），
            // 一旦格式不符会让整个目录的时间戳解析失效（事件全丢）
            if name == ".logGraph" {
                continue;
            }
            walk_log_files(&path, &rel, depth + 1, out);
        } else if is_log_file_name(&name) {
            out.push(rel);
        }
    }
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

// ---- 行偏移 seek 读取 ----

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

// ---- 建库（便宜通道：读 + 行偏移 + 计数 + 首/末行 ts） ----

/// 行 ts 提取：bytes[s..e) 为一行（不含 \n，可能含 \r），整行 lossy 后提取。
/// 与旧版事件索引逐字节同语义（整行搜索，时间戳可在行内任意位置——
/// 长前缀行如 `LEVEL [very.long.module.path] 2024-01-01 ...` 的 ts 远超 64B）；
/// 合法 UTF-8 下 from_utf8_lossy 为零拷贝，仅命中行付费。无 ts → NO_TS。
fn line_ts_of(bytes: &[u8], s: usize, e: usize, fmt: Option<&TsFormat>) -> i64 {
    let mut end = e;
    if end > s && bytes[end - 1] == b'\r' {
        end -= 1;
    }
    let line = String::from_utf8_lossy(&bytes[s..end]);
    extract_timestamp(&line, fmt).map(|x| x.ts).unwrap_or(NO_TS)
}

/// 读文件头部（最多 max 字节，UTF-8 lossy）；时间戳格式探测用，避免为探测整读首文件。
fn read_head_lossy(path: &Path, max: usize) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; max];
    let mut filled = 0usize;
    while filled < buf.len() {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(k) => filled += k,
            Err(e) => return Err(e.to_string()),
        }
    }
    buf.truncate(filled);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 扫描目录建内存库（便宜通道）。emit(loaded, total, current) 报告逐文件进度。
///
/// 文件级并行 worker 池：读 + 行偏移 + 空行计数 + 首/末行 ts。
/// **不做**逐行 ts 提取/事件排序/行号直查表——过滤扫描本就重读原文件，
/// 命中行的 ts 扫描时内联解析（`line_ts_of`）；时间轴范围取各文件首/末行
/// ts 的全局 min/max（时间序日志 = 精确值；乱序日志近似，命中点渲染不受影响）。
fn build_mem_db(
    root: &Path,
    names: &[String],
    mut emit: impl FnMut(usize, usize, &str) + Send,
) -> Result<MemDb, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 单文件扫描产物
    struct FileOut {
        name: String,
        offsets: Vec<u64>,
        skipped: u32,
        first_ts: Option<i64>,
        last_ts: Option<i64>,
    }

    // 格式探测：仅首个文件头 1MB 的前 100 个非空行（读失败 → None = 全格式回退）
    let fmt: Option<&'static TsFormat> = names.first().and_then(|rel| {
        let head = read_head_lossy(&root.join(rel), 1024 * 1024).ok()?;
        let sample: Vec<&str> = head
            .split('\n')
            .take(100)
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .filter(|l| !js_trim(l).is_empty())
            .collect();
        detect_timestamp_format(&sample)
    });

    let n = names.len();
    let threads = std::thread::available_parallelism()
        .map(|c| c.get())
        .unwrap_or(4)
        .min(n.max(1))
        .max(1);
    let cursor = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let emit_m = Mutex::new(&mut emit);
    let mut slots: Vec<Option<FileOut>> = (0..n).map(|_| None).collect();

    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    // 成果攒本地、汇合后按索引回填（免每槽加锁）
                    let mut mine: Vec<(usize, FileOut)> = Vec::new();
                    loop {
                        let i = cursor.fetch_add(1, Ordering::Relaxed);
                        if i >= n {
                            break;
                        }
                        let rel = &names[i];
                        let Ok(bytes) = std::fs::read(root.join(rel)) else {
                            continue; // 读取失败跳过（建库/扫描同语义）
                        };
                        // 单趟行扫描：行起始偏移（与 split('\n') 分段语义一致，
                        // 尾部换行会产生一个末尾空行段）+ 空行计数
                        let mut offsets: Vec<u64> =
                            Vec::with_capacity(64 + bytes.len() / 16 * 8);
                        let mut skipped: u32 = 0;
                        let mut pos = 0usize;
                        loop {
                            let start = pos;
                            let end = match bytes[pos..].iter().position(|&b| b == b'\n') {
                                Some(k) => pos + k,
                                None => bytes.len(),
                            };
                            offsets.push(start as u64);
                            if js_trim_bytes(&bytes[start..end]).is_empty() {
                                skipped += 1;
                            }
                            if end == bytes.len() {
                                break;
                            }
                            pos = end + 1;
                        }
                        // 首/末行 ts（时间轴范围）：首行 + 尾部回找首个有 ts 的
                        // 非空行（≤8 行，尾空段跳过）
                        let line_span = |li: usize| -> (usize, usize) {
                            let s = offsets[li] as usize;
                            let e = if li + 1 < offsets.len() {
                                offsets[li + 1] as usize - 1 // 剥 \n
                            } else {
                                bytes.len()
                            };
                            (s, e)
                        };
                        let first_ts = {
                            let (s, e) = line_span(0);
                            let ts = line_ts_of(&bytes, s, e, fmt);
                            (ts != NO_TS).then_some(ts)
                        };
                        let mut last_ts: Option<i64> = None;
                        for li in (0..offsets.len()).rev().take(8) {
                            let (s, e) = line_span(li);
                            if js_trim_bytes(&bytes[s..e]).is_empty() {
                                continue;
                            }
                            let ts = line_ts_of(&bytes, s, e, fmt);
                            if ts != NO_TS {
                                last_ts = Some(ts);
                                break;
                            }
                        }
                        mine.push((
                            i,
                            FileOut {
                                name: rel.clone(),
                                offsets,
                                skipped,
                                first_ts,
                                last_ts,
                            },
                        ));
                        let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                        (emit_m.lock())(d, n, rel);
                    }
                    mine
                })
            })
            .collect();
        for h in handles {
            for (i, out) in h.join().map_err(|_| "建库 worker 崩溃".to_string())? {
                slots[i] = Some(out);
            }
        }
        Ok::<(), String>(())
    })?;

    // ---- 汇合（串行 O(文件数)）：first_line 前缀 + 范围 min/max ----
    let mut files: Vec<FileEntry> = Vec::with_capacity(n);
    let mut total_lines: u32 = 0;
    let mut skipped: u32 = 0;
    let mut range: Option<(i64, i64)> = None;
    let fold = |ts: i64, range: &mut Option<(i64, i64)>| {
        *range = Some(match *range {
            None => (ts, ts),
            Some((lo, hi)) => (lo.min(ts), hi.max(ts)),
        });
    };
    for out in slots.into_iter().flatten() {
        let first_line = total_lines;
        total_lines += out.offsets.len() as u32;
        skipped += out.skipped;
        if let Some(ts) = out.first_ts {
            fold(ts, &mut range);
        }
        if let Some(ts) = out.last_ts {
            fold(ts, &mut range);
        }
        files.push(FileEntry {
            name: out.name,
            first_line,
            offsets: Arc::new(out.offsets),
        });
    }

    Ok(MemDb {
        root: root.to_path_buf(),
        files,
        total_lines,
        skipped,
        range,
        fmt,
        filters: Mutex::new(FilterCache::default()),
    })
}

/// 打开目录（便宜通道建库：读 + 行偏移 + 计数 + 首/末行 ts；无磁盘缓存）。
#[tauri::command]
pub async fn db_open(app: tauri::AppHandle, dir: String) -> Result<DbOpenResult, String> {
    use tauri::Emitter;

    tauri::async_runtime::spawn_blocking(move || {
        let t0 = Instant::now();
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
        // .logGraph 工作区目录（filters.json 持久化 + perf 日志）
        std::fs::create_dir_all(root.join(".logGraph"))
            .map_err(|e| format!("创建工作区目录失败: {e}"))?;

        let file_count = names.len() as u32;
        let db = build_mem_db(&root, &names, |loaded, total, current| {
            let _ = app.emit(
                "db_build_progress",
                serde_json::json!({ "loaded": loaded, "total": total, "current": current }),
            );
        })?;
        let total_lines = db.total_lines;
        let skipped = db.skipped;
        let fmt_id = db.fmt.map(|f| f.id.to_string());
        let (range_start, range_end) = match db.range {
            Some((s, e)) => (Some(s), Some(e)),
            None => (None, None),
        };

        // 骨架字节数（内存基准：offsets；命中缓存另计）
        let mem_bytes = db.files.iter().map(|f| f.offsets.len() * 8).sum::<usize>();
        perf_log(
            &root,
            &format!(
                "open: {file_count} files, {total_lines} lines, skipped {skipped}, skeleton {} MB, {:?}",
                mem_bytes / 1048576,
                t0.elapsed()
            ),
        );

        *MEM_DB.write() = Some(Arc::new(db));
        Ok(DbOpenResult {
            cache_hit: false,
            total_lines,
            skipped,
            file_count,
            timestamp_format_id: fmt_id,
            range_start,
            range_end,
        })
    })
    .await
    .map_err(|e| format!("db_open 任务失败: {e}"))?
}

// ---- 过滤：批量直扫 + 内存命中缓存 ----

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
///   不同 pattern 数，prefilter 后每趟 ~0.3s/GB）。
/// - 命中 match → line_offsets 二分行号；同行多 match 由「上一个行号」去重
///   （match 按位置升序）。
/// - message scope：expr 粗筛（msg ⊆ line，整行命中是必要条件）收集候选
///   行去重后精筛——ts 只在前 64B 前缀提取（**指定格式**单次调用，探测
///   失败/格式突变回退全格式），msg 域字节级匹配（免整行 utf8 转换）。
///   无 ts 行 message 域为空 → 不可能命中。
/// - ^/$ 以 multi_line 语义锚定行边界；CRLF 行尾 `$` 与 \r 相邻的边缘
///   差异不处理。
/// - 每文件单线程、行号升序 → 免 sort/dedup（msg 候选除外，跨 expr 需去重）。
/// - 命中行 ts **内联解析**（`line_ts_of`，仅命中行付费；无逐行事件索引）。
/// 返回与 queries 同序的命中列表（line 升序；ts = NO_TS 表示该行无 ts）。
#[allow(clippy::type_complexity)]
fn scan_filters_once(
    root: &Path,
    files: &[FileEntry],
    queries: &[FilterQuery],
    ts_fmt: Option<&'static TsFormat>,
) -> Result<Vec<Vec<HitEntry>>, String> {
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
    let perf: Arc<Mutex<Vec<String>>> = Default::default();

    // ---- 文件级并行（stride 交错，first_line 升序 → 大文件分散） ----
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files.len())
        .max(1);
    let n_q = queries.len();
    let scan = |part: &[FileEntry]| -> Vec<Vec<HitEntry>> {
        let mut buckets: Vec<Vec<HitEntry>> = (0..n_q).map(|_| Vec::new()).collect();
        for fe in part {
            let t_read = Instant::now();
            let Ok(bytes) = std::fs::read(root.join(&fe.name)) else {
                continue; // 读取失败跳过（与建库语义一致）
            };
            let ms_read = t_read.elapsed().as_millis();
            // 行起始偏移：直接借用建库时的 Arc 偏移（零拷贝）；
            // 空/越界（异常）→ 手扫 \n 兜底
            let offsets = &fe.offsets;
            let fallback: Vec<u64>;
            let starts: &[u64] = if !offsets.is_empty()
                && offsets[0] == 0
                && *offsets.last().unwrap() <= bytes.len() as u64
            {
                offsets
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
                fallback = v;
                &fallback
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
                    let global = fe.first_line + li as u32;
                    let mut need_msg = false;
                    // 惰性 ts：仅存在 raw（非 msg）归属时才解析（msg 精筛时另解析）
                    let mut hit_ts = NO_TS;
                    let mut ts_ready = false;
                    for &(qi, is_msg) in &raw_slots[ei] {
                        if is_msg {
                            need_msg = true;
                        } else {
                            if !ts_ready {
                                let s = starts[li] as usize;
                                let e = if li + 1 < starts.len() {
                                    starts[li + 1] as usize - 1 // 剥 \n
                                } else {
                                    bytes.len()
                                };
                                hit_ts = line_ts_of(&bytes, s, e, ts_fmt);
                                ts_ready = true;
                            }
                            buckets[qi].push(HitEntry { line: global, ts: hit_ts });
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
                    // 命中 ts 内联解析（fmt-only，与旧版 JOIN 语义一致；
                    // ext 仅用于域切分——带全格式回退，不可复用）
                    let hit_ts = line_ts_of(&bytes, s, e, ts_fmt);
                    for (mi, mre) in msg_regexes.iter().enumerate() {
                        if mre.is_match(msg) {
                            for &qi in &msg_slots[mi] {
                                buckets[qi].push(HitEntry { line: global, ts: hit_ts });
                            }
                        }
                    }
                }
            }
            {
                let mut v = perf.lock();
                v.push(format!(
                    "scan {} {:.1}MB read={}ms iter={}ms msg={:?} hits={raw_hits} cand={n_cand}",
                    fe.name,
                    bytes.len() as f64 / 1048576.0,
                    ms_read,
                    ms_iter,
                    t_msg.elapsed()
                ));
            }
        }
        buckets
    };
    let results: Vec<Vec<Vec<HitEntry>>> = if threads <= 1 {
        vec![scan(files)]
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|t| {
                    // Arc clone（offsets 不复制），stride 均摊大文件
                    let part: Vec<FileEntry> = files
                        .iter()
                        .skip(t)
                        .step_by(threads)
                        .map(|fe| FileEntry {
                            name: fe.name.clone(),
                            first_line: fe.first_line,
                            offsets: Arc::clone(&fe.offsets),
                        })
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
    let mut per_filter: Vec<Vec<HitEntry>> = (0..n_q).map(|_| Vec::new()).collect();
    for b in results {
        for (qi, v) in b.into_iter().enumerate() {
            per_filter[qi].extend(v);
        }
    }
    // 行号升序:多线程 stride 合并后乱序
    for v in per_filter.iter_mut() {
        v.sort_unstable_by_key(|h| h.line);
    }
    // 每文件计时落地(一次写;目录无 .logGraph 时静默跳过——测试用例)
    {
        let logs = perf.lock();
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
/// （目录变化由重新打开目录全量重建保证，无需纳入。）
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

/// 批量过滤器查询结果（命令内聚合，最终编码为二进制 IPC 响应）：
/// (filter_id, (line, ts)[] 按 ts 升序)
type FilterBatchOut = Vec<(String, Vec<HitEntry>)>;

/// 结果编码（二进制，~12B/命中；百万级命中走 JSON 会到 100MB+ 且
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

/// 批量运行过滤器（recomputeMatches / 单 filter 编辑共用）：
/// 1. 逐个比对定义指纹——命中的直接取内存命中（不扫描）；
/// 2. miss 的单遍批量直扫原文件，结果写入内存命中缓存；
/// 3. 命中行关联事件 ts 编码为二进制返回。
#[tauri::command]
pub async fn db_filters_batch(
    queries: Vec<FilterQuery>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let t0 = Instant::now();
        let db = current_db()?;
        let root = db.root.clone();
        perf_log(
            &root,
            &format!("---- db_filters_batch: {} queries ----", queries.len()),
        );

        let mut out: FilterBatchOut = Vec::new();
        let mut miss: Vec<FilterQuery> = Vec::new();
        {
            let fc = db.filters.lock();
            for q in &queries {
                let hit = fc
                    .fps
                    .get(&q.filter_id)
                    .map(|s| s == &filter_def_fp(q))
                    .unwrap_or(false)
                    .then(|| fc.hits.get(&q.filter_id).cloned())
                    .flatten();
                match hit {
                    Some(h) => out.push((q.filter_id.clone(), hits_with_ts(&h))),
                    None => miss.push(q.clone()),
                }
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
            let t = Instant::now();
            // 建库时已探测格式（v2 每次重读首文件 10 行，此处直接复用）
            let ts_fmt = db.fmt;
            let mut per_filter = scan_filters_once(&root, &db.files, &miss, ts_fmt)?;
            let scan_ms = t.elapsed();
            let t = Instant::now();
            let mut fc = db.filters.lock();
            for (qi, q) in miss.iter().enumerate() {
                let hits = Arc::new(std::mem::take(&mut per_filter[qi]));
                fc.fps.insert(q.filter_id.clone(), filter_def_fp(q));
                fc.hits.insert(q.filter_id.clone(), Arc::clone(&hits));
                out.push((q.filter_id.clone(), hits_with_ts(&hits)));
            }
            drop(fc);
            perf_log(
                &root,
                &format!(
                    "store+join: {} miss filters, hits {:?}, {:?} (scan {:?})",
                    miss.len(),
                    out.iter().map(|(_, h)| h.len()).collect::<Vec<_>>(),
                    t.elapsed(),
                    scan_ms
                ),
            );
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

/// 删除一个 filter 的命中（filter 被删时调用）
#[tauri::command]
pub async fn db_filter_drop(filter_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = current_db()?;
        let mut fc = db.filters.lock();
        fc.hits.remove(&filter_id);
        fc.fps.remove(&filter_id);
        // 多行子条件下推的 sub 缓存（fid\u{0}i）一并清理，避免编辑/删除后残留累积
        let prefix = format!("{filter_id}\u{0}");
        fc.hits.retain(|k, _| !k.starts_with(&prefix));
        fc.fps.retain(|k, _| !k.starts_with(&prefix));
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
        let (fi, path, local) = locate(&db, no)?;
        let offsets = &db.files[fi].offsets;
        read_line_range(&path, offsets, local, local)?
            .into_iter()
            .next()
            .ok_or_else(|| format!("行号越界: {no}"))
    })
    .await
    .map_err(|e| format!("db_line 任务失败: {e}"))?
}

/// 视口行文本：按全局行号集合取行（任意顺序；内部排序去重）。
/// 同文件行号 gap<=64 合并成一整段 seek 读取（段内多余行无害，调用方按需取用）。
/// 返回原始字节：`[count: u32][pad: u32] + 每行 [line: u32][len: u32][utf-8 bytes]`
#[tauri::command]
pub async fn db_lines_by_ids(ids: Vec<u32>) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if ids.is_empty() {
            return Ok(vec![0u8; 8]);
        }
        let db = current_db()?;
        let root = &db.root;
        let files = &db.files;
        let mut sorted = ids;
        sorted.sort_unstable();
        sorted.dedup();

        let mut rows: Vec<(u32, String)> = Vec::with_capacity(sorted.len());
        let mut i = 0usize;
        let mut fi = 0usize; // files 与 sorted 均升序 → 双指针
        while i < sorted.len() {
            let line = sorted[i];
            while fi + 1 < files.len() && files[fi + 1].first_line <= line {
                fi += 1;
            }
            let fe = &files[fi];
            let file_limit = files.get(fi + 1).map(|f| f.first_line).unwrap_or(u32::MAX);
            let mut j = i;
            while j < sorted.len() && sorted[j] < file_limit {
                j += 1;
            }
            if line < fe.first_line {
                i = j;
                continue;
            }
            let locals: Vec<u32> = sorted[i..j].iter().map(|&l| l - fe.first_line).collect();
            let segs = merge_line_segments(&locals, 64);
            for (lo, hi) in segs {
                if let Ok(texts) = read_line_range(&root.join(&fe.name), &fe.offsets, lo, hi) {
                    for (k, text) in texts.into_iter().enumerate() {
                        rows.push((fe.first_line + lo + k as u32, text));
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
/// 命中缓存自带 ts（扫描时内联解析）——直接按窗口过滤，无事件索引查询。
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
        let db = current_db()?;
        // 命中并集（各 filter line 升序 → 归并后 sort+dedup；无 ts 命中自然出局）
        let mut out: Vec<u32> = Vec::new();
        for fid in &filter_ids {
            if let Some(h) = filter_hits(&db, fid) {
                out.extend(
                    h.iter()
                        .filter(|e| e.ts != NO_TS && e.ts >= start && e.ts <= end)
                        .map(|e| e.line),
                );
            }
        }
        if out.is_empty() {
            return Ok(Vec::new());
        }
        out.sort_unstable();
        out.dedup();
        Ok(out)
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
        let db = current_db()?;
        Ok(db
            .files
            .iter()
            .map(|fe| DbFileInfo {
                first_line: fe.first_line,
                path: db.root.join(&fe.name).to_string_lossy().into_owned(),
                name: fe.name.clone(),
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

    fn fe(name: &str, first_line: u32, text: &str) -> FileEntry {
        FileEntry {
            name: name.into(),
            first_line,
            offsets: Arc::new(scan_offsets(text)),
        }
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
    fn line_ts_of_whole_line_semantics() {
        // 回归：时间戳不在行首的行（前缀 > 64B）——旧版事件索引对整行提取能命中，
        // v4 曾误用 64B 前缀窗口 → NO_TS → 命中从时间轴/序列匹配中消失
        let fmt = detect_timestamp_format(&["2024-01-01 09:00:00.000 x"]).unwrap();
        // 70B 前缀：ts 起点在 64B 窗口之外
        let line = format!("{}2024-01-01 09:00:05.123 tail", "L".repeat(70));
        let b = line.as_bytes();
        assert_ne!(line_ts_of(b, 0, b.len(), Some(fmt)), NO_TS);
        // ts 在行首（常规日志）不受影响
        let head = "2024-01-01 09:00:05.123 hello";
        assert_ne!(
            line_ts_of(head.as_bytes(), 0, head.len(), Some(fmt)),
            NO_TS
        );
        // 无 ts 行 → NO_TS
        let none = "no timestamp in this line at all";
        assert_eq!(line_ts_of(none.as_bytes(), 0, none.len(), Some(fmt)), NO_TS);
        // CRLF：\r 不影响提取
        let crlf = "2024-01-01 09:00:05.123 x\r\n";
        assert_ne!(
            line_ts_of(crlf.as_bytes(), 0, crlf.len() - 1, Some(fmt)),
            NO_TS
        );
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
        let files = vec![fe("a.log", 0, a_text), fe("b.log", 4, b_text)];
        let q = |id: &str, pattern: &str, is_regex: bool, cs: bool, scope: &str| FilterQuery {
            filter_id: id.into(),
            pattern: pattern.into(),
            is_regex,
            case_sensitive: cs,
            scope: scope.into(),
        };
        // 多 filter 单遍：raw/message/字面量/正则混合，结果正确分桶
        let lines = |v: &Vec<HitEntry>| -> Vec<u32> { v.iter().map(|h| h.line).collect() };
        let queries = vec![
            q("msg", "hello", false, true, "message"), // msg 域 → 0,2,4
            q("raw", "plain", false, true, "raw"),     // 整行 → 1
            q("re", "wor.d", true, true, "message"),   // 正则 msg → 2
        ];
        let r = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(lines(&r[0]), vec![0, 2, 4]);
        assert_eq!(lines(&r[1]), vec![1]); // 无 ts 行命中 → ts = NO_TS
        assert_eq!(r[1][0].ts, NO_TS);
        assert_eq!(lines(&r[2]), vec![2]);
        // 有 ts 命中行：ts 内联解析（fmt=None → 全格式）
        assert_eq!(r[2][0].ts, 1704103201000);
        // 大小写不敏感（(?i) 折叠）：message + raw 两种 scope
        let queries = vec![
            q("m", "HELLO", false, false, "message"),
            q("r", "ALPHA", false, false, "raw"),
        ];
        let r = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(lines(&r[0]), vec![0, 2, 4]);
        assert_eq!(lines(&r[1]), vec![0, 4]);
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
        assert_eq!(lines(&r[0]), vec![0, 2, 4]);
        assert_eq!(lines(&r[1]), vec![0, 2, 4]);
        // ^/$ 按行边界锚定（multi_line）：「no ts」仅在行 1 行尾
        let r = scan_filters_once(&dir, &files, &[q("a", "no ts$", true, true, "raw")], None)
            .unwrap();
        assert_eq!(lines(&r[0]), vec![1]);
        // 空行（两文件尾空段 = 全局行 3、5）：^$ 只命中空行
        let r = scan_filters_once(&dir, &files, &[q("e", "^$", true, true, "raw")], None)
            .unwrap();
        assert_eq!(lines(&r[0]), vec![3, 5]);
        std::fs::remove_dir_all(&dir).unwrap();
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
    fn hits_with_ts_orders_by_ts_and_drops_no_ts() {
        // 行 10/20/30 有 ts；行 99 无 ts（命中也被丢弃）
        let hits = vec![
            HitEntry { line: 30, ts: 300 },
            HitEntry { line: 99, ts: NO_TS },
            HitEntry { line: 10, ts: 200 },
            HitEntry { line: 20, ts: 100 },
        ];
        let out = hits_with_ts(&hits);
        assert_eq!(
            out.iter().map(|h| (h.line, h.ts)).collect::<Vec<_>>(),
            vec![(20, 100), (10, 200), (30, 300)]
        );
        assert!(hits_with_ts(&[]).is_empty());
    }

    #[test]
    fn build_mem_db_excludes_loggraph_and_builds_range() {
        let dir = tmp_dir("build");
        std::fs::create_dir_all(dir.join(".logGraph")).unwrap();
        std::fs::write(
            dir.join("a.log"),
            "2024-01-01 10:00:00.000 alpha\nplain line\n2024-01-01 10:00:01.000 beta\n",
        )
        .unwrap();
        std::fs::write(dir.join(".logGraph").join("junk.log"), "1791550151000 epoch junk\n").unwrap();
        let mut names = Vec::new();
        walk_log_files(&dir, "", 0, &mut names);
        names.sort();
        assert_eq!(names, vec!["a.log".to_string()]); // .logGraph 被排除

        let db = build_mem_db(&dir, &names, |_, _, _| {}).unwrap();
        assert_eq!(db.total_lines, 4); // 3 行 + 尾空段
        assert_eq!(db.skipped, 1); // 尾空段为空行
        assert_eq!(
            db.range,
            Some((1704103200000, 1704103201000)) // 首行/末行 ts（Date.UTC 无时区修正）
        );
        // 偏移：split('\n') 分段语义（与串行版一致）
        assert_eq!(db.files[0].offsets.len(), 4);
        assert_eq!(db.files[0].offsets[0], 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 大规模基准(用户实测复现):`cargo test --release bench_db_filters_scale -- --ignored --nocapture`
    /// 复刻 db_filters_batch 全链路(建库→scan→join→encode)，分阶段计时。
    /// 纯内存版：另报告驻留字节数（磁盘缓存选型的核心输入）。
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

        // ---- 建库（复刻 db_open）----
        let t1 = Instant::now();
        let mut names: Vec<String> = Vec::new();
        walk_log_files(&dir, "", 0, &mut names);
        names.sort();
        let db = build_mem_db(&dir, &names, |_, _, _| {}).unwrap();
        println!(
            "[bench] 建库(便宜通道: 读+偏移+计数 {} 万行): {:?}",
            db.total_lines / 10000,
            t1.elapsed()
        );
        let offsets_b: usize = db.files.iter().map(|f| f.offsets.len() * 8).sum();
        println!("[bench] 驻留: offsets {} MB, range {:?}", offsets_b / 1048576, db.range);

        // ---- db_filters_batch 复刻 ----
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
        let per_filter = scan_filters_once(&dir, &db.files, &queries, db.fmt).unwrap();
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

        let t5 = Instant::now();
        let mut out: FilterBatchOut = Vec::new();
        {
            let mut fc = db.filters.lock();
            for (qi, q) in queries.iter().enumerate() {
                let hits = Arc::new(per_filter[qi].clone());
                fc.fps.insert(q.filter_id.clone(), filter_def_fp(q));
                fc.hits.insert(q.filter_id.clone(), Arc::clone(&hits));
                out.push((q.filter_id.clone(), hits_with_ts(&hits)));
            }
        }
        println!("[bench] join(2 filter, 含无 ts 过滤): {:?}", t5.elapsed());

        let t6 = Instant::now();
        let bytes = encode_filter_batch(&out);
        println!("[bench] encode: {:?} ({} MB)", t6.elapsed(), bytes.len() / 1048576);
        println!("[bench] 命中驻留: {} MB", per_filter.iter().map(|v| v.len() * 4).sum::<usize>() / 1048576);

        // 复查（fp 命中路径）
        let t7 = Instant::now();
        let fc = db.filters.lock();
        let mut warm = 0usize;
        for q in &queries {
            if fc.fps.get(&q.filter_id).map(|s| s == &filter_def_fp(q)).unwrap_or(false) {
                warm += fc.hits.get(&q.filter_id).map(|h| h.len()).unwrap_or(0);
            }
        }
        println!("[bench] 复查(fp 命中 {} 行): {:?}", warm, t7.elapsed());

        println!("[bench] 链路总耗时(scan 起): {:?}", t3.elapsed());
        std::fs::remove_dir_all(&dir).ok();
    }
}
