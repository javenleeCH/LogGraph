/**
 * 密度着色口径（画布 TimelineCanvas 与 LogStreamView 共用一份实现）
 *
 * 历史问题：三处密度渲染（画布 lane / 画布折叠组行 / 表格流全局列）都写
 * `count / maxCount` 线性归一化。事件分布均匀时每个桶都≈峰值，于是整条被
 * 推到饱和 —— 实测 801MB / 206h 全量窗下，「垂直对齐看关联」这个核心卖点
 * 在默认视图里退化成两条 100% 实心色条，看不出任何结构。
 *
 * 改成以「常态速率」（均匀铺满时每桶应有的条数）为 0 点做对数映射后：
 * - 静默段变暗、突发段变亮 → 结构可见；
 * - 真的均匀 → 整条落在中间灰度 —— 那才是对的，因为确实没有变化；
 * - 基线只依赖全局量（不含滚动位置），滚动时颜色不跳变。
 */

/** 密度桶宽度（像素） */
export const DENSITY_BUCKET_W = 3;

/** 对数映射的封顶倍频程数（±2 档 = 1/4× ~ 4×） */
const MAX_OCTAVE = 2;
/** 最暗 / 最亮透明度 */
const ALPHA_MIN = 0.08;
const ALPHA_MAX = 0.92;

/** 相对常态的倍率 → 透明度（对数刻度，常态 = 中点灰度） */
export function densityAlpha(count: number, expected: number): number {
  const base = expected > 0 ? expected : 1;
  const octave = Math.max(-MAX_OCTAVE, Math.min(MAX_OCTAVE, Math.log2(Math.max(count, 1) / base)));
  return ALPHA_MIN + ((octave + MAX_OCTAVE) / (2 * MAX_OCTAVE)) * (ALPHA_MAX - ALPHA_MIN);
}

/** 倍率标签：0.4× / 3.2× / 28× */
export function fmtRatio(r: number): string {
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}

/** #rrggbb + alpha → rgba()；非法输入原样返回（不抛错，画布上色失败不该中断渲染） */
export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
