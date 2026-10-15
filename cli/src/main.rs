//! logGraph 引擎 CLI（契约 plans/engine-cli-api-contract.md §4，v1.3 REST 化）。
//!
//! 用法：
//!   loggraph search   <PATH> <PATTERN> [-i] [-F] [--json]
//!   loggraph cep      <PATH> --rules <RULES.cep.json> [--json]
//!   loggraph validate <RULES_FILE> [--json]
//!   loggraph schema   [cep]
//!   loggraph ws <info|filters|sequences|line|lines|corr|files> ...（工作区 API，
//!                Tauri ws_* IPC 命令的 1:1 等价，无状态：请求自描述，
//!                ctx 由 `ws info` 产出、`--ctx` 回传复用）
//!   loggraph parse <file|dir> ...（解析 API，parse_log/parse_dir 1:1 等价）
//!
//! 退出码（§4.6）：0 成功；1 无命中/校验失败/违规门禁；2 错误（E_*）；
//! 3 fallback 门禁。stdout 只承载结果，错误一律 stderr。

use clap::{Parser, Subcommand};
use loggraph_engine::cep::{GroupSpec, RunSeqResponse};
use loggraph_engine::error::{EngineError, EngineResult};
use loggraph_engine::parser::{
    find_format, parse_dir_files, parse_text_full, read_file_lossy, DirMeta, LogEvent,
};
use loggraph_engine::pipeline::{run_cep, PipelineStats};
use loggraph_engine::rules::{self, RuleIssue};
use loggraph_engine::session::{FilterQuery, Session, WsCtx};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

#[derive(Parser)]
#[command(
    name = "loggraph",
    version,
    about = "rg + CEP 日志分析引擎（无数据库）",
    after_help = "退出码：0 成功 / 1 无命中或校验失败 / 2 错误 / 3 fallback 门禁"
)]
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
    /// 只校验规则文件，不扫日志
    Validate(ValidateArgs),
    /// 打印 JSON Schema（当前仅 cep 规则文件 schema）
    Schema(SchemaArgs),
    /// 工作区 API：目录工作区（ctx 快照 + 过滤命中 + 行读取 + 序列匹配）。
    /// Tauri `ws_*` IPC 命令的 1:1 CLI 等价（v1.3 REST 化）；无会话状态——
    /// `ws info` 产出 ctx（唯一付整读价的入口），其余命令 `--ctx` 复用
    /// （缺省内部重建，付整读价）
    Ws(WsArgs),
    /// 解析 API：单文件/目录解析。`parse_log` / `parse_dir` IPC 的 1:1 等价
    Parse(ParseArgs),
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
    /// glob 过滤，`!` 前缀排除（rg -g，可多次；推荐 -g "*.log"）
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
    /// 正则或关键词（默认按正则）
    pattern: String,
    /// 忽略大小写
    #[arg(short = 'i', long)]
    ignore_case: bool,
    /// 按纯文本匹配（默认正则）
    #[arg(short = 'F', long = "fixed-strings")]
    fixed_strings: bool,
    /// 输出 JSON（契约 §5.1：{files, stats} 信封）
    #[arg(long)]
    json: bool,
    #[command(flatten)]
    walk: WalkArgs,
}

#[derive(clap::Args)]
struct CepArgs {
    /// 日志文件或目录
    path: PathBuf,
    /// 规则文件（.cep.json，契约 §3）
    #[arg(short = 'R', long = "rules")]
    rules: PathBuf,
    /// 输出 JSON（契约 §5.2：{response, stats} 信封）
    #[arg(long)]
    json: bool,
    /// 存在 NOT 违规 → 退出码 1（默认关，D5）
    #[arg(long)]
    fail_on_violation: bool,
    /// fallback=true（存在 v1 不支持规则）→ 退出码 3（默认关，D10）
    #[arg(long)]
    fail_on_unsupported: bool,
    #[command(flatten)]
    walk: WalkArgs,
}

#[derive(clap::Args)]
struct ValidateArgs {
    /// 规则文件
    file: PathBuf,
    /// 输出 JSON（契约 §5.3：RuleReport）
    #[arg(long)]
    json: bool,
}

#[derive(clap::Args)]
struct SchemaArgs {
    /// schema 名（当前仅 cep）
    kind: String,
}

// ---- 工作区 API（ws_* IPC 的 1:1 CLI 等价，契约 v1.3 §4.8）----

#[derive(clap::Args)]
struct WsArgs {
    #[command(subcommand)]
    cmd: WsCommand,
}

#[derive(Subcommand)]
enum WsCommand {
    /// 建工作区上下文（= ws_info；唯一付整读价的入口），打印 ctx JSON。
    /// 管道保存后供其余命令 `--ctx` 复用
    Info(WsInfoArgs),
    /// 批量过滤扫描（= ws_filters）；--queries 为 FilterQuery JSON 数组
    Filters(WsFiltersArgs),
    /// 过滤 + 序列匹配（= ws_sequences；queries 先行 warm 命中缓存）
    Sequences(WsSequencesArgs),
    /// 单行文本（= ws_line）
    Line(WsLineArgs),
    /// 批量行文本（= ws_lines）；--ids 为逗号分隔全局行号
    Lines(WsLinesArgs),
    /// 关联窗口行号（= 引擎 corr_ids；IPC 已删，CLI 保留）
    Corr(WsCorrArgs),
    /// 文件清单（first_line 升序；CLI 便利命令）
    Files(WsFilesArgs),
}

#[derive(clap::Args)]
struct WsInfoArgs {
    /// 日志目录
    dir: PathBuf,
    /// 仅用这些相对路径文件（可多次；缺省 = 目录全集）
    #[arg(long = "file")]
    files: Vec<String>,
}

/// --ctx 公共参数（WsCtx JSON 文件或 `-`=stdin；缺省 = 内部重建 ctx）
#[derive(clap::Args)]
struct CtxArgs {
    /// `ws info` 产出的 ctx JSON（`-` = stdin）；缺省内部重建（付整读价）
    #[arg(long)]
    ctx: Option<String>,
}

#[derive(clap::Args)]
struct WsFiltersArgs {
    /// 日志目录
    dir: PathBuf,
    /// FilterQuery JSON 数组文件（`-` = stdin）
    #[arg(short = 'q', long)]
    queries: String,
    #[command(flatten)]
    ctx: CtxArgs,
}

#[derive(clap::Args)]
struct WsSequencesArgs {
    /// 日志目录
    dir: PathBuf,
    /// FilterQuery JSON 数组文件（`-` = stdin；须含 group 引用的全部 filter）
    #[arg(short = 'q', long)]
    queries: String,
    /// GroupSpec JSON 数组文件（`-` = stdin）
    #[arg(short = 'g', long)]
    groups: String,
    #[command(flatten)]
    ctx: CtxArgs,
}

#[derive(clap::Args)]
struct WsLineArgs {
    /// 日志目录
    dir: PathBuf,
    /// 全局行号
    #[arg(long)]
    no: u32,
    #[command(flatten)]
    ctx: CtxArgs,
}

#[derive(clap::Args)]
struct WsLinesArgs {
    /// 日志目录
    dir: PathBuf,
    /// 全局行号，逗号分隔（如 3,17,42）
    #[arg(long)]
    ids: String,
    #[command(flatten)]
    ctx: CtxArgs,
}

#[derive(clap::Args)]
struct WsCorrArgs {
    /// 日志目录
    dir: PathBuf,
    /// FilterQuery JSON 数组文件（`-` = stdin；须含 --filters 引用的全部 filter）
    #[arg(short = 'q', long)]
    queries: String,
    /// filter id 清单，逗号分隔
    #[arg(short = 'f', long)]
    filters: String,
    /// 窗口起点（epoch ms）
    #[arg(long)]
    start: i64,
    /// 窗口终点（epoch ms，含）
    #[arg(long)]
    end: i64,
    #[command(flatten)]
    ctx: CtxArgs,
}

#[derive(clap::Args)]
struct WsFilesArgs {
    /// 日志目录
    dir: PathBuf,
}

// ---- 解析 API（parse_* IPC 的 1:1 CLI 等价，契约 v1.2 §4.9）----

#[derive(clap::Args)]
struct ParseArgs {
    #[command(subcommand)]
    cmd: ParseCommand,
}

#[derive(Subcommand)]
enum ParseCommand {
    /// 解析单个日志文件（= parse_log）
    File(ParseFileArgs),
    /// 批量解析目录（= parse_dir；默认只回 DirMeta，--full 带事件与原文）
    Dir(ParseDirArgs),
}

#[derive(clap::Args)]
struct ParseFileArgs {
    /// 日志文件路径
    path: PathBuf,
    /// 强制时间戳格式 id（缺省 = 自动探测）
    #[arg(long = "format-id")]
    format_id: Option<String>,
}

#[derive(clap::Args)]
struct ParseDirArgs {
    /// 日志目录
    dir: PathBuf,
    /// 输出全量事件 + 原始行（大数据集慎用）
    #[arg(long)]
    full: bool,
}

// ---- 会话/解析实现 ----

/// `--file` 清单 → build_ctx 的 files 参数（空 = 全集；仅 `ws info` 支持）
fn files_opt(files: &[String]) -> Option<&[String]> {
    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

/// 读取 JSON 输入（`-` = stdin）
fn read_json_input(spec: &str) -> EngineResult<String> {
    if spec == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|source| EngineError::Io { path: PathBuf::from("<stdin>"), source })?;
        Ok(s)
    } else {
        let p = PathBuf::from(spec);
        std::fs::read_to_string(&p).map_err(|source| EngineError::Io { path: p, source })
    }
}

/// 读取并反序列化 JSON 输入（`-` = stdin）
fn parse_json_input<T: serde::de::DeserializeOwned>(spec: &str) -> EngineResult<T> {
    let text = read_json_input(spec)?;
    serde_json::from_str(&text)
        .map_err(|source| EngineError::Usage { message: format!("JSON 输入解析失败（{spec}）: {source}") })
}

fn print_json<T: Serialize>(v: &T) {
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let _ = serde_json::to_writer(&mut out, v);
    let _ = writeln!(out);
    let _ = out.flush();
}

/// 工作区会话装载：--ctx 提供 → 零 I/O 按 ctx 重建；缺省 → 内部 build_ctx
/// （付整读价）。`ws info` 是唯一应该付整读价的入口，其余命令建议管道传 ctx。
fn load_ws(dir: &Path, ctx_spec: Option<&str>) -> EngineResult<Session> {
    match ctx_spec {
        Some(spec) => {
            let ctx: WsCtx = parse_json_input(spec)?;
            Session::from_ctx(dir, &ctx)
        }
        None => Session::from_ctx(dir, &Session::build_ctx(dir, None, |_, _, _| {})?),
    }
}

/// 落盘引擎缓存工件（.off 偏移表 / .bin 命中集）：建父目录 + 临时文件 +
/// 原子改名；失败静默（只影响下次延迟，不影响正确性）。与壳层 ws.rs 同语义。
fn persist_cache(items: Vec<(PathBuf, Vec<u8>)>) {
    for (path, bytes) in items {
        let Some(parent) = path.parent() else { continue };
        if std::fs::create_dir_all(parent).is_err() {
            continue;
        }
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

fn do_ws(args: WsArgs) -> ExitCode {
    match args.cmd {
        WsCommand::Info(a) => {
            let ctx = match Session::build_ctx(&a.dir, files_opt(&a.files), |_, _, _| {}) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            print_json(&ctx);
            ExitCode::SUCCESS
        }
        WsCommand::Filters(a) => {
            let queries: Vec<FilterQuery> = match parse_json_input(&a.queries) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            let session = match load_ws(&a.dir, a.ctx.ctx.as_deref()) {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            let outcome = match session.filters_batch(&queries) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            persist_cache(session.take_persistable());
            let total_hits: usize = outcome.out.iter().map(|(_, h)| h.len()).sum();
            print_json(&CliFiltersEnvelope {
                filters: outcome
                    .out
                    .iter()
                    .map(|(id, hits)| CliFilterOut { filter_id: id, hits })
                    .collect(),
            });
            if total_hits == 0 {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        WsCommand::Sequences(a) => {
            let queries: Vec<FilterQuery> = match parse_json_input(&a.queries) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            let groups: Vec<GroupSpec> = match parse_json_input(&a.groups) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            let session = match load_ws(&a.dir, a.ctx.ctx.as_deref()) {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            // 先填充命中缓存（= IPC ws_sequences 的 warm 语义）
            if let Err(e) = session.filters_batch(&queries) {
                return fail(e);
            }
            persist_cache(session.take_persistable());
            print_json(&session.run_sequences(&groups));
            ExitCode::SUCCESS
        }
        WsCommand::Line(a) => {
            let session = match load_ws(&a.dir, a.ctx.ctx.as_deref()) {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            let text = match session.line(a.no) {
                Ok(t) => t,
                Err(e) => {
                    persist_cache(session.take_persistable());
                    return fail(e);
                }
            };
            persist_cache(session.take_persistable());
            println!("{text}");
            ExitCode::SUCCESS
        }
        WsCommand::Lines(a) => {
            let ids: Vec<u32> = match a
                .ids
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.parse::<u32>().map_err(|_| EngineError::Usage {
                        message: format!("行号解析失败: {s:?}（--ids 应为逗号分隔的非负整数）"),
                    })
                })
                .collect::<Result<_, _>>()
            {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            let session = match load_ws(&a.dir, a.ctx.ctx.as_deref()) {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            let rows: Vec<CliLineRow> = session
                .lines_by_ids(&ids)
                .into_iter()
                .map(|(line, text)| CliLineRow { line, text })
                .collect();
            persist_cache(session.take_persistable());
            print_json(&rows);
            ExitCode::SUCCESS
        }
        WsCommand::Corr(a) => {
            let queries: Vec<FilterQuery> = match parse_json_input(&a.queries) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            let fids: Vec<String> = a
                .filters
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            let session = match load_ws(&a.dir, a.ctx.ctx.as_deref()) {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            if let Err(e) = session.filters_batch(&queries) {
                return fail(e);
            }
            persist_cache(session.take_persistable());
            let ids = session.corr_ids(&fids, a.start, a.end);
            print_json(&ids);
            if ids.is_empty() {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        WsCommand::Files(a) => {
            let session = match load_ws(&a.dir, None) {
                Ok(s) => s,
                Err(e) => return fail(e),
            };
            print_json(&session.file_infos());
            ExitCode::SUCCESS
        }
    }
}

#[derive(Serialize)]
struct CliFilterOut<'a> {
    #[serde(rename = "filterId")]
    filter_id: &'a str,
    hits: &'a [loggraph_engine::session::HitEntry],
}

#[derive(Serialize)]
struct CliFiltersEnvelope<'a> {
    filters: Vec<CliFilterOut<'a>>,
}

#[derive(Serialize)]
struct CliLineRow {
    line: u32,
    text: String,
}

fn do_parse(args: ParseArgs) -> ExitCode {
    match args.cmd {
        ParseCommand::File(a) => {
            let forced = match a.format_id.as_deref() {
                None => None,
                Some(id) => match find_format(id) {
                    Some(f) => Some(f),
                    None => {
                        return fail(EngineError::Usage {
                            message: format!("未知时间戳格式 id: {id}"),
                        })
                    }
                },
            };
            let text = match read_file_lossy(&a.path) {
                Ok(t) => t,
                Err(source) => return fail(EngineError::Io { path: a.path, source }),
            };
            print_json(&parse_text_full(&text, forced));
            ExitCode::SUCCESS
        }
        ParseCommand::Dir(a) => {
            let r = match parse_dir_files(&a.dir, |_, _, _| {}) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
            if a.full {
                print_json(&CliParseDirFull {
                    meta: &r.meta,
                    events: &r.events,
                    raw_lines: &r.raw_lines,
                });
            } else {
                print_json(&r.meta);
            }
            ExitCode::SUCCESS
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliParseDirFull<'a> {
    meta: &'a DirMeta,
    events: &'a [LogEvent],
    raw_lines: &'a [String],
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Command::Search(a) => do_search(a),
        Command::Cep(a) => do_cep(a),
        Command::Validate(a) => do_validate(a),
        Command::Schema(a) => do_schema(a),
        Command::Ws(a) => do_ws(a),
        Command::Parse(a) => do_parse(a),
    }
}

/// 错误统一出口：stderr 打印（规则类展开聚合 issue），退出码 2（§4.6）
fn fail(e: EngineError) -> ExitCode {
    eprintln!("错误: {e}");
    let issues: &[RuleIssue] = match &e {
        EngineError::RulesSchema { issues } | EngineError::RulesSemantic { issues } => issues,
        _ => &[],
    };
    for i in issues {
        let rule = i.rule.unwrap_or_else(|| i.code.as_str());
        eprintln!("  [{rule}] {}: {}", i.path, i.message);
    }
    ExitCode::from(2)
}

fn read_rules(path: &Path) -> EngineResult<String> {
    std::fs::read_to_string(path)
        .map_err(|source| EngineError::Io { path: path.to_path_buf(), source })
}

fn walk_or_fail(path: &Path, opts: &WalkOptions) -> EngineResult<Vec<PathBuf>> {
    let paths = search::walk(path, opts)?;
    if paths.is_empty() {
        return Err(EngineError::NoFiles { path: path.to_path_buf() });
    }
    Ok(paths)
}

/// `search --json` 信封（契约 §5.1）：直接结构体序列化保持声明键序
#[derive(Serialize)]
struct SearchEnvelope<'a> {
    files: &'a [loggraph_engine::search::FileHits],
    stats: &'a loggraph_engine::search::SearchStats,
}

/// `cep --json` 信封（契约 §5.2）
#[derive(Serialize)]
struct CepEnvelope<'a> {
    response: &'a RunSeqResponse,
    stats: &'a PipelineStats,
}

fn do_search(args: SearchArgs) -> ExitCode {
    // 阶段计时：walk / search / print 拆分（只进 stderr 诊断行，stdout 契约不变）
    let t0 = Instant::now();
    let paths = match walk_or_fail(&args.path, &args.walk.options()) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let walk_ms = t0.elapsed().as_millis();
    let pattern = Pattern {
        pattern: args.pattern,
        case_sensitive: !args.ignore_case,
        is_regex: !args.fixed_strings,
    };
    let t_search = Instant::now();
    let (files, stats) = match search::search_all(&paths, &pattern) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let search_ms = t_search.elapsed().as_millis();
    if args.json {
        // 直接结构体序列化：保持声明序（json! 宏会走 Value/BTreeMap 变字母序）；
        // to_writer 流式写出，不再先拼出整个 JSON 大字符串
        let env = SearchEnvelope { files: &files, stats: &stats };
        let stdout = std::io::stdout();
        let mut out = BufWriter::new(stdout.lock());
        let _ = serde_json::to_writer(&mut out, &env);
        let _ = writeln!(out);
        let _ = out.flush();
    } else {
        // 快速打印：路径前缀每文件拼一次；行内容手工组字节 + write_all 批量
        // 落缓冲，绕开 writeln! 的 format 机器（百万级命中时 fmt 每行 1~3µs
        // 是输出阶段大头；rg 的 printer 正是手工组字节的）
        let t_print = Instant::now();
        let stdout = std::io::stdout();
        let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
        let mut line = String::with_capacity(256);
        for f in &files {
            let prefix = f.path.display().to_string();
            for h in &f.hits {
                line.clear();
                line.push_str(&prefix);
                line.push(':');
                push_u64(&mut line, h.line_number);
                line.push(':');
                line.push_str(&h.text);
                line.push('\n');
                let _ = out.write_all(line.as_bytes());
            }
        }
        let _ = out.flush();
        let print_ms = t_print.elapsed().as_millis();
        eprintln!(
            "命中文件 {}/{}，命中行 {}，耗时 {} ms",
            stats.files_with_matches, stats.files_searched, stats.matched_lines, stats.elapsed_ms
        );
        eprintln!(
            "阶段耗时 walk={}ms search={}ms print={}ms 总计={}ms",
            walk_ms, search_ms, print_ms, t0.elapsed().as_millis()
        );
    }
    // 对齐 rg：无命中 = 1（不是错误，D3）
    if stats.matched_lines > 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

/// u64 → 十进制 ASCII 追加（快速打印路径专用，绕开 format 机器）
fn push_u64(buf: &mut String, mut n: u64) {
    if n == 0 {
        buf.push('0');
        return;
    }
    let mut digits = [b'0'; 20];
    let mut i = digits.len();
    while n > 0 {
        i -= 1;
        digits[i] += (n % 10) as u8;
        n /= 10;
    }
    buf.push_str(std::str::from_utf8(&digits[i..]).expect("纯数字 ASCII"));
}

fn do_cep(args: CepArgs) -> ExitCode {
    let raw = match read_rules(&args.rules) {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    let rules = match rules::parse_rules(&raw) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let paths = match walk_or_fail(&args.path, &args.walk.options()) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let (resp, stats) = match run_cep(&paths, &rules.filters, &rules.groups) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };

    if args.json {
        let out = CepEnvelope { response: &resp, stats: &stats };
        println!("{}", serde_json::to_string(&out).unwrap());
    } else {
        let labels: HashMap<&str, &str> = rules
            .groups
            .iter()
            .filter_map(|g| g.label.as_deref().map(|l| (g.group_id.as_str(), l)))
            .collect();
        print_cep_text(&resp, &stats, &labels);
    }

    let mut code = 0u8;
    if args.fail_on_violation && resp.results.values().any(|r| !r.not_violations.is_empty()) {
        code = 1;
    }
    if args.fail_on_unsupported && resp.fallback {
        code = 3;
    }
    ExitCode::from(code)
}

/// 文本输出（§4.7）：时间转 UTC 串，统计与警告走 stderr
fn print_cep_text(resp: &RunSeqResponse, stats: &PipelineStats, labels: &HashMap<&str, &str>) {
    eprintln!(
        "文件 {}，时间戳格式 {}，入 CEP 事件 {}，无时间戳丢弃 {}",
        stats.files,
        stats.ts_format.as_deref().unwrap_or("(无)"),
        stats.events_with_ts,
        stats.no_ts
    );
    if resp.fallback {
        eprintln!("警告：存在 v1 不支持规则（W01–W05，详见 loggraph validate），对应 group 未计算（fallback）");
    }
    for (gid, result) in &resp.results {
        let title = match labels.get(gid.as_str()) {
            Some(l) => format!("{gid}（{l}）"),
            None => gid.clone(),
        };
        println!("══ group {title} ══");
        for chain in &result.chains {
            match &chain.thread {
                Some(t) => println!(
                    "#{} [{} → {}] thread: {t}",
                    chain.chain_index,
                    format_utc_ms(chain.start_ts),
                    format_utc_ms(chain.end_ts)
                ),
                None => println!(
                    "#{} [{} → {}]",
                    chain.chain_index,
                    format_utc_ms(chain.start_ts),
                    format_utc_ms(chain.end_ts)
                ),
            }
            for step in &chain.steps {
                println!("    {} {} {}", format_utc_ms(step.event.ts), step.filter_id, step.event.raw);
            }
        }
        for v in &result.not_violations {
            println!(
                "NOT 违规 edge={}：{} ← 禁止窗口内出现 {}",
                v.edge_id, v.from_event.raw, v.to_event.raw
            );
        }
        for st in &result.edge_stats {
            println!("edge {}：匹配 {}，断裂/违规 {}", st.edge_id, st.matched_count, st.miss_count);
        }
        if !result.uncovered_events.is_empty() {
            println!("未覆盖事件 {} 条", result.uncovered_events.len());
        }
    }
}

fn do_validate(args: ValidateArgs) -> ExitCode {
    let raw = match read_rules(&args.file) {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    let report = rules::validate_rules(&raw);
    if args.json {
        println!("{}", serde_json::to_string(&report).unwrap());
    } else {
        for i in report.errors.iter().chain(report.warnings.iter()) {
            let rule = i.rule.unwrap_or_else(|| i.code.as_str());
            println!("[{rule}] {}: {}", i.path, i.message);
        }
        println!("错误 {}，警告 {}", report.errors.len(), report.warnings.len());
    }
    if report.valid {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn do_schema(args: SchemaArgs) -> ExitCode {
    if args.kind != "cep" {
        eprintln!("错误: 未知 schema \"{}\"（当前仅支持 cep）", args.kind);
        return ExitCode::from(2);
    }
    let v: serde_json::Value =
        serde_json::from_str(rules::CEP_RULES_SCHEMA).expect("内嵌 schema 必然是合法 JSON");
    // 紧凑单行，便于 | jq 管道（§4.4）
    println!("{}", serde_json::to_string(&v).unwrap());
    ExitCode::SUCCESS
}

/// epoch ms → "YYYY-MM-DD HH:MM:SS.mmm"（UTC；契约 §4.7 D6。
/// 手写 Howard Hinnant civil_from_days 算法，不引 chrono 依赖）
fn format_utc_ms(ts: i64) -> String {
    let (y, m, d) = civil_from_days(ts.div_euclid(86_400_000));
    let sod = ts.rem_euclid(86_400_000); // 当日内 ms，恒 ≥ 0
    let (h, rest) = (sod / 3_600_000, sod % 3_600_000);
    let (mi, rest) = (rest / 60_000, rest % 60_000);
    let (s, ms) = (rest / 1_000, rest % 1_000);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{ms:03}")
}

/// 1970-01-01 起的天数 → (年, 月[1-12], 日[1-31])，对负天数也正确
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_formatting() {
        // 2024-01-01 00:00:01.469 UTC
        assert_eq!(format_utc_ms(1_704_067_201_469), "2024-01-01 00:00:01.469");
        // epoch
        assert_eq!(format_utc_ms(0), "1970-01-01 00:00:00.000");
        // 2026-10-09 00:00:00.000 UTC（今日校验点）
        assert_eq!(format_utc_ms(1_791_504_000_000), "2026-10-09 00:00:00.000");
        // 负值（epoch 前）也正确：-1 = 1969-12-31 23:59:59.999
        assert_eq!(format_utc_ms(-1), "1969-12-31 23:59:59.999");
    }
}
