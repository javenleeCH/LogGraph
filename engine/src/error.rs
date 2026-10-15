//! 引擎统一错误模型（契约 §2.1 / §3.10）。
//!
//! 所有公开 API 返回 [`EngineResult`]；跨进程（CLI stderr / Tauri invoke
//! reject / agent）统一用 [`ErrorDto`]：`{ code, message, details? }`，
//! `code` 为稳定字符串（§3.10 总表），消费方只允许按 code 分支。

use crate::rules::RuleIssue;
use serde::Serialize;
use std::path::PathBuf;

pub type EngineResult<T> = Result<T, EngineError>;

/// 稳定错误码（序列化为 "E_*" 字符串，§3.10）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "E_RULES_SYNTAX")]
    RulesSyntax,
    #[serde(rename = "E_RULES_SCHEMA")]
    RulesSchema,
    #[serde(rename = "E_RULES_SEMANTIC")]
    RulesSemantic,
    #[serde(rename = "E_RULES_VERSION")]
    RulesVersion,
    #[serde(rename = "E_PATTERN")]
    Pattern,
    #[serde(rename = "E_GLOB")]
    Glob,
    #[serde(rename = "E_IO")]
    Io,
    #[serde(rename = "E_NO_FILES")]
    NoFiles,
    /// 会话/参数类使用错误（行号越界、目录不存在、清单为空等；v1.2）
    #[serde(rename = "E_USAGE")]
    Usage,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RulesSyntax => "E_RULES_SYNTAX",
            Self::RulesSchema => "E_RULES_SCHEMA",
            Self::RulesSemantic => "E_RULES_SEMANTIC",
            Self::RulesVersion => "E_RULES_VERSION",
            Self::Pattern => "E_PATTERN",
            Self::Glob => "E_GLOB",
            Self::Io => "E_IO",
            Self::NoFiles => "E_NO_FILES",
            Self::Usage => "E_USAGE",
        }
    }
}

/// 跨进程错误 DTO（契约 §2.1 / §6.3）：Tauri reject 载荷 / CLI 错误形状
#[derive(Debug, Clone, Serialize)]
pub struct ErrorDto {
    pub code: String,
    pub message: String,
    /// 规则类错误必带：`{ "issues": [RuleIssue…] }`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// 引擎错误（thiserror；Display 即人类可读 message）
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("非法正则/模式 {input:?}: {source}")]
    InvalidPattern { input: String, source: grep_regex::Error },

    /// 会话扫描的正则编译失败（regex::bytes 路径；code 同 E_PATTERN，v1.2）
    #[error("构建正则失败 {input:?}: {source}")]
    PatternBuild { input: String, source: regex::Error },

    #[error("非法 glob {glob:?}: {source}")]
    InvalidGlob { glob: String, source: ignore::Error },

    #[error("读取/扫描 {} 失败: {source}", path.display())]
    Io { path: PathBuf, source: std::io::Error },

    #[error("规则文件 JSON 语法错误: {source}")]
    RulesSyntax { source: serde_json::Error },

    #[error("规则文件不符合 schema（{} 处）", .issues.len())]
    RulesSchema { issues: Vec<RuleIssue> },

    #[error("规则文件语义错误（{} 处）", .issues.len())]
    RulesSemantic { issues: Vec<RuleIssue> },

    #[error("不支持的规则文件版本: {found}（引擎支持 {supported:?}）")]
    RulesVersion { found: u32, supported: Vec<u32> },

    #[error("{} 下未找到可搜索文件", path.display())]
    NoFiles { path: PathBuf },

    /// 会话/参数类使用错误（v1.2：行号越界、目录不存在、清单为空等）
    #[error("{message}")]
    Usage { message: String },
}

impl EngineError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidPattern { .. } | Self::PatternBuild { .. } => ErrorCode::Pattern,
            Self::InvalidGlob { .. } => ErrorCode::Glob,
            Self::Io { .. } => ErrorCode::Io,
            Self::RulesSyntax { .. } => ErrorCode::RulesSyntax,
            Self::RulesSchema { .. } => ErrorCode::RulesSchema,
            Self::RulesSemantic { .. } => ErrorCode::RulesSemantic,
            Self::RulesVersion { .. } => ErrorCode::RulesVersion,
            Self::NoFiles { .. } => ErrorCode::NoFiles,
            Self::Usage { .. } => ErrorCode::Usage,
        }
    }

    /// 跨进程形状：`{ code, message, details? }`（规则类错误带聚合 issues）
    pub fn to_dto(&self) -> ErrorDto {
        let details = match self {
            Self::RulesSchema { issues } | Self::RulesSemantic { issues } => {
                serde_json::to_value(issues)
                    .ok()
                    .map(|v| serde_json::json!({ "issues": v }))
            }
            _ => None,
        };
        ErrorDto {
            code: self.code().as_str().to_string(),
            message: self.to_string(),
            details,
        }
    }
}
