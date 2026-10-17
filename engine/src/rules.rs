//! `.cep` 规则文件装载与三层校验（契约 §2.6 / §3.8–§3.10）。
//!
//! 三层：JSON 语法（`E_RULES_SYNTAX`）→ 版本闸门（S11）→ 结构（`E_RULES_SCHEMA`，
//! 手写镜像 `schemas/cep-rules-1.schema.json`，不引 JSON-Schema 库）→ 语义
//! （`E_RULES_SEMANTIC`，S01–S10；S08 用 `E_PATTERN`）。
//! 每层内部聚合全部问题、不 fail-fast；前层失败则后层跳过。
//! v1 不支持的能力不报错，产出 W01–W05 警告（§3.9），文件保持合法。

use crate::cep::GroupSpec;
use crate::error::{EngineError, EngineResult};
use crate::pipeline::FilterDef;
use crate::search::Pattern;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 内嵌的规则文件 JSON Schema（与 `loggraph schema` 输出、编辑器引用同一份）
pub const CEP_RULES_SCHEMA: &str = include_str!("../../schemas/cep-rules-1.schema.json");

/// 引擎支持的规则文件格式版本（契约 §3.2）
pub const SUPPORTED_VERSIONS: &[u32] = &[1];

// §3.7 数量上限（D11：冻结值，调整走 minor 版本）
const MAX_FILTERS: usize = 1024;
const MAX_GROUPS: usize = 1024;
const MAX_GROUP_FILTERS: usize = 256;
const MAX_EDGES: usize = 256;
const MAX_EDGE_TARGETS: usize = 16;
const MAX_NODE_MAP: usize = 256;
const MAX_PATTERN_LEN: usize = 4096;
const MAX_LABEL_LEN: usize = 64;
const MAX_DESC_LEN: usize = 2000;
const MAX_EXPR_LEN: usize = 512;

/// 校验问题分类（错误码见 §3.10；警告统一 W_RULES_UNSUPPORTED）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum IssueCode {
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
    #[serde(rename = "W_RULES_UNSUPPORTED")]
    Unsupported,
}

impl IssueCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RulesSyntax => "E_RULES_SYNTAX",
            Self::RulesSchema => "E_RULES_SCHEMA",
            Self::RulesSemantic => "E_RULES_SEMANTIC",
            Self::RulesVersion => "E_RULES_VERSION",
            Self::Pattern => "E_PATTERN",
            Self::Unsupported => "W_RULES_UNSUPPORTED",
        }
    }
}

/// 单条校验问题（契约 §3.10）
#[derive(Debug, Clone, Serialize)]
pub struct RuleIssue {
    pub code: IssueCode,
    /// S01–S10 / W01–W05；结构层问题无编号
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<&'static str>,
    /// 实例路径，如 `$.groups[0].edges[1].toFilterId`
    pub path: String,
    pub message: String,
}

/// 校验报告（`loggraph validate --json` 输出形状，契约 §5.3）
#[derive(Debug, Clone, Serialize)]
pub struct RuleReport {
    pub valid: bool,
    pub errors: Vec<RuleIssue>,
    pub warnings: Vec<RuleIssue>,
}

/// 解析后的规则文件（契约 §3.2）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RulesFile {
    /// 规则文件格式版本（缺省 = 1；parse_rules 保证 ∈ SUPPORTED_VERSIONS）
    #[serde(default = "default_version")]
    pub version: u32,
    /// 编辑器 schema 引用，引擎忽略（schema 允许该字段）
    #[serde(rename = "$schema", default)]
    pub schema_ref: Option<String>,
    /// 人类备注，引擎忽略
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub filters: Vec<FilterDef>,
    #[serde(default)]
    pub groups: Vec<GroupSpec>,
}

fn default_version() -> u32 {
    1
}

/// 只校验不构造：聚合返回全部问题（供 validate 命令 / UI 表单 / Tauri）
pub fn validate_rules(json: &str) -> RuleReport {
    let json = strip_bom(json);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let value: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            errors.push(RuleIssue {
                code: IssueCode::RulesSyntax,
                rule: None,
                path: "$".to_string(),
                message: e.to_string(),
            });
            return RuleReport { valid: false, errors, warnings };
        }
    };

    match version_check(&value) {
        // 版本未知 → 后续校验没有意义，立即终止（S11）
        Some(found) => {
            errors.push(RuleIssue {
                code: IssueCode::RulesVersion,
                rule: Some("S11"),
                path: "$.version".to_string(),
                message: format!(
                    "不支持的规则文件版本 {found}（引擎支持 {SUPPORTED_VERSIONS:?}）"
                ),
            });
            return RuleReport { valid: false, errors, warnings };
        }
        None => {}
    }

    validate_structure(&value, &mut errors);

    if errors.is_empty() {
        // 结构已过（required/类型/未知键/边界全查过），typed 反序列化必然成功
        let file: RulesFile = serde_json::from_value(value)
            .expect("结构校验通过后 typed 反序列化不应失败");
        validate_semantics(&file, &mut errors, &mut warnings);
    }

    RuleReport { valid: errors.is_empty(), errors, warnings }
}

/// 校验 + 构造：任一 error → Err（规则类错误带聚合 issues）
pub fn parse_rules(json: &str) -> EngineResult<RulesFile> {
    let json = strip_bom(json);
    let value: Value = serde_json::from_str(json)
        .map_err(|source| EngineError::RulesSyntax { source })?;

    if let Some(found) = version_check(&value) {
        return Err(EngineError::RulesVersion { found, supported: SUPPORTED_VERSIONS.to_vec() });
    }

    let mut errors = Vec::new();
    validate_structure(&value, &mut errors);
    if !errors.is_empty() {
        return Err(EngineError::RulesSchema { issues: errors });
    }

    let file: RulesFile = serde_json::from_value(value).map_err(|e| {
        EngineError::RulesSchema {
            issues: vec![RuleIssue {
                code: IssueCode::RulesSchema,
                rule: None,
                path: "$".to_string(),
                message: format!("反序列化失败: {e}"),
            }],
        }
    })?;

    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    validate_semantics(&file, &mut errors, &mut warnings);
    if !errors.is_empty() {
        return Err(EngineError::RulesSemantic { issues: errors });
    }
    Ok(file)
}

/// 剥离 UTF-8 BOM（§3.1：带 BOM 引擎剥离）
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// 版本闸门：`None` = 通过（缺省 1 / 类型错已在 validate_structure 报 schema 错）；
/// `Some(found)` = 不支持的版本，调用方必须终止。
fn version_check(value: &Value) -> Option<u32> {
    let v = value.get("version")?;
    let n = v.as_u64()?;
    if SUPPORTED_VERSIONS.contains(&(n as u32)) && n <= u32::MAX as u64 {
        None
    } else {
        Some(u32::try_from(n).unwrap_or(u32::MAX))
    }
}

fn schema_err(errors: &mut Vec<RuleIssue>, path: String, message: String) {
    errors.push(RuleIssue {
        code: IssueCode::RulesSchema,
        rule: None,
        path,
        message,
    });
}

fn sem_err(errors: &mut Vec<RuleIssue>, rule: &'static str, path: String, message: String) {
    errors.push(RuleIssue {
        code: IssueCode::RulesSemantic,
        rule: Some(rule),
        path,
        message,
    });
}

fn warn(warnings: &mut Vec<RuleIssue>, rule: &'static str, path: String, message: String) {
    warnings.push(RuleIssue {
        code: IssueCode::Unsupported,
        rule: Some(rule),
        path,
        message,
    });
}

/// id 格式：`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`（§3.7 $defs/id）
fn is_id(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphanumeric() || c == '_' => {}
        _ => return false,
    }
    let n = s.chars().count();
    n <= 64
        && it.take(63).all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn check_id_field(v: Option<&Value>, path: String, errors: &mut Vec<RuleIssue>) {
    match v {
        None => schema_err(errors, path, "缺少必填字段".to_string()),
        Some(x) => match x.as_str() {
            None => schema_err(errors, path, "必须是字符串".to_string()),
            Some(s) if !is_id(s) => schema_err(
                errors,
                path,
                format!("\"{s}\" 不符合 id 格式 ^[A-Za-z0-9_][A-Za-z0-9_.-]{{0,63}}$"),
            ),
            _ => {}
        },
    }
}

fn check_string_field(
    v: Option<&Value>,
    path: String,
    max_len: Option<usize>,
    errors: &mut Vec<RuleIssue>,
) {
    if let Some(x) = v {
        match x.as_str() {
            None => schema_err(errors, path, "必须是字符串".to_string()),
            Some(s) => {
                if let Some(max) = max_len {
                    if s.chars().count() > max {
                        schema_err(errors, path, format!("长度超过上限 {max}"));
                    }
                }
            }
        }
    }
}

fn check_bool_field(v: Option<&Value>, path: String, errors: &mut Vec<RuleIssue>) {
    if let Some(x) = v {
        if !x.is_boolean() {
            schema_err(errors, path, "必须是布尔值".to_string());
        }
    }
}

/// id 数组：元素字符串 + id 格式 + 去重
fn check_id_array(arr: &[Value], path: String, errors: &mut Vec<RuleIssue>) {
    let mut seen: HashSet<&str> = HashSet::new();
    for (i, x) in arr.iter().enumerate() {
        let p = format!("{path}[{i}]");
        match x.as_str() {
            None => schema_err(errors, p, "必须是字符串".to_string()),
            Some(s) => {
                if !is_id(s) {
                    schema_err(errors, p.clone(), format!("\"{s}\" 不符合 id 格式"));
                }
                if !seen.insert(s) {
                    schema_err(errors, p, format!("\"{s}\" 重复（uniqueItems）"));
                }
            }
        }
    }
}

fn check_array_field(
    v: Option<&Value>,
    path: String,
    min_items: Option<usize>,
    max_items: usize,
    errors: &mut Vec<RuleIssue>,
    f: impl Fn(&Value, String, &mut Vec<RuleIssue>),
) {
    let arr = match v {
        None => {
            schema_err(errors, path, "缺少必填字段".to_string());
            return;
        }
        Some(x) => match x.as_array() {
            Some(a) => a,
            None => {
                schema_err(errors, path, "必须是数组".to_string());
                return;
            }
        },
    };
    if let Some(min) = min_items {
        if arr.len() < min {
            schema_err(errors, path.clone(), format!("至少需要 {min} 项（minItems: {min}）"));
        }
    }
    if arr.len() > max_items {
        schema_err(errors, path.clone(), format!("超过上限 {max_items} 项"));
    }
    for (i, item) in arr.iter().enumerate() {
        f(item, format!("{path}[{i}]"), errors);
    }
}

// ---------------------------------------------------------------------------
// 结构层：手写镜像 §3.7 schema（未知字段 / 必填 / 类型 / 枚举 / id 正则 /
// 边界 / 去重）。kind↔字段条件（S06/S07）不在此层（结构层不懂 kind 缺省
// 语义，统一由语义层做；schema 里的 allOf 是给编辑器的）。
// ---------------------------------------------------------------------------

fn validate_structure(v: &Value, errors: &mut Vec<RuleIssue>) {
    let Some(obj) = v.as_object() else {
        schema_err(errors, "$".to_string(), "顶层必须是 JSON 对象".to_string());
        return;
    };

    // 未知字段（version 的值已由版本闸门处理）
    for k in obj.keys() {
        if !matches!(k.as_str(), "$schema" | "version" | "description" | "filters" | "groups") {
            schema_err(
                errors,
                format!("$.{k}"),
                format!("未知字段 \"{k}\"（additionalProperties: false）"),
            );
        }
    }

    // version 类型（缺省 = 1；非整数 → schema 错，S11）
    if let Some(x) = obj.get("version") {
        if !x.is_null() && x.as_u64().is_none() {
            schema_err(errors, "$.version".to_string(), "version 必须是整数".to_string());
        }
    }

    // $schema：任意字符串（引擎不校验 uri，§3.2）
    check_string_field(obj.get("$schema"), "$.$schema".to_string(), None, errors);
    check_string_field(
        obj.get("description"),
        "$.description".to_string(),
        Some(MAX_DESC_LEN),
        errors,
    );

    check_array_field(
        obj.get("filters"),
        "$.filters".to_string(),
        Some(1),
        MAX_FILTERS,
        errors,
        validate_filter,
    );

    if let Some(g) = obj.get("groups") {
        match g.as_array() {
            None => schema_err(errors, "$.groups".to_string(), "groups 必须是数组".to_string()),
            Some(arr) => {
                if arr.len() > MAX_GROUPS {
                    schema_err(errors, "$.groups".to_string(), format!("超过上限 {MAX_GROUPS} 项"));
                }
                for (i, gr) in arr.iter().enumerate() {
                    validate_group(gr, format!("$.groups[{i}]"), errors);
                }
            }
        }
    }
}

fn validate_filter(v: &Value, path: String, errors: &mut Vec<RuleIssue>) {
    let Some(obj) = v.as_object() else {
        schema_err(errors, path, "过滤器必须是对象".to_string());
        return;
    };
    for k in obj.keys() {
        if !matches!(k.as_str(), "id" | "label" | "pattern" | "isRegex" | "caseSensitive") {
            schema_err(
                errors,
                format!("{path}.{k}"),
                format!("未知字段 \"{k}\"（additionalProperties: false）"),
            );
        }
    }
    check_id_field(obj.get("id"), format!("{path}.id"), errors);
    check_string_field(obj.get("label"), format!("{path}.label"), Some(MAX_LABEL_LEN), errors);
    match obj.get("pattern") {
        None => schema_err(errors, format!("{path}.pattern"), "缺少必填字段 \"pattern\"".to_string()),
        Some(p) => match p.as_str() {
            None => schema_err(errors, format!("{path}.pattern"), "必须是字符串".to_string()),
            Some(s) if s.is_empty() => {
                schema_err(errors, format!("{path}.pattern"), "不能为空（minLength: 1）".to_string())
            }
            Some(s) if s.chars().count() > MAX_PATTERN_LEN => {
                schema_err(errors, format!("{path}.pattern"), format!("长度超过上限 {MAX_PATTERN_LEN}"))
            }
            _ => {}
        },
    }
    check_bool_field(obj.get("isRegex"), format!("{path}.isRegex"), errors);
    check_bool_field(obj.get("caseSensitive"), format!("{path}.caseSensitive"), errors);
}

fn validate_group(v: &Value, path: String, errors: &mut Vec<RuleIssue>) {
    let Some(obj) = v.as_object() else {
        schema_err(errors, path, "group 必须是对象".to_string());
        return;
    };
    for k in obj.keys() {
        if !matches!(
            k.as_str(),
            "groupId" | "label" | "scope" | "filterIds" | "edges" | "nodeCounts" | "nodeConditions"
        ) {
            schema_err(
                errors,
                format!("{path}.{k}"),
                format!("未知字段 \"{k}\"（additionalProperties: false）"),
            );
        }
    }
    check_id_field(obj.get("groupId"), format!("{path}.groupId"), errors);
    check_string_field(obj.get("label"), format!("{path}.label"), Some(MAX_LABEL_LEN), errors);
    if let Some(s) = obj.get("scope") {
        match s.as_str() {
            Some("global") | Some("thread") => {}
            _ => schema_err(
                errors,
                format!("{path}.scope"),
                "必须是 \"global\" 或 \"thread\"".to_string(),
            ),
        }
    }
    check_array_field(
        obj.get("filterIds"),
        format!("{path}.filterIds"),
        Some(1),
        MAX_GROUP_FILTERS,
        errors,
        |item, p, errs| {
            check_id_array(std::slice::from_ref(item), p, errs);
        },
    );
    check_array_field(
        obj.get("edges"),
        format!("{path}.edges"),
        None,
        MAX_EDGES,
        errors,
        validate_edge,
    );
    check_node_counts(obj.get("nodeCounts"), format!("{path}.nodeCounts"), errors);
    check_node_conditions(obj.get("nodeConditions"), format!("{path}.nodeConditions"), errors);
}

fn validate_edge(v: &Value, path: String, errors: &mut Vec<RuleIssue>) {
    let Some(obj) = v.as_object() else {
        schema_err(errors, path, "边必须是对象".to_string());
        return;
    };
    for k in obj.keys() {
        if !matches!(
            k.as_str(),
            "id" | "kind" | "fromFilterId" | "toFilterId" | "toFilterIds" | "maxGapMs" | "periodMs"
        ) {
            schema_err(
                errors,
                format!("{path}.{k}"),
                format!("未知字段 \"{k}\"（additionalProperties: false）"),
            );
        }
    }
    check_id_field(obj.get("id"), format!("{path}.id"), errors);
    if let Some(k) = obj.get("kind") {
        if !matches!(
            k.as_str(),
            Some("seq") | Some("not") | Some("and") | Some("or") | Some("opt") | Some("periodic")
        ) {
            schema_err(
                errors,
                format!("{path}.kind"),
                "必须是 seq/not/and/or/opt/periodic 之一".to_string(),
            );
        }
    }
    check_id_field(obj.get("fromFilterId"), format!("{path}.fromFilterId"), errors);
    if let Some(t) = obj.get("toFilterId") {
        check_id_field(Some(t), format!("{path}.toFilterId"), errors);
    }
    if let Some(t) = obj.get("toFilterIds") {
        match t.as_array() {
            None => schema_err(errors, format!("{path}.toFilterIds"), "必须是数组".to_string()),
            Some(arr) => {
                if arr.len() < 2 {
                    schema_err(
                        errors,
                        format!("{path}.toFilterIds"),
                        "至少需要 2 项（minItems: 2）".to_string(),
                    );
                }
                if arr.len() > MAX_EDGE_TARGETS {
                    schema_err(
                        errors,
                        format!("{path}.toFilterIds"),
                        format!("超过上限 {MAX_EDGE_TARGETS} 项"),
                    );
                }
                check_id_array(arr, format!("{path}.toFilterIds"), errors);
            }
        }
    }
    match obj.get("maxGapMs") {
        None => schema_err(errors, format!("{path}.maxGapMs"), "缺少必填字段 \"maxGapMs\"".to_string()),
        Some(n) => match n.as_i64() {
            Some(m) if m >= 0 => {}
            Some(m) => schema_err(errors, format!("{path}.maxGapMs"), format!("{m} 小于下限 0")),
            None => schema_err(errors, format!("{path}.maxGapMs"), "必须是整数".to_string()),
        },
    }
    if let Some(n) = obj.get("periodMs") {
        match n.as_i64() {
            Some(m) if m > 0 => {}
            Some(m) => schema_err(errors, format!("{path}.periodMs"), format!("{m} 必须大于 0")),
            None => schema_err(errors, format!("{path}.periodMs"), "必须是整数".to_string()),
        }
    }
}

fn check_node_counts(v: Option<&Value>, path: String, errors: &mut Vec<RuleIssue>) {
    let Some(x) = v else { return };
    let Some(obj) = x.as_object() else {
        schema_err(errors, path, "nodeCounts 必须是对象".to_string());
        return;
    };
    if obj.len() > MAX_NODE_MAP {
        schema_err(errors, path.clone(), format!("超过上限 {MAX_NODE_MAP} 个键"));
    }
    for (k, val) in obj {
        let p = format!("{path}.{k}");
        if !is_id(k) {
            schema_err(errors, p.clone(), format!("键 \"{k}\" 不符合 id 格式"));
        }
        let Some(nc) = val.as_object() else {
            schema_err(errors, p, "必须是对象 {min?, max?}".to_string());
            continue;
        };
        for kk in nc.keys() {
            if !matches!(kk.as_str(), "min" | "max") {
                schema_err(errors, format!("{p}.{kk}"), format!("未知字段 \"{kk}\""));
            }
        }
        for key in ["min", "max"] {
            if let Some(n) = nc.get(key) {
                match n.as_i64() {
                    Some(m) if m >= 1 => {}
                    Some(m) => schema_err(errors, format!("{p}.{key}"), format!("{m} 小于下限 1")),
                    None => schema_err(errors, format!("{p}.{key}"), "必须是整数".to_string()),
                }
            }
        }
        if !nc.contains_key("min") && !nc.contains_key("max") {
            schema_err(errors, p, "min / max 至少给一个".to_string());
        }
    }
}

fn check_node_conditions(v: Option<&Value>, path: String, errors: &mut Vec<RuleIssue>) {
    let Some(x) = v else { return };
    let Some(obj) = x.as_object() else {
        schema_err(errors, path, "nodeConditions 必须是对象".to_string());
        return;
    };
    if obj.len() > MAX_NODE_MAP {
        schema_err(errors, path.clone(), format!("超过上限 {MAX_NODE_MAP} 个键"));
    }
    for (k, val) in obj {
        let p = format!("{path}.{k}");
        if !is_id(k) {
            schema_err(errors, p.clone(), format!("键 \"{k}\" 不符合 id 格式"));
        }
        match val.as_str() {
            None => schema_err(errors, p, "必须是字符串".to_string()),
            Some(s) if s.is_empty() => {
                schema_err(errors, p, "不能为空（minLength: 1）".to_string())
            }
            Some(s) if s.chars().count() > MAX_EXPR_LEN => {
                schema_err(errors, p, format!("长度超过上限 {MAX_EXPR_LEN}"))
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// 语义层（S01–S10 + W01–W05）：typed 反序列化成功后执行
// ---------------------------------------------------------------------------

fn validate_semantics(
    file: &RulesFile,
    errors: &mut Vec<RuleIssue>,
    warnings: &mut Vec<RuleIssue>,
) {
    // ---- S01 过滤器 id 唯一 / S08 正则可编译 ----
    let mut filter_first: HashMap<&str, usize> = HashMap::new();
    for (i, f) in file.filters.iter().enumerate() {
        if let Some(&j) = filter_first.get(f.id.as_str()) {
            sem_err(
                errors,
                "S01",
                format!("$.filters[{i}].id"),
                format!("过滤器 id \"{}\" 重复（首次出现于 filters[{j}]）", f.id),
            );
        } else {
            filter_first.insert(f.id.as_str(), i);
        }
        if f.is_regex {
            let pat = Pattern {
                pattern: f.pattern.clone(),
                case_sensitive: f.case_sensitive,
                is_regex: true,
            };
            if let Err(e) = pat.compile() {
                errors.push(RuleIssue {
                    code: IssueCode::Pattern,
                    rule: Some("S08"),
                    path: format!("$.filters[{i}].pattern"),
                    message: e.to_string(),
                });
            }
        }
    }
    let declared: HashSet<&str> = file.filters.iter().map(|f| f.id.as_str()).collect();

    // ---- S02–S10（逐 group；S05 边 id 跨 group 唯一）----
    let mut group_first: HashMap<&str, usize> = HashMap::new();
    let mut edge_first: HashMap<&str, (usize, usize)> = HashMap::new();
    for (gi, g) in file.groups.iter().enumerate() {
        let gpath = format!("$.groups[{gi}]");

        if let Some(&j) = group_first.get(g.group_id.as_str()) {
            sem_err(
                errors,
                "S02",
                format!("{gpath}.groupId"),
                format!("groupId \"{}\" 重复（首次出现于 groups[{j}]）", g.group_id),
            );
        } else {
            group_first.insert(g.group_id.as_str(), gi);
        }

        // W01
        if g.scope == "thread" {
            warn(
                warnings,
                "W01",
                format!("{gpath}.scope"),
                "scope=thread 引擎 v1 不支持，该 group 将不计算（fallback）".to_string(),
            );
        }

        let members: HashSet<&str> = g.filter_ids.iter().map(|s| s.as_str()).collect();

        // S03
        for (i, fid) in g.filter_ids.iter().enumerate() {
            if !declared.contains(fid.as_str()) {
                sem_err(
                    errors,
                    "S03",
                    format!("{gpath}.filterIds[{i}]"),
                    format!("引用了未声明的过滤器 \"{fid}\""),
                );
            }
        }

        // W04 / W05（非空才警告；空 map = 未写）
        if g.node_counts.as_ref().is_some_and(|m| !m.is_empty()) {
            warn(
                warnings,
                "W04",
                format!("{gpath}.nodeCounts"),
                "nodeCounts 引擎 v1 不支持，该 group 将不计算（fallback）".to_string(),
            );
        }
        if g.node_conditions.as_ref().is_some_and(|m| !m.is_empty()) {
            warn(
                warnings,
                "W05",
                format!("{gpath}.nodeConditions"),
                "nodeConditions 引擎 v1 不支持，该 group 将不计算（fallback）".to_string(),
            );
        }

        // S09
        if let Some(ncs) = &g.node_counts {
            for k in ncs.keys() {
                if !members.contains(k.as_str()) {
                    sem_err(
                        errors,
                        "S09",
                        format!("{gpath}.nodeCounts.{k}"),
                        format!("键 \"{k}\" 不在 group \"{}\" 的 filterIds 中", g.group_id),
                    );
                }
            }
        }
        if let Some(ncs) = &g.node_conditions {
            for k in ncs.keys() {
                if !members.contains(k.as_str()) {
                    sem_err(
                        errors,
                        "S09",
                        format!("{gpath}.nodeConditions.{k}"),
                        format!("键 \"{k}\" 不在 group \"{}\" 的 filterIds 中", g.group_id),
                    );
                }
            }
        }

        // S10：nodeCount 1 ≤ min ≤ max（缺省端 min=1 / max=∞）
        if let Some(ncs) = &g.node_counts {
            for (k, nc) in ncs {
                let min = nc.min.unwrap_or(1);
                if let Some(max) = nc.max {
                    if min > max {
                        sem_err(
                            errors,
                            "S10",
                            format!("{gpath}.nodeCounts.{k}"),
                            format!("min={min} max={max} 不满足 1 ≤ min ≤ max"),
                        );
                    }
                }
            }
        }

        for (ei, e) in g.edges.iter().enumerate() {
            let epath = format!("{gpath}.edges[{ei}]");
            let kind = e.kind.as_deref().unwrap_or("seq");

            // S05（跨 group 唯一）
            if let Some(&(gj, ej)) = edge_first.get(e.id.as_str()) {
                sem_err(
                    errors,
                    "S05",
                    format!("{epath}.id"),
                    format!("边 id \"{}\" 重复（首次出现于 groups[{gj}].edges[{ej}]）", e.id),
                );
            } else {
                edge_first.insert(e.id.as_str(), (gi, ei));
            }

            // S04
            if !members.contains(e.from_filter_id.as_str()) {
                sem_err(
                    errors,
                    "S04",
                    format!("{epath}.fromFilterId"),
                    format!(
                        "边端点 \"{}\" 不在 group \"{}\" 的 filterIds 中",
                        e.from_filter_id, g.group_id
                    ),
                );
            }
            if let Some(t) = &e.to_filter_id {
                if !members.contains(t.as_str()) {
                    sem_err(
                        errors,
                        "S04",
                        format!("{epath}.toFilterId"),
                        format!("边端点 \"{t}\" 不在 group \"{}\" 的 filterIds 中", g.group_id),
                    );
                }
            }
            if let Some(ts) = &e.to_filter_ids {
                for (i, t) in ts.iter().enumerate() {
                    if !members.contains(t.as_str()) {
                        sem_err(
                            errors,
                            "S04",
                            format!("{epath}.toFilterIds[{i}]"),
                            format!("边端点 \"{t}\" 不在 group \"{}\" 的 filterIds 中", g.group_id),
                        );
                    }
                }
            }

            // S06：kind ↔ 目标字段（§3.5 表；kind 缺省 = seq）
            if kind == "and" || kind == "or" {
                if e.to_filter_ids.is_none() {
                    sem_err(
                        errors,
                        "S06",
                        format!("{epath}.toFilterIds"),
                        format!("kind={kind} 必须提供 toFilterIds（2..16 项）"),
                    );
                }
                if e.to_filter_id.is_some() {
                    sem_err(
                        errors,
                        "S06",
                        format!("{epath}.toFilterId"),
                        format!("kind={kind} 不允许提供 toFilterId（以 toFilterIds 为准）"),
                    );
                }
            } else {
                if e.to_filter_id.is_none() {
                    sem_err(
                        errors,
                        "S06",
                        format!("{epath}.toFilterId"),
                        format!("kind={kind} 必须提供 toFilterId"),
                    );
                }
                if e.to_filter_ids.is_some() {
                    sem_err(
                        errors,
                        "S06",
                        format!("{epath}.toFilterIds"),
                        format!("kind={kind} 不允许提供 toFilterIds"),
                    );
                }
            }

            // S07：periodic ↔ periodMs
            if kind == "periodic" {
                if e.period_ms.is_none() {
                    sem_err(
                        errors,
                        "S07",
                        format!("{epath}.periodMs"),
                        "kind=periodic 必须提供 periodMs".to_string(),
                    );
                }
                warn(
                    warnings,
                    "W03",
                    format!("{epath}.kind"),
                    "kind=periodic 引擎 v1 不支持，该 group 将不计算（fallback）".to_string(),
                );
            } else if e.period_ms.is_some() {
                sem_err(
                    errors,
                    "S07",
                    format!("{epath}.periodMs"),
                    format!("kind={kind} 不允许提供 periodMs（仅 periodic）"),
                );
            }

            // W02（kind=opt）：engine ≥ 0.2.0 已支持，不再告警/回退
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const MINIMAL: &str = r#"{
        "version": 1,
        "filters": [ { "id": "error", "pattern": "FATAL" } ],
        "groups": [ { "groupId": "g", "filterIds": ["error"], "edges": [] } ]
    }"#;

    fn report(json: &str) -> RuleReport {
        validate_rules(json)
    }

    fn rules(code: IssueCode, rule: Option<&str>) -> impl Fn(&RuleIssue) -> bool + '_ {
        move |i: &RuleIssue| i.code == code && i.rule == rule
    }

    #[test]
    fn minimal_file_is_valid() {
        let r = report(MINIMAL);
        assert!(r.valid, "errors: {:?}", r.errors);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn defaults_version_and_groups() {
        let r = report(r#"{ "filters": [ { "id": "a", "pattern": "x" } ] }"#);
        assert!(r.valid, "errors: {:?}", r.errors);
        let f = parse_rules(r#"{ "filters": [ { "id": "a", "pattern": "x" } ] }"#).unwrap();
        assert_eq!(f.version, 1);
        assert!(f.groups.is_empty());
        assert!(f.schema_ref.is_none());
        assert!(f.description.is_none());
    }

    #[test]
    fn syntax_error_is_e_rules_syntax() {
        let r = report("{ not json");
        assert!(!r.valid);
        assert!(r.errors.iter().any(rules(IssueCode::RulesSyntax, None)));
        match parse_rules("{ not json") {
            Err(e) => assert_eq!(e.code().as_str(), "E_RULES_SYNTAX"),
            Ok(_) => panic!("应报语法错误"),
        }
    }

    #[test]
    fn bom_is_stripped() {
        let r = report("\u{feff}{ \"filters\": [ { \"id\": \"a\", \"pattern\": \"x\" } ] }");
        assert!(r.valid, "errors: {:?}", r.errors);
    }

    #[test]
    fn unknown_field_rejected() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x", "caseSensitve": true } ] }"#,
        );
        assert!(!r.valid);
        assert!(
            r.errors
                .iter()
                .any(|i| i.path.contains("caseSensitve") && i.code == IssueCode::RulesSchema)
        );
    }

    #[test]
    fn version_gate_terminates() {
        let r = report(r#"{ "version": 2, "filters": [ { "id": "a", "pattern": "x" } ] }"#);
        assert!(!r.valid);
        assert!(r.errors.iter().any(rules(IssueCode::RulesVersion, Some("S11"))));
        // 版本未知 → 不做结构校验（未知字段也不报）
        assert_eq!(r.errors.len(), 1);
        match parse_rules(r#"{ "version": 2, "filters": [ { "id": "a", "pattern": "x" } ] }"#) {
            Err(e) => {
                assert_eq!(e.code().as_str(), "E_RULES_VERSION");
                match e {
                    EngineError::RulesVersion { found, .. } => assert_eq!(found, 2),
                    _ => panic!(),
                }
            }
            Ok(_) => panic!("应报版本错误"),
        }
    }

    #[test]
    fn version_wrong_type_is_schema_error() {
        let r = report(r#"{ "version": "1", "filters": [ { "id": "a", "pattern": "x" } ] }"#);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|i| i.path == "$.version"));
    }

    #[test]
    fn empty_filters_rejected() {
        let r = report(r#"{ "filters": [] }"#);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|i| i.path == "$.filters"));
    }

    #[test]
    fn bad_id_format_rejected() {
        let r = report(r#"{ "filters": [ { "id": "-bad", "pattern": "x" } ] }"#);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|i| i.path == "$.filters[0].id"));
    }

    #[test]
    fn duplicate_filter_id_s01() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" }, { "id": "a", "pattern": "y" } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S01"))));
    }

    #[test]
    fn duplicate_group_id_s02() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [] },
                            { "groupId": "g", "filterIds": ["a"], "edges": [] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S02"))));
    }

    #[test]
    fn undeclared_filter_reference_s03() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a", "ghost"], "edges": [] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S03"))));
    }

    #[test]
    fn edge_endpoint_outside_group_s04() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" }, { "id": "b", "pattern": "y" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [
                    { "id": "e", "fromFilterId": "a", "toFilterId": "b", "maxGapMs": 100 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S04"))));
    }

    #[test]
    fn edge_id_unique_across_groups_s05() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [
                  { "groupId": "g1", "filterIds": ["a"], "edges": [
                    { "id": "e", "fromFilterId": "a", "toFilterId": "a", "maxGapMs": 100 } ] },
                  { "groupId": "g2", "filterIds": ["a"], "edges": [
                    { "id": "e", "fromFilterId": "a", "toFilterId": "a", "maxGapMs": 100 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S05"))));
    }

    #[test]
    fn kind_target_consistency_s06() {
        // and 边缺 toFilterIds
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" }, { "id": "b", "pattern": "y" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a", "b"], "edges": [
                    { "id": "e", "kind": "and", "fromFilterId": "a", "toFilterId": "b", "maxGapMs": 100 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S06"))));
        // seq 边带 toFilterIds
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" }, { "id": "b", "pattern": "y" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a", "b"], "edges": [
                    { "id": "e", "fromFilterId": "a", "toFilterIds": ["a", "b"], "maxGapMs": 100 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S06"))));
        // kind 缺省 = seq：缺 toFilterId
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [
                    { "id": "e", "fromFilterId": "a", "maxGapMs": 100 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S06"))));
    }

    #[test]
    fn periodic_period_ms_s07() {
        // periodic 缺 periodMs
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [
                    { "id": "e", "kind": "periodic", "fromFilterId": "a", "toFilterId": "a", "maxGapMs": 100 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S07"))));
        assert!(r.warnings.iter().any(rules(IssueCode::Unsupported, Some("W03"))));
        // seq 带 periodMs
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [
                    { "id": "e", "fromFilterId": "a", "toFilterId": "a", "maxGapMs": 100, "periodMs": 50 } ] } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S07"))));
    }

    #[test]
    fn bad_regex_s08() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "([unclosed", "isRegex": true } ] }"#,
        );
        assert!(!r.valid);
        assert!(r.errors.iter().any(rules(IssueCode::Pattern, Some("S08"))));
        // 契约 §2.6：parse_rules 对 S 码失败统一返回 RulesSemantic；
        // E_PATTERN 是 issue 层的 code（上面 r.errors 已验证）
        match parse_rules(r#"{ "filters": [ { "id": "a", "pattern": "([x", "isRegex": true } ] }"#) {
            Err(e) => assert_eq!(e.code().as_str(), "E_RULES_SEMANTIC"),
            Ok(_) => panic!("应报正则错误"),
        }
    }

    #[test]
    fn node_map_keys_s09() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" }, { "id": "b", "pattern": "y" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [],
                    "nodeCounts": { "b": { "min": 1 } },
                    "nodeConditions": {} } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S09"))));
    }

    #[test]
    fn node_count_range_s10() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "filterIds": ["a"], "edges": [],
                    "nodeCounts": { "a": { "min": 5, "max": 2 } } } ] }"#,
        );
        assert!(r.errors.iter().any(rules(IssueCode::RulesSemantic, Some("S10"))));
    }

    #[test]
    fn unsupported_features_warn_not_error() {
        let r = report(
            r#"{ "filters": [ { "id": "a", "pattern": "x" }, { "id": "b", "pattern": "y" } ],
                "groups": [ { "groupId": "g", "scope": "thread", "filterIds": ["a", "b"], "edges": [
                    { "id": "e", "kind": "opt", "fromFilterId": "a", "toFilterId": "b", "maxGapMs": 100 } ],
                    "nodeCounts": { "a": { "min": 1 } },
                    "nodeConditions": { "b": "level == 'E'" } } ] }"#,
        );
        assert!(r.valid, "errors: {:?}", r.errors);
        let codes: BTreeSet<&str> = r.warnings.iter().filter_map(|w| w.rule).collect();
        // opt（W02）已在 engine ≥ 0.2.0 支持，不再告警；剩余 W01/W04/W05 仍触发
        assert_eq!(codes, BTreeSet::from(["W01", "W04", "W05"]));
    }

    #[test]
    fn schema_ref_and_label_accepted() {
        let r = report(
            r#"{ "$schema": "https://loggraph.dev/schemas/cep-rules-1.schema.json",
                "description": "d",
                "filters": [ { "id": "a", "label": "展示名", "pattern": "x" } ],
                "groups": [ { "groupId": "g", "label": "组名", "filterIds": ["a"], "edges": [] } ] }"#,
        );
        assert!(r.valid, "errors: {:?}", r.errors);
        let f = parse_rules(r#"{ "filters": [ { "id": "a", "pattern": "x", "label": "L" } ] }"#)
            .unwrap();
        assert_eq!(f.filters[0].label.as_deref(), Some("L"));
    }

    #[test]
    fn embedded_schema_is_valid_json() {
        let v: Value = serde_json::from_str(CEP_RULES_SCHEMA).expect("内嵌 schema 必须是合法 JSON");
        assert_eq!(v["$id"], "https://loggraph.dev/schemas/cep-rules-1.schema.json");
    }
}
