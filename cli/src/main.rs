//! logGraph 引擎 CLI：rg 直扫 + CEP 序列匹配，第一版无任何数据库依赖。
//!
//! 用法：
//!   loggraph search <路径> <模式> [-i] [-F] [--json]
//!   loggraph cep <路径> --rules <rules.json> [--json]

use clap::{Parser, Subcommand};
use loggraph_engine::cep::GroupSpec;
use loggraph_engine::pipeline::{run_cep, FilterDef};
use loggraph_engine::search::{self, Pattern, WalkOptions};
use serde::Deserialize;
use std::path::PathBuf;
use std::process;

#[derive(Parser)]
#[command(name = "loggraph", version, about = "rg + CEP 日志分析引擎（无数据库）")]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand)]
enum Command {
    /// rg 同内核直扫（默认正则，-F 切字面量，与 rg 习惯一致）
    Search(SearchArgs),
    /// 按规则文件跑 CEP 序列匹配
    Cep(CepArgs),
}

/// 目录遍历公共开关（rg 同款）
#[derive(clap::Args)]
struct WalkArgs {
    /// 搜索隐藏文件/目录（rg --hidden）
    #[arg(long)]
    hidden: bool,
    /// 不尊重 .gitignore/.ignore/.rgignore 等规则（rg --no-ignore）
    #[arg(long)]
    no_ignore: bool,
    /// glob 过滤，`!` 前缀排除（rg -g，可多次）
    #[arg(short = 'g', long = "glob")]
    globs: Vec<String>,
}

impl WalkArgs {
    fn options(&self) -> WalkOptions {
        WalkOptions {
            hidden: self.hidden,
            no_ignore: self.no_ignore,
            globs: self.globs.clone(),
            exts: Vec::new(),
        }
    }
}

#[derive(clap::Args)]
struct SearchArgs {
    /// 日志文件或目录
    path: PathBuf,
    /// 正则或关键词
    pattern: String,
    /// 忽略大小写
    #[arg(short = 'i', long)]
    ignore_case: bool,
    /// 按纯文本匹配（默认正则）
    #[arg(short = 'F', long = "fixed-strings")]
    fixed_strings: bool,
    /// 输出 JSON
    #[arg(long)]
    json: bool,
    #[command(flatten)]
    walk: WalkArgs,
}

#[derive(clap::Args)]
struct CepArgs {
    /// 日志文件或目录
    path: PathBuf,
    /// 规则文件：{ "filters": [FilterDef], "groups": [GroupSpec] }
    #[arg(short = 'R', long = "rules")]
    rules: PathBuf,
    /// 输出 JSON
    #[arg(long)]
    json: bool,
    #[command(flatten)]
    walk: WalkArgs,
}

#[derive(Deserialize)]
struct RulesFile {
    filters: Vec<FilterDef>,
    groups: Vec<GroupSpec>,
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("错误: {msg}");
    process::exit(1);
}

fn main() {
    let cli = Cli::parse();
    match cli.cmd {
        Command::Search(args) => do_search(args),
        Command::Cep(args) => do_cep(args),
    }
}

fn do_search(args: SearchArgs) {
    let paths = match search::walk(&args.path, &args.walk.options()) {
        Ok(v) => v,
        Err(e) => fail(e),
    };
    if paths.is_empty() {
        fail(format!("{} 下未找到可搜索文件", args.path.display()));
    }
    let pattern = Pattern {
        pattern: args.pattern,
        case_sensitive: !args.ignore_case,
        is_regex: !args.fixed_strings,
    };
    let (files, stats) = match search::search_all(&paths, &pattern) {
        Ok(v) => v,
        Err(e) => fail(e),
    };
    if args.json {
        println!("{}", serde_json::to_string(&files).unwrap());
    } else {
        for f in &files {
            for h in &f.hits {
                println!("{}:{}:{}", f.path.display(), h.line_number, h.text);
            }
        }
        eprintln!(
            "命中文件 {}/{}，命中行 {}，耗时 {} ms",
            stats.files_with_matches, stats.files_searched, stats.matched_lines, stats.elapsed_ms
        );
    }
}

fn do_cep(args: CepArgs) {
    let raw = match std::fs::read_to_string(&args.rules) {
        Ok(s) => s,
        Err(e) => fail(format!("读取规则文件 {} 失败: {e}", args.rules.display())),
    };
    let rules: RulesFile = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => fail(format!("规则文件解析失败: {e}")),
    };
    let paths = match search::walk(&args.path, &args.walk.options()) {
        Ok(v) => v,
        Err(e) => fail(e),
    };
    if paths.is_empty() {
        fail(format!("{} 下未找到可搜索文件", args.path.display()));
    }

    let (resp, stats) = match run_cep(&paths, &rules.filters, &rules.groups) {
        Ok(v) => v,
        Err(e) => fail(e),
    };

    if args.json {
        println!("{}", serde_json::to_string(&serde_json::json!({"response": resp, "stats": stats})).unwrap());
        return;
    }

    eprintln!(
        "文件 {}，时间戳格式 {}，入 CEP 事件 {}，无时间戳丢弃 {}",
        stats.files,
        stats.ts_format.as_deref().unwrap_or("(无)"),
        stats.events_with_ts,
        stats.no_ts
    );
    if resp.fallback {
        eprintln!("注意：存在引擎当前不支持的规则（thread/opt/periodic/节点计数/条件），其结果未计算");
    }
    for (gid, result) in &resp.results {
        println!("══ group {gid} ══");
        for chain in &result.chains {
            println!(
                "#{} [{} → {}]",
                chain.chain_index, chain.start_ts, chain.end_ts
            );
            for step in &chain.steps {
                println!("    {} {} {}", step.event.ts, step.filter_id, step.event.raw);
            }
        }
        for v in &result.not_violations {
            println!(
                "NOT 违规 edge={}：{} ← 在禁止窗口内出现 {}",
                v.edge_id, v.from_event.raw, v.to_event.raw
            );
        }
        for st in &result.edge_stats {
            println!(
                "edge {}：匹配 {}，断裂/违规 {}",
                st.edge_id, st.matched_count, st.miss_count
            );
        }
    }
}
