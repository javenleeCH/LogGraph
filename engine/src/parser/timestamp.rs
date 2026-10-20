//! 时间戳格式：探测 + 提取。逐条对齐 `src/parser/timestampFormats.ts`。
//!
//! 语义对齐要点：
//! - 5 种格式按固定顺序（iso-local-ms → iso-8601 → syslog → time-only-ms → epoch），
//!   提取时顺序尝试，某格式 regex 命中但 parse 失败（如 syslog 月份非法）则继续下一个；
//! - 探测取「regex 能匹配最多行」的格式（仅要求 is_match，不要求 parse 成功），
//!   计数**严格大于**才替换 —— 平局保留数组序在前者，与 JS 完全一致；
//! - epoch 格式 JS 用 lookaround 正则（regex crate 不支持），改为「极大数字段」扫描，
//!   第一个长度恰为 13 或 10 的段命中，与 JS 最左优先语义等价（见 plans/rust-parser-design.md §3.6）；
//! - `Date.UTC` 的越界字段进位语义（月 13 → 次年 1、日 0 → 上月末、秒 61 → 进分）
//!   由 [`date_utc_like`] + Hinnant `days_from_civil` 实现。
//!
//! 正则翻译（见 [`build_re`]）：JS 无 u 标志正则中 `\d` = ASCII 数字、`\s` = 特定 Unicode
//! 空白集；Rust regex 默认 unicode 模式下 `\d`/`\s` 语义不同，因此模式串按 JS 原样书写，
//! 编译前做 `\d` → `[0-9]`、`\s` → 精确等价类的机械替换。

use regex::Regex;
use std::sync::OnceLock;

/// 提取结果：epoch 毫秒 + 匹配区间（字节偏移）。
/// 所有格式的匹配内容均为纯 ASCII，故字节偏移必在 char 边界上，切片安全。
/// start / format_id 仅测试断言引用（生产路径只用 ts + end），allow 防 dead_code。
#[allow(dead_code)]
pub struct ExtractedTimestamp {
    pub ts: i64,
    pub start: usize,
    pub end: usize,
    pub format_id: &'static str,
}

/// 一个时间戳格式预设（对齐 JS 的 TimestampFormat）
pub struct TsFormat {
    pub id: &'static str,
    is_match: fn(&str) -> bool,
    extract: fn(&str) -> Option<ExtractedTimestamp>,
}

/// ECMAScript `\s`（无 u 标志）的精确等价字符类：
/// Unicode White_Space 属性 − U+0085(NEL) + U+FEFF。
/// （Rust unicode 模式 `\s` 多含 NEL、少含 FEFF，均与 JS 不同，故显式列出。）
const JS_S: &str = r"[\t\n\x0B\f\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// 按 JS 语义编译正则：模式串用 JS 原文书写（\d、\s），
/// 编译前把 `\d` → `[0-9]`（JS \d 为 ASCII 数字）、`\s` → [`JS_S`]。
/// 保持默认 unicode 模式：`[^\]]` 等否定类按 char 匹配，切片永落 char 边界。
/// （line.rs 的 thread/level 正则同样经此编译，保证两模块 \s 语义一致）
pub fn build_re(pat: &str) -> Regex {
    let translated = pat.replace("\\d", "[0-9]").replace("\\s", JS_S);
    Regex::new(&translated).expect("invalid timestamp regex")
}

/// 全部格式（顺序即优先级，勿调整）
pub fn formats() -> &'static [TsFormat] {
    static FORMATS: OnceLock<Vec<TsFormat>> = OnceLock::new();
    FORMATS.get_or_init(|| {
        vec![
            TsFormat {
                id: "iso-local-ms",
                is_match: is_match_iso_local,
                extract: extract_iso_local,
            },
            TsFormat {
                id: "iso-8601",
                is_match: is_match_iso_8601,
                extract: extract_iso_8601,
            },
            TsFormat {
                id: "syslog",
                is_match: is_match_syslog,
                extract: extract_syslog,
            },
            TsFormat {
                id: "nginx",
                is_match: is_match_nginx,
                extract: extract_nginx,
            },
            TsFormat {
                id: "time-only-ms",
                is_match: is_match_time_only,
                extract: extract_time_only,
            },
            TsFormat {
                id: "epoch",
                is_match: is_match_epoch,
                extract: extract_epoch,
            },
        ]
    })
}

/// 按 id 查格式（invoke formatId 参数映射用）
pub fn find_format(id: &str) -> Option<&'static TsFormat> {
    formats().iter().find(|f| f.id == id)
}

/// 从一行提取时间戳。指定格式时只试它；否则按顺序试全部（parse 失败继续下一个）。
/// 对齐 JS extractTimestamp。
pub fn extract_timestamp(line: &str, format: Option<&TsFormat>) -> Option<ExtractedTimestamp> {
    match format {
        Some(f) => (f.extract)(line),
        None => formats().iter().find_map(|f| (f.extract)(line)),
    }
}

/// 自动探测：能 regex 匹配最多行的格式获胜（严格大于才替换，平局保留在前者）。
/// 对齐 JS detectTimestampFormat。
pub fn detect_timestamp_format(sample_lines: &[&str]) -> Option<&'static TsFormat> {
    let mut best: Option<&'static TsFormat> = None;
    let mut best_count = 0usize;
    for f in formats() {
        let mut count = 0usize;
        for line in sample_lines {
            if (f.is_match)(line) {
                count += 1;
            }
        }
        if count > best_count {
            best_count = count;
            best = Some(f);
        }
    }
    best
}

// ---- 各格式实现（正则与 JS 逐字符一致）----

// 2024-01-01 12:00:00.123（[ T] 分隔均可，毫秒可选 1~3 位）
fn re_iso_local() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        build_re(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?")
    })
}

fn is_match_iso_local(line: &str) -> bool {
    re_iso_local().is_match(line)
}

fn extract_iso_local(line: &str) -> Option<ExtractedTimestamp> {
    let caps = re_iso_local().captures(line)?;
    let y: i64 = caps[1].parse().ok()?;
    let mo: i64 = caps[2].parse().ok()?; // 1-based
    let d: i64 = caps[3].parse().ok()?;
    let h: i64 = caps[4].parse().ok()?;
    let mi: i64 = caps[5].parse().ok()?;
    let s: i64 = caps[6].parse().ok()?;
    let ms = parse_ms_opt(caps.get(7).map(|m| m.as_str()));
    // JS: Date.UTC(y, mo-1, d, h, mi, s, ms) —— 不做时区修正，原样保留为 UTC 纪元值
    let ts = date_utc_like(y, mo - 1, d, h, mi, s, ms);
    let whole = caps.get(0)?;
    Some(ExtractedTimestamp {
        ts,
        start: whole.start(),
        end: whole.end(),
        format_id: "iso-local-ms",
    })
}

// 2024-01-01T12:00:00.123Z / +08:00 / -0500（时区可选）
fn re_iso_8601() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        build_re(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?")
    })
}

fn is_match_iso_8601(line: &str) -> bool {
    re_iso_8601().is_match(line)
}

fn extract_iso_8601(line: &str) -> Option<ExtractedTimestamp> {
    let caps = re_iso_8601().captures(line)?;
    let y: i64 = caps[1].parse().ok()?;
    let mo: i64 = caps[2].parse().ok()?;
    let d: i64 = caps[3].parse().ok()?;
    let h: i64 = caps[4].parse().ok()?;
    let mi: i64 = caps[5].parse().ok()?;
    let s: i64 = caps[6].parse().ok()?;
    let ms = parse_ms_opt(caps.get(7).map(|m| m.as_str()));
    let base = date_utc_like(y, mo - 1, d, h, mi, s, ms);
    // JS: 无时区或 Z → 不修正；+08:00 → base - offset（UTC = local + offset）
    let ts = match caps.get(8).map(|m| m.as_str()) {
        None | Some("Z") => base,
        Some(tz) => {
            let sign: i64 = if tz.starts_with('-') { -1 } else { 1 };
            // 对齐 JS: tz.slice(1).replace(/[^0-9]/g, '')（去符号与冒号，仅留数字）
            let cleaned: String = tz[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let hh: i64 = cleaned.get(0..2).and_then(|s| s.parse().ok()).unwrap_or(0);
            let mm: i64 = cleaned.get(2..4).and_then(|s| s.parse().ok()).unwrap_or(0);
            base - sign * (hh * 3600 + mm * 60) * 1000
        }
    };
    let whole = caps.get(0)?;
    Some(ExtractedTimestamp {
        ts,
        start: whole.start(),
        end: whole.end(),
        format_id: "iso-8601",
    })
}

// Jan 01 12:00:00（syslog 风格，无年份 → 当前年）
fn re_syslog() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        build_re(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})")
    })
}

fn is_match_syslog(line: &str) -> bool {
    re_syslog().is_match(line)
}

/// 月份缩写 → 0-based；大小写敏感（"jan"/"JAN" 查表失败返回 None，对齐 JS MONTHS）
fn month_from_abbr(s: &str) -> Option<i64> {
    match s {
        "Jan" => Some(0),
        "Feb" => Some(1),
        "Mar" => Some(2),
        "Apr" => Some(3),
        "May" => Some(4),
        "Jun" => Some(5),
        "Jul" => Some(6),
        "Aug" => Some(7),
        "Sep" => Some(8),
        "Oct" => Some(9),
        "Nov" => Some(10),
        "Dec" => Some(11),
        _ => None,
    }
}

fn extract_syslog(line: &str) -> Option<ExtractedTimestamp> {
    let caps = re_syslog().captures(line)?;
    // 月份非法 → None（extract_timestamp 会继续尝试后续格式，对齐 JS）
    let mon = month_from_abbr(&caps[1])?;
    let d: i64 = caps[2].parse().ok()?;
    let h: i64 = caps[3].parse().ok()?;
    let mi: i64 = caps[4].parse().ok()?;
    let s: i64 = caps[5].parse().ok()?;
    let year = current_year_utc();
    let ts = date_utc_like(year, mon, d, h, mi, s, 0);
    let whole = caps.get(0)?;
    Some(ExtractedTimestamp {
        ts,
        start: whole.start(),
        end: whole.end(),
        format_id: "syslog",
    })
}

// nginx access $time_local：`[10/Oct/2026:13:55:36 +0000]`（dd/Mon/yyyy:HH:mm:ss +zzzz，含括号整体剥除）
fn re_nginx() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        build_re(r"\[(\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2})\s+([+-]\d{4})\]\s*")
    })
}

fn is_match_nginx(line: &str) -> bool {
    re_nginx().is_match(line)
}

/// 取 group1 `10/Oct/2026:13:55:36` 与 group2 偏移 `+0000`，转 UTC 毫秒。
fn extract_nginx(line: &str) -> Option<ExtractedTimestamp> {
    let caps = re_nginx().captures(line)?;
    let date = &caps[1];
    let mon = month_from_abbr(&date[3..6])?;
    let d: i64 = date[0..2].parse().ok()?;
    let y: i64 = date[7..11].parse().ok()?;
    let h: i64 = date[12..14].parse().ok()?;
    let mi: i64 = date[15..17].parse().ok()?;
    let s: i64 = date[18..20].parse().ok()?;
    let tz = &caps[2];
    let sign: i64 = if tz.starts_with('-') { -1 } else { 1 };
    let tzh: i64 = tz[1..3].parse().ok()?;
    let tzm: i64 = tz[3..5].parse().ok()?;
    let ts = date_utc_like(y, mon, d, h, mi, s, 0) - sign * (tzh * 3600 + tzm * 60) * 1000;
    let whole = caps.get(0)?;
    Some(ExtractedTimestamp {
        ts,
        start: whole.start(),
        end: whole.end(),
        format_id: "nginx",
    })
}

// 12:00:00.123（仅时分秒；日期部分固定 1970-01-01，保证相对顺序正确）
fn re_time_only() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| build_re(r"(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?"))
}

fn is_match_time_only(line: &str) -> bool {
    re_time_only().is_match(line)
}

fn extract_time_only(line: &str) -> Option<ExtractedTimestamp> {
    let caps = re_time_only().captures(line)?;
    let h: i64 = caps[1].parse().ok()?;
    let mi: i64 = caps[2].parse().ok()?;
    let s: i64 = caps[3].parse().ok()?;
    let ms = parse_ms_opt(caps.get(4).map(|m| m.as_str()));
    // JS: Date.UTC(1970, 0, 1, h, mi, s, ms)
    let ts = date_utc_like(1970, 0, 1, h, mi, s, ms);
    let whole = caps.get(0)?;
    Some(ExtractedTimestamp {
        ts,
        start: whole.start(),
        end: whole.end(),
        format_id: "time-only-ms",
    })
}

// Unix epoch：13 位毫秒 / 10 位秒。
// JS 正则 /(?<!\d)(\d{13})(?!\d)|(?<!\d)(\d{10})(?!\d)/ 依赖 lookaround，regex crate 不支持，
// 改为等价的「极大数字段」扫描：从左到右切出前后均非数字的连续 ASCII 数字段，
// 第一个长度恰为 13 或 10 的段命中（13 → ms；10 → s ×1000）。
// 等价性：长度 ≠ 10/13 的段在 JS 正则下任何起点都无法同时满足前后 lookaround，必然被跳过；
// 「同一起点 13 位分支优先」也天然满足（一个段的长度唯一确定）。
fn is_match_epoch(line: &str) -> bool {
    extract_epoch(line).is_some()
}

fn extract_epoch(line: &str) -> Option<ExtractedTimestamp> {
    let b = line.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let len = i - start;
            if len == 13 || len == 10 {
                // 纯 ASCII 数字段，字节边界即 char 边界，切片安全
                let digits = &line[start..i];
                let v: i64 = digits.parse().ok()?;
                let ts = if len == 13 { v } else { v.checked_mul(1000)? };
                return Some(ExtractedTimestamp {
                    ts,
                    start,
                    end: i,
                    format_id: "epoch",
                });
            }
        } else {
            i += 1;
        }
    }
    None
}

// ---- 公共工具 ----

/// 毫秒段对齐 JS `m.padEnd(3, '0')` 后取数值：'1'→100、'12'→120、'123'→123。
/// 正则已约束 \d{1,3}；防御性兜底更长输入按原值解析（对齐 padEnd 不截断语义）。
fn parse_ms_opt(ms: Option<&str>) -> i64 {
    match ms {
        None => 0,
        Some(s) => match s.len() {
            0 => 0,
            1 => s.parse::<i64>().unwrap_or(0) * 100,
            2 => s.parse::<i64>().unwrap_or(0) * 10,
            _ => s.parse::<i64>().unwrap_or(0),
        },
    }
}

/// 对齐 JS `Date.UTC(y, month0, d, h, mi, s, ms)`：所有越界字段自动进/退位。
/// 例：month0=12 → 次年 1 月；d=0 → 上月末；d=32 → 次月 1 日；s=61 → 进分；ms=1500 → 进秒 500。
/// 时/分/秒/毫秒为线性量纲，天然进位；仅年月日需归一化。
pub fn date_utc_like(y: i64, month0: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> i64 {
    let y = y + month0.div_euclid(12);
    let m = month0.rem_euclid(12) + 1; // 1..=12
    let days = days_from_civil(y, m, 1) + (d - 1);
    (days * 86400 + h * 3600 + mi * 60 + s) * 1000 + ms
}

/// Howard Hinnant days_from_civil：公历 (y, m∈[1,12], d∈[1,31]) → 自 1970-01-01 的天数。
/// d 越界由调用方以加减天数处理（date_utc_like 已做）；y/m 需在合法范围。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // Mar=0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Hinnant civil_from_days：天数 → (y, m, d)。仅用于 current_year_utc。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 当前 UTC 年份（syslog 无年份时取当前年）。
/// 与 JS `new Date().getFullYear()`（本地时区年）仅在跨年瞬间的数小时内可能不同，已文档化。
fn current_year_utc() -> i64 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_from_days(secs.div_euclid(86400)).0
}

// ---- 单元测试（cargo test）----
// 每个断言值均已按 JS 语义人工推演（Date.UTC / 正则最左匹配 / padEnd）。

#[cfg(test)]
mod tests {
    use super::*;

    // days_from_civil 基准值（可与 Date.UTC 交叉验证）
    #[test]
    fn days_from_civil_basics() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(2000, 1, 1), 10957); // 30*365 + 7 闰日(1972..1996)
        assert_eq!(days_from_civil(2000, 3, 1), 11017); // 含 2000-02-29
        assert_eq!(days_from_civil(2024, 1, 1), 19723); // 54*365 + 13 闰日
        assert_eq!(days_from_civil(2024, 2, 29), 19782); // 19723 + 31 + 28
        assert_eq!(days_from_civil(2024, 3, 1), 19783);
        // civil_from_days 往返
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19723), (2024, 1, 1));
        assert_eq!(civil_from_days(19782), (2024, 2, 29));
        assert_eq!(civil_from_days(19783), (2024, 3, 1));
    }

    #[test]
    fn date_utc_like_carry() {
        // 正常值：Date.UTC(2024,0,1) = 1704067200000
        assert_eq!(date_utc_like(2024, 0, 1, 0, 0, 0, 0), 1704067200000);
        // month0=12 → 次年 1 月
        assert_eq!(
            date_utc_like(2024, 12, 1, 0, 0, 0, 0),
            date_utc_like(2025, 0, 1, 0, 0, 0, 0)
        );
        // month0=-1 → 去年 12 月
        assert_eq!(
            date_utc_like(2024, -1, 1, 0, 0, 0, 0),
            date_utc_like(2023, 11, 1, 0, 0, 0, 0)
        );
        // d=0 → 上月末
        assert_eq!(
            date_utc_like(2024, 0, 0, 0, 0, 0, 0),
            date_utc_like(2023, 11, 31, 0, 0, 0, 0)
        );
        // d=32 → 次月 1 日（1 月 31 天）
        assert_eq!(
            date_utc_like(2024, 0, 32, 0, 0, 0, 0),
            date_utc_like(2024, 1, 1, 0, 0, 0, 0)
        );
        // 时分秒毫秒全越界 → 等价进位组合
        assert_eq!(
            date_utc_like(2024, 0, 1, 25, 61, 61, 1000),
            date_utc_like(2024, 0, 2, 2, 2, 2, 0)
        );
    }

    #[test]
    fn iso_local_ms_values() {
        // Date.UTC(2024,0,1,12,0,0,123) = 1704110400123
        let r = extract_iso_local("2024-01-01 12:00:00.123 [T1] INFO hello").unwrap();
        assert_eq!(r.ts, 1704110400123);
        assert_eq!(r.start, 0);
        assert_eq!(r.end, 23);
        assert_eq!(r.format_id, "iso-local-ms");

        // T 分隔同样接受；无毫秒
        let r = extract_iso_local("2024-01-01T12:00:00 x").unwrap();
        assert_eq!(r.ts, 1704110400000);

        // 毫秒 padEnd：'.1' → 100ms；'.12' → 120ms
        let r = extract_iso_local("2024-01-01 12:00:00.1 x").unwrap();
        assert_eq!(r.ts, 1704110400100);
        let r = extract_iso_local("2024-01-01 12:00:00.12 x").unwrap();
        assert_eq!(r.ts, 1704110400120);

        // 不匹配
        assert!(extract_iso_local("12:00:00 no date").is_none());
        assert!(extract_iso_local("2024/01/01 12:00:00").is_none());
        // 全角数字（Unicode Nd）不匹配 —— JS \d 为 ASCII，翻译后 [0-9] 同
        assert!(extract_iso_local("２０２４-01-01 12:00:00").is_none());
    }

    #[test]
    fn iso_8601_values() {
        let r = extract_iso_8601("2024-01-01T12:00:00.123Z x").unwrap();
        assert_eq!(r.ts, 1704110400123);

        // +08:00：base - 8h
        let r = extract_iso_8601("2024-01-01T12:00:00.123+08:00").unwrap();
        assert_eq!(r.ts, 1704110400123 - 8 * 3600 * 1000);

        // -0500（无冒号）：base + 5h
        let r = extract_iso_8601("2024-01-01T12:00:00.123-0500").unwrap();
        assert_eq!(r.ts, 1704110400123 + 5 * 3600 * 1000);

        // 无时区 = 不修正
        let r = extract_iso_8601("2024-01-01T12:00:00.123 x").unwrap();
        assert_eq!(r.ts, 1704110400123);

        // 空格分隔不属于本格式（由 iso-local-ms 承接）
        assert!(extract_iso_8601("2024-01-01 12:00:00").is_none());
    }

    #[test]
    fn syslog_values() {
        // 期望值动态取当前年（与实现同源，避免测试跨年翻转）
        let expect = date_utc_like(current_year_utc(), 0, 2, 3, 4, 5, 0);
        let r = extract_syslog("Jan 02 03:04:05 host cmd").unwrap();
        assert_eq!(r.ts, expect);
        assert_eq!(r.start, 0);
        assert_eq!(r.end, "Jan 02 03:04:05".len());

        // 月份大小写敏感：Xyz / jan 均不识别（对齐 JS MONTHS 查表）
        assert!(extract_syslog("Xyz 02 03:04:05 x").is_none());
        assert!(extract_syslog("jan 02 03:04:05 x").is_none());
        // 一位日（Apr 的 0-based 月份 = 3；原测试误写 2 = Mar）
        let expect = date_utc_like(current_year_utc(), 3, 9, 10, 11, 12, 0);
        let r = extract_syslog("Apr 9 10:11:12 x").unwrap();
        assert_eq!(r.ts, expect);
    }

    #[test]
    fn nginx_values() {
        // [10/Oct/2026:13:55:36 +0000]：Oct=9，+0000 不调整
        let expect = date_utc_like(2026, 9, 10, 13, 55, 36, 0);
        let r = extract_nginx("[10/Oct/2026:13:55:36 +0000] \"GET / HTTP/1.1\" 200 612").unwrap();
        assert_eq!(r.ts, expect);
        assert_eq!(r.start, 0);
        // 带前导字段（remote addr - - [）→ start 在其后
        let r2 = extract_nginx("1.2.3.4 - - [10/Oct/2026:13:55:36 +0000] \"GET\" 200 612").unwrap();
        assert_eq!(r2.ts, expect);
        assert_eq!(r2.start, "1.2.3.4 - - ".len());
        // +0800：比 UTC 早 8 小时（offset 修正）
        let r3 = extract_nginx("[10/Oct/2026:13:55:36 +0800] x").unwrap();
        assert_eq!(r3.ts, expect - 8 * 3600 * 1000);
        // 月份非法 / 格式不匹配 → None
        assert!(extract_nginx("[10/xyz/2026:13:55:36 +0000] x").is_none());
        assert!(extract_nginx("no timestamp here").is_none());
    }

    #[test]
    fn time_only_values() {
        // Date.UTC(1970,0,1,12,34,56,789) = 45296789
        let r = extract_time_only("12:34:56.789 x").unwrap();
        assert_eq!(r.ts, 45296789);
        // 非行首锚定：取最左匹配
        let r = extract_time_only("xx 09:00:00 y").unwrap();
        assert_eq!(r.start, 3);
        assert_eq!(r.ts, 9 * 3600 * 1000);
        assert!(extract_time_only("no time here").is_none());
    }

    #[test]
    fn epoch_maximal_runs() {
        // 13 位段命中
        let r = extract_epoch("msg 1710000000000 end").unwrap();
        assert_eq!(r.ts, 1710000000000);
        assert_eq!(r.start, 4);
        assert_eq!(r.end, 17);

        // 10 位段 → 秒 ×1000
        let r = extract_epoch("msg 1710000000 end").unwrap();
        assert_eq!(r.ts, 1710000000000);

        // 14/15/11/12 位段：前后 lookaround 必然失败 → 跳过（JS 同）
        // （14 位 = 前紧邻数字 9 + 13 位；原测试字符串少写一个 0 实为 13 位，笔误）
        assert!(extract_epoch("91710000000000 x").is_none());
        assert!(extract_epoch("abc 123456789012345 x").is_none());
        assert!(extract_epoch("13812345678 x").is_none());
        assert!(extract_epoch("123456789012 x").is_none());

        // 最左优先：起点 0 处 13 位分支失败（仅 10 位）、10 位分支成功，
        // 与 JS 交替分支在同一位置的尝试结果一致（原断言误写成 13 位段值）
        let r = extract_epoch("1234567890 1234567890123").unwrap();
        assert_eq!(r.ts, 1234567890000);
        assert_eq!(r.start, 0);
        let r = extract_epoch("1234567890123 1234567890").unwrap();
        assert_eq!(r.ts, 1234567890123);
        assert_eq!(r.start, 0);

        // 前紧邻数字的 13 位段（如 9+13 位 = 14 位）不命中（(?<!\d) 等价）
        assert!(extract_epoch("91710000000000 x").is_none());
        // 无数字
        assert!(extract_epoch("no digits").is_none());
    }

    #[test]
    fn extract_order_and_fallback() {
        // 无指定格式：iso-local-ms 优先
        let r = extract_timestamp("2024-01-01 12:00:00.123 x", None).unwrap();
        assert_eq!(r.format_id, "iso-local-ms");

        // syslog 月份非法 → 落到 time-only（"03:04:05"）
        let r = extract_timestamp("Xyz 02 03:04:05 x", None).unwrap();
        assert_eq!(r.format_id, "time-only-ms");
        assert_eq!(r.ts, 3 * 3600 * 1000 + 4 * 60 * 1000 + 5 * 1000);

        // 指定格式：只试它
        let fmt = find_format("epoch").unwrap();
        let r = extract_timestamp("2024-01-01 12:00:00 1710000000000", Some(fmt)).unwrap();
        assert_eq!(r.format_id, "epoch");

        // 全部失败
        assert!(extract_timestamp("nothing at all", None).is_none());
    }

    #[test]
    fn detect_prefers_most_matches() {
        // 空格分隔：只有 iso-local-ms 匹配
        let f = detect_timestamp_format(&["2024-01-01 12:00:00 a", "2024-01-02 12:00:00 b"]).unwrap();
        assert_eq!(f.id, "iso-local-ms");

        // T 分隔：iso-local-ms / iso-8601 / time-only 三方平局 → 保留最前者（JS 同）
        let f = detect_timestamp_format(&["2024-01-01T12:00:00Z a"]).unwrap();
        assert_eq!(f.id, "iso-local-ms");

        // syslog 与 time-only 平局 → syslog 在前
        let f = detect_timestamp_format(&["Jan 01 12:00:00 a"]).unwrap();
        assert_eq!(f.id, "syslog");

        // 仅 time-only
        let f = detect_timestamp_format(&["12:00:00 a", "13:00:00 b"]).unwrap();
        assert_eq!(f.id, "time-only-ms");

        // 仅 epoch
        let f = detect_timestamp_format(&["1710000000000 a"]).unwrap();
        assert_eq!(f.id, "epoch");

        // 月份非法的 syslog 行：探测计数仍计入（JS 仅要求 regex 匹配），
        // 与 time-only 平局 → syslog 胜出；但逐行解析时 syslog parse 失败落 time-only
        let f = detect_timestamp_format(&["Xyz 01 12:00:00 a"]).unwrap();
        assert_eq!(f.id, "syslog");

        // nginx 行：nginx 与 time-only 都匹配 → 平局保留在前者 → nginx
        let f = detect_timestamp_format(&[
            "1.2.3.4 - - [10/Oct/2026:13:55:36 +0000] \"GET\" 200",
            "5.6.7.8 - - [10/Oct/2026:13:55:37 +0000] \"POST\" 201",
        ])
        .unwrap();
        assert_eq!(f.id, "nginx");

        // 无一样本 → None
        assert!(detect_timestamp_format(&["plain text", ""]).is_none());
        assert!(detect_timestamp_format(&[]).is_none());
    }

    #[test]
    fn js_whitespace_class_covers_fullwidth_and_nbsp() {
        // 全角空格 / NBSP 作为 syslog 分隔符：JS \s 匹配 → Rust 翻译类同样匹配
        assert!(is_match_syslog("Jan\u{3000}01 12:00:00"));
        assert!(is_match_syslog("Jan\u{00A0}01 12:00:00"));
        // NEL(U+0085) 在 JS \s 集合之外 → 不匹配（与 JS 一致）
        assert!(!is_match_syslog("Jan\u{0085}01 12:00:00"));
    }

    #[test]
    fn find_format_ids() {
        assert_eq!(find_format("iso-local-ms").unwrap().id, "iso-local-ms");
        assert_eq!(find_format("epoch").unwrap().id, "epoch");
        assert!(find_format("no-such").is_none());
    }
}
