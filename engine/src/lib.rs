//! logGraph 核心引擎（纯 Rust，不依赖 tauri）
//!
//! - [`search`]：rg 同内核（grep-searcher + grep-regex）的多文件正则/关键词直扫
//! - [`parser`]：时间戳格式探测与提取（5 种格式）+ 行解析（thread/level/message）
//!   + 全文件/全目录解析流水线 + 日志集发现（v1.2 下沉）
//! - [`session`]：目录工作区——REST 式无状态请求（ctx 快照 + `.logGraph`
//!   透明磁盘缓存）+ 便宜通道建库 + 过滤命中缓存 + 行偏移 seek 直读（v1.2 自
//!   src-tauri 壳层下沉，v1.3 REST 化）
//! - [`cep`]：EPL/CEP 风格的事件序列模式匹配（seq / not / and / or…）
//! - [`pipeline`]：无数据库一条龙（扫描 → 时间戳 → CEP）
//! - [`rules`]：`.cep` 规则文件装载与三层校验（契约 §3）
//! - [`error`]：统一错误模型（`E_*` 稳定码，契约 §2.1/§3.10）
//!
//! 契约：`plans/engine-cli-api-contract.md`（v1.2）。

pub mod cep;
pub mod error;
pub mod expr;
pub mod filter_agg;
pub mod parser;
pub mod pipeline;
pub mod rules;
pub mod search;
pub mod session;

pub use error::{EngineError, EngineResult, ErrorDto};
pub use rules::{parse_rules, validate_rules, RuleIssue, RuleReport, RulesFile};
pub use search::{walk_files, FileHits, Hit, Pattern, SearchStats};
pub use session::{CtxFile, FileInfo, FilterQuery, FiltersBatchOutcome, HitEntry, Session, WsCtx};

