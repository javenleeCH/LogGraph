/**
 * 概览热点扫描
 *
 * 动机：全量视图下（例如 206h 的窗宽压进几百像素），几十万条命中在密度条上
 * 只是一片灰度均匀的色块，肉眼读不出结构。此时用户真正的问题是「哪里出事了」，
 * 与其让人盯着色块找，不如直接算出最密集的时段并跳过去。
 *
 * 用法：传入时间窗 + 各 lane 的 ts 升序事件，按固定份数切片统计，返回事件数
 * 最高的若干个互不重叠的连续时段（互不重叠=覆盖更多不同时刻，避免把整个
 * 峰值区连成一块）。
 */
export interface Hotspot {
  /** 时段起点（ms 时间戳） */
  start: number;
  /** 时段终点（ms 时间戳） */
  end: number;
  /** 时段内事件总数 */
  count: number;
  /** 相对「均匀分布期望值」的倍率（1=常态，>1=突发） */
  ratio: number;
}

export interface HotspotOptions {
  /** 时间窗切片数（扫描粒度） */
  slices?: number;
  /** 热点窗口宽度（以切片为单位） */
  window?: number;
  /** 最多返回几个热点 */
  limit?: number;
  /**
   * 是否做二次细化（默认开）。
   * 粗扫为了不漏峰必须开大窗口（206h 的窗里 ~3h），直接跳过去用户还得
   * 自己再找一遍；细化在命中窗口内再扫一次，把窗口收窄到 ~25min。
   */
  refine?: boolean;
}

/** 细化扫描的切片数 / 窗口宽度（在粗窗口内部） */
const REFINE_SLICES = 32;
const REFINE_WINDOW = 4;

/** 单次滑窗扫描（不含细化） */
function scanRange(
  range: { start: number; end: number },
  lanes: readonly (readonly { ts: number }[])[],
  slices: number,
  win: number,
  limit: number,
): Hotspot[] {
  const span = range.end - range.start;
  if (span <= 0 || lanes.length === 0) return [];

  const counts = new Int32Array(slices);
  let total = 0;
  for (const le of lanes) {
    for (const ev of le) {
      const i = Math.floor(((ev.ts - range.start) / span) * slices);
      if (i >= 0 && i < slices) {
        counts[i]++;
        total++;
      }
    }
  }
  if (total === 0) return [];

  // 滑窗求和（滚动和 → O(slices)，不用 O(slices × win)）
  const sums = new Int32Array(slices - win + 1);
  let rolling = 0;
  for (let i = 0; i < slices; i++) {
    rolling += counts[i];
    if (i >= win) rolling -= counts[i - win];
    if (i >= win - 1) sums[i - win + 1] = rolling;
  }

  const candidates: { i: number; sum: number }[] = [];
  for (let i = 0; i < sums.length; i++) candidates.push({ i, sum: sums[i] });
  candidates.sort((a, b) => b.sum - a.sum);

  const w = span / slices;
  const expected = Math.max(1, (total * win) / slices);
  const out: Hotspot[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (c.sum === 0) break;
    const start = range.start + c.i * w;
    const end = range.start + (c.i + win) * w;
    // 与已选热点重叠则跳过：保证输出互不重叠，指向不同的时刻
    if (out.some((h) => start < h.end && end > h.start)) continue;
    out.push({ start, end, count: c.sum, ratio: c.sum / expected });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 找出时间窗内事件最密集的若干连续时段。
 * 复杂度 O(事件总数 + 切片数)；细化再扫一遍（同一量级），仍是一次线性扫描级别。
 */
export function findHotspots(
  range: { start: number; end: number },
  lanes: readonly (readonly { ts: number }[])[],
  opts: HotspotOptions = {},
): Hotspot[] {
  const slices = Math.max(1, opts.slices ?? 256);
  const win = Math.min(slices, Math.max(1, opts.window ?? 4));
  const limit = Math.max(1, opts.limit ?? 3);
  const coarse = scanRange(range, lanes, slices, win, limit);
  if (opts.refine === false) return coarse;

  // 二次细化：窗口内再扫，定位到真正的峰；倍率沿用粗扫值（它表达的才是
  // 「这里比全局常态密多少」——细化区间内部处处都密，其局部倍率无意义）
  return coarse.map((h) => {
    const fine = scanRange({ start: h.start, end: h.end }, lanes, REFINE_SLICES, REFINE_WINDOW, 1);
    return fine.length > 0 ? { ...fine[0], ratio: h.ratio } : h;
  });
}
