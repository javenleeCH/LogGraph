/**
 * 序列匹配（CEP）统计口径统一
 *
 * 背景：引擎对链明细（`chains`）有上限（CEP_MAX_CHAINS 护栏）。被截断时
 * 真值由 `totalChains` 携带；`uncovered` 为 SoA 全量回传、从不截断。
 * 直接读 `.length` 会把上限当成真值——历史 bug：画布头部显示「2000 异常」
 * 而 CEP 面板显示「335,780 异常」，同一分组两个入口两个数。所有对外展示
 * 的计数**必须**走这里，禁止直接读 length。
 */
import type { SequenceMatchResult } from '../types';

/** 完整链数（未截断时退回数组长度） */
export function trueChainCount(r: SequenceMatchResult | undefined): number {
  if (!r) return 0;
  return r.totalChains ?? r.chains.length;
}

/** 完整未覆盖事件数（异常数）：SoA 全量回传，恒为真值 */
export function trueUncoveredCount(r: SequenceMatchResult | undefined): number {
  if (!r) return 0;
  return r.uncovered?.ids.length ?? 0;
}

/** 链明细是否被上限截断（真值多于已回传条数） */
export function isSequenceTruncated(r: SequenceMatchResult | undefined): boolean {
  if (!r) return false;
  return trueChainCount(r) > r.chains.length;
}

/** 千分位（与 App/Toolbar 一致，跟随本机 locale） */
export function fmtCount(n: number): string {
  return n.toLocaleString();
}

/**
 * 紧凑计数：空间受限的标签用（纵轴子列头、chip）。
 * 268569 → 26.9万；1200 → 1200
 */
export function fmtCompact(n: number): string {
  if (n < 10000) return String(n);
  if (n < 100_000_000) return `${trim0(n / 10_000)}万`;
  return `${trim0(n / 100_000_000)}亿`;
}

/** 去掉小数末尾的 .0 */
function trim0(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
