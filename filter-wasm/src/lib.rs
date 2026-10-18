use wasm_bindgen::prelude::*;

/// 多行 filter 的命中聚合 —— 与桌面引擎 `engine/src/filter_agg.rs` 逐字节同源。
/// Web 端（dbStore / FilterEngine）经此函数跑与桌面 native 引擎完全相同的
/// 「正向交集 − 排除并集」聚合，杜绝两端分叉（契约 §3.14）。
#[path = "../../engine/src/filter_agg.rs"]
mod filter_agg;

/// 编译后的正则表达式，底层是 Rust 标准 `regex` crate —— 与桌面（Tauri）后端
/// 用于过滤的引擎逐字节一致。导出到 JS，让 Web 端过滤结果与桌面端完全相同。
///
/// 默认启用 Unicode 模式（与 `regex::Regex::new` 一致），因此 `\b` 按 Unicode
/// 词边界解释，与桌面端一致；且同样**不支持**环视断言 / 反向引用（编译即报错），
/// 从而消除 web/desktop 的过滤引擎分歧（web-desktop-consistency-review.md §1.1）。
#[wasm_bindgen]
pub struct Regex {
    inner: regex::Regex,
}

#[wasm_bindgen]
impl Regex {
    /// 编译一个 pattern。`case_insensitive` 对应桌面过滤器的同名开关。
    #[wasm_bindgen(constructor)]
    pub fn new(pattern: &str, case_insensitive: bool) -> Result<Regex, JsError> {
        let mut b = regex::RegexBuilder::new(pattern);
        b.case_insensitive(case_insensitive);
        b.build()
            .map(|inner| Regex { inner })
            .map_err(|e| JsError::new(&format!("无效的正则表达式: {e}")))
    }

    /// 若 pattern 在 text 中任意位置匹配则返回 true。
    #[wasm_bindgen(js_name = "isMatch")]
    pub fn is_match(&self, text: &str) -> bool {
        self.inner.is_match(text)
    }

    /// 返回首个匹配的 [start, end) 字节区间，无匹配返回 null。
    #[wasm_bindgen(js_name = "find")]
    pub fn find(&self, text: &str) -> Option<MatchSpan> {
        self.inner.find(text).map(|m| MatchSpan {
            start: m.start(),
            end: m.end(),
        })
    }
}

#[wasm_bindgen]
pub struct MatchSpan {
    #[wasm_bindgen(getter)]
    pub start: usize,
    #[wasm_bindgen(getter)]
    pub end: usize,
}

/// 多行 filter 子条件命中聚合（与桌面引擎同源）。
///
/// `pos_json` / `neg_json` 均为 JSON 字符串，形状 `[[{line, ts}, ...], ...]`：
/// - `pos_json`：各**正向**子条件的命中集（行号升序、ts 对齐）。
/// - `neg_json`：各**排除**子条件（`!` 前缀）的命中集。
///
/// 返回 JSON 字符串 `[{line, ts}, ...]`：正向集合交集 − 排除集合并集
/// （以最短正向集为基）。空 `pos` 返回 `[]`。解析失败按空集处理（与引擎
/// `aggregate_sub_hits` 的「无正向锚→空」语义一致）。
#[wasm_bindgen(js_name = "aggregateFilterHits")]
pub fn aggregate_filter_hits(pos_json: &str, neg_json: &str) -> String {
    let pos: Vec<Vec<filter_agg::AggHit>> = serde_json::from_str(pos_json).unwrap_or_default();
    let neg: Vec<Vec<filter_agg::AggHit>> = serde_json::from_str(neg_json).unwrap_or_default();
    let out = filter_agg::aggregate_sub_hits(&pos, &neg);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}
