//! logGraph 核心引擎（纯 Rust，不依赖 tauri）
//!
//! - [`search`]：rg 同内核（grep-searcher + grep-regex）的多文件正则/关键词直扫
//! - [`cep`]：EPL/CEP 风格的事件序列模式匹配（seq / not / and / or…）

pub mod cep;
pub mod parser;
pub mod pipeline;
pub mod search;

pub use search::{walk_files, FileHits, Hit, Pattern, SearchStats};
