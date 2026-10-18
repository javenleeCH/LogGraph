/**
 * 关联键提取质量提示——纯函数，供 CEP 面板展示（`scope='key'` 时）。
 *
 * 与 `threadHint.ts` 同款设计：`scope='key'` 的退化是**静默**的——
 * - 正则没从任何事件提取到键 ⇒ 该组已按全局匹配（§3.4.1），链会跨请求串出伪链；
 * - 几乎每个事件一个键 ⇒ 桶被拆碎，链凑不齐 ⇒ 全部漏报（零链）。
 * 引擎只在 key 路径真实生效时回传 `keyStats`，这里把两种指纹变成可见提示。
 */

import type { KeyStats, SequenceMatchResult } from '../types';
import { fmtCount } from '../utils/counts';

export interface KeyHint {
  /** 徽标文字（极短，块头空间有限） */
  text: string;
  /** 悬浮说明：说清「这意味着什么」和「为什么会这样」 */
  title: string;
  /** true → 告警态（无键覆盖 或 键粒度过细） */
  warn: boolean;
}

/** 基数比阈值：distinct/withKey 超过它即疑似每个事件一个键 */
const MISGRAB_RATIO = 0.8;
/** 事件数下限：小样本下「每条一个键」可能是真的 */
const MISGRAB_MIN_EVENTS = 10;

/**
 * 依据 `keyStats` 给出提示。
 * @returns null = 无需提示（无统计数据、或没有参与匹配的事件）
 */
export function keyHint(r: SequenceMatchResult): KeyHint | null {
  const st: KeyStats | undefined = r.keyStats;
  if (!st || st.totalEvents === 0) return null;

  // 指纹一：一个键都没提取到 ⇒ 已按全局匹配（引擎侧静默退化）
  if (st.withKey === 0) {
    return {
      warn: true,
      text: '⚠ 无关联键',
      title:
        `本组 ${fmtCount(st.totalEvents)} 个事件都没被关联键正则命中，已按全局匹配 ——\n` +
        '链会跨请求串出伪链。\n\n' +
        '检查 keyPattern：正则须含 1 个捕获组（如 traceId=([0-9a-f-]+)），\n' +
        '且要匹配日志里关联键的真实写法。',
    };
  }

  // 指纹二：基数比接近 1 ⇒ 几乎每个事件一个键 ⇒ 桶拆碎 ⇒ 全漏
  const ratio = st.distinctKeys / st.withKey;
  if (ratio > MISGRAB_RATIO && st.withKey >= MISGRAB_MIN_EVENTS) {
    return {
      warn: true,
      text: `⚠ ${st.distinctKeys} 键/${st.withKey} 事件`,
      title:
        `几乎每个事件一个键（基数比 ${(ratio * 100).toFixed(0)}%）—— 键粒度太细，\n` +
        '每个桶都凑不齐一条链，结果是全部漏报（零链）。\n\n' +
        '关联键应当在一整个请求内保持不变；若正则把行号/时间戳也捕进了\n' +
        '捕获组，每行就会变成不同的键。',
    };
  }

  const pct = Math.round((st.withKey / st.totalEvents) * 100);
  return {
    warn: false,
    text: `🔑 ${pct}% · ${st.distinctKeys} 键`,
    title:
      `${fmtCount(st.withKey)} / ${fmtCount(st.totalEvents)} 个事件提取到关联键，\n` +
      `共 ${st.distinctKeys} 个不同键，各自独立成桶匹配。\n\n` +
      `${fmtCount(st.totalEvents - st.withKey)} 个未命中正则的事件不进任何键桶\n` +
      '（没有键就无从关联，混匹配只会跨请求串出伪链），计入未覆盖事件。',
  };
}
