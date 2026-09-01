/**
 * 过滤器引擎：把 LogEvent[] 与用户过滤器匹配，得到每个过滤器的匹配事件集合。
 *
 * 为性能考虑：
 * - 正则编译结果缓存（按 pattern+flags）
 * - 文本搜索使用 indexOf（普通字符串）或 RegExp.test（正则模式）
 */

import type { Filter, FilterMatch, LogEvent } from '../types';

interface CompiledFilter {
  filterId: string;
  /** 编译后的正则；若 isRegex=false 则为 null，使用字符串匹配 */
  regex: RegExp | null;
  /** 字符串匹配时的小写文本（已按大小写策略处理） */
  literal: string | null;
  scope: 'raw' | 'message';
  caseSensitive: boolean;
}

/** 编译单个过滤器为可执行形式 */
function compileFilter(f: Filter): CompiledFilter | null {
  if (!f.pattern) return null;
  if (!f.enabled) return null;
  if (f.isRegex) {
    try {
      const flags = f.caseSensitive ? 'g' : 'gi';
      // 使用 sticky 'y' 会在 lastIndex 上出问题，用全局 + lastIndex 重置即可
      return {
        filterId: f.id,
        regex: new RegExp(f.pattern, flags),
        literal: null,
        scope: f.scope,
        caseSensitive: f.caseSensitive,
      };
    } catch {
      // 非法正则，忽略
      return null;
    }
  }
  return {
    filterId: f.id,
    regex: null,
    literal: f.caseSensitive ? f.pattern : f.pattern.toLowerCase(),
    scope: f.scope,
    caseSensitive: f.caseSensitive,
  };
}

/** 判断单个事件是否匹配某个已编译过滤器 */
function eventMatches(ev: LogEvent, cf: CompiledFilter): boolean {
  const text = cf.scope === 'raw' ? ev.raw : ev.message;
  if (cf.regex) {
    cf.regex.lastIndex = 0;
    return cf.regex.test(text);
  }
  if (cf.literal === null) return false;
  if (cf.caseSensitive) return text.includes(cf.literal);
  return text.toLowerCase().includes(cf.literal);
}

export class FilterEngine {
  /** 运行所有过滤器，返回 per-filter 匹配集合（与 filters 同序同长，空 pattern 返回空数组） */
  static run(events: LogEvent[], filters: Filter[]): FilterMatch[] {
    // 按 filters 原序编译；未编译成功（空 pattern / 非法正则）的保留为 null
    const compiled: (CompiledFilter | null)[] = filters.map(compileFilter);
    const valid = compiled.filter(
      (c): c is CompiledFilter => c !== null,
    );

    // 初始化每个有效过滤器的结果桶
    const buckets = new Map<string, LogEvent[]>();
    for (const cf of valid) buckets.set(cf.filterId, []);

    // 单次遍历所有事件，分桶到匹配的过滤器
    for (const ev of events) {
      for (const cf of valid) {
        if (eventMatches(ev, cf)) {
          buckets.get(cf.filterId)!.push(ev);
        }
      }
    }

    // 结果与 filters 一一对应（空 pattern / 未启用的过滤器返回空 events）
    const result: FilterMatch[] = filters.map((f, i) => {
      const cf = compiled[i];
      if (!cf) return { filterId: f.id, events: [] };
      return { filterId: f.id, events: buckets.get(cf.filterId)! };
    });
    return result;
  }

  /** 校验正则是否合法，返回错误信息或 null */
  static validateRegex(pattern: string): string | null {
    if (!pattern) return null;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }
}
