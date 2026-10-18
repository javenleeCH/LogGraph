import type { LogEvent } from '../types';

/**
 * 稳定合并两个按 ts 升序的事件数组（实时 tail 增量追加用）。
 *
 * 两段各自已按 ts 排序，合并为 O(N) 且保持 ts 升序；同 ts 时保留左侧（旧事件）优先，
 * 维持整体稳定。事件 id 来自 rawLines 行号、与顺序无关，合并时不改动——调用方负责
 * 在传入前把段内 id 重基为全局行号。
 */
export function mergeEventsByTs(a: LogEvent[], b: LogEvent[]): LogEvent[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  // 追加快路径：b 整体不早于 a 的尾部 ⇒ 无需逐元素比较，直接拼接
  // （与双指针结果逐项等价：a 全取完后才取 b；同 ts 时 a 在前，稳定性一致）
  if (a[a.length - 1].ts <= b[0].ts) return a.concat(b);

  const out = new Array<LogEvent>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    if (a[i].ts <= b[j].ts) out[k++] = a[i++];
    else out[k++] = b[j++];
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * b 是否可整体追加在 a 之后（即 b 的最早 ts 不早于 a 的最晚 ts）。
 *
 * 该判定是「增量」的前提：只有纯追加时，新增事件的命中集才能直接拼在旧命中集末尾，
 * 且结果与全量重算逐项一致（顺序、稳定性均不变）。任一为空视作纯追加（退化无交错）。
 */
export function isPureAppend(a: LogEvent[], b: LogEvent[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a[a.length - 1].ts <= b[0].ts;
}
