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

/** 解析单行的后段（已去除时间戳） */
function parseRest(rest: string): { thread?: string; level?: string; message: string } {
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
      message = message.slice(bracketLevel[0].length).trim();
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
      const rest = raw.slice(raw.indexOf(extracted.matchStr) + extracted.matchStr.length);
      const { thread, level, message } = parseRest(rest);
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
