/**
 * 异常语义分级：把「未被任何链覆盖的事件」这条原始噪声，聚合成可行动的
 * 「异常时间窗口」并分级。
 *
 * 动机：33 万量级下逐个事件报异常毫无意义——用户看不了 33 万条，也不知道
 * 该看哪一段。连续发生的异常其实是**同一件事**（服务抖动 5 秒里塞了 500
 * 条），按时间聚成段后，500 条变成 1 段，且段的大小本身就是信号。
 *
 * 设计要点：
 * - 纯函数、不参与匹配语义，只解释结果，故永远不会改变匹配结果；
 * - 输入必须 ts 升序（引擎与 TS 回退路径都保证），否则二分/合并都失效；
 * - 分级阈值可配，默认按段内事件数。
 */

/** SoA 未覆盖事件（引擎紧凑回传形态，见 types.ts SequenceMatchResult.uncovered） */
export interface UncoveredSoa {
  ids: number[];
  ts: number[];
}

/** 异常时间窗口：一段连续异常 */
export interface AnomalyWindow {
  startTs: number;
  endTs: number;
  /** 段内异常事件数 */
  count: number;
  /** 分级：low=零散零星；med=成簇；high=密集爆发 */
  level: 'low' | 'med' | 'high';
}

export interface AnomalySummary {
  /** 原始异常事件总数（= 未聚合时的条数） */
  total: number;
  /** 聚合后的窗口段数 */
  windows: AnomalyWindow[];
  /** 各级别的段数 */
  counts: { low: number; med: number; high: number };
}

/** 默认分级阈值（段内事件数）：<10 零散 / <50 成簇 / >=50 密集爆发 */
export const DEFAULT_LEVEL_THRESHOLDS = { med: 10, high: 50 };

/**
 * 相邻异常间隔 <= gapMs 视为同一段。默认 1 秒：同一次抖动里的多条日志
 * 通常间隔在毫秒级；跨过 1 秒基本是另一起事件了。
 */
export const DEFAULT_ANOMALY_GAP_MS = 1000;

function levelOf(count: number, t: { med: number; high: number }): AnomalyWindow['level'] {
  if (count >= t.high) return 'high';
  if (count >= t.med) return 'med';
  return 'low';
}

/**
 * 把 ts 升序的异常事件聚合成时间窗口（输入为 SoA 的 ts 列，或等价形态）。
 * 空输入 → total=0、windows=[]（调用方据此判断「无异常」）。
 */
export function aggregateAnomalyWindows(
  tsList: ArrayLike<number>,
  gapMs: number = DEFAULT_ANOMALY_GAP_MS,
  thresholds: { med: number; high: number } = DEFAULT_LEVEL_THRESHOLDS,
): AnomalySummary {
  const windows: AnomalyWindow[] = [];
  if (tsList.length === 0) {
    return { total: 0, windows, counts: { low: 0, med: 0, high: 0 } };
  }
  // 单趟扫描：输入已按 ts 升序，相邻间隔 <= gapMs 即并入当前段
  let start = tsList[0];
  let end = tsList[0];
  let count = 1;
  for (let i = 1; i < tsList.length; i++) {
    const ts = tsList[i];
    if (ts - end <= gapMs) {
      end = ts;
      count++;
    } else {
      windows.push({ startTs: start, endTs: end, count, level: levelOf(count, thresholds) });
      start = ts;
      end = ts;
      count = 1;
    }
  }
  windows.push({ startTs: start, endTs: end, count, level: levelOf(count, thresholds) });

  const counts = { low: 0, med: 0, high: 0 };
  for (const w of windows) counts[w.level]++;
  return { total: tsList.length, windows, counts };
}

/** 分级的中文标签 */
export const LEVEL_LABEL: Record<AnomalyWindow['level'], string> = {
  low: '零散',
  med: '成簇',
  high: '密集爆发',
};

/**
 * 定位 ts 落在哪个窗口（windows 按 startTs 升序且不重叠；落在段外 → null）。
 * 用于给逐条异常标注「它属于哪一段、那段有多严重」，否则用户在密密麻麻的
 * 异常列表里看不出哪几条是一伙的。
 */
export function windowAt(windows: AnomalyWindow[], ts: number): AnomalyWindow | null {
  let lo = 0;
  let hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid];
    if (ts < w.startTs) hi = mid - 1;
    else if (ts > w.endTs) lo = mid + 1;
    else return w;
  }
  return null;
}

/**
 * 给 UI 的一句话摘要。段数本身就是信息量——1 段 500 条的密集爆发，
 * 与 500 段零散 1 条，是完全不同的两件事。
 */
export function formatAnomalySummary(s: AnomalySummary): string {
  if (s.total === 0) return '无异常';
  const n = s.windows.length;
  const parts: string[] = [`${n} 段异常窗口（共 ${s.total} 条）`];
  if (s.counts.high > 0) parts.push(`${s.counts.high} 段密集`);
  else if (s.counts.med > 0) parts.push(`${s.counts.med} 段成簇`);
  return parts.join(' · ');
}
