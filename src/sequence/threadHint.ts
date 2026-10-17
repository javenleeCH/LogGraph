/**
 * thread 解析质量提示——纯函数，供 CEP 面板展示（放在独立模块是为了可单测，
 * 也避免测试为了一个字符串函数去挂载整个面板组件）。
 *
 * 背景：`thread` 不是日志里的独立字段，而是**位置启发式**的解析产物
 * （解析器只认紧跟时间戳的 `[...]`）。实测 9 种常见格式里只有 1 种
 * （log4j2 那种线程写在最前的）能解析出 thread；Spring Boot / Logback
 * 把 level 写在 thread 之前的两种主流写法、以及 nginx / syslog /
 * Python logging 全部解析不出。
 *
 * 解析不出时所有事件落进同一个空桶，`scope: 'thread'` 就**静默退化成全局**。
 * 行为上还算保守（等价于没开分桶），但用户会误以为在按线程隔离，从而相信
 * 那些跨线程串出来的伪链——所以必须让它可见。
 */

import type { SequenceMatchResult } from '../types';
import { fmtCount } from '../utils/counts';

export interface ThreadHint {
  /** 徽标文字（极短，块头空间有限） */
  text: string;
  /** 悬浮说明：说清「这意味着什么」和「为什么会这样」 */
  title: string;
  /** true → 告警态（覆盖率 0 或疑似误抓） */
  warn: boolean;
}

/** 基数比阈值：distinct/withThread 超过它即疑似每个事件一个桶 */
const MISGRAB_RATIO = 0.8;
/** 事件数下限：小样本下「每条一个线程」可能是真的（如 3 条日志 3 个线程） */
const MISGRAB_MIN_EVENTS = 10;

/**
 * 依据 `threadStats` 给出提示。
 * @returns null = 无需提示（无统计数据、或没有参与匹配的事件）
 */
export function threadHint(r: SequenceMatchResult): ThreadHint | null {
  const st = r.threadStats;
  if (!st || st.totalEvents === 0) return null;

  // 指纹一：覆盖率 0 ⇒ 全部落 ∅ 桶 ⇒ 按线程作用域等同全局
  if (st.withThread === 0) {
    return {
      warn: true,
      text: '⚠ 无 thread',
      title:
        `本组 ${fmtCount(st.totalEvents)} 个事件都没解析出 thread，全部落进同一个空桶 ——\n` +
        '按线程作用域此时等同于全局，链会跨线程串出伪链。\n\n' +
        'thread 是位置启发式：只认紧跟时间戳的 [...]。level 写在 thread 之前\n' +
        '（Spring Boot / Logback 的常见写法）、或根本没有该段（nginx / syslog /\n' +
        'Python logging）的日志都解析不出。',
    };
  }

  // 指纹二：基数比接近 1 ⇒ 几乎每个事件一个桶 ⇒ 疑似误抓非线程字段
  // 误抓比漏解析危险得多：漏解析只是退化成全局（保守可用），误抓会把流拆碎
  // 导致链永远凑不齐（零链 = 全部漏报）。
  const ratio = st.distinctThreads / st.withThread;
  if (ratio > MISGRAB_RATIO && st.withThread >= MISGRAB_MIN_EVENTS) {
    return {
      warn: true,
      text: `⚠ ${st.distinctThreads} 线程/${st.withThread} 事件`,
      title:
        `几乎每个事件一个桶（基数比 ${(ratio * 100).toFixed(0)}%）—— 疑似把\n` +
        'traceId / requestId 之类非线程字段当成了 thread。\n\n' +
        '链必须在同一个桶内成立，这种拆分会导致全部漏报（零链）。\n' +
        '误抓比漏解析危险得多：漏解析只是退化成全局，结果仍保守可用。',
    };
  }

  const pct = Math.round((st.withThread / st.totalEvents) * 100);
  return {
    warn: false,
    text: `🧵 ${pct}% · ${st.distinctThreads} 线程`,
    title:
      `${fmtCount(st.withThread)} / ${fmtCount(st.totalEvents)} 个事件解析出 thread，\n` +
      `共 ${st.distinctThreads} 个不同线程。\n\n` +
      'thread 是位置启发式（只认紧跟时间戳的 [...]），\n' +
      `${fmtCount(st.totalEvents - st.withThread)} 个未解析出的事件统一归入空桶。`,
  };
}
