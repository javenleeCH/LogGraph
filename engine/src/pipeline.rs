//! 无数据库流水线：rg 直扫命中 → 时间戳提取 → CEP 序列匹配，全程在内存中
//! 只保留命中行，不引入 SQLite 等任何数据库。CLI 与 Tauri 层共用此入口。

use crate::cep::{self, GroupSpec, RunSeqResponse, SeqEvent};
use crate::error::EngineResult;
use crate::parser::timestamp::{detect_timestamp_format, extract_timestamp, TsFormat};
use crate::parser::{detect_log_family, parse_rest_fam};
use crate::search::{self, Pattern};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// 过滤器定义（= 带 id 的搜索模式；规则文件 `filters[]` 条目，契约 §3.3：
/// camelCase + `deny_unknown_fields`，`label` 为展示元数据、引擎忽略）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterDef {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub pattern: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub is_regex: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStats {
    pub files: usize,
    /// 每个过滤器的命中行数
    pub filter_hits: HashMap<String, u64>,
    /// 成功提取时间戳、进入 CEP 的事件数
    pub events_with_ts: u64,
    pub ts_format: Option<String>,
    /// 命中但无法提取时间戳、被 CEP 丢弃的行数
    pub no_ts: u64,
}

/// 全流程：扫描 → 解析时间戳 → CEP。
pub fn run_cep(
    paths: &[PathBuf],
    filters: &[FilterDef],
    groups: &[GroupSpec],
) -> EngineResult<(RunSeqResponse, PipelineStats)> {
    // 1) 每个过滤器跑一次 rg 直扫
    let mut hits_by_filter: HashMap<String, Vec<search::FileHits>> = HashMap::new();
    let mut filter_hits_count = HashMap::new();
    for f in filters {
        let pat = Pattern {
            pattern: f.pattern.clone(),
            case_sensitive: f.case_sensitive,
            is_regex: f.is_regex,
        };
        let (files, _stats) = search::search_all(paths, &pat)?;
        let n: u64 = files.iter().map(|x| x.hits.len() as u64).sum();
        filter_hits_count.insert(f.id.clone(), n);
        hits_by_filter.insert(f.id.clone(), files);
    }

    // 2) 用首批命中行探测一次时间戳格式（失败则逐行回退全格式尝试）
    let mut sample_lines: Vec<String> = Vec::new();
    'outer: for files in hits_by_filter.values() {
        for file in files {
            for h in &file.hits {
                sample_lines.push(h.text.clone());
                if sample_lines.len() >= 200 {
                    break 'outer;
                }
            }
        }
    }
    let sample_refs: Vec<&str> = sample_lines.iter().map(|s| s.as_str()).collect();
    let format: Option<&TsFormat> = detect_timestamp_format(&sample_refs);

    // 同一批样本探测布局族：使 pipeline（CEP 逐行重解析）与 GUI 解析的 thread 提取一致，
    // 避免「视图有线程、引擎没线程」的分桶退化（契约 §3.13）。
    let family = {
        let mut rests: Vec<String> = Vec::new();
        for l in sample_lines.iter() {
            if let Some(e) = extract_timestamp(l, format) {
                rests.push(l[e.end..].to_string());
            }
        }
        let refs: Vec<&str> = rests.iter().map(|s| s.as_str()).collect();
        detect_log_family(&refs)
    };

    // 3) 全局行身份：同一物理行被多个过滤器命中时，CEP 中必须是同一事件 id。
    //    key = (文件在 paths 中的下标, 1-based 行号)
    let mut line_id: HashMap<(usize, u64), u32> = HashMap::new();
    let mut next_id = 1u32;
    let mut store: HashMap<String, Vec<SeqEvent>> = HashMap::new();
    let mut no_ts = 0u64;

    let path_index: HashMap<PathBuf, usize> =
        paths.iter().enumerate().map(|(i, p)| (p.clone(), i)).collect();

    for f in filters {
        let mut events = Vec::new();
        let files = hits_by_filter.remove(&f.id).unwrap_or_default();
        for file in files {
            let fi = path_index.get(&file.path).copied().unwrap_or(0);
            for h in file.hits {
                let key = (fi, h.line_number);
                let id = if let Some(id) = line_id.get(&key) {
                    *id
                } else {
                    let id = next_id;
                    next_id += 1;
                    line_id.insert(key, id);
                    id
                };
                // 探测格式优先，失败再逐行全格式尝试（对齐 parser 回退语义）
                let extracted = extract_timestamp(&h.text, format)
                    .or_else(|| extract_timestamp(&h.text, None));
                if let Some(ts) = extracted {
                    // 解析时间戳之后的剩余段：抽出 thread / level / message
                    // （对齐前端 parseRest，使 nodeConditions 表达式的 level/msg/thread
                    // 字段能与 GUI 视图等价求值）
                    let parsed = parse_rest_fam(&h.text[ts.end..], family);
                    events.push(SeqEvent {
                        id,
                        ts: ts.ts,
                        raw: h.text.clone(),
                        message: parsed.message,
                        thread: parsed.thread,
                        level: parsed.level,
                        source_file: Some(file.path.to_string_lossy().into_owned()),
                    });
                } else {
                    no_ts += 1;
                }
            }
        }
        events.sort_by_key(|e| (e.ts, e.id));
        store.insert(f.id.clone(), events);
    }

    let events_with_ts: u64 = store.values().map(|v| v.len() as u64).sum();
    let stats = PipelineStats {
        files: paths.len(),
        filter_hits: filter_hits_count,
        events_with_ts,
        ts_format: format.map(|f| f.id.to_string()),
        no_ts,
    };

    // 4) CEP 序列匹配
    let resp = cep::run_sequences(groups, &store);
    Ok((resp, stats))
}
