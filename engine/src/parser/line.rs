//! 行后段解析：thread / level / message 提取。
//! 逐条对齐 `src/parser/LogParser.ts` 的 `parseRest()`（含 LEVELS 集合与两段式 level 判定）。
//! （v1.2 自 src-tauri 壳层下沉——行解析属业务语义，壳层不得自有实现。）

use crate::parser::timestamp::build_re;
use regex::Regex;
use std::sync::LazyLock;

/// JS `String.prototype.trim` 的字符集 = Unicode White_Space + U+FEFF。
/// Rust `char::is_whitespace` 即 White_Space 属性但不含 U+FEFF，此处补齐。
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// 对齐 LogParser.LEVELS（裸写比较大小写敏感；括号形式比较 upper 后的值）
const LEVELS: &[&str] = &[
    "TRACE", "DEBUG", "INFO", "NOTICE", "WARN", "WARNING", "ERROR", "ERR", "FATAL", "CRITICAL",
    "CRIT", "ALERT", "EMERG", "PANIC",
];

// JS: /^\[([^\]]+)\]\s*/ —— 锚定行首的 [Thread] 段
static THREAD_RE: LazyLock<Regex> = LazyLock::new(|| build_re(r"^\[([^\]]+)\]\s*"));

// JS: /^([A-Z]+)\s+/ —— 锚定行首的裸写级别词（后随至少一个空白）
static BARE_LEVEL_RE: LazyLock<Regex> = LazyLock::new(|| build_re(r"^([A-Z]+)\s+"));

// JS: /(?:\[|\()([A-Za-z]+)(?:\]|\))\s*/ —— 无锚点，取最左匹配（[INFO] / (WARN)）
static BRACKET_LEVEL_RE: LazyLock<Regex> =
    LazyLock::new(|| build_re(r"(?:\[|\()([A-Za-z]+)(?:\]|\))\s*"));

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
///    否则（不匹配或不在集合）找括号式最左匹配，upper 后属于 LEVELS → level=upper，
///    删除匹配区间本身（保留前缀；JS 旧实现按长度从头切，位置错误，已同步修正）。
pub fn parse_rest(rest: &str) -> RestParsed {
    let mut msg: String = js_trim(rest).to_string();
    let mut thread: Option<String> = None;
    let mut level: Option<String> = None;

    // 1. [Thread1] 开头
    if let Some(caps) = THREAD_RE.captures(&msg) {
        thread = Some(caps[1].to_string());
        let whole = caps.get(0).unwrap();
        msg = js_trim(&msg[whole.end()..]).to_string();
    }

    // 2. 裸写级别（要求 ∈ LEVELS，大小写敏感）
    let mut bare_used = false;
    if let Some(caps) = BARE_LEVEL_RE.captures(&msg) {
        let word = caps.get(1).unwrap().as_str();
        if LEVELS.contains(&word) {
            level = Some(word.to_string());
            let whole = caps.get(0).unwrap();
            msg = js_trim(&msg[whole.end()..]).to_string();
            bare_used = true;
        }
    }

    // 3. 括号级别（裸写未命中/不在集合时；最左匹配，upper 后校验）
    if !bare_used {
        if let Some(caps) = BRACKET_LEVEL_RE.captures(&msg) {
            let upper = caps.get(1).unwrap().as_str().to_uppercase();
            if LEVELS.contains(&upper.as_str()) {
                level = Some(upper);
                let range = caps.get(0).unwrap().range();
                msg.replace_range(range, "");
                msg = js_trim(&msg).to_string();
            }
        }
    }

    RestParsed {
        thread,
        level,
        message: msg,
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
        // 小写 (info) → upper "INFO" ∈ LEVELS → level=INFO（JS 同；
        // 行首 [info] 会被 thread 正则吃掉，故用圆括号测括号级别分支）
        let r = parse_rest("(info) started");
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
