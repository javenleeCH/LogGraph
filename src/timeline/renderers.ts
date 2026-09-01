/**
 * Canvas 绘制函数（浅色主题，Perfetto 风格）：
 * 轴网格、lane、事件、minimap、关联连线。
 * 纯函数式，不持有状态，由 TimelineCanvas 调用。
 */

import type { Filter, FilterMatch, LogEvent, TimeRange } from '../types';
import { LAYOUT } from './layout';
import { chooseTickStep, formatTime, formatDateTime } from '../utils/timeFormat';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: TimeRange;
  timeToX: (t: number) => number;
  xToTime: (x: number) => number;
  mouseRowY: number | null;
}

// 浅色主题调色板（硬编码，避免与 CSS 变量耦合）
const C = {
  axisBg: '#f1f3f4',
  headerColBg: '#ffffff',
  trackAlt: '#f8f9fa',
  trackEven: '#f1f3f4',
  trackHover: '#e8f0fe',
  headerBorder: '#dadce0',
  text: '#202124',
  textDim: '#5f6368',
  textFaint: '#9aa0a6',
  tickLine: '#9aa0a6',
  gridLine: 'rgba(60,64,67,0.08)',
  trackBottom: '#e8eaed',
  selectedFill: '#202124',
  corrStroke: '#e37400',
  scrubberStroke: 'rgba(26,115,232,0.5)',
  scrubberBubble: '#1a73e8',
  minimapBg: '#f8f9fa',
  minimapBorder: '#dadce0',
  minimapViewFill: 'rgba(26,115,232,0.12)',
  minimapViewStroke: '#1a73e8',
  corrLink: 'rgba(233,116,0,0.45)',
  tooltipBg: '#ffffff',
  tooltipBorder: '#dadce0',
};

// ---- 颜色工具 ----
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

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
      ctx.strokeStyle = C.corrStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(xOff - 1, eventY - 1, w + 2, eventH + 2);
    }
  }
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

/** 绘制 minimap */
export function drawMinimap(
  rc: RenderContext,
  fullRange: TimeRange,
  view: TimeRange,
  matches: FilterMatch[],
  filters: Filter[],
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

  for (let i = 0; i < matches.length; i++) {
    const fm = matches[i];
    const color = filters.find((f) => f.id === fm.filterId)?.color ?? '#888';
    const bandTop = top + 6 + (i % 4) * 8;
    ctx.fillStyle = withAlpha(color, 0.9);
    for (const ev of fm.events) {
      const x = tToX(ev.ts);
      ctx.fillRect(x, bandTop, 1, 7);
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
