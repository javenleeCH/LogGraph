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

/** 多行子条件：pattern 按换行拆分，每行独立匹配，全部通过（AND）才算命中 */
interface SubCondition {
  /** 行文本（已剥 ! 前缀与首尾空白） */
  source: string;
  /** ! 开头：该行不出现才命中（排除行） */
  negate: boolean;
  /** JS RegExp（正则模式编译兜底；非法正则为 null） */
  regex: RegExp | null;
  /** 字符串匹配时的小写文本（已按大小写策略处理） */
  literal: string | null;
}

interface CompiledFilter {
  filterId: string;
  /** 原始 pattern（多行含 \n；wasm 引擎按子条件懒编译） */
  pattern: string;
  /** 子条件列表（单行时长度 1 且 negate=false，与旧单条件行为逐字节一致） */
  subs: SubCondition[];
  scope: 'raw' | 'message';
  caseSensitive: boolean;
}

/** pattern → 子条件文本列表（剥 ! 前缀、去首尾空白、跳过空行） */
function splitSubConditions(pattern: string): { source: string; negate: boolean }[] {
  const out: { source: string; negate: boolean }[] = [];
  for (const rawLine of pattern.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('!')) {
      const source = line.slice(1).trim();
      if (source) out.push({ source, negate: true });
    } else {
      out.push({ source: line, negate: false });
    }
  }
  return out;
}

/** 编译单个过滤器为可执行形式；pattern 只含空白（含纯换行）视同空返回 null */
function compileFilter(f: Filter): CompiledFilter | null {
  if (!f.pattern || !f.pattern.trim()) return null;
  if (!f.enabled) return null;
  const lines = splitSubConditions(f.pattern);
  if (lines.length === 0) return null;
  const subs: SubCondition[] = lines.map(({ source, negate }) => {
    if (f.isRegex) {
      let regex: RegExp | null = null;
      try {
        // 使用 sticky 'y' 会在 lastIndex 上出问题，用全局 + lastIndex 重置即可
        regex = new RegExp(source, f.caseSensitive ? 'g' : 'gi');
      } catch {
        // JS 编译失败的非法正则：保留 null（wasm 引擎同样会拒绝 → 两端一致不命中）
      }
      return { source, negate, regex, literal: null };
    }
    return {
      source,
      negate,
      regex: null,
      literal: f.caseSensitive ? source : source.toLowerCase(),
    };
  });
  return {
    filterId: f.id,
    pattern: f.pattern,
    subs,
    scope: f.scope,
    caseSensitive: f.caseSensitive,
  };
}

/** 单个子条件对文本的命中判断 */
function subMatches(text: string, sub: SubCondition, cf: CompiledFilter): boolean {
  if (sub.literal !== null) {
    // 字符串匹配路径（两端语义一致）
    if (cf.caseSensitive) return text.includes(sub.literal);
    return text.toLowerCase().includes(sub.literal);
  }
  if (sub.regex === null) return false;
  // 正则路径：优先 wasm（与桌面同一 Rust regex crate，结果一致），
  // 未就绪/失败/该 pattern 编译失败时回退 JS RegExp（降级模式）。
  const wr = getWasmRegex(sub.source, !cf.caseSensitive);
  if (wr) return wr.isMatch(text);
  sub.regex.lastIndex = 0;
  return sub.regex.test(text);
}

/** 判断单个事件是否匹配某个已编译过滤器（全部子条件 AND；! 行取反） */
function eventMatches(ev: LogEvent, cf: CompiledFilter): boolean {
  const text = cf.scope === 'raw' ? ev.raw : ev.message;
  for (const sub of cf.subs) {
    const hit = subMatches(text, sub, cf);
    if (sub.negate === hit) return false; // 排除行命中 / 普通行未命中 → 整体不匹配
  }
  return true;
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
   * wasm 未就绪时用 JS RegExp 兜底。多行 pattern 逐行校验（! 前缀已剥），错误带行号。
   */
  static validateRegex(pattern: string): string | null {
    if (!pattern) return null;
    const lines = splitSubConditions(pattern);
    const multi = lines.length > 1;
    for (let i = 0; i < lines.length; i++) {
      const err = validateOneRegex(lines[i].source);
      if (err) return multi ? `第 ${i + 1} 行：${err}` : err;
    }
    return null;
  }
}

/** 校验单条正则（wasm 优先，JS 兜底） */
function validateOneRegex(pattern: string): string | null {
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
