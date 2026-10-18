/**
 * 日志解析器：原始文本 -> LogEvent[]。
 *
 * 流程：
 * 1. 按行切分
 * 2. 自动探测（或使用指定）时间戳格式
 * 3. 逐行解析：提取 ts，剥离时间戳后的 thread / level / message
 */

import type { LogEvent } from '../types';
import {
  detectTimestampFormat,
  extractTimestamp,
  type TimestampFormat,
} from './timestampFormats';

const LEVELS = new Set([
  'VERBOSE', 'TRACE', 'DEBUG', 'INFO', 'NOTICE',
  'WARN', 'WARNING', 'ERROR', 'FATAL', 'CRIT', 'CRITICAL',
  'EMERG', 'EMERGENCY', 'ALERT', 'I', 'D', 'W', 'E', 'F',
]);

export interface ParseOptions {
  /** 强制使用的时间戳格式；不传则自动探测 */
  timestampFormat?: TimestampFormat;
}

export interface ParseResult {
  events: LogEvent[];
  /** 实际使用的时间戳格式 id */
  timestampFormatId: string | null;
  /** 无法解析时间戳的行数 */
  skipped: number;
  /** 总行数 */
  totalLines: number;
}

// 级别可能以 () 或 [] 包裹，也可能裸写
const LEVEL_BRACKET_RE = /(?:\[|\()(?<level>[A-Za-z]+)(?:\]|\))\s*/;

/** 日志布局族——由样本后段探测，决定 thread 的额外提取槽位（对齐 engine::parser::line::LogFamily）。 */
export type LogFamily = 'unknown' | 'springLogback' | 'log4jThreadAfter';

const SPRING_RE = / --- \[[^\]]+\]/;
const LOG4J_RE = /^[A-Za-z][A-Za-z]*\s+\[[^\]]+\]/;
const BRACKET_RE = /\[([^\]]+)\]/;

/** 由样本后段（已去时间戳）探测布局族，多数决（>50% 才采用）。对齐 engine::parser::line::detect_log_family。 */
export function detectLogFamily(rests: string[]): LogFamily {
  let total = 0, sb = 0, lj = 0;
  for (const r of rests.slice(0, 200)) {
    const t = r.trim();
    if (!t) continue;
    total++;
    if (SPRING_RE.test(t)) sb++;
    if (LOG4J_RE.test(t)) lj++;
  }
  if (total === 0) return 'unknown';
  const half = Math.floor(total / 2);
  if (sb > half) return 'springLogback';
  if (lj > half) return 'log4jThreadAfter';
  return 'unknown';
}

/** 位置约束的家族内 thread 提取；未命中默认启发式时才调用。对齐 engine::parser::line::extract_family_thread。 */
function applyFamilyThread(message: string, family: LogFamily): [string | undefined, string] {
  if (family === 'springLogback') {
    const m = message.match(SPRING_RE);
    if (m && m.index !== undefined) {
      const inner = m[0].match(BRACKET_RE);
      if (inner) {
        const thread = inner[1];
        const replaced = (message.slice(0, m.index) + ' ' + message.slice(m.index + m[0].length)).trim();
        return [thread, replaced];
      }
    }
    return [undefined, message];
  }
  if (family === 'log4jThreadAfter') {
    const c = message.match(BRACKET_RE);
    if (c && c.index !== undefined) {
      const thread = c[1];
      const replaced = (message.slice(0, c.index) + ' ' + message.slice(c.index + c[0].length)).trim();
      return [thread, replaced];
    }
    return [undefined, message];
  }
  return [undefined, message];
}

/** 解析单行的后段（已去除时间戳）。导出以便单测（对齐 engine::parser::line::parse_rest）。 */
export function parseRest(rest: string, family: LogFamily = 'unknown'): { thread?: string; level?: string; message: string } {
  let thread: string | undefined;
  let level: string | undefined;
  let message = rest.trim();

  // [Thread1] 开头
  const threadMatch = message.match(/^\[([^\]]+)\]\s*/);
  if (threadMatch) {
    thread = threadMatch[1];
    message = message.slice(threadMatch[0].length).trim();
  }

  // 级别：裸写大写词 或 [INFO] / (WARN)
  const bareLevel = message.match(/^([A-Z]+)\s+/);
  if (bareLevel && LEVELS.has(bareLevel[1])) {
    level = bareLevel[1];
    message = message.slice(bareLevel[0].length).trim();
  } else {
    const bracketLevel = message.match(LEVEL_BRACKET_RE);
    if (bracketLevel && LEVELS.has(bracketLevel.groups!.level.toUpperCase())) {
      level = bracketLevel.groups!.level.toUpperCase();
      // 删除匹配区间本身（保留前缀）；旧 slice(match[0].length) 按长度从头切，位置错误
      const i = bracketLevel.index ?? 0;
      message = (message.slice(0, i) + message.slice(i + bracketLevel[0].length)).trim();
    }
  }

  // 家族感知提取（仅当行首启发式未命中）。位置约束，不「到处找方括号」，不会误抓。
  if (!thread) {
    const [t, m] = applyFamilyThread(message, family);
    if (t) {
      thread = t;
      message = m;
    }
  }

  return { thread, level, message };
}

export class LogParser {
  private format: TimestampFormat | null = null;

  /** 预扫描：取前 N 行探测时间戳格式 */
  preScan(text: string, sampleCount = 100): TimestampFormat | null {
    const lines = text.split(/\r?\n/).slice(0, sampleCount).filter((l) => l.trim());
    this.format = detectTimestampFormat(lines);
    return this.format;
  }

  parse(text: string, options: ParseOptions = {}): ParseResult {
    const fmt = options.timestampFormat ?? this.format ?? undefined;
    const allLines = text.split(/\r?\n/);
    const events: LogEvent[] = [];
    let skipped = 0;

    // 若未预扫描，先探测
    let format = fmt;
    if (!format) {
      const sample = allLines.slice(0, 100).filter((l) => l.trim());
      format = detectTimestampFormat(sample) ?? undefined;
    }

    const formatId = format?.id ?? null;

    // 探测日志布局族（基于样本后段），用于 thread 的家族感知提取（对齐 engine::parser::detect_log_family）
    const sampleRests: string[] = [];
    for (const l of allLines.slice(0, 200)) {
      if (!l.trim()) continue;
      const e = extractTimestamp(l, format);
      if (e) sampleRests.push(l.slice(e.index + e.matchStr.length));
    }
    const family = detectLogFamily(sampleRests);

    for (let i = 0; i < allLines.length; i++) {
      const raw = allLines[i];
      if (!raw.trim()) {
        skipped++;
        continue;
      }
      const extracted = extractTimestamp(raw, format);
      if (!extracted) {
        skipped++;
        continue;
      }
      // 用真实匹配区间切出剩余（对齐 Rust &raw[ext.end..]），避免 matchStr 在行内更早
      // 重复时 indexOf 定位错位的已知偏差（web-desktop-consistency-review.md §1.3）。
      const rest = raw.slice(extracted.index + extracted.matchStr.length);
      const { thread, level, message } = parseRest(rest, family);
      events.push({
        id: i,
        ts: extracted.ts,
        raw,
        thread,
        level,
        message,
      });
    }

    // 保证按时间升序（即便原始乱序也修正，便于二分查找）
    events.sort((a, b) => a.ts - b.ts);

    return {
      events,
      timestampFormatId: formatId,
      skipped,
      totalLines: allLines.length,
    };
  }
}
