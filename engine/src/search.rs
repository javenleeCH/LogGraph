//! rg 能力：基于 grep-searcher（rg 内核：mmap + SIMD + memchr）+ grep-regex
//! 的多文件直扫。语义与命令行 rg 对齐：默认 Unicode 行模式、CRLF 自适应、
//! 命中二进制（NUL）即停。

use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, Sink, SinkMatch};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

/// 搜索模式（对齐前端 Filter 的关键字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pattern {
    /// 用户输入的关键词或正则
    pub pattern: String,
    #[serde(default)]
    pub case_sensitive: bool,
    /// false = 纯文本（自动转义元字符），true = 正则
    #[serde(default)]
    pub is_regex: bool,
}

impl Pattern {
    pub fn literal(s: impl Into<String>) -> Self {
        Pattern { pattern: s.into(), case_sensitive: true, is_regex: false }
    }
    pub fn regex(s: impl Into<String>) -> Self {
        Pattern { pattern: s.into(), case_sensitive: true, is_regex: true }
    }
    pub fn case_insensitive(mut self) -> Self {
        self.case_sensitive = false;
        self
    }
}

/// 单条命中（1-based 行号 + 去行尾终止符的文本）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub line_number: u64,
    pub text: String,
}

/// 单个文件的全部命中（文件内按行号升序）
#[derive(Debug, Clone, Serialize)]
pub struct FileHits {
    pub path: PathBuf,
    pub hits: Vec<Hit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchStats {
    pub files_searched: usize,
    pub files_with_matches: usize,
    pub matched_lines: u64,
    pub elapsed_ms: u128,
}

/// 把用户输入的纯文本转成正则字面量（grep-regex 未 re-export regex::escape）
fn escape_literal(s: &str) -> String {
    const META: &[char] = &['\\', '.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$'];
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if META.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl Pattern {
    /// 编译为 rg 同内核 matcher
    pub fn compile(&self) -> Result<RegexMatcher, String> {
        let expr = if self.is_regex {
            self.pattern.clone()
        } else {
            escape_literal(&self.pattern)
        };
        // 不固定 CRLF：searcher 默认按 LF 切行，CRLF 文件行尾残留的 \r
        // 在 sink 输出时统一 trim（matcher/searcher 双侧行终止符配置否则会冲突）
        RegexMatcherBuilder::new()
            .case_insensitive(!self.case_sensitive)
            .build(&expr)
            .map_err(|e| format!("非法正则 '{}': {e}", self.pattern))
    }
}

/// 收集命中行的 sink
struct CollectSink {
    hits: Vec<Hit>,
}

impl Sink for CollectSink {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let line_number = mat
            .line_number()
            .expect("非 multiline 模式下行号必然可用");
        // 非 multiline 模式下一次 matched 只有一行（含行终止符）
        let raw = mat.lines().next().unwrap_or_default();
        let text = String::from_utf8_lossy(raw);
        let text = text.trim_end_matches(['\r', '\n']).to_string();
        self.hits.push(Hit { line_number, text });
        Ok(true)
    }
}

fn new_searcher() -> Searcher {
    grep_searcher::SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build()
}

/// 直扫单个文件
pub fn search_file(path: impl AsRef<Path>, pattern: &Pattern) -> Result<FileHits, String> {
    let matcher = pattern.compile()?;
    search_file_with(path.as_ref(), &matcher)
}

fn search_file_with(path: &Path, matcher: &RegexMatcher) -> Result<FileHits, String> {
    let mut searcher = new_searcher();
    let mut sink = CollectSink { hits: Vec::new() };
    searcher
        .search_path(matcher, path, &mut sink)
        .map_err(|e| format!("扫描 {} 失败: {e}", path.display()))?;
    Ok(FileHits { path: path.to_path_buf(), hits: sink.hits })
}

/// 多文件并行直扫（按文件并行，文件内有序；输出顺序与输入一致）
pub fn search_all(paths: &[PathBuf], pattern: &Pattern) -> Result<(Vec<FileHits>, SearchStats), String> {
    let start = Instant::now();
    let matcher = Arc::new(pattern.compile()?);

    let results: Vec<Result<FileHits, String>> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(paths.len());
        for path in paths {
            let matcher = Arc::clone(&matcher);
            handles.push(scope.spawn(move || search_file_with(path, &matcher)));
        }
        handles.into_iter().map(|h| h.join().expect("扫描线程 panic")).collect()
    });

    let mut out = Vec::with_capacity(paths.len());
    for r in results {
        out.push(r?);
    }
    let stats = SearchStats {
        files_searched: paths.len(),
        files_with_matches: out.iter().filter(|f| !f.hits.is_empty()).count(),
        matched_lines: out.iter().map(|f| f.hits.len() as u64).sum(),
        elapsed_ms: start.elapsed().as_millis(),
    };
    Ok((out, stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_log(name: &str, body: &str) -> PathBuf {
        let mut p = std::env::temp_dir().join("loggraph_engine_test");
        std::fs::create_dir_all(&p).unwrap();
        p.push(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p
    }

    #[test]
    fn literal_case_sensitive() {
        let p = tmp_log("lit.log", "hello Error world\nno match here\nerror lowercase\n");
        let r = search_file(&p, &Pattern::literal("Error")).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].line_number, 1);
    }

    #[test]
    fn case_insensitive_matches_all() {
        let p = tmp_log("ci.log", "Error\nerror\nERROR\nfine\n");
        let r = search_file(&p, &Pattern::literal("error").case_insensitive()).unwrap();
        assert_eq!(r.hits.len(), 3);
    }

    #[test]
    fn regex_matches_and_meta_escaped() {
        let p = tmp_log("re.log", "a123b\n12.5 ms\n12.5.1 tag\n");
        // 正则：数字开头
        let r = search_file(&p, &Pattern::regex(r"^\d+\.\d+ ")).unwrap();
        assert_eq!(r.hits.iter().map(|h| h.line_number).collect::<Vec<_>>(), vec![2]);
        // 字面量里的 . 不应当通配
        let r2 = search_file(&p, &Pattern::literal("12.5")).unwrap();
        assert_eq!(r2.hits.len(), 2);
    }

    #[test]
    fn invalid_regex_reported() {
        let p = tmp_log("bad.log", "x\n");
        let r = search_file(&p, &Pattern::regex("(unclosed"));
        assert!(r.is_err());
    }
}
