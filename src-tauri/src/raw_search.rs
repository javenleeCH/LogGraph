//! rg 引擎封装：grep-searcher（ripgrep 内核）直扫原文件。
//!
//! 职责：给定 pattern（子串/正则、大小写敏感）+ 目录，返回**全局行号**升序列表。
//! 行号映射：grep 的 1-based 文件内行号 - 1 + files.first_line → 全局行号。
//! grep-searcher 行切分（\n 计数）与 split('\n') 语义天然一致。

use grep_regex::RegexMatcherBuilder;
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
    let matcher = build_matcher(pattern, is_regex, case_sensitive)?;

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

    let mut all_hits: Vec<u32> = Vec::new();
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .crlf(true)
        .build();

    for (name, first_line) in files {
        let path = root.join(&name);
        let mut sink = LineCollector {
            first_line,
            out: Vec::new(),
        };
        // 读取失败跳过（与建库语义一致）
        let _ = searcher.search_path(&matcher, &path, &mut sink);
        all_hits.extend(sink.out);
    }

    // 跨文件按 first_line 顺序收集已天然升序；稳妥去重排序
    all_hits.sort_unstable();
    all_hits.dedup();
    Ok(all_hits)
}
