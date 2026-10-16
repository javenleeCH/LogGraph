/**
 * Canvas 绘制函数（浅色主题，Perfetto 风格）：
 * 轴网格、lane、事件、minimap、关联连线。
 * 纯函数式，不持有状态，由 TimelineCanvas 调用。
 */

import type { Filter, FilterGroup, FilterMatch, LogEvent, MatchedChain, SequenceMatchResult, TimeRange } from '../types';
import { LAYOUT } from './layout';
import { DENSITY_BUCKET_W, densityAlpha, withAlpha } from './density';
import { chooseTickStep, formatTime, formatDateTime } from '../utils/timeFormat';
import { fmtCompact } from '../utils/counts';
import type { VisibleRow } from './layout';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: TimeRange;
  timeToX: (t: number) => number;
  xToTime: (x: number) => number;
  mouseRowY: number | null;
}

// 浅色主题调色板：运行时从 CSS 变量读取（带 fallback），与 DOM 样式共享同一套 token
export const readVar = (name: string, fallback: string): string => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
};

function buildPalette() {
  return {
  axisBg: readVar('--bg-track', '#f1f3f4'),
  headerColBg: readVar('--bg', '#ffffff'),
  trackAlt: readVar('--bg-track-alt', '#f8f9fa'),
  trackEven: readVar('--bg-track', '#f1f3f4'),
  trackHover: readVar('--bg-track-hover', '#e8f0fe'),
  headerBorder: readVar('--border', '#dadce0'),
  text: readVar('--text', '#202124'),
  textDim: readVar('--text-dim', '#5f6368'),
  textFaint: readVar('--text-faint', '#80868b'),
  tickLine: readVar('--text-faint', '#80868b'),
  gridLine: 'rgba(60,64,67,0.08)',
  trackBottom: readVar('--border-light', '#e8eaed'),
  selectedFill: readVar('--text', '#202124'),
  corrStroke: readVar('--corr', '#2563eb'),
  scrubberStroke: 'rgba(26,115,232,0.5)',
  scrubberBubble: readVar('--accent', '#1a73e8'),
  minimapBg: readVar('--bg-panel', '#f8f9fa'),
  minimapBorder: readVar('--border', '#dadce0'),
  minimapViewFill: 'rgba(26,115,232,0.12)',
  minimapViewStroke: readVar('--accent', '#1a73e8'),
  corrLink: 'rgba(37,99,235,0.4)',
  // CEP 异常 / NOT 违规：专用红（--anomaly），刻意区别于 --track-orange 关联琥珀，
  // 见 global.css 中 --anomaly 的注释
  anomalyFill: readVar('--anomaly', '#cf222e'),
  anomalyStroke: readVar('--anomaly', '#cf222e'),
  seqLinkAlpha: 0.75,
  tooltipBg: readVar('--bg', '#ffffff'),
  tooltipBorder: readVar('--border', '#dadce0'),
}}

let C = buildPalette();

/** 每帧调用：重新从 CSS 变量读取色板，保证主题切换后画布实时更新 */
export function refreshPalette() {
  C = buildPalette();
}

// ---- 颜色工具（withAlpha 见 ./density，与密度着色同源） ----

function getMonoFont() {
  return '"Roboto Mono","SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';
}
function getSansFont() {
  return '"Google Sans","Roboto",-apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
}

/** 绘制时间轴标尺 + 网格 */
export function drawAxis(rc: RenderContext, _fullRange: TimeRange | null) {
  const { ctx, width, view, timeToX } = rc;
  ctx.save();

  ctx.fillStyle = C.axisBg;
  ctx.fillRect(0, 0, width, LAYOUT.AXIS_HEIGHT);

  ctx.fillStyle = C.headerColBg;
  ctx.fillRect(0, 0, LAYOUT.LEFT_LABEL_WIDTH, LAYOUT.AXIS_HEIGHT);

  ctx.strokeStyle = C.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, LAYOUT.AXIS_HEIGHT + 0.5);
  ctx.lineTo(width, LAYOUT.AXIS_HEIGHT + 0.5);
  ctx.stroke();

  const span = view.end - view.start;
  const step = chooseTickStep(span);
  const startTick = Math.ceil(view.start / step) * step;

  // 垂直网格线
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth = 1;
  for (let t = startTick; t <= view.end + step; t += step) {
    const x = Math.floor(timeToX(t)) + 0.5;
    if (x < LAYOUT.LEFT_LABEL_WIDTH) continue;
    ctx.beginPath();
    ctx.moveTo(x, LAYOUT.AXIS_HEIGHT);
    ctx.lineTo(x, rc.height);
    ctx.stroke();
  }

  // 刻度文字 + 短线
  ctx.fillStyle = C.textDim;
  ctx.font = `11px ${getMonoFont()}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let t = startTick; t <= view.end + step; t += step) {
    const x = timeToX(t);
    if (x < LAYOUT.LEFT_LABEL_WIDTH) continue;
    ctx.strokeStyle = C.tickLine;
    ctx.beginPath();
    ctx.moveTo(x, LAYOUT.AXIS_HEIGHT - 8);
    ctx.lineTo(x, LAYOUT.AXIS_HEIGHT);
    ctx.stroke();
    ctx.fillText(formatTickLabel(t, step), x, LAYOUT.AXIS_HEIGHT / 2 - 1);
  }

  ctx.restore();
}

function formatTickLabel(t: number, step: number): string {
  if (step >= 86400000) return formatDateTime(t).slice(0, 10);
  if (step >= 3600000) return formatDateTime(t).slice(11, 19);
  return formatTime(t);
}

/** 绘制单个 lane 背景 + 标题（含 hover 高亮） */
export function drawLaneBackground(
  rc: RenderContext,
  filter: Filter,
  index: number,
  matchCount: number,
  hovered: boolean,
) {
  const { ctx, width } = rc;
  const y = LAYOUT.AXIS_HEIGHT + index * (LAYOUT.LANE_HEIGHT + LAYOUT.LANE_GAP);
  const h = LAYOUT.LANE_HEIGHT;

  ctx.save();

  if (hovered) {
    ctx.fillStyle = C.trackHover;
  } else {
    ctx.fillStyle = index % 2 === 0 ? C.trackEven : C.trackAlt;
  }
  ctx.fillRect(0, y, width, h);

  // 左侧标题列
  ctx.fillStyle = C.headerColBg;
  ctx.fillRect(0, y, LAYOUT.LEFT_LABEL_WIDTH, h);

  ctx.strokeStyle = C.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LAYOUT.LEFT_LABEL_WIDTH + 0.5, y);
  ctx.lineTo(LAYOUT.LEFT_LABEL_WIDTH + 0.5, y + h);
  ctx.stroke();

  // 颜色条
  ctx.fillStyle = filter.color;
  ctx.fillRect(0, y, 3, h);

  // 标题
  ctx.fillStyle = C.text;
  ctx.font = `500 12px ${getSansFont()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelY = y + 12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(8, labelY - 8, LAYOUT.LEFT_LABEL_WIDTH - 16, 16);
  ctx.clip();
  ctx.fillText(filter.label, 10, labelY);
  ctx.restore();

  // 匹配数
  ctx.fillStyle = C.textDim;
  ctx.font = `11px ${getMonoFont()}`;
  ctx.fillText(`${matchCount}`, 10, y + h - 10);

  // 过滤器模式
  if (filter.pattern) {
    ctx.fillStyle = C.textFaint;
    ctx.font = `11px ${getMonoFont()}`;
    const mode = filter.isRegex ? '/' + filter.pattern + '/' : '"' + filter.pattern + '"';
    ctx.save();
    ctx.beginPath();
    ctx.rect(40, y + h - 18, LAYOUT.LEFT_LABEL_WIDTH - 48, 16);
    ctx.clip();
    ctx.fillText(mode, 42, y + h - 10);
    ctx.restore();
  }

  // lane 底线
  ctx.strokeStyle = C.trackBottom;
  ctx.beginPath();
  ctx.moveTo(0, y + h + 0.5);
  ctx.lineTo(width, y + h + 0.5);
  ctx.stroke();

  ctx.restore();
}

/** 绘制 lane 内的事件标记 */
export function drawLaneEvents(
  rc: RenderContext,
  filter: Filter,
  index: number,
  events: LogEvent[],
  selectedId: number | null,
  hoveredId: number | null,
  correlatedIds: Set<number>,
) {
  const { ctx, view, timeToX, width } = rc;
  const y = LAYOUT.AXIS_HEIGHT + index * (LAYOUT.LANE_HEIGHT + LAYOUT.LANE_GAP);
  const h = LAYOUT.LANE_HEIGHT;
  const eventH = h * LAYOUT.EVENT_HEIGHT_RATIO;
  const eventY = y + (h - eventH) / 2;
  const chartLeft = LAYOUT.LEFT_LABEL_WIDTH;
  const chartWidth = width - chartLeft;

  ctx.save();
  ctx.beginPath();
  ctx.rect(chartLeft, y, chartWidth, h);
  ctx.clip();

  for (const ev of events) {
    if (ev.ts < view.start || ev.ts > view.end) continue;
    const x = timeToX(ev.ts);
    if (x < chartLeft - 6 || x > width + 6) continue;

    const isSel = ev.id === selectedId;
    const isHov = ev.id === hoveredId;
    const isCorr = correlatedIds.has(ev.id);

    let fillColor = filter.color;
    if (isSel) {
      fillColor = C.selectedFill;
    } else if (isCorr) {
      fillColor = lightenHex(filter.color, 0.15);
    }
    ctx.fillStyle = fillColor;

    const w = isSel ? 3.5 : isHov ? 3 : LAYOUT.EVENT_MIN_WIDTH;
    const xOff = x - w / 2;
    ctx.fillRect(xOff, eventY, w, eventH);

    if (isSel) {
      ctx.strokeStyle = filter.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y + h / 2, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x, y + 1);
      ctx.lineTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y - 4);
      ctx.closePath();
      ctx.fill();
    }

    if (isCorr && !isSel) {
      // 关联=琥珀虚线框（区别于 CEP 异常的红色实线框、链节点的组色实线框）
      ctx.setLineDash(CORR_RING_DASH);
      ctx.strokeStyle = C.corrStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(xOff - 1, eventY - 1, w + 2, eventH + 2);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

/** 绘制单个 lane 背景 + 标题（直接给定 y/h，用于 visibleRows 布局） */
export function drawLaneBackgroundAt(
  rc: RenderContext,
  filter: Filter,
  y: number,
  h: number,
  matchCount: number,
  hovered: boolean,
) {
  const { ctx, width } = rc;
  ctx.save();
  ctx.fillStyle = hovered ? C.trackHover : C.trackAlt;
  ctx.fillRect(0, y, width, h);
  ctx.fillStyle = C.headerColBg;
  ctx.fillRect(0, y, LAYOUT.LEFT_LABEL_WIDTH, h);
  ctx.strokeStyle = C.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LAYOUT.LEFT_LABEL_WIDTH + 0.5, y);
  ctx.lineTo(LAYOUT.LEFT_LABEL_WIDTH + 0.5, y + h);
  ctx.stroke();
  ctx.fillStyle = filter.color;
  ctx.fillRect(0, y, 3, h);
  ctx.fillStyle = C.text;
  ctx.font = `500 12px ${getSansFont()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelY = y + 12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(8, labelY - 8, LAYOUT.LEFT_LABEL_WIDTH - 16, 16);
  ctx.clip();
  ctx.fillText(filter.label, 10, labelY);
  ctx.restore();
  ctx.fillStyle = C.textDim;
  ctx.font = `11px ${getMonoFont()}`;
  ctx.fillText(`${matchCount}`, 10, y + h - 10);
  if (filter.pattern) {
    ctx.fillStyle = C.textFaint;
    ctx.font = `11px ${getMonoFont()}`;
    const mode = filter.isRegex ? '/' + filter.pattern + '/' : '"' + filter.pattern + '"';
    ctx.save();
    ctx.beginPath();
    ctx.rect(40, y + h - 18, LAYOUT.LEFT_LABEL_WIDTH - 48, 16);
    ctx.clip();
    ctx.fillText(mode, 42, y + h - 10);
    ctx.restore();
  }
  ctx.strokeStyle = C.trackBottom;
  ctx.beginPath();
  ctx.moveTo(0, y + h + 0.5);
  ctx.lineTo(width, y + h + 0.5);
  ctx.stroke();
  ctx.restore();
}

/** 关联的ptime邻域标记：虚线框（区别于 CEP 链/异常的实线框）。
 *  颜色之外再补一重形状语义——组色调色板含橙色项，仅靠色相差不足以保证可辨。 */
const CORR_RING_DASH = [2, 2];

/** 绘制 lane 内的事件标记（直接给定 y/h，用于 visibleRows 布局） */
export function drawLaneEventsAt(
  rc: RenderContext,
  filter: Filter,
  y: number,
  h: number,
  events: LogEvent[],
  selectedId: number | null,
  hoveredId: number | null,
  correlatedIds: Set<number>,
  chainIds: Set<number> | null = null,
  anomalyIds: Set<number> | null = null,
  chainColor: string | null = null,
  chainIndexOf: ((eventId: number) => number | null) | null = null,
  violationIds: Set<number> | null = null,
  jitterTs: Set<number> | null = null,
) {
  const { ctx, view, timeToX, width } = rc;
  const eventH = h * LAYOUT.EVENT_HEIGHT_RATIO;
  const eventY = y + (h - eventH) / 2;
  const chartLeft = LAYOUT.LEFT_LABEL_WIDTH;
  const chartWidth = width - chartLeft;
  ctx.save();
  ctx.beginPath();
  ctx.rect(chartLeft, y, chartWidth, h);
  ctx.clip();
  // ---- 密度模式（可见事件过多）----
  // 桶聚合绘制 + 仅单独绘制选中/悬停/关联标记：宽视口下逐标记 fillRect
  // 是每帧数百 ms 的主因（WASD 卡顿）；密度图在大 zoom-out 下信息量等价。
  if (events.length > LAYOUT.DENSITY_EVENT_THRESHOLD) {
    const bucketW = DENSITY_BUCKET_W;
    const bucketCount = Math.ceil(chartWidth / bucketW);
    const buckets = new Int32Array(bucketCount);
    const specials: { x: number; ev: LogEvent }[] = [];
    let inView = 0;
    for (const ev of events) {
      if (ev.ts < view.start || ev.ts > view.end) continue;
      const x = timeToX(ev.ts);
      if (x < chartLeft || x >= width) continue;
      buckets[Math.min(bucketCount - 1, Math.floor((x - chartLeft) / bucketW))]++;
      inView++;
      if (
        ev.id === selectedId ||
        ev.id === hoveredId ||
        correlatedIds.has(ev.id)
      ) {
        specials.push({ x, ev });
      }
    }
    // 常态速率 = 可见事件均匀铺满各桶时每桶应有的条数。
    // 用它做 0 点而不是 cnt/maxCount（后者在均匀分布下全线饱和 → 实心色条）。
    const expected = Math.max(1, inView / bucketCount);
    const barH = h * LAYOUT.EVENT_HEIGHT_RATIO;
    const barTop = y + (h - barH) / 2;
    for (let i = 0; i < bucketCount; i++) {
      const cnt = buckets[i];
      if (cnt === 0) continue;
      ctx.fillStyle = withAlpha(filter.color, densityAlpha(cnt, expected));
      ctx.fillRect(chartLeft + i * bucketW, barTop, bucketW - 0.5, barH);
    }
    // 特殊标记（少量）单独绘制，保持选中/悬停/关联在密度图上可见
    for (const { x, ev } of specials) {
      const isSel = ev.id === selectedId;
      const isHov = ev.id === hoveredId;
      const isCorr = correlatedIds.has(ev.id);
      const w = isSel ? 3.5 : isHov ? 3 : LAYOUT.EVENT_MIN_WIDTH;
      ctx.fillStyle = isSel ? C.selectedFill : isCorr ? lightenHex(filter.color, 0.15) : filter.color;
      ctx.fillRect(x - w / 2, eventY, w, eventH);
      if (isCorr && !isSel) {
        ctx.setLineDash(CORR_RING_DASH);
        ctx.strokeStyle = C.corrStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - w / 2 - 1, eventY - 1, w + 2, eventH + 2);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
    return;
  }

  for (const ev of events) {
    if (ev.ts < view.start || ev.ts > view.end) continue;
    const x = timeToX(ev.ts);
    if (x < chartLeft - 6 || x > width + 6) continue;
    const isSel = ev.id === selectedId;
    const isHov = ev.id === hoveredId;
    const isCorr = correlatedIds.has(ev.id);
    const isChain = chainIds?.has(ev.id) ?? false;
    const isAnom = anomalyIds?.has(ev.id) ?? false;
    const isViol = violationIds?.has(ev.id) ?? false;
    const isJit = jitterTs?.has(ev.ts) ?? false;
    let fillColor = filter.color;
    if (isSel) fillColor = C.selectedFill;
    else if (isAnom || isViol) fillColor = C.anomalyFill;
    else if (isCorr) fillColor = lightenHex(filter.color, 0.15);
    ctx.fillStyle = fillColor;
    const w = isSel ? 3.5 : isHov || isChain ? 3 : LAYOUT.EVENT_MIN_WIDTH;
    ctx.fillRect(x - w / 2, eventY, w, eventH);
  // 外框语义三态：链上=组色实线框；异常/违规=--anomaly 专红实线框；
  // 抖动=关联蓝框（见 corrStroke，虚线）。红框与蓝框刻意不同色：前者是引擎
  // 判定的数据异常，后者是选中事件派生的时间邻域，混淆会直接误判现场。
    if (isChain && !isSel) {
      ctx.strokeStyle = chainColor ?? filter.color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - w / 2 - 1.5, eventY - 1.5, w + 3, eventH + 3);
    } else if ((isAnom || isViol) && !isSel) {
      ctx.strokeStyle = C.anomalyStroke;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - w / 2 - 1.5, eventY - 1.5, w + 3, eventH + 3);
    } else if (isJit && !isSel) {
      ctx.strokeStyle = C.corrStroke;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - w / 2 - 1.5, eventY - 1.5, w + 3, eventH + 3);
    }
    // 链号小标记：链上事件右侧标注链序号（选中或悬停时显示，避免全量噪声）
    if ((isSel || isHov) && isChain && chainIndexOf) {
      const ci = chainIndexOf(ev.id);
      if (ci !== null) {
        ctx.fillStyle = chainColor ?? filter.color;
        ctx.font = `600 10px ${getMonoFont()}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`#${ci}`, x + 5, eventY + eventH / 2);
      }
    }
    if (isSel) {
      ctx.strokeStyle = filter.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y + h / 2, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x, y + 1);
      ctx.lineTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y - 4);
      ctx.closePath();
      ctx.fill();
    }
    if (isCorr && !isSel) {
      ctx.setLineDash(CORR_RING_DASH);
      ctx.strokeStyle = C.corrStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - w / 2 - 1, eventY - 1, w + 2, eventH + 2);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

/** Shift 框选拖拽中的高亮带：accent 半透明填充 + 边线 + 两端把手 */
export function drawBrushOverlay(rc: RenderContext, x1: number, x2: number) {
  const { ctx, height } = rc;
  const top = LAYOUT.AXIS_HEIGHT;
  const bottom = height - LAYOUT.MINIMAP_HEIGHT - LAYOUT.MINIMAP_GAP;
  if (x2 <= x1 || bottom <= top) return;
  const accent = readVar('--accent', '#1a73e8');
  ctx.save();
  ctx.fillStyle = withAlpha(accent, 0.15);
  ctx.fillRect(x1, top, x2 - x1, bottom - top);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(x1 + 0.5, top + 0.5, x2 - x1 - 1, bottom - top - 1);
  ctx.fillStyle = accent;
  ctx.fillRect(x1 - 1.5, top, 3, bottom - top);
  ctx.fillRect(x2 - 1.5, top, 3, bottom - top);
  ctx.restore();
}
/** 绘制关联连线：选中/游标事件竖线贯穿所有 lane */
export function drawCorrelationLinks(
  rc: RenderContext,
  filters: Filter[],
  matches: FilterMatch[],
  centerTs: number | null,
  selectedId: number | null,
) {
  if (centerTs === null) return;
  const { ctx, timeToX, width } = rc;
  const cx = timeToX(centerTs);
  if (cx < LAYOUT.LEFT_LABEL_WIDTH || cx > width) {
    void filters;
    void matches;
    void selectedId;
    return;
  }

  const lanesBottom =
    LAYOUT.AXIS_HEIGHT +
    filters.length * (LAYOUT.LANE_HEIGHT + LAYOUT.LANE_GAP);

  ctx.save();
  ctx.strokeStyle = C.corrLink;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx + 0.5, LAYOUT.AXIS_HEIGHT);
  ctx.lineTo(cx + 0.5, Math.max(lanesBottom, LAYOUT.AXIS_HEIGHT));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = C.corrStroke;
  ctx.beginPath();
  ctx.arc(cx, LAYOUT.AXIS_HEIGHT, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  void matches;
  void selectedId;
}

/** 绘制游标 + 时间标签 */
export function drawScrubber(rc: RenderContext, scrubberTs: number | null) {
  if (scrubberTs === null) return;
  const { ctx, width, height, timeToX } = rc;
  const x = timeToX(scrubberTs);
  if (x < LAYOUT.LEFT_LABEL_WIDTH || x > width) return;

  ctx.save();
  ctx.strokeStyle = C.scrubberStroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, height);
  ctx.stroke();

  const label = formatTime(scrubberTs);
  ctx.font = `11px ${getMonoFont()}`;
  const tw = ctx.measureText(label).width + 12;
  const th = 16;
  const tx = Math.max(LAYOUT.LEFT_LABEL_WIDTH, Math.min(x - tw / 2, width - tw));

  ctx.fillStyle = C.scrubberBubble;
  roundRect(ctx, tx, 2, tw, th, 3);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, tx + tw / 2, 2 + th / 2);
  ctx.restore();
}

/** minimap 离屏直方图缓存（由 TimelineCanvas 的 useMemo 维护） */
export interface MinimapCache {
  canvas: HTMLCanvasElement;
  key: string;
}

/** 绘制 minimap（直方图走离屏缓存位图，每帧仅 drawImage + 视口框） */
export function drawMinimap(
  rc: RenderContext,
  fullRange: TimeRange,
  view: TimeRange,
  matches: FilterMatch[],
  filters: Filter[],
  cache: MinimapCache | null = null,
) {
  const { ctx, width, height } = rc;
  const top = height - LAYOUT.MINIMAP_HEIGHT;
  const left = LAYOUT.LEFT_LABEL_WIDTH;
  const w = width - left;
  const h = LAYOUT.MINIMAP_HEIGHT;

  ctx.save();
  ctx.fillStyle = C.minimapBg;
  ctx.fillRect(left, top, w, h);
  ctx.strokeStyle = C.minimapBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, w, h);

  // 左侧标题列
  ctx.fillStyle = C.headerColBg;
  ctx.fillRect(0, top, left, h);
  ctx.fillStyle = C.textFaint;
  ctx.font = `11px ${getSansFont()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('概览', 8, top + h / 2);

  const span = fullRange.end - fullRange.start || 1;
  const tToX = (t: number) => left + ((t - fullRange.start) / span) * w;

  // 直方图：优先离屏缓存（O(1) drawImage）；缓存缺失时降级为直绘
  if (cache) {
    ctx.drawImage(cache.canvas, left, top, w, h);
  } else {
    // 降级直绘路径（缓存未就绪时的首帧）：与缓存同口径按列聚合
    const cols = Math.max(1, Math.floor(w));
    for (let i = 0; i < matches.length; i++) {
      const fm = matches[i];
      const color = filters.find((f) => f.id === fm.filterId)?.color ?? '#888';
      const bandTop = top + 6 + (i % 4) * 8;
      const buckets = new Int32Array(cols);
      let inView = 0;
      for (const ev of fm.events) {
        if (ev.ts < fullRange.start || ev.ts > fullRange.end) continue;
        const x = Math.floor(((ev.ts - fullRange.start) / span) * w);
        if (x < 0 || x >= cols) continue;
        buckets[x]++;
        inView++;
      }
      const expected = Math.max(1, inView / cols);
      for (let x = 0; x < cols; x++) {
        const c = buckets[x];
        if (c === 0) continue;
        ctx.fillStyle = withAlpha(color, densityAlpha(c, expected));
        ctx.fillRect(left + x, bandTop, 1, 7);
      }
    }
  }

  const vx = tToX(view.start);
  const vw = Math.max(2, tToX(view.end) - vx);
  ctx.fillStyle = C.minimapViewFill;
  ctx.fillRect(vx, top, vw, h);
  ctx.strokeStyle = C.minimapViewStroke;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vx + 0.5, top + 0.5, vw, h - 1);

  ctx.fillStyle = C.minimapViewStroke;
  ctx.fillRect(vx - 1, top + 4, 3, h - 8);
  ctx.fillRect(vx + vw - 2, top + 4, 3, h - 8);

  ctx.restore();
}

// ---- 工具 ----
function lightenHex(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return `rgb(${r},${g},${b})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- group 折叠/标题/密度热力 ----

/**
 * 绘制 group 标题行：折叠箭头 ▶/▼ + 组名 + 子项数 + 组色条。
 * headerY / headerH 来自 VisibleRow 的 y / height。
 */
export function drawGroupHeader(
  rc: RenderContext,
  group: FilterGroup,
  headerY: number,
  headerH: number,
  childCount: number,
  hovered: boolean,
  seqStat: { chains: number; anomalies: number; anomalyEnabled: boolean } | null = null,
) {
  const { ctx, width } = rc;
  ctx.save();

  // 背景（比 filter 行略深，区分层次）
  ctx.fillStyle = hovered ? C.trackHover : C.trackBottom;
  ctx.fillRect(0, headerY, width, headerH);

  // 左侧标题列底色
  ctx.fillStyle = C.headerColBg;
  ctx.fillRect(0, headerY, LAYOUT.LEFT_LABEL_WIDTH, headerH);

  // 组色条
  ctx.fillStyle = group.color;
  ctx.fillRect(0, headerY, 3, headerH);

  // 折叠箭头
  ctx.fillStyle = C.text;
  ctx.font = `13px ${getSansFont()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const arrow = group.collapsed ? '▶' : '▼';
  ctx.fillText(arrow, 10, headerY + headerH / 2);

  // 组名
  ctx.font = `600 12px ${getSansFont()}`;
  ctx.save();
  ctx.beginPath();
  ctx.rect(28, headerY, LAYOUT.LEFT_LABEL_WIDTH - 36, headerH);
  ctx.clip();
  ctx.fillText(group.label, 28, headerY + headerH / 2);
  ctx.restore();

  // 子项数（右侧）
  ctx.fillStyle = C.textDim;
  ctx.font = `11px ${getMonoFont()}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${childCount}`, LAYOUT.LEFT_LABEL_WIDTH - 8, headerY + headerH / 2);

  // 序列链统计（组名右侧，图表区内）：⛓ N 链 · M 异常
  if (seqStat && seqStat.chains >= 0 && (seqStat.chains > 0 || seqStat.anomalyEnabled)) {
    // 紧凑格式：真值可能是 33.6 万，展开写会顶掉图表区
    const parts: string[] = [`⛓ ${fmtCompact(seqStat.chains)} 链`];
    if (seqStat.anomalyEnabled) parts.push(`${fmtCompact(seqStat.anomalies)} 异常`);
    const label = parts.join(' · ');
    ctx.save();
    ctx.fillStyle = seqStat.anomalyEnabled && seqStat.anomalies > 0 ? C.anomalyFill : C.textDim;
    ctx.font = `11px ${getSansFont()}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 裁剪到图表区，避免与右侧内容重叠
    ctx.beginPath();
    ctx.rect(LAYOUT.LEFT_LABEL_WIDTH + 8, headerY, rc.width - LAYOUT.LEFT_LABEL_WIDTH - 16, headerH);
    ctx.clip();
    ctx.fillText(label, LAYOUT.LEFT_LABEL_WIDTH + 10, headerY + headerH / 2);
    ctx.restore();
  }

  // 底线
  ctx.strokeStyle = C.trackBottom;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerY + headerH + 0.5);
  ctx.lineTo(width, headerY + headerH + 0.5);
  ctx.stroke();

  ctx.restore();
}

/**
 * 绘制 group 折叠态密度热力条：按像素分桶统计事件数，颜色深浅=密度，组色着色。
 * 复用 LogStreamView 的密度桶思路。
 */
export function drawGroupDensity(
  rc: RenderContext,
  group: FilterGroup,
  events: LogEvent[],
  rowY: number,
  rowH: number,
  selectedId: number | null,
  hoveredId: number | null,
  correlatedIds: Set<number>,
) {
  const { ctx, view, timeToX, width } = rc;
  const chartLeft = LAYOUT.LEFT_LABEL_WIDTH;
  const chartW = width - chartLeft;
  if (chartW <= 0) return;

  ctx.save();

  // 行背景（左侧标题列 + 右侧绘图区）
  ctx.fillStyle = C.trackEven;
  ctx.fillRect(0, rowY, width, rowH);
  ctx.fillStyle = C.headerColBg;
  ctx.fillRect(0, rowY, chartLeft, rowH);
  ctx.strokeStyle = C.headerBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartLeft + 0.5, rowY);
  ctx.lineTo(chartLeft + 0.5, rowY + rowH);
  ctx.stroke();

  // 组色条
  ctx.fillStyle = group.color;
  ctx.fillRect(0, rowY, 3, rowH);

  // 左侧标题：折叠提示
  ctx.fillStyle = C.textDim;
  ctx.font = `11px ${getMonoFont()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.beginPath();
  ctx.rect(8, rowY, chartLeft - 16, rowH);
  ctx.clip();
  ctx.fillText(`${group.label}（${events.length}）`, 10, rowY + rowH / 2);
  ctx.restore();

  // 绘图区裁剪
  ctx.beginPath();
  ctx.rect(chartLeft, rowY, chartW, rowH);
  ctx.clip();

  if (events.length === 0) {
    ctx.fillStyle = C.textFaint;
    ctx.font = `11px ${getSansFont()}`;
  } else {
    // 密度桶：每桶 3px 宽，统计桶内事件数
    const bucketW = DENSITY_BUCKET_W;
    const bucketCount = Math.ceil(chartW / bucketW);
    const buckets = new Int32Array(bucketCount);
    let inView = 0;
    for (const ev of events) {
      if (ev.ts < view.start || ev.ts > view.end) continue;
      const x = timeToX(ev.ts) - chartLeft;
      if (x < 0 || x >= chartW) continue;
      const idx = Math.min(bucketCount - 1, Math.floor(x / bucketW));
      buckets[idx]++;
      inView++;
    }
    // 深浅 = 相对常态速率的倍率（对数），常态为中间灰度；见 density.ts
    const expected = Math.max(1, inView / bucketCount);
    const barH = rowH * LAYOUT.EVENT_HEIGHT_RATIO;
    const barTop = rowY + (rowH - barH) / 2;
    for (let i = 0; i < bucketCount; i++) {
      const cnt = buckets[i];
      if (cnt === 0) continue;
      const bx = chartLeft + i * bucketW;
      ctx.fillStyle = withAlpha(group.color, densityAlpha(cnt, expected));
      ctx.fillRect(bx, barTop, bucketW - 0.5, barH);
    }
  }

  ctx.restore();

  // 选中/关联事件在折叠行上也标记（竖线高亮）
  ctx.save();
  ctx.beginPath();
  ctx.rect(chartLeft, rowY, chartW, rowH);
  ctx.clip();
  const drawMark = (id: number, color: string, w: number) => {
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    if (ev.ts < view.start || ev.ts > view.end) return;
    const x = timeToX(ev.ts);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, rowY + 2, w, rowH - 4);
  };
  if (selectedId !== null) drawMark(selectedId, C.selectedFill, 3.5);
  for (const cid of correlatedIds) {
    if (cid !== selectedId) drawMark(cid, withAlpha(group.color, 0.9), 2);
  }
  if (hoveredId !== null && hoveredId !== selectedId) {
    drawMark(hoveredId, withAlpha(group.color, 0.5), 2);
  }
  ctx.restore();

  // 行底线
  ctx.strokeStyle = C.trackBottom;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rowY + rowH + 0.5);
  ctx.lineTo(width, rowY + rowH + 0.5);
  ctx.stroke();
  ctx.restore();
}

// ---- 序列链（graph 关联）箭头连线 ----

/**
 * 绘制序列链跨 lane 箭头连线：
 * 链上相邻步事件之间（从上行 lane 的步事件到下行 lane 的步事件）画带箭头的连线。
 * 连线颜色 = group 色；同组多链用透明度与链号渐变区分。
 * 只有相邻步都落在「展开的 filter 行」上才画（折叠 density 行不画，避免歧义）。
 */
export function drawSequenceLinks(
  rc: RenderContext,
  rows: VisibleRow[],
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
) {
  const { ctx, view, timeToX, width } = rc;
  if (!sequenceResults || Object.keys(sequenceResults).length === 0) return;

  // filterId → 行 y/h（只统计展开 filter 行）
  const rowByFilter = new Map<string, { y: number; h: number }>();
  for (const row of rows) {
    if (row.kind === 'filter') {
      rowByFilter.set(row.filter.id, { y: row.y, h: row.height });
    }
  }

  ctx.save();
  ctx.lineCap = 'round';
  for (const group of groups) {
    const result = sequenceResults[group.id];
    if (!result || result.chains.length === 0) continue;
    if (group.visible === false) continue;

    const chains: MatchedChain[] = result.chains;
    // 链数过多时连线已是色块噪声（2 万条贝塞尔/帧也是显著开销），跳过绘制；
    // 放大使视口内链数降到阈值内后自动恢复
    if (chains.length > LAYOUT.SEQ_LINK_MAX_CHAINS) continue;
    const alphaBase = C.seqLinkAlpha;
    // 多链时降低单链透明度，避免重叠糊成一团
    const alpha = chains.length > 8 ? 0.35 : chains.length > 3 ? 0.5 : alphaBase;

    for (const chain of chains) {
      for (let i = 0; i + 1 < chain.steps.length; i++) {
        const a = chain.steps[i];
        const b = chain.steps[i + 1];
        const ra = rowByFilter.get(a.filterId);
        const rb = rowByFilter.get(b.filterId);
        if (!ra || !rb) continue;
        // 视口裁剪
        if (
          (a.event.ts < view.start && b.event.ts < view.start) ||
          (a.event.ts > view.end && b.event.ts > view.end)
        ) {
          continue;
        }
        const x1 = timeToX(a.event.ts);
        const x2 = timeToX(b.event.ts);
        if (Math.max(x1, x2) < LAYOUT.LEFT_LABEL_WIDTH || Math.min(x1, x2) > width) continue;
        const y1 = ra.y + ra.h / 2;
        const y2 = rb.y + rb.h / 2;

        // 垂直走向为主：从 a 事件点直接连到 b 事件点（水平+垂直二次贝塞尔）
        const mx = (x1 + x2) / 2;
        ctx.strokeStyle = withAlpha(group.color, alpha);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(mx, y1 + (y2 - y1) * 0.2, mx, (y1 + y2) / 2);
        ctx.quadraticCurveTo(mx, y2 - (y2 - y1) * 0.2, x2, y2);
        ctx.stroke();

        // 箭头：终点方向由贝塞尔末端切线决定（近似用 (x2-mx, y2-y2) 即水平入射）
        drawArrowHead(ctx, x2, y2, x2 >= mx ? 1 : -1, 0, group.color, alpha);
      }
    }
  }
  ctx.restore();
}

/**
 * 序列装饰层：NOT 违规红连线 + periodic 心跳标记。
 * - NOT 违规：A 事件与违规 B 事件间画红色短虚线（区别于链连线的组色实线）
 * - periodic：正常段画 lane 下划线（组色细线）；缺口在期望时刻画 ⚠ 红标记；抖动画 ⚡ 黄标记
 */
export function drawSequenceDecorations(
  rc: RenderContext,
  rows: VisibleRow[],
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
) {
  const { ctx, view, timeToX, width } = rc;
  if (!sequenceResults) return;

  const rowByFilter = new Map<string, { y: number; h: number }>();
  for (const row of rows) {
    if (row.kind === 'filter') rowByFilter.set(row.filter.id, { y: row.y, h: row.height });
  }

  ctx.save();
  for (const group of groups) {
    const r = sequenceResults[group.id];
    if (!r || group.visible === false) continue;

    // ---- NOT 违规：红色短虚线 from → to（行取边定义的 from/to filter）----
    for (const edge of group.sequence?.edges ?? []) {
      if ((edge.kind ?? 'seq') !== 'not') continue;
      const vs = r.notViolations.filter((v) => v.edgeId === edge.id);
      if (vs.length === 0) continue;
      const ra = rowByFilter.get(edge.fromFilterId);
      const rb = rowByFilter.get(edge.toFilterId);
      if (!ra || !rb) continue;
      for (const v of vs) {
        if (v.fromEvent.ts < view.start && v.toEvent.ts < view.start) continue;
        if (v.fromEvent.ts > view.end && v.toEvent.ts > view.end) continue;
        const x1 = timeToX(v.fromEvent.ts);
        const x2 = timeToX(v.toEvent.ts);
        if (Math.max(x1, x2) < LAYOUT.LEFT_LABEL_WIDTH || Math.min(x1, x2) > width) continue;
        const y1 = ra.y + ra.h / 2;
        const y2 = rb.y + rb.h / 2;
        ctx.strokeStyle = C.anomalyStroke;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        // B 事件上画 ×
        ctx.strokeStyle = C.anomalyStroke;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x2 - 4, y2 - 4);
        ctx.lineTo(x2 + 4, y2 + 4);
        ctx.moveTo(x2 - 4, y2 + 4);
        ctx.lineTo(x2 + 4, y2 - 4);
        ctx.stroke();
      }
    }

    // ---- periodic：段下划线 + 缺口 ⚠ + 抖动 ⚡ ----
    for (const hb of r.heartbeats) {
      const row = rowByFilter.get(hb.filterId);
      if (!row) continue;
      const yBase = row.y + row.h - 3;
      // 正常段下划线
      ctx.strokeStyle = withAlpha(group.color, 0.5);
      ctx.lineWidth = 2;
      for (const seg of hb.segments) {
        const x1 = timeToX(Math.max(seg.startTs, view.start));
        const x2 = timeToX(Math.min(seg.endTs, view.end));
        if (x2 < LAYOUT.LEFT_LABEL_WIDTH || x1 > width) continue;
        ctx.beginPath();
        ctx.moveTo(Math.max(x1, LAYOUT.LEFT_LABEL_WIDTH), yBase);
        ctx.lineTo(Math.min(x2, width), yBase);
        ctx.stroke();
      }
      // 缺口 ⚠（期望时刻）
      ctx.font = `600 11px ${getSansFont()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = C.anomalyFill;
      for (const gp of hb.gaps) {
        if (gp.expectedTs < view.start || gp.expectedTs > view.end) continue;
        const x = timeToX(gp.expectedTs);
        if (x < LAYOUT.LEFT_LABEL_WIDTH || x > width) continue;
        ctx.fillText('⚠', x, yBase);
      }
      // 抖动 ⚡（黄）
      ctx.fillStyle = C.corrStroke;
      for (const jt of hb.jitters) {
        if (jt.ts < view.start || jt.ts > view.end) continue;
        const x = timeToX(jt.ts);
        if (x < LAYOUT.LEFT_LABEL_WIDTH || x > width) continue;
        ctx.fillText('⚡', x, row.y + 10);
      }
    }
  }
  ctx.restore();
}

/** 画箭头头部（方向单位向量 dx,dy） */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: string,
  alpha: number,
) {
  const size = 6;
  // 垂直向量
  const px = -dy;
  const py = dx;
  ctx.fillStyle = withAlpha(color, Math.min(1, alpha + 0.15));
  ctx.beginPath();
  ctx.moveTo(x + dx * size, y + dy * size);
  ctx.lineTo(x + px * size * 0.55, y + py * size * 0.55);
  ctx.lineTo(x - px * size * 0.55, y - py * size * 0.55);
  ctx.closePath();
  ctx.fill();
}
