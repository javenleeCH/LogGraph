/**
 * 时间戳格式预设与解析。
 *
 * 支持自动探测常见日志行首时间戳格式，也能让用户手动指定正则。
 * 所有时间戳统一转换为 epoch 毫秒（UTC 或本地时区，见下方说明）。
 */

/** 一个时间戳格式的探测/解析预设 */
export interface TimestampFormat {
  /** 唯一标识 */
  id: string;
  /** 显示名 */
  label: string;
  /** 匹配时间戳的正则（必须为无锚点，从行首搜索） */
  regex: RegExp;
  /**
   * 把正则匹配到的捕获组（group[0] 为整体匹配）转换为 epoch 毫秒。
   * 若无法解析返回 null。
   */
  parse: (match: RegExpMatchArray) => number | null;
}

// 月份缩写 -> 数字
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** 常见时间戳格式预设，按优先级排序 */
export const TIMESTAMP_FORMATS: TimestampFormat[] = [
  // 2024-01-01 12:00:00.123
  {
    id: 'iso-local-ms',
    label: 'YYYY-MM-DD HH:mm:ss.SSS',
    regex: /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/,
    parse: (m) => {
      const ms = m[7] ? m[7].padEnd(3, '0') : '0';
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +ms) -
        // Date.UTC 返回 UTC；这里不修正时区，时间戳原样保留为 UTC 纪元值，
        // 显示时再统一处理。日志时间通常无时区信息，按 UTC 处理最稳定。
        0;
    },
  },
  // 2024-01-01T12:00:00Z  (ISO 8601 带可选时区)
  {
    id: 'iso-8601',
    label: 'ISO 8601 (Z/offset)',
    regex: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?/,
    parse: (m) => {
      const ms = m[7] ? m[7].padEnd(3, '0') : '0';
      const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +ms);
      const tz = m[8];
      if (!tz || tz === 'Z') return base;
      // 偏移如 +08:00 / -0500
      const sign = tz[0] === '-' ? -1 : 1;
      const cleaned = tz.slice(1).replace(/[^0-9]/g, '');
      const hh = +(cleaned.slice(0, 2) || '0');
      const mm = +(cleaned.slice(2, 4) || '0');
      // UTC = local + offset；Date.UTC 得到的就是 UTC，偏移表示本地=UTC+offset
      return base - sign * (hh * 3600 + mm * 60) * 1000;
    },
  },
  // Jan 01 12:00:00  (syslog 风格，无年份 -> 当前年)
  {
    id: 'syslog',
    label: 'syslog (MMM DD HH:mm:ss)',
    regex: /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/,
    parse: (m) => {
      const mon = MONTHS[m[1]];
      if (mon === undefined) return null;
      const year = new Date().getFullYear();
      return Date.UTC(year, mon, +m[2], +m[3], +m[4], +m[5], 0);
    },
  },
  // 12:00:00.123  (仅有时分秒，取当天 -> 用 epoch 的 date 部分=1970/1/1)
  // 这类日志通常只有当天数据，时序仍正确
  {
    id: 'time-only-ms',
    label: 'HH:mm:ss.SSS (当天)',
    regex: /(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/,
    parse: (m) => {
      const ms = m[4] ? m[4].padEnd(3, '0') : '0';
      // 用 1970-01-01 作为日期部分，保证不同行相对顺序正确
      return Date.UTC(1970, 0, 1, +m[1], +m[2], +m[3], +ms);
    },
  },
  // Unix epoch 毫秒/秒 (纯数字，13 位优先，否则 10 位按秒)
  {
    id: 'epoch',
    label: 'Unix epoch (ms/s)',
    regex: /(?<!\d)(\d{13})(?!\d)|(?<!\d)(\d{10})(?!\d)/,
    parse: (m) => {
      if (m[1]) return +m[1];
      if (m[2]) return +m[2] * 1000;
      return null;
    },
  },
];

/** 时间戳提取结果 */
export interface TimestampMatch {
  ts: number;
  /** 匹配到的整体文本 */
  matchStr: string;
  formatId: string;
  /** 匹配在行中的起始字符索引（对齐 Rust `ext.start`，用于切出时间戳之后的剩余文本） */
  index: number;
}

/**
 * 从一行文本中尝试提取时间戳。
 * @param line 原始日志行
 * @param format 指定格式；不传则自动探测
 * @returns TimestampMatch 或 null
 */
export function extractTimestamp(
  line: string,
  format?: TimestampFormat,
): TimestampMatch | null {
  const formats = format ? [format] : TIMESTAMP_FORMATS;
  for (const f of formats) {
    const m = line.match(f.regex);
    if (m) {
      const ts = f.parse(m);
      if (ts !== null && !Number.isNaN(ts)) {
        // 注意：用真实匹配起始 index（非 indexOf(matchStr)），避免 matchStr 在行内
        // 更早重复出现时定位到错误位置 —— 对齐 Rust `&raw[ext.end..]`（plans/web-desktop-consistency-review.md §1.3）。
        return { ts, matchStr: m[0], formatId: f.id, index: m.index ?? 0 };
      }
    }
  }
  return null;
}

/** 自动探测一组日志行最适用的时间戳格式（取能匹配最多行的那个） */
export function detectTimestampFormat(sampleLines: string[]): TimestampFormat | null {
  let best: TimestampFormat | null = null;
  let bestCount = 0;
  for (const f of TIMESTAMP_FORMATS) {
    let count = 0;
    for (const line of sampleLines) {
      if (line.match(f.regex)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = f;
    }
  }
  return best && bestCount > 0 ? best : null;
}
