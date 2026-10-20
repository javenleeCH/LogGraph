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

/// 日志「布局族」—— 由样本后段（已去时间戳）探测，决定 thread 的额外提取槽位。
///
/// 这是提高 thread 解析覆盖率的**唯一 sanctioned 路径**：按格式族在预期位置取 thread，
/// 绝不做「取消行首锚定、到处找方括号」（那会把假阴性换成更坏的假阳性，见契约 §3.13）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LogFamily {
    /// 未知 / 默认：只用行首 `^\[...\]` 启发式（与旧行为一致）
    Unknown,
    /// Spring Boot / Logback 默认布局：`LEVEL PID --- [thread] logger : msg`
    /// thread 在 `--- [..]` 标记之后，而非行首。
    SpringLogback,
    /// log4j2 变体 / 自定义布局：`LEVEL [thread] logger - msg`
    /// thread 是紧跟级别词之后的第一个 `[..]`。
    Log4jThreadAfter,
    /// Python logging `%(threadName)s`：`Thread-N` / `MainThread` / `Dummy-N` / 池线程
    PythonThread,
    /// syslog（RFC3164/5424 传统）：`program[pid]` 组件标识（name[digits]）
    SyslogComponent,
}

// 位置约束的家族标记（不锚行首，但要求固定的 `--- [thread]` 分隔符）
static SPRING_RE: LazyLock<Regex> = LazyLock::new(|| build_re(r" --- \[[^\]]+\]"));
// 行首 `LEVEL [thread]`：级别词（纯字母）后紧跟 `[thread]`
static LOG4J_RE: LazyLock<Regex> =
    LazyLock::new(|| build_re(r"^[A-Za-z][A-Za-z]*\s+\[[^\]]+\]"));
// Python threading 标记：Thread-N / MainThread / Dummy-N / 池线程（独特，不误抓）
static PYTHON_THREAD_RE: LazyLock<Regex> = LazyLock::new(|| {
    build_re(r"Thread-\d+|MainThread|Dummy-\d+|ThreadPoolExecutor-\d+_\d+|asyncio_loop")
});
// syslog 组件：program[pid]:（含前导与冒号后空格一并剥，避免残留分隔符/双空格）
static SYSLOG_COMP_RE: LazyLock<Regex> =
    LazyLock::new(|| build_re(r"\s*(\S+)\[(\d+)\]:\s*"));
// 通用括号捕获（取第一个 `[..]` 内容）
static BRACKET_RE: LazyLock<Regex> = LazyLock::new(|| build_re(r"\[([^\]]+)\]"));

/// 由样本后段（已去除时间戳）探测日志布局族。
/// 多数决：某族命中率 > 50% 才采用，否则回退 Unknown（保守，避免偶发括号误抓）。
pub fn detect_log_family(rests: &[&str]) -> LogFamily {
    let mut total = 0usize;
    let mut sb = 0usize;
    let mut lj = 0usize;
    let mut py = 0usize;
    let mut sys = 0usize;
    for r in rests.iter().take(200) {
        let t = js_trim(r);
        if t.is_empty() {
            continue;
        }
        total += 1;
        if SPRING_RE.is_match(t) {
            sb += 1;
        }
        if LOG4J_RE.is_match(t) {
            lj += 1;
        }
        if PYTHON_THREAD_RE.is_match(t) {
            py += 1;
        }
        if SYSLOG_COMP_RE.is_match(t) {
            sys += 1;
        }
    }
    if total == 0 {
        return LogFamily::Unknown;
    }
    let half = total / 2;
    if sb > half {
        LogFamily::SpringLogback
    } else if lj > half {
        LogFamily::Log4jThreadAfter
    } else if py > half {
        LogFamily::PythonThread
    } else if sys > half {
        LogFamily::SyslogComponent
    } else {
        LogFamily::Unknown
    }
}

/// 位置约束的家族内 thread 提取（仅当默认行首启发式未命中时调用）。
/// 返回 (thread, 更新后的 message)。家族外绝不取 thread，故不会引入误抓。
fn extract_family_thread(msg: &str, family: LogFamily) -> (Option<String>, String) {
    match family {
        LogFamily::Unknown => (None, msg.to_string()),
        LogFamily::SpringLogback => {
            // ` --- [thread]`：取标记后的第一个括号 token 作 thread，并把该标记段替换为空格
            if let Some(m) = SPRING_RE.find(msg) {
                if let Some(b) = BRACKET_RE.captures(&msg[m.start()..m.end()]) {
                    let thread = b.get(1).unwrap().as_str().to_string();
                    let replaced =
                        format!("{} {}", &msg[..m.start()], &msg[m.end()..]).trim().to_string();
                    (Some(thread), replaced)
                } else {
                    (None, msg.to_string())
                }
            } else {
                (None, msg.to_string())
            }
        }
        LogFamily::Log4jThreadAfter => {
            // 紧跟级别词之后的第一个 `[..]`（级别已在前置步骤剥除，这里 msg 以 `[..]` 起或含之）
            if let Some(c) = BRACKET_RE.captures(msg) {
                let thread = c.get(1).unwrap().as_str().to_string();
                let range = c.get(0).unwrap().range();
                let mut s = msg.to_string();
                s.replace_range(range, " ");
                (Some(thread), js_trim(&s).to_string())
            } else {
                (None, msg.to_string())
            }
        }
        LogFamily::PythonThread => {
            // logging %(threadName)s：Thread-N / MainThread / Dummy-N / 池线程，取首个并剥除
            if let Some(m) = PYTHON_THREAD_RE.find(msg) {
                let thread = m.as_str().to_string();
                let replaced = trim_delim(&format!("{} {}", &msg[..m.start()], &msg[m.end()..]));
                (Some(thread), replaced)
            } else {
                (None, msg.to_string())
            }
        }
        LogFamily::SyslogComponent => {
            // syslog program[pid]: → 组件标识取 name[pid]，连前导空格/冒号一起剥（对齐 spring 干净剥法）
            if let Some(c) = SYSLOG_COMP_RE.captures(msg) {
                let thread = format!("{}[{}]", c.get(1).unwrap().as_str(), c.get(2).unwrap().as_str());
                let range = c.get(0).unwrap().range();
                let mut s = msg.to_string();
                s.replace_range(range, " ");
                (Some(thread), js_trim(&s).to_string())
            } else {
                (None, msg.to_string())
            }
        }
    }
}

/// 剥除 token 后残留的分隔符（`:` 与 `-`）再 js_trim；Python/syslog 的 thread token
/// 常紧贴 `:`（`Thread-1:` / `nginx[1234]:`），移除 token 后需要一并清掉。
fn trim_delim(s: &str) -> String {
    let t = s.trim_start_matches([':', '-', ' ', '\t']);
    js_trim(t).to_string()
}

/// 家族感知版：默认启发式之后，若未取到 thread，再按家族在预期槽位补取。
/// 家族感知提取是位置约束的，绝不会「到处找方括号」，故不会引入误抓。
pub fn parse_rest_fam(rest: &str, family: LogFamily) -> RestParsed {
    let mut parsed = parse_rest(rest);
    if parsed.thread.is_none() {
        let (t, m) = extract_family_thread(&parsed.message, family);
        if t.is_some() {
            parsed.thread = t;
            parsed.message = m;
        }
    }
    parsed
}

/// 对齐 LogParser.LEVELS（裸写比较大小写敏感；括号形式比较 upper 后的值）。
/// 含 TS 端的单字母级别 I/D/W/E/F 与 VERBOSE/EMERGENCY；ERR/PANIC 为 Rust 端额外同义词。
const LEVELS: &[&str] = &[
    "VERBOSE", "TRACE", "DEBUG", "INFO", "NOTICE", "WARN", "WARNING", "ERROR", "ERR", "FATAL",
    "CRIT", "CRITICAL", "EMERG", "EMERGENCY", "ALERT", "PANIC", "I", "D", "W", "E", "F",
];

// JS: /^\[([^\]]+)\]\s*/ —— 锚定行首的 [Thread] 段
static THREAD_RE: LazyLock<Regex> = LazyLock::new(|| build_re(r"^\[([^\]]+)\]\s*"));

// JS: /^([A-Z]+)\s+/ —— 锚定行首的裸写级别词（后随至少一个空白）
static BARE_LEVEL_RE: LazyLock<Regex> = LazyLock::new(|| build_re(r"^([A-Z]+)\s+"));

// JS: /(?:\[|\()([A-Za-z]+)(?:\]|\))\s*/ —— 无锚点，取最左匹配（[INFO] / (WARN)）
static BRACKET_LEVEL_RE: LazyLock<Regex> =
    LazyLock::new(|| build_re(r"(?:\[|\()([A-Za-z]+)(?:\]|\))\s*"));

#[derive(PartialEq, Debug)]
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

    // ---- 布局族探测 + 家族感知 thread 提取（B 解析覆盖，2026-10-18）----

    #[test]
    fn spring_logback_thread_after_separator() {
        // Spring Boot / Logback 默认：LEVEL PID --- [thread] logger : msg
        let r = parse_rest_fam(
            " INFO 12345 --- [main] com.foo.Bar : started",
            LogFamily::SpringLogback,
        );
        assert_eq!(r.thread.as_deref(), Some("main"));
        assert_eq!(r.level.as_deref(), Some("INFO"));
        assert_eq!(r.message, "12345  com.foo.Bar : started");
    }

    #[test]
    fn log4j_thread_after_level() {
        // log4j2 变体 / 自定义布局：LEVEL [thread] logger - msg
        let r = parse_rest_fam(
            "ERROR [pool-1] com.foo.Service - boom",
            LogFamily::Log4jThreadAfter,
        );
        assert_eq!(r.thread.as_deref(), Some("pool-1"));
        assert_eq!(r.level.as_deref(), Some("ERROR"));
        assert_eq!(r.message, "com.foo.Service - boom");
    }

    #[test]
    fn family_extraction_only_when_leading_thread_missing() {
        // 行首已有 thread（log4j2 线程在前）→ 家族规则不覆盖、不误改
        let r = parse_rest_fam(
            "[net-0] INFO 12345 --- [main] com.foo : x",
            LogFamily::SpringLogback,
        );
        assert_eq!(r.thread.as_deref(), Some("net-0")); // 仍取行首
        assert_eq!(r.level.as_deref(), Some("INFO"));
    }

    #[test]
    fn unknown_family_keeps_legacy_behavior() {
        // 未知族 → 与旧 parse_rest 完全一致（不引入任何新提取）
        let cases = [
            "[INFO] message body",
            "INFO hello",
            "(main) E crash",
            "hello (INFO) world",
        ];
        for c in cases {
            assert_eq!(parse_rest_fam(c, LogFamily::Unknown), parse_rest(c));
        }
    }

    #[test]
    fn detect_log_family_majority_vote() {
        // 全部 Spring Boot → 探出 SpringLogback
        let rests = [
            " INFO 1 --- [main] a : x",
            " WARN 1 --- [main] a : y",
            " ERROR 1 --- [main] a : z",
        ];
        assert_eq!(detect_log_family(&rests), LogFamily::SpringLogback);

        // 全部 log4j 变体 → Log4jThreadAfter
        let rests2 = ["INFO [t1] a - x", "WARN [t1] a - y", "ERROR [t1] a - z"];
        assert_eq!(detect_log_family(&rests2), LogFamily::Log4jThreadAfter);

        // 多数不足（混入不带 threaded 布局的行）→ 回退 Unknown（保守，防误抓）
        let rests3 = ["INFO plain message", "WARN [t1] a - y", "ERROR plain message"];
        assert_eq!(detect_log_family(&rests3), LogFamily::Unknown);

        // 空样本 → Unknown
        assert_eq!(detect_log_family(&[]), LogFamily::Unknown);

        // 单行也能探出（覆盖 pipeline 逐行场景虽无多数决，但标记足够特异）
        let single = [" INFO 1 --- [main] a : x"];
        assert_eq!(detect_log_family(&single), LogFamily::SpringLogback);
    }

    #[test]
    fn detect_log_family_rejects_nginx_level_bracket_as_thread() {
        // nginx：行首 [error] 是级别不是线程；不应被误判为任何族
        // （保持现状：由行首启发式把 [error] 当 thread，见契约 §3.13 不变量）
        let rests = ["[error] 12345#0: *1 open() failed", "[error] 12346#0: *2 closed"];
        assert_eq!(detect_log_family(&rests), LogFamily::Unknown);
    }

    #[test]
    fn detect_python_thread_and_syslog_component() {
        // Python logging %(threadName)s
        let py = [
            "INFO Thread-1: worker done",
            "INFO Thread-2: worker done",
            "WARN MainThread: init ok",
        ];
        assert_eq!(detect_log_family(&py), LogFamily::PythonThread);

        // syslog：hostname program[pid]:
        let sys = [
            "web01 nginx[1234]: 10.0.0.1 GET /",
            "web01 app[5678]: connect timeout",
            "web01 nginx[1234]: 10.0.0.2 POST /api",
        ];
        assert_eq!(detect_log_family(&sys), LogFamily::SyslogComponent);
    }

    #[test]
    fn extract_python_thread_from_rest() {
        // 家族感知补取：行首无 [thread]，靠 PythonThread 槽位
        let r = parse_rest_fam("INFO Thread-1: worker done", LogFamily::PythonThread);
        assert_eq!(r.thread.as_deref(), Some("Thread-1"));
        assert_eq!(r.level.as_deref(), Some("INFO"));
        assert_eq!(r.message, "worker done");

        // MainThread 也能取
        let r2 = parse_rest_fam("WARN MainThread: init", LogFamily::PythonThread);
        assert_eq!(r2.thread.as_deref(), Some("MainThread"));
        assert_eq!(r2.message, "init");
    }

    #[test]
    fn extract_syslog_component_from_rest() {
        // hostname program[pid]: → 组件标识取 name[pid]
        let r = parse_rest_fam("web01 nginx[1234]: 10.0.0.1 GET /", LogFamily::SyslogComponent);
        assert_eq!(r.thread.as_deref(), Some("nginx[1234]"));
        assert_eq!(r.message, "web01 10.0.0.1 GET /");
    }
}
