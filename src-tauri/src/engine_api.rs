//! Tauri IPC 薄壳：`engine_*` 命令面（契约 §6.1）。
//!
//! 壳层零业务逻辑：参数转发给 loggraph-engine，错误统一 `to_dto()` 后
//! 走 Tauri reject（`{ code, message, details? }`，§6.3）。
//! 数据层 `ws_*`（REST 式无状态）与 `parser::*` 命令另见各模块。

use loggraph_engine::cep::RunSeqResponse;
use loggraph_engine::error::EngineResult;
use loggraph_engine::pipeline::{run_cep, PipelineStats};
use loggraph_engine::rules::{validate_rules, RuleReport};
use loggraph_engine::search::{self, FileHits, Pattern, SearchStats, WalkOptions};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---- 入参 DTO（camelCase + 缺省值，前端 §6.2 形状） ----

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkOptionsDto {
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub no_ignore: bool,
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default)]
    pub exts: Vec<String>,
}

impl WalkOptionsDto {
    fn to_engine(&self) -> WalkOptions {
        WalkOptions {
            hidden: self.hidden,
            no_ignore: self.no_ignore,
            globs: self.globs.clone(),
            exts: self.exts.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// 文件或目录
    pub root: String,
    pub pattern: Pattern,
    #[serde(default)]
    pub walk: WalkOptionsDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCepRequest {
    /// 文件或目录
    pub root: String,
    /// `.cep` 规则文件全文（UI 负责读文件，§6.1）
    pub rules_json: String,
    #[serde(default)]
    pub walk: WalkOptionsDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkRequest {
    pub root: String,
    #[serde(default)]
    pub walk: WalkOptionsDto,
}

// ---- 出参 DTO（与 CLI --json 同形，§5.1/§5.2） ----

#[derive(Debug, Serialize)]
pub struct SearchOutcome {
    pub files: Vec<FileHits>,
    pub stats: SearchStats,
}

#[derive(Debug, Serialize)]
pub struct RunCepOutcome {
    pub response: RunSeqResponse,
    pub stats: PipelineStats,
}

// ---- 命令 ----

fn to_dto(e: loggraph_engine::EngineError) -> loggraph_engine::ErrorDto {
    e.to_dto()
}

#[tauri::command]
pub fn engine_search(req: SearchRequest) -> Result<SearchOutcome, loggraph_engine::ErrorDto> {
    inner_search(&req).map_err(to_dto)
}

fn inner_search(req: &SearchRequest) -> EngineResult<SearchOutcome> {
    let root = PathBuf::from(&req.root);
    let opts = req.walk.to_engine();
    let paths = search::walk(&root, &opts)?;
    let (files, stats) = search::search_all(&paths, &req.pattern)?;
    Ok(SearchOutcome { files, stats })
}

#[tauri::command]
pub fn engine_run_cep(req: RunCepRequest) -> Result<RunCepOutcome, loggraph_engine::ErrorDto> {
    inner_run_cep(&req).map_err(to_dto)
}

fn inner_run_cep(req: &RunCepRequest) -> EngineResult<RunCepOutcome> {
    let rules = loggraph_engine::parse_rules(&req.rules_json)?;
    let root = PathBuf::from(&req.root);
    let opts = req.walk.to_engine();
    let paths = search::walk(&root, &opts)?;
    let (response, stats) = run_cep(&paths, &rules.filters, &rules.groups)?;
    Ok(RunCepOutcome { response, stats })
}

#[tauri::command]
pub fn engine_validate_rules(rules_json: String) -> RuleReport {
    validate_rules(&rules_json)
}

#[tauri::command]
pub fn engine_walk(req: WalkRequest) -> Result<Vec<String>, loggraph_engine::ErrorDto> {
    let root = PathBuf::from(&req.root);
    search::walk(&root, &req.walk.to_engine())
        .map(|paths| paths.into_iter().map(|p| p.display().to_string()).collect())
        .map_err(to_dto)
}
