//! logGraph 核心引擎（纯 Rust，不依赖 tauri）
//!
//! - [`search`]：rg 同内核（grep-searcher + grep-regex）的多文件正则/关键词直扫
//! - [`parser`]：时间戳格式探测与提取（5 种格式）
//! - [`cep`]：EPL/CEP 风格的事件序列模式匹配（seq / not / and / or…）
//! - [`pipeline`]：无数据库一条龙（扫描 → 时间戳 → CEP）
//! - [`rules`]：`.cep` 规则文件装载与三层校验（契约 §3）
//! - [`error`]：统一错误模型（`E_*` 稳定码，契约 §2.1/§3.10）
//!
//! 契约：`plans/engine-cli-api-contract.md`（v1.1）。

pub mod cep;
pub mod error;
pub mod parser;
pub mod pipeline;
pub mod rules;
pub mod search;

pub use error::{EngineError, EngineResult, ErrorDto};
pub use rules::{parse_rules, validate_rules, RuleIssue, RuleReport, RulesFile};
pub use search::{walk_files, FileHits, Hit, Pattern, SearchStats};
