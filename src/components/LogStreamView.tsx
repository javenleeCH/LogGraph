import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLogStore } from '../store/logStore';
import { bisectLeft } from '../timeline/correlation';
import { formatTime, formatDuration, chooseTickStep } from '../utils/timeFormat';
import type { LogEvent } from '../types';
import styles from './LogStreamView.module.css';

const CARD_H = 20; // 单个事件卡片高度
const ROW_PAD = 4; // 行内上下留白
const TIME_COL_WIDTH = 104; // 左侧时间列宽
const MIN_LANE_WIDTH = 120; // 每列最小宽度
const GLOBAL_TICK_H = 80; // 全局模式：每个刻度最小高度
const GLOBAL_CASCADE = 16; // 全局模式：同时间事件级联偏移（略小于卡片高，形成层叠）
const DENSITY_BUCKET_H = 3; // 全局模式密度桶高度（px）
const DENSITY_CARD_THRESHOLD = 3; // 桶内事件数超过此值则只显示密度、不显示卡片

const LEVEL_COLOR: Record<string, string> = {
  ERROR: '#cc4125',
  FATAL: '#cc4125',
  CRITICAL: '#cc4125',
  WARN: '#ed8526',
  WARNING: '#ed8526',
  INFO: '#1c66d4',
  DEBUG: '#1b9949',
  TRACE: '#8e44ad',
};

/** hex 颜色 -> [r, g, b] */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const num = parseInt(n, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

interface RowData {
  ts: number;
  /** 各列在该时间戳的事件数（用于计算行高） */
  counts: number[];
  /** 行高 = max(counts) * CARD_H + 2*ROW_PAD */
  height: number;
  /** 行顶部 Y = 之前所有行高之和 */
  top: number;
}

interface TickMark {
  ts: number;
  y: number;
}

/**
 * 从所有匹配项的事件中收集去重时间戳（升序），并按列分组。
 */
function buildRows(
  matches: { filterId: string; events: LogEvent[] }[],
  viewRange: { start: number; end: number } | null,
): { rows: RowData[]; laneEvents: LogEvent[][] } {
  if (!viewRange || matches.length === 0) {
    return { rows: [], laneEvents: matches.map(() => []) };
  }
  // 收集每个 lane 在 viewRange 内的事件
  const laneEvents: LogEvent[][] = matches.map((fm) => {
    const evs = fm.events;
    const s = bisectLeft(evs, viewRange.start);
    const e = bisectLeft(evs, viewRange.end);
    return evs.slice(s, e);
  });
  // 收集去重时间戳
  const tsSet = new Set<number>();
  for (const le of laneEvents) {
    for (const ev of le) tsSet.add(ev.ts);
  }
  const tsList = Array.from(tsSet).sort((a, b) => a - b);
  // 每个 lane 的事件按 ts 建索引（因可能同 ts 多事件，用 Map<ts, LogEvent[]>）
  const laneByTs: Map<number, LogEvent[]>[] = laneEvents.map((le) => {
    const m = new Map<number, LogEvent[]>();
    for (const ev of le) {
      let arr = m.get(ev.ts);
      if (!arr) {
        arr = [];
        m.set(ev.ts, arr);
      }
      arr.push(ev);
    }
    return m;
  });
  // 构建行
  const rows: RowData[] = [];
  let top = 0;
  for (const ts of tsList) {
    const counts = laneByTs.map((m) => m.get(ts)?.length ?? 0);
    const maxCount = Math.max(1, ...counts);
    const height = maxCount * CARD_H + ROW_PAD * 2;
    rows.push({ ts, counts, height, top });
    top += height;
  }
  return { rows, laneEvents };
}

type ViewMode = 'aligned' | 'independent' | 'global';

const MODE_LABEL: Record<ViewMode, string> = {
  aligned: '对齐',
  independent: '独立',
  global: '全局',
};

export function LogStreamView() {
  const viewRange = useLogStore((s) => s.viewRange);
  const fullRange = useLogStore((s) => s.fullRange);
  const matches = useLogStore((s) => s.matches);
  const filters = useLogStore((s) => s.filters);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const correlatedEventIds = useLogStore((s) => s.correlatedEventIds);
  const hoveredEventId = useLogStore((s) => s.hoveredEventId);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const setHovered = useLogStore((s) => s.setHovered);
  const resetView = useLogStore((s) => s.resetView);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  // 时间轴模式：aligned=按事件时间戳对齐；independent=各列独立；global=固定刻度时间尺
  const [mode, setMode] = useState<ViewMode>('aligned');

  const { rows, laneEvents } = useMemo(
    () => buildRows(matches, viewRange),
    [matches, viewRange],
  );

  const totalHeight =
    rows.length > 0 ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;

  // 列宽：按比例数组控制，各列之间可拖拽
  const measureRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(800);
  const [colRatios, setColRatios] = useState<number[]>([]);
  // 过滤器数量变化时重置为等分
  useEffect(() => {
    setColRatios((prev) => {
      const n = filters.length;
      if (prev.length === n) return prev;
      return new Array(n).fill(1 / Math.max(1, n));
    });
  }, [filters.length]);
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setAvailW(Math.max(0, el.clientWidth - TIME_COL_WIDTH));
      setViewportH(el.clientHeight);
    });
    ro.observe(el);
    setAvailW(Math.max(0, el.clientWidth - TIME_COL_WIDTH));
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // 实际各列像素宽（保底最小宽度）
  const colWidths = useMemo(() => {
    const n = filters.length;
    if (n === 0) return [];
    const total = availW;
    const ratios = colRatios.length === n ? colRatios : new Array(n).fill(1 / n);
    const sum = ratios.reduce((a, b) => a + b, 0) || 1;
    const raw = ratios.map((r) => (r / sum) * total);
    const clamped = raw.map((w) => Math.max(MIN_LANE_WIDTH, w));
    // 修正总和误差：最后一列吸收
    const diff = total - clamped.reduce((a, b) => a + b, 0);
    if (clamped.length > 0)
      clamped[clamped.length - 1] = Math.max(
        MIN_LANE_WIDTH,
        clamped[clamped.length - 1] + diff,
      );
    return clamped;
  }, [colRatios, availW, filters.length]);

  // 列间拖拽：拖动第 i 与 i+1 列之间的分隔条
  const colDrag = useRef<{ idx: number; startX: number; startRatios: number[] } | null>(null);
  const onColResizeDown = useCallback(
    (idx: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      colDrag.current = { idx, startX: e.clientX, startRatios: [...colRatios] };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [colRatios],
  );
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = colDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const total = availW || 1;
      const deltaRatio = dx / total;
      const ratios = [...d.startRatios];
      const i = d.idx;
      if (i + 1 >= ratios.length) return;
      const sum = ratios[i] + ratios[i + 1];
      let a = ratios[i] + deltaRatio;
      let b = sum - a;
      const minRatio = MIN_LANE_WIDTH / total;
      if (a < minRatio) {
        a = minRatio;
        b = sum - a;
      }
      if (b < minRatio) {
        b = minRatio;
        a = sum - b;
      }
      ratios[i] = a;
      ratios[i + 1] = b;
      setColRatios(ratios);
    };
    const onUp = () => {
      if (colDrag.current) {
        colDrag.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [availW]);

  // 对齐模式：虚拟化按行前缀和二分定位可见行
  const overscan = 6;
  const visibleRows = useMemo(() => {
    if (rows.length === 0) return [];
    const minTop = scrollTop - overscan * 2 * CARD_H;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].top < minTop) lo = mid + 1;
      else hi = mid;
    }
    let i = Math.max(0, lo - 1);
    i = Math.max(0, i - overscan);
    const out: RowData[] = [];
    for (; i < rows.length; i++) {
      out.push(rows[i]);
      if (rows[i].top > scrollTop + viewportH + overscan * 2 * CARD_H) break;
    }
    return out;
  }, [rows, scrollTop, viewportH]);

  // 全局模式：固定刻度时间尺，事件按真实时间戳线性映射到 Y
  const globalData = useMemo(() => {
    if (mode !== 'global' || !viewRange) return null;
    const spanMs = viewRange.end - viewRange.start;
    if (spanMs <= 0) return null;
    const tickStep = chooseTickStep(spanMs, 8);
    const tickCount = Math.ceil(spanMs / tickStep) + 1;
    const totalH = Math.max(viewportH, tickCount * GLOBAL_TICK_H);
    const pxPerMs = totalH / spanMs;
    const ticks: TickMark[] = [];
    const first = Math.ceil(viewRange.start / tickStep) * tickStep;
    for (let t = first; t <= viewRange.end; t += tickStep) {
      ticks.push({ ts: t, y: (t - viewRange.start) * pxPerMs });
    }
    return { tickStep, pxPerMs, totalH, ticks };
  }, [mode, viewRange, viewportH]);

  // WASD 快捷键：W/S 缩放时间窗，A/D 平移时间窗
  // WASD 滚动：W/S 上下滚动（同滚轮），A/D 左右滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (!['w', 's', 'a', 'd'].includes(key)) return;
      const el = scrollRef.current;
      if (!el) return;
      e.preventDefault();
      const step = e.shiftKey ? el.clientHeight * 0.8 : 60;
      const hStep = e.shiftKey ? el.clientWidth * 0.6 : 80;
      if (key === 'w') {
        el.scrollBy({ top: -step, behavior: 'auto' });
      } else if (key === 's') {
        el.scrollBy({ top: step, behavior: 'auto' });
      } else if (key === 'a') {
        el.scrollBy({ left: -hStep, behavior: 'auto' });
      } else if (key === 'd') {
        el.scrollBy({ left: hStep, behavior: 'auto' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 选中事件自动滚动
  const lastScrollTarget = useRef<number | null>(null);
  useEffect(() => {
    if (selectedEventId === null) {
      lastScrollTarget.current = null;
      return;
    }
    if (lastScrollTarget.current === selectedEventId) return;
    const el = scrollRef.current;
    if (!el) return;

    // 全局模式：按事件真实 ts 定位
    if (mode === 'global' && viewRange && globalData) {
      let targetTs: number | null = null;
      for (const le of laneEvents) {
        const ev = le.find((e) => e.id === selectedEventId);
        if (ev) {
          targetTs = ev.ts;
          break;
        }
      }
      if (targetTs === null) return;
      const y = (targetTs - viewRange.start) * globalData.pxPerMs;
      if (y < el.scrollTop || y > el.scrollTop + el.clientHeight) {
        el.scrollTo({ top: y - el.clientHeight / 3, behavior: 'smooth' });
      }
      lastScrollTarget.current = selectedEventId;
      return;
    }

    // 对齐模式：按行定位
    let targetRow: RowData | undefined;
    for (const r of rows) {
      for (let li = 0; li < laneEvents.length; li++) {
        if (laneEvents[li].some((e) => e.id === selectedEventId && e.ts === r.ts)) {
          targetRow = r;
          break;
        }
      }
      if (targetRow) break;
    }
    if (!targetRow) return;
    const y = targetRow.top;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: y - el.clientHeight / 3, behavior: 'smooth' });
    }
    lastScrollTarget.current = selectedEventId;
  }, [selectedEventId, rows, laneEvents, mode, viewRange, globalData]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // 每个 lane 按 ts 分组（供对齐模式渲染）
  const laneByTs = useMemo(() => {
    return laneEvents.map((le) => {
      const m = new Map<number, LogEvent[]>();
      for (const ev of le) {
        let arr = m.get(ev.ts);
        if (!arr) {
          arr = [];
          m.set(ev.ts, arr);
        }
        arr.push(ev);
      }
      return m;
    });
  }, [laneEvents]);

  if (!viewRange || !fullRange) {
    return (
      <div ref={measureRef} className={styles.empty}>
        打开日志文件并添加过滤器以开始
      </div>
    );
  }

  if (filters.length === 0) {
    return (
      <div ref={measureRef} className={styles.empty}>
        请先添加过滤器，每列对应一个过滤器的匹配结果
      </div>
    );
  }

  const showTimeCol = mode !== 'independent';

  /** 渲染列间竖向 resizer（在第 i 与 i+1 列之间） */
  const renderColResizer = (i: number) => {
    if (i >= filters.length - 1) return null;
    return (
      <div
        key={'rs' + i}
        className={styles.colResizer}
        onMouseDown={(e) => onColResizeDown(i, e)}
        title="拖拽调节列宽"
      />
    );
  };

  return (
    <div ref={measureRef} className={styles.wrap}>
      {/* 顶栏 */}
      <div className={styles.header}>
        <span className={styles.headerLabel}>纵轴视图</span>
        <span className={styles.headerInfo}>
          {formatTime(viewRange.start)} → {formatTime(viewRange.end)}
        </span>
        <span className={styles.headerDivider}>|</span>
        <span className={styles.headerInfo}>窗宽 {formatDuration(viewRange.end - viewRange.start)}</span>
        <span className={styles.headerDivider}>|</span>
        <span className={styles.headerInfo}>
          {mode === 'global'
            ? `${globalData?.ticks.length ?? 0} 刻度 · ${filters.length} 列`
            : `${rows.length} 个时间点 · ${filters.length} 列`}
        </span>
        <span className={styles.spacer} />
        <span className={styles.hint} title="W/S 缩放时间窗，A/D 平移时间窗">WASD</span>
        <div
          className={styles.modeSwitch}
          title="时间轴模式：对齐=按事件时间戳分行对齐；独立=各列自由排列无时间轴；全局=固定刻度时间尺，按密度着色"
        >
          {(['aligned', 'independent', 'global'] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={styles.modeBtn + (mode === m ? ' ' + styles.modeBtnActive : '')}
              onClick={() => setMode(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <button className="ghost" onClick={resetView} title="重置为全量">
          全量
        </button>
      </div>

      {/* 列头 */}
      <div className={styles.columnHeader}>
        {showTimeCol && (
          <div className={styles.timeColHeader} style={{ width: TIME_COL_WIDTH }}>
            时间
          </div>
        )}
        {filters.map((f, li) => (
          <Fragment key={f.id}>
            <div
              className={styles.laneHeader}
              style={{ width: colWidths[li] ?? MIN_LANE_WIDTH, borderLeftColor: f.color }}
            >
              <span className={styles.laneDot} style={{ background: f.color }} />
              <span className={styles.laneTitle}>{f.label}</span>
              <span className={styles.lanePattern}>{f.pattern || '（空）'}</span>
            </div>
            {renderColResizer(li)}
          </Fragment>
        ))}
      </div>

      {/* 主体 */}
      <div ref={scrollRef} className={styles.body} onScroll={onScroll}>
        {mode === 'global' && globalData ? (
          /* —— 全局时间轴模式：固定刻度时间尺，密度热力 + 稀疏时卡片 —— */
          <div className={styles.gridInner} style={{ height: globalData.totalH }}>
            <div className={styles.timeCol} style={{ width: TIME_COL_WIDTH }}>
              {globalData.ticks
                .filter((t) => t.y >= scrollTop - 40 && t.y <= scrollTop + viewportH + 40)
                .map((t) => (
                  <div
                    key={t.ts}
                    className={styles.tickRow}
                    style={{ top: t.y, height: 'auto' }}
                  >
                    <span className={styles.tickLabel}>{formatTime(t.ts)}</span>
                    <span className={styles.tickLine} />
                  </div>
                ))}
              {globalData.ticks.length === 0 && (
                <div className={styles.emptyMsg}>当前时间窗内无刻度</div>
              )}
            </div>

            {filters.map((f, li) => (
              <Fragment key={f.id}>
                <GlobalLane
                  color={f.color}
                  width={colWidths[li] ?? MIN_LANE_WIDTH}
                  events={laneEvents[li] ?? []}
                  viewRange={viewRange}
                  pxPerMs={globalData.pxPerMs}
                  ticks={globalData.ticks}
                  scrollTop={scrollTop}
                  viewportH={viewportH}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
                {renderColResizer(li)}
              </Fragment>
            ))}
          </div>
        ) : mode === 'aligned' ? (
          /* —— 对齐模式：按时间戳并集分行，各列同时间行顶部对齐 —— */
          <div className={styles.gridInner} style={{ height: totalHeight }}>
            <div className={styles.timeCol} style={{ width: TIME_COL_WIDTH }}>
              {visibleRows.map((r) => (
                <div
                  key={r.ts}
                  className={styles.tickRow}
                  style={{ top: r.top, height: r.height }}
                >
                  <span className={styles.tickLabel}>{formatTime(r.ts)}</span>
                  <span className={styles.tickLine} />
                </div>
              ))}
              {visibleRows.length === 0 && (
                <div className={styles.emptyMsg}>当前时间窗内无匹配事件</div>
              )}
            </div>

            {filters.map((f, li) => (
              <Fragment key={f.id}>
                <LaneColumn
                  color={f.color}
                  width={colWidths[li] ?? MIN_LANE_WIDTH}
                  visibleRows={visibleRows}
                  laneByTs={laneByTs[li] ?? new Map()}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
                {renderColResizer(li)}
              </Fragment>
            ))}
          </div>
        ) : (
          /* —— 独立模式：各列各自从上到下顺序排列，不按时间对齐 —— */
          <div className={styles.gridInner}>
            {filters.map((f, li) => (
              <Fragment key={f.id}>
                <LaneStream
                  color={f.color}
                  width={colWidths[li] ?? MIN_LANE_WIDTH}
                  events={laneEvents[li] ?? []}
                  scrollTop={scrollTop}
                  viewportH={viewportH}
                  selectedEventId={selectedEventId}
                  hoveredEventId={hoveredEventId}
                  correlatedEventIds={correlatedEventIds}
                  onSelect={selectEvent}
                  onHover={setHovered}
                />
                {renderColResizer(li)}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 全局时间轴模式：密度热力条（按过滤器色着色、深浅=事件密度）+ 稀疏时叠加卡片 */
interface GlobalLaneProps {
  color: string;
  width: number;
  events: LogEvent[];
  viewRange: { start: number; end: number };
  pxPerMs: number;
  ticks: TickMark[];
  scrollTop: number;
  viewportH: number;
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function GlobalLane({
  color,
  width,
  events,
  viewRange,
  pxPerMs,
  ticks,
  scrollTop,
  viewportH,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  onSelect,
  onHover,
}: GlobalLaneProps) {
  const rgb = useMemo(() => hexToRgb(color), [color]);
  const overscan = 60;
  const yTop = Math.max(0, scrollTop - overscan);
  const yBot = scrollTop + viewportH + overscan;
  const bucketCount = Math.max(0, Math.ceil((yBot - yTop) / DENSITY_BUCKET_H));

  // 密度桶：统计每个纵向像素桶内的事件数
  const { buckets, maxCount } = useMemo(() => {
    const arr = new Array(bucketCount).fill(0);
    const tsTop = viewRange.start + yTop / pxPerMs;
    const tsBot = viewRange.start + yBot / pxPerMs;
    let s = bisectLeft(events, tsTop);
    if (s > 0) s -= 1;
    const e = bisectLeft(events, tsBot) + 1;
    for (let i = Math.max(0, s); i < Math.min(events.length, e); i++) {
      const ev = events[i];
      const y = (ev.ts - viewRange.start) * pxPerMs;
      let bi = Math.floor((y - yTop) / DENSITY_BUCKET_H);
      if (bi < 0) bi = 0;
      else if (bi >= bucketCount) bi = bucketCount - 1;
      arr[bi]++;
    }
    let mx = 1;
    for (const c of arr) if (c > mx) mx = c;
    return { buckets: arr, maxCount: mx };
  }, [events, viewRange, pxPerMs, yTop, yBot, bucketCount]);

  // 稀疏时才叠加独立卡片
  const dense = maxCount > DENSITY_CARD_THRESHOLD;
  const tsTop = viewRange.start + yTop / pxPerMs;
  const tsBot = viewRange.start + yBot / pxPerMs;
  let sIdx = bisectLeft(events, tsTop);
  if (sIdx > 0) sIdx -= 1;
  const eIdx = Math.min(events.length, bisectLeft(events, tsBot) + 1);
  const visibleCards = dense ? [] : events.slice(Math.max(0, sIdx), eIdx);

  // 可见刻度参考线
  const guideTicks = ticks.filter((t) => t.y >= yTop && t.y <= yBot);

  // 选中事件所在桶（高亮）
  let selBucket = -1;
  if (selectedEventId !== null) {
    for (let i = Math.max(0, sIdx); i < Math.min(events.length, eIdx); i++) {
      if (events[i].id === selectedEventId) {
        const y = (events[i].ts - viewRange.start) * pxPerMs;
        selBucket = Math.floor((y - yTop) / DENSITY_BUCKET_H);
        break;
      }
    }
  }

  return (
    <div
      className={styles.lane}
      style={{ width, borderLeftColor: color }}
      onMouseLeave={() => onHover(null)}
    >
      {/* 刻度横向参考线 */}
      {guideTicks.map((t) => (
        <div key={'g' + t.ts} className={styles.guideLine} style={{ top: t.y }} />
      ))}

      {/* 密度热力条：始终渲染，颜色深浅=事件密度，色调=过滤器色 */}
      {buckets.map((c, i) => {
        if (c === 0) return null;
        const alpha = Math.min(0.18 + (c / maxCount) * 0.77, 0.95);
        const isSel = i === selBucket;
        return (
          <div
            key={i}
            className={styles.densityBar + (isSel ? ' ' + styles.densityBarSel : '')}
            style={{
              top: yTop + i * DENSITY_BUCKET_H,
              height: DENSITY_BUCKET_H,
              background: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`,
            }}
            title={`${c} 条事件`}
            onClick={() => {
              // 点击桶：选中该桶内第一个事件
              const by = yTop + i * DENSITY_BUCKET_H;
              const btsTop = viewRange.start + by / pxPerMs;
              const idx = bisectLeft(events, btsTop);
              if (idx < events.length) onSelect(events[idx].id);
            }}
          />
        );
      })}

      {/* 稀疏时叠加独立卡片 */}
      {visibleCards.map((ev) => {
        const y = (ev.ts - viewRange.start) * pxPerMs;
        const idx = 0; // 稀疏时同时间事件极少，不做级联
        const cascade = idx * GLOBAL_CASCADE;
        const isSel = ev.id === selectedEventId;
        const isHover = ev.id === hoveredEventId;
        const isCorr = correlatedEventIds.has(ev.id);
        const levelColor = ev.level ? LEVEL_COLOR[ev.level.toUpperCase()] : undefined;
        const evStyle = {
          top: y + cascade,
          '--ev-border': levelColor ?? color,
        } as React.CSSProperties;
        return (
          <div
            key={ev.id}
            className={[
              styles.globalEvent,
              isSel ? styles.globalEventSel : '',
              isHover ? styles.globalEventHover : '',
              isCorr ? styles.globalEventCorr : '',
            ].join(' ')}
            style={evStyle}
            onClick={() => onSelect(ev.id)}
            onMouseEnter={() => onHover(ev.id)}
          >
            {levelColor && (
              <span className={styles.eventLevel} style={{ background: levelColor }}>
                {ev.level}
              </span>
            )}
            <span className={styles.eventRaw} title={ev.raw}>
              {ev.raw}
            </span>
          </div>
        );
      })}

      {maxCount <= 1 && visibleCards.length === 0 && (
        <div className={styles.emptyMsg}>无匹配</div>
      )}
    </div>
  );
}

/** 独立列模式：不按时间对齐，各列自己顺序排列（带虚拟化） */
interface LaneStreamProps {
  color: string;
  width: number;
  events: LogEvent[];
  scrollTop: number;
  viewportH: number;
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function LaneStream({
  color,
  width,
  events,
  scrollTop,
  viewportH,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  onSelect,
  onHover,
}: LaneStreamProps) {
  const cardH = CARD_H + 2;
  const overscan = 8;
  const startIdx = Math.max(0, Math.floor(scrollTop / cardH) - overscan);
  const count = Math.ceil(viewportH / cardH) + overscan * 2;
  const endIdx = Math.min(events.length, startIdx + count);
  const visible = events.slice(startIdx, endIdx);
  const topPad = startIdx * cardH;
  const bottomPad = (events.length - endIdx) * cardH;
  return (
    <div
      className={styles.lane}
      style={{ width, borderLeftColor: color, position: 'relative' }}
      onMouseLeave={() => onHover(null)}
    >
      <div style={{ height: topPad }} />
      {visible.map((ev) => {
        const isSel = ev.id === selectedEventId;
        const isHover = ev.id === hoveredEventId;
        const isCorr = correlatedEventIds.has(ev.id);
        const levelColor = ev.level ? LEVEL_COLOR[ev.level.toUpperCase()] : undefined;
        return (
          <div
            key={ev.id}
            className={[
              styles.event,
              isSel ? styles.eventSel : '',
              isHover ? styles.eventHover : '',
              isCorr ? styles.eventCorr : '',
            ].join(' ')}
            style={{ height: CARD_H - 2 }}
            onClick={() => onSelect(ev.id)}
            onMouseEnter={() => onHover(ev.id)}
          >
            {levelColor && (
              <span className={styles.eventLevel} style={{ background: levelColor }}>
                {ev.level}
              </span>
            )}
            <span className={styles.eventTs}>{formatTime(ev.ts)}</span>
            <span className={styles.eventRaw} title={ev.raw}>
              {ev.raw}
            </span>
          </div>
        );
      })}
      {visible.length === 0 && <div className={styles.emptyMsg}>无匹配</div>}
      <div style={{ height: bottomPad }} />
    </div>
  );
}

interface LaneColumnProps {
  color: string;
  width: number;
  visibleRows: RowData[];
  laneByTs: Map<number, LogEvent[]>;
  selectedEventId: number | null;
  hoveredEventId: number | null;
  correlatedEventIds: Set<number>;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}

function LaneColumn({
  color,
  width,
  visibleRows,
  laneByTs,
  selectedEventId,
  hoveredEventId,
  correlatedEventIds,
  onSelect,
  onHover,
}: LaneColumnProps) {
  return (
    <div
      className={styles.lane}
      style={{ width, borderLeftColor: color }}
      onMouseLeave={() => onHover(null)}
    >
      {/* 行背景 + 事件 */}
      {visibleRows.map((r) => {
        const evs = laneByTs.get(r.ts) ?? [];
        return (
          <div
            key={r.ts}
            className={styles.laneRow}
            style={{ top: r.top, height: r.height }}
          >
            <div className={styles.laneRowBg + (visibleRows.indexOf(r) % 2 ? ' ' + styles.laneRowAlt : '')} />
            <div className={styles.eventStack}>
              {evs.map((ev) => {
                const isSel = ev.id === selectedEventId;
                const isHover = ev.id === hoveredEventId;
                const isCorr = correlatedEventIds.has(ev.id);
                const levelColor = ev.level ? LEVEL_COLOR[ev.level.toUpperCase()] : undefined;
                return (
                  <div
                    key={ev.id}
                    className={[
                      styles.event,
                      isSel ? styles.eventSel : '',
                      isHover ? styles.eventHover : '',
                      isCorr ? styles.eventCorr : '',
                    ].join(' ')}
                    style={{ height: CARD_H - 2 }}
                    onClick={() => onSelect(ev.id)}
                    onMouseEnter={() => onHover(ev.id)}
                  >
                    {levelColor && (
                      <span className={styles.eventLevel} style={{ background: levelColor }}>
                        {ev.level}
                      </span>
                    )}
                    <span className={styles.eventTs}>{formatTime(ev.ts)}</span>
                    <span className={styles.eventRaw} title={ev.raw}>
                      {ev.raw}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
