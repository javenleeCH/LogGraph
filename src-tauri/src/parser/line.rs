//! 行后段解析：thread / level / message 提取。
//! 逐条对齐 `src/parser/LogParser.ts` 的 `parseRest()`（含 LEVELS 集合与两段式 level 判定）。

use crate::parser::timestamp::build_re;
use regex::Regex;
use std::sync::OnceLock;

/// JS `String.prototype.trim` 的字符集 = Unicode White_Space + U+FEFF。
/// Rust `char::is_whitespace` 即 White_Space 属性但不含 U+FEFF，此处补齐。
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// 对齐 LogParser.LEVELS（裸写比较大小写敏感；括号形式比较 upper 后的值）
const LEVELS: &[&str] = &[
    "VERBOSE", "TRACE", "DEBUG", "INFO", "NOTICE",
    "WARN", "WARNING", "ERROR", "FATAL", "CRIT", "CRITICAL",
    "EMERG", "EMERGENCY", "ALERT", "I", "D", "W", "E", "F",
];

/// 词是否属于 LEVELS（db.rs 偏移版 parse_rest 复用）
pub fn is_level_word(word: &str) -> bool {
    LEVELS.contains(&word)
}

// JS: /^\[([^\]]+)\]\s*/ —— 锚定行首的 [Thread] 段
fn thread_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"^\[([^\]]+)\]\s*"))
}

// JS: /^([A-Z]+)\s+/ —— 锚定行首的裸写级别词（后随至少一个空白）
fn bare_level_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"^([A-Z]+)\s+"))
}

// JS: /(?:\[|\()([A-Za-z]+)(?:\]|\))\s*/ —— 无锚点，取最左匹配（[INFO] / (WARN)）
fn bracket_level_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"(?:\[|\()([A-Za-z]+)(?:\]|\))\s*"))
}

pub struct RestParsed {
    pub thread: Option<String>,
    pub level: Option<String>,
    pub message: String,
}

/// 解析时间戳之后的剩余段。
/// 对齐 JS parseRest：
/// 1. trim；
/// 2. `^\[([^\]]+)\]\s*` 命中 → thread，剥除后再 trim（[] 内容不校验，"[INFO]" 会被当 thread）；
/// 3. 裸写 `^([A-Z]+)\s+` 命中**且**属于 LEVELS（大小写敏感）→ 剥除；
///    否则（不匹配或不在集合）找括号式最左匹配，upper 后属于 LEVELS → level=upper，剥除。
pub fn parse_rest(rest: &str) -> RestParsed {
    let mut msg: &str = js_trim(rest);
    let mut thread: Option<String> = None;
    let mut level: Option<String> = None;

    // 1. [Thread1] 开头
    if let Some(caps) = thread_re().captures(msg) {
        thread = Some(caps[1].to_string());
        let whole = caps.get(0).unwrap();
        msg = js_trim(&msg[whole.end()..]);
    }

    // 2. 裸写级别（要求 ∈ LEVELS，大小写敏感）
    let mut bare_used = false;
    if let Some(caps) = bare_level_re().captures(msg) {
        let word = caps.get(1).unwrap().as_str();
        if LEVELS.contains(&word) {
            level = Some(word.to_string());
            let whole = caps.get(0).unwrap();
            msg = js_trim(&msg[whole.end()..]);
            bare_used = true;
        }
    }

    // 3. 括号级别（裸写未命中/不在集合时；最左匹配，upper 后校验）
    if !bare_used {
        if let Some(caps) = bracket_level_re().captures(msg) {
            let word = caps.get(1).unwrap().as_str();
            // 捕获仅含 [A-Za-z]，to_uppercase 与 JS toUpperCase 等价
            let upper = word.to_uppercase();
            if LEVELS.contains(&upper.as_str()) {
                level = Some(upper);
                let whole = caps.get(0).unwrap();
                msg = js_trim(&msg[whole.end()..]);
            }
        }
    }

    RestParsed {
        thread,
        level,
        message: msg.to_string(),
    }
}

// ---- 单元测试（每个断言按 JS parseRest 人工推演）----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_includes_bom() {
        // U+FEFF 在 JS trim 集合内，Rust is_whitespace 不含 —— js_trim 补齐
        assert_eq!(js_trim("\u{feff}INFO x\u{feff}"), "INFO x");
        assert_eq!(js_trim("  \t\r\n x \u{00a0}"), "x"); // NBSP 也是 JS trim 集合成员
        assert_eq!(js_trim(""), "");
    }

    #[test]
    fn thread_then_bare_level() {
        let r = parse_rest(" [Thread1] INFO hello world");
        assert_eq!(r.thread.as_deref(), Some("Thread1"));
        assert_eq!(r.level.as_deref(), Some("INFO"));
        assert_eq!(r.message, "hello world");
    }

    #[test]
    fn thread_bracket_level() {
        let r = parse_rest("[main] [E] tag: boom");
        assert_eq!(r.thread.as_deref(), Some("main"));
        assert_eq!(r.level.as_deref(), Some("E"));
        assert_eq!(r.message, "tag: boom");
    }

    #[test]
    fn unicode_thread_not_broken() {
        // 中文线程名：unicode 模式下 [^\]] 按 char 匹配，切片安全
        let r = parse_rest("[线程池-1] ERROR 崩溃");
        assert_eq!(r.thread.as_deref(), Some("线程池-1"));
        assert_eq!(r.level.as_deref(), Some("ERROR"));
        assert_eq!(r.message, "崩溃");
    }

    #[test]
    fn lowercase_bracket_level_uppercased() {
        // 小写 [info] → upper "INFO" ∈ LEVELS → level=INFO（JS 同）
        let r = parse_rest("[info] started");
        assert_eq!(r.level.as_deref(), Some("INFO"));
        assert_eq!(r.message, "started");
    }

    #[test]
    fn bracket_info_consumed_as_thread() {
        // [INFO] 在行首会被 thread 正则吃掉（thread 不查 LEVELS，JS 同）
        let r = parse_rest("[INFO] message body");
        assert_eq!(r.thread.as_deref(), Some("INFO"));
        assert_eq!(r.level, None);
        assert_eq!(r.message, "message body");
    }

    #[test]
    fn bare_level_requires_trailing_space() {
        // 行尾裸词无尾随空白 → ^([A-Z]+)\s+ 不匹配 → 不识别（JS 同）
        let r = parse_rest("INFO");
        assert_eq!(r.level, None);
        assert_eq!(r.message, "INFO");

        let r = parse_rest("INFO hello");
        assert_eq!(r.level.as_deref(), Some("INFO"));
        assert_eq!(r.message, "hello");
    }

    #[test]
    fn bare_word_not_in_levels_falls_to_bracket() {
        // "IMPORTANT" ∉ LEVELS → 走括号分支（无括号则不剥，JS 同）
        let r = parse_rest("IMPORTANT message");
        assert_eq!(r.level, None);
        assert_eq!(r.message, "IMPORTANT message");

        // 裸写不合法但行中有括号级别 → 剥括号处
        let r = parse_rest("IMPORTANT (WARN) message");
        assert_eq!(r.level.as_deref(), Some("WARN"));
        assert_eq!(r.message, "IMPORTANT message");
    }

    #[test]
    fn bracket_level_leftmost_no_thread() {
        // 圆括号组件名不匹配 thread（thread 只认 [..]）；
        // (main) 的 main ∉ LEVELS → 不剥，message 原样（JS 同）
        let r = parse_rest("(main) E crash");
        assert_eq!(r.thread, None);
        assert_eq!(r.level, None);
        assert_eq!(r.message, "(main) E crash");

        // 无 thread 时括号级别取最左
        let r = parse_rest("hello (INFO) world");
        assert_eq!(r.thread, None);
        assert_eq!(r.level.as_deref(), Some("INFO"));
        assert_eq!(r.message, "hello world");
    }

    #[test]
    fn whitespace_only() {
        let r = parse_rest("   \r\n  ");
        assert_eq!(r.thread, None);
        assert_eq!(r.level, None);
        assert_eq!(r.message, "");
    }

    #[test]
    fn level_word_with_multispace_stripped() {
        // \s+ 贪婪：级别词后多个空白一并剥除
        let r = parse_rest("[t] ERROR   msg");
        assert_eq!(r.thread.as_deref(), Some("t"));
        assert_eq!(r.level.as_deref(), Some("ERROR"));
        assert_eq!(r.message, "msg");
    }

    #[test]
    fn fullwidth_space_after_thread_consumed() {
        // 全角空格 ∈ JS \s → JS 会剥；Rust 翻译类同样剥（若用 ASCII \s 则不一致，此处守护）
        let r = parse_rest("[线程]\u{3000}ERROR msg");
        assert_eq!(r.thread.as_deref(), Some("线程"));
        assert_eq!(r.level.as_deref(), Some("ERROR"));
        assert_eq!(r.message, "msg");
    }
}
