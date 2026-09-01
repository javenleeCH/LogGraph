/**
 * 关联查找器：跨 lane 查找时间相近的事件。
 *
 * 核心价值：当你选中 lane A 的某事件时，
 * 在所有其它 lane 中找到时间窗口内最近的事件并高亮/连线。
 */

import type { FilterMatch, LogEvent } from '../types';

/**
 * 二分查找：在已按 ts 升序排列的事件数组中，找到 <= target 的最大索引。
 */
export function bisectLeft(events: LogEvent[], target: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].ts < target) lo = mid + 1;
    else hi = mid;
  }
  return lo; // 第一个 >= target 的索引
}

export interface NeighborResult {
  filterId: string;
  /** 窗口内最近的事件（可能为空，若无匹配） */
  events: LogEvent[];
}

/**
 * 在每个 lane 内查找时间窗口内的事件。
 * @param matches  各 lane 的匹配集合
 * @param centerTs 中心时间戳
 * @param halfWindowMs 半窗口大小（毫秒），窗口 = [center - half, center + half]
 */
export function findCorrelations(
  matches: FilterMatch[],
  centerTs: number,
  halfWindowMs: number,
): NeighborResult[] {
  const results: NeighborResult[] = [];
  const lo = centerTs - halfWindowMs;
  const hi = centerTs + halfWindowMs;

  for (const fm of matches) {
    const evs = fm.events;
    if (evs.length === 0) {
      results.push({ filterId: fm.filterId, events: [] });
      continue;
    }
    // 找到第一个 >= lo 的索引
    let start = bisectLeft(evs, lo);
    if (start > 0 && evs[start - 1].ts >= lo) start--;
    // 向后收集到 ts > hi 为止
    const found: LogEvent[] = [];
    for (let i = start; i < evs.length; i++) {
      if (evs[i].ts > hi) break;
      if (evs[i].ts >= lo) found.push(evs[i]);
    }
    results.push({ filterId: fm.filterId, events: found });
  }
  return results;
}

/**
 * 在单个 lane 中找到最接近 targetTs 的事件（用于游标显示）。
 */
export function nearestEvent(events: LogEvent[], targetTs: number): LogEvent | null {
  if (events.length === 0) return null;
  const idx = bisectLeft(events, targetTs);
  if (idx === 0) return events[0];
  if (idx >= events.length) return events[events.length - 1];
  const a = events[idx - 1];
  const b = events[idx];
  return Math.abs(a.ts - targetTs) <= Math.abs(b.ts - targetTs) ? a : b;
}
