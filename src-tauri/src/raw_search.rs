//! rg 引擎封装：grep-searcher（ripgrep 内核）直扫原文件。
//!
//! 职责：给定 pattern（子串/正则、大小写敏感）+ 目录，返回**全局行号**升序列表。
//! 行号映射：grep 的 1-based 文件内行号 - 1 + files.first_line → 全局行号。
//! grep-searcher 行切分（\n 计数）与 split('\n') 语义天然一致。

use grep_regex::RegexMatcherBuilder;
use grep_matcher::LineTerminator;
use grep_searcher::{SearcherBuilder, Sink, SinkMatch};
use rusqlite::Connection;
use std::path::Path;

/// 收集命中行号的 Sink
struct LineCollector {
    /// 该文件首行全局行号
    first_line: u32,
    out: Vec<u32>,
}

impl Sink for LineCollector {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        if let Some(n) = mat.line_number() {
            // grep 行号 1-based → 0-based + 首行偏移
            let global = self.first_line + (n as u32 - 1);
            self.out.push(global);
        }
        Ok(true)
    }
}

/// 构建 matcher：子串 → regex 转义为字面量；大小写由 builder 控制（rg 同款折叠）
fn build_matcher(
    pattern: &str,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<grep_regex::RegexMatcher, String> {
    let expr = if is_regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    let mut b = RegexMatcherBuilder::new();
    b.case_insensitive(!case_sensitive);
    // CRLF（rg --crlf 同款）：让 ^ / $ 锚点按 Windows 换行语义编译。
    // 副作用：crlf(true) 会把 matcher 的 line_terminator 置为 CRLF，
    // 因此 searcher 侧必须同步设为 LineTerminator::crlf()——
    // 否则 Searcher::check_config 会报 MismatchedLineTerminators，
    // 且该错误会被 search_path 吞成 io::Error 被 `let _ =` 丢弃 → 静默零命中。
    b.crlf(true);
    b.build(&expr).map_err(|e| format!("构建 matcher 失败: {e}"))
}

/// rg 直扫目录内全部日志文件，返回命中**全局行号**升序列表。
pub(crate) fn search_dir(
    root: &Path,
    conn: &Connection,
    pattern: &str,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<u32>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    // 入口先编译一次校验 pattern 合法（线程内各自重建，失败即整体失败）
    build_matcher(pattern, is_regex, case_sensitive)?;

    // 文件清单（first_line 升序 = 全局行号升序）
    let files = {
        let mut stmt = conn
            .prepare("SELECT name, first_line FROM files ORDER BY first_line")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
            })
            .map_err(|e| e.to_string())?;
        rows.flatten().collect::<Vec<_>>()
    };

    // ---- 文件级并行（rg CLI 同款策略）：单线程串行扫描比 rg 慢一个核数倍 ----
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files.len())
        .max(1);

    let mut all_hits: Vec<u32> = if threads <= 1 {
        scan_files(root, &files, 0, 1, pattern, is_regex, case_sensitive)?
    } else {
        // 交错分配（stride）：files 按 first_line 升序，大文件天然分散到各线程
        let results: Vec<Result<Vec<u32>, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|t| {
                    scope.spawn(move || {
                        scan_files(root, &files, t, threads, pattern, is_regex, case_sensitive)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Ok(Vec::new()))).collect()
        });
        let mut out = Vec::new();
        for r in results {
            out.extend(r?);
        }
        out
    };

    // 跨文件按 first_line 顺序收集已天然升序；稳妥去重排序
    all_hits.sort_unstable();
    all_hits.dedup();
    Ok(all_hits)
}

/// 扫描 files 中 `idx % stride == offset` 的文件（线程任务体）。
/// 每线程独立 matcher/searcher（RegexMatcher 的 Sync 性不承担，重建成本 ~ms 级）。
fn scan_files(
    root: &Path,
    files: &[(String, u32)],
    offset: usize,
    stride: usize,
    pattern: &str,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<u32>, String> {
    let matcher = build_matcher(pattern, is_regex, case_sensitive)?;
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .line_terminator(LineTerminator::crlf())
        .build();
    let mut hits = Vec::new();
    for (name, first_line) in files.iter().skip(offset).step_by(stride) {
        let mut sink = LineCollector {
            first_line: *first_line,
            out: Vec::new(),
        };
        // 读取失败跳过（与建库语义一致）
        let _ = searcher.search_path(&matcher, &root.join(name), &mut sink);
        hits.extend(sink.out);
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个临时目录 + files 表（first_line 与 db.rs 的 split('\n') 语义一致）
    struct Fixture {
        dir: std::path::PathBuf,
    }

    impl Fixture {
        fn new(tag: &str, files: &[(&str, &str)]) -> (Fixture, Connection) {
            let dir = std::env::temp_dir().join(format!(
                "loggraph_raw_search_{tag}_{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();

            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE files (fid INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                                     first_line INTEGER NOT NULL);",
            )
            .unwrap();

            // 与 db.rs 建库同款：全局行号按 split('\n') 递增（尾随空行也计入）
            let mut next_line: u32 = 0;
            for (i, (name, content)) in files.iter().enumerate() {
                std::fs::write(dir.join(name), content.as_bytes()).unwrap();
                conn.execute(
                    "INSERT INTO files(fid, name, first_line) VALUES (?1, ?2, ?3)",
                    rusqlite::params![(i + 1) as i64, *name, next_line as i64],
                )
                .unwrap();
                next_line += content.split('\n').count() as u32;
            }
            (Fixture { dir }, conn)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// CRLF 文件：字面量命中行号必须与 split('\n') 全局行号一致
    #[test]
    fn crlf_literal_global_line_numbers() {
        let (f, conn) = Fixture::new(
            "lit",
            &[
                ("a.log", "alpha\r\nbeta\r\ngamma\r\n"), // 4 行（尾随空行）
                ("b.log", "beta again\r\n"),             // 首行全局行号 = 4
            ],
        );
        let hits = search_dir(&f.dir, &conn, "beta", false, true).unwrap();
        // a.log 第 2 行 → 全局 1；b.log 第 1 行 → 全局 4
        assert_eq!(hits, vec![1, 4]);
    }

    /// 大小写不敏感 / 正则匹配的基本行为
    #[test]
    fn case_insensitive_and_regex() {
        let (f, conn) = Fixture::new(
            "ci",
            &[("a.log", "ERROR: boom\nwarn: hmm\n"), ("b.log", "Info: ok\n")],
        );
        // 默认（case_sensitive=false）应命中 ERROR 与 warn 两行
        let hits = search_dir(&f.dir, &conn, "error|warn", true, false).unwrap();
        assert_eq!(hits, vec![0, 1]);
        // 大小写敏感：ERROR 不再命中，只剩小写 warn
        let hits = search_dir(&f.dir, &conn, "error|warn", true, true).unwrap();
        assert_eq!(hits, vec![1]);
    }

    /// CRLF 文件上的 `$` 锚点回归测试：若 matcher/searcher 两侧的 CRLF 配置
    /// 被单独改动（例如把 line_terminator 删掉），此用例会红。
    #[test]
    fn crlf_dollar_anchor_matches() {
        let (f, conn) = Fixture::new(
            "anchor",
            &[("a.log", "ok done\r\nstill running\r\n"), ("b.log", "done\r\n")],
        );
        // `$` 只应命中以 done 结尾的行：
        // a.log 第 1 行 → 全局 0；b.log 首行全局行号 = 3（a.log 占 3 个 split 行）
        let hits = search_dir(&f.dir, &conn, r"done$", true, true).unwrap();
        assert_eq!(hits, vec![0, 3]);
    }

    /// 空 pattern → 空结果（不触发任何扫描）
    #[test]
    fn empty_pattern_yields_nothing() {
        let (f, conn) = Fixture::new("empty", &[("a.log", "x\n")]);
        assert!(search_dir(&f.dir, &conn, "", false, true).unwrap().is_empty());
    }
}
