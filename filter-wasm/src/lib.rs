use wasm_bindgen::prelude::*;

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
