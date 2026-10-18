import type { LogEvent } from '../types';

/**
 * 稳定合并两个按 ts 升序的事件数组（实时 tail 增量追加用）。
 *
 * 两段各自已按 ts 排序，合并为 O(N) 且保持 ts 升序；同 ts 时保留左侧（旧事件）优先，
 * 维持整体稳定。事件 id 来自 rawLines 行号、与顺序无关，合并时不改动——调用方负责
 * 在传入前把段内 id 重基为全局行号。
 */
export function mergeEventsByTs(a: LogEvent[], b: LogEvent[]): LogEvent[] {
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
