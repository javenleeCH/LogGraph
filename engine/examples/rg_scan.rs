//! 引擎 rg 能力实测：cargo run -p loggraph-engine --example rg_scan -- <目录> [正则]
//! 枚举目录下全部日志文件并并行直扫，输出命中与统计（不建任何数据库）。
use loggraph_engine::search::{search_all, Pattern};
use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().unwrap_or_default() == ".logGraph" {
                continue;
            }
            walk(&p, out);
        } else if p.extension().map(|x| x == "log" || x == "txt").unwrap_or(false) {
            out.push(p);
        }
    }
}

fn main() {
    let dir = std::env::args().nth(1).expect("用法: rg_scan <日志目录> [正则]");
    let expr = std::env::args().nth(2).unwrap_or_else(|| "ERROR|FATAL".to_string());

    let mut paths = Vec::new();
    walk(Path::new(&dir), &mut paths);
    eprintln!("扫描 {} 个文件，模式 = {:?}", paths.len(), expr);

    let (results, stats) = search_all(&paths, &Pattern::regex(expr)).expect("搜索失败");
    for f in &results {
        for h in &f.hits {
            println!("{}:{}:{}", f.path.display(), h.line_number, h.text);
        }
    }
    eprintln!(
        "命中文件 {}/{}，命中行 {}，耗时 {} ms",
        stats.files_with_matches, stats.files_searched, stats.matched_lines, stats.elapsed_ms
    );
}
