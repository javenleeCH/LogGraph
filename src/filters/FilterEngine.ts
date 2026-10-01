/**
 * 过滤器引擎：把 LogEvent[] 与用户过滤器匹配，得到每个过滤器的匹配事件集合。
 *
 * 为性能考虑：
 * - 正则编译结果缓存（按 pattern+flags）
 * - 文本搜索使用 indexOf（普通字符串）或 RegExp.test（正则模式）
 * - 大小写不敏感匹配预生成小写文本缓存（避免每行 toLowerCase 分配新串）
 * - 单 filter 增量重算 + 分块异步调度（百万行不阻塞主线程）
 *
 * 引擎统一（web-desktop-consistency-review.md §1.1）：
 * - 正则过滤器优先用 wasm 版 Rust `regex` crate（regexWasm.ts），
 *   与桌面端(dbMode, Rust regex)引擎逐字节一致；
 * - wasm 未就绪/加载失败时回退 JS RegExp（降级模式，结果可能与桌面不一致）；
 * - 字符串匹配（非正则）两端语义一致，无引擎分歧。
 */

import type { Filter, FilterMatch, LogEvent } from '../types';
import {
  ensureRegexWasm,
  getWasmRegex,
  validateWithWasm,
} from './regexWasm';

interface CompiledFilter {
  filterId: string;
  /** 原始 pattern（正则模式下用于 wasm 引擎懒编译） */
  pattern: string;
  /** JS RegExp（wasm 未就绪/加载失败时的兜底；非法正则为 null） */
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
    let regex: RegExp | null = null;
    try {
      // 使用 sticky 'y' 会在 lastIndex 上出问题，用全局 + lastIndex 重置即可
      regex = new RegExp(f.pattern, f.caseSensitive ? 'g' : 'gi');
    } catch {
      // JS 编译失败的非法正则：保留 null（wasm 引擎同样会拒绝 → 两端一致不命中）
    }
    return {
      filterId: f.id,
      pattern: f.pattern,
      regex,
      literal: null,
      scope: f.scope,
      caseSensitive: f.caseSensitive,
    };
  }
  return {
    filterId: f.id,
    pattern: f.pattern,
    regex: null,
    literal: f.caseSensitive ? f.pattern : f.pattern.toLowerCase(),
    scope: f.scope,
    caseSensitive: f.caseSensitive,
  };
}

/** 判断单个事件是否匹配某个已编译过滤器 */
function eventMatches(ev: LogEvent, cf: CompiledFilter): boolean {
  const text = cf.scope === 'raw' ? ev.raw : ev.message;
  if (cf.literal !== null) {
    // 字符串匹配路径（两端语义一致）
    if (cf.caseSensitive) return text.includes(cf.literal);
    return text.toLowerCase().includes(cf.literal);
  }
  if (cf.regex === null) return false;
  // 正则路径：优先 wasm（与桌面同一 Rust regex crate，结果一致），
  // 未就绪/失败/该 pattern 编译失败时回退 JS RegExp（降级模式）。
  const wr = getWasmRegex(cf.pattern, !cf.caseSensitive);
  if (wr) return wr.isMatch(text);
  cf.regex.lastIndex = 0;
  return cf.regex.test(text);
}

export class FilterEngine {
  /** 运行所有过滤器，返回 per-filter 匹配集合（与 filters 同序同长，空 pattern 返回空数组） */
  static run(events: LogEvent[], filters: Filter[]): FilterMatch[] {
    // 预热 wasm 引擎（幂等；本次运行可能仍是 JS 兜底，下次运行起走 wasm）
    void ensureRegexWasm();
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

  /**
   * 单 filter 重算（增量路径）：只跑一个 filter，其余 matches 引用复用。
   * 大数据量下配合 runFilterChunked 异步分块执行，避免阻塞主线程。
   */
  static runFilter(events: LogEvent[], filter: Filter): FilterMatch {
    void ensureRegexWasm();
    const cf = compileFilter(filter);
    if (!cf) return { filterId: filter.id, events: [] };
    const out: LogEvent[] = [];
    for (const ev of events) {
      if (eventMatches(ev, cf)) out.push(ev);
    }
    return { filterId: filter.id, events: out };
  }

  /**
   * 分块异步执行单 filter（同步每块 CHUNK 事件，块间让出主线程）。
   * 每块完成回调进度 onProgress(已处理数/总数)；onDone 返回最终结果。
   * 返回 cancel 函数（组件卸载/新 filter 编辑时取消旧任务）。
   */
  static runFilterChunked(
    events: LogEvent[],
    filter: Filter,
    onProgress: (done: number, total: number) => void,
    onDone: (match: FilterMatch) => void,
  ): () => void {
    void ensureRegexWasm();
    const cf = compileFilter(filter);
    if (!cf) {
      onProgress(events.length, events.length);
      onDone({ filterId: filter.id, events: [] });
      return () => {};
    }
    const out: LogEvent[] = [];
    const CHUNK = 50_000;
    let i = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      const end = Math.min(i + CHUNK, events.length);
      for (; i < end; i++) {
        if (eventMatches(events[i], cf)) out.push(events[i]);
      }
      onProgress(i, events.length);
      if (i < events.length) {
        setTimeout(step, 0); // 让出主线程，保持 UI 响应
      } else {
        onDone({ filterId: filter.id, events: out });
      }
    };
    step();
    return () => {
      cancelled = true;
    };
  }

  /**
   * 校验正则是否合法，返回错误信息或 null。
   * 优先用 wasm（= 桌面同款 Rust regex）校验，保证"编辑时能过 ⇔ 桌面能编译"；
   * wasm 未就绪时用 JS RegExp 兜底。
   */
  static validateRegex(pattern: string): string | null {
    if (!pattern) return null;
    const wasmErr = validateWithWasm(pattern);
    if (wasmErr !== undefined) return wasmErr;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }
}
