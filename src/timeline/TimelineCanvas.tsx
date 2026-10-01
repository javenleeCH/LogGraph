import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import {
  LAYOUT,
  buildVisibleRows,
  type VisibleRow,
} from './layout';
import {
  drawAxis,
  drawLaneBackgroundAt,
  drawLaneEventsAt,
  drawCorrelationLinks,
  drawScrubber,
  drawMinimap,
  drawGroupHeader,
  drawGroupDensity,
  drawSequenceLinks,
  drawSequenceDecorations,
  readVar,
  refreshPalette,
  type RenderContext,
} from './renderers';
import { bisectLeft, nearestEvent } from './correlation';
import { ZoomPanAnimator } from './zoomPanAnimator';
import { formatDateTime } from '../utils/timeFormat';
import type { Filter, LogEvent, TimeRange } from '../types';
import tipStyles from './Tooltip.module.css';

interface DragState {
  mode: 'none' | 'pan' | 'scrubber' | 'minimap' | 'brush';
  startX: number;
  startY: number;
  /** pan 时记录起始 view */
  startView: TimeRange | null;
  /** minimap 拖拽时记录起始 view */
  startMinimapView: TimeRange | null;
}

/** 单个 filter 的序列链渲染数据（memo 产物，见 chainDataMapRef） */
interface ChainData {
  chainIds: Set<number>;
  chainColor: string;
  chainIndexOf: (id: number) => number | null;
  anomalyIds: Set<number> | null;
  violationIds: Set<number>;
  jitterTs: Set<number>;
}

export function TimelineCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>({
    mode: 'none',
    startX: 0,
    startY: 0,
    startView: null,
    startMinimapView: null,
  });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const [hoveredFilter, setHoveredFilter] = useState<Filter | null>(null);

  // store 订阅
  const events = useLogStore((s) => s.events);
  const filters = useLogStore((s) => s.filters);
  const matches = useLogStore((s) => s.matches);
  const groups = useLogStore((s) => s.groups);
  const viewRange = useLogStore((s) => s.viewRange);
  const fullRange = useLogStore((s) => s.fullRange);
  const hoveredEventId = useLogStore((s) => s.hoveredEventId);

  const setViewRange = useLogStore((s) => s.setViewRange);
  const zoomTo = useLogStore((s) => s.zoomTo);
  const panBy = useLogStore((s) => s.panBy);
  const zoomByRatio = useLogStore((s) => s.zoomByRatio);
  const panByPx = useLogStore((s) => s.panByPx);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const setHovered = useLogStore((s) => s.setHovered);
  const setScrubber = useLogStore((s) => s.setScrubber);
  const toggleGroupCollapsed = useLogStore((s) => s.toggleGroupCollapsed);

  // ---- WASD 平滑缩放/平移动画器（Perfetto 式弹簧+加速）----
  // 回调实时读取 store 状态与画布尺寸，避免闭包陈旧。
  const animator = useMemo(
    () =>
      new ZoomPanAnimator({
        onPanned: (movedPx) => {
          const chartW = sizeRef.current.w - LAYOUT.LEFT_LABEL_WIDTH;
          if (chartW <= 0) return;
          panByPx(movedPx, chartW);
        },
        onZoomed: (mouseX, ratioDelta) => {
          const st = useLogStore.getState();
          if (!st.viewRange || !st.fullRange) return;
          const w = sizeRef.current.w;
          const chartLeft = LAYOUT.LEFT_LABEL_WIDTH;
          const chartW = w - chartLeft;
          const span = st.viewRange.end - st.viewRange.start || 1;
          const centerTs =
            st.viewRange.start + ((mouseX - chartLeft) / chartW) * span;
          zoomByRatio(centerTs, ratioDelta);
        },
      }),
    [panByPx, zoomByRatio],
  );
  useEffect(() => () => animator.dispose(), [animator]);

  // ---- 坐标换算 ----
  const makeTimeFns = useCallback(
    (view: TimeRange, w: number) => {
      const chartLeft = LAYOUT.LEFT_LABEL_WIDTH;
      const chartW = w - chartLeft;
      const span = view.end - view.start || 1;
      const timeToX = (t: number) =>
        chartLeft + ((t - view.start) / span) * chartW;
      const xToTime = (x: number) =>
        view.start + ((x - chartLeft) / chartW) * span;
      return { timeToX, xToTime };
    },
    [],
  );

  // ---- 渲染（脏标记：状态变化才重绘，静止时 0 CPU） ----
  // 渲染函数实时读 store（避免闭包陈旧）；调度由「标脏 + 单帧 RAF」驱动，
  // 不再用每帧循环（百万事件全量遍历会卡死主线程）。
  const renderRef = useRef<() => void>(() => {});
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const scheduleRender = useCallback(() => {
    if (rafRef.current) return; // 已排队
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      renderRef.current();
    });
  }, []);
  renderRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    if (w === 0 || h === 0) return;

    // 实时读取最新 store 状态
    const st = useLogStore.getState();
    const {
      events,
      filters,
      matches,
      groups,
      viewRange,
      fullRange,
      selectedEventId,
      hoveredEventId,
      scrubberTs,
      correlatedEventIds,
      sequenceResults,
    } = st;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 每帧重读 CSS 变量色板（主题切换 / CSS 注入时序）
    refreshPalette();
    ctx.clearRect(0, 0, w, h);
    // 填满画布背景，避免轨道下方出现透明黑框
    ctx.fillStyle = readVar('--bg-canvas', '#0b0e14');
    ctx.fillRect(0, 0, w, h);

    if (!viewRange || !fullRange) {
      ctx.fillStyle = readVar('--text-faint', '#80868b');
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('打开日志文件并添加过滤器以开始', w / 2, h / 2);
      return;
    }

    const { timeToX, xToTime } = makeTimeFns(viewRange, w);

    // 构建可见行（group 折叠/展开后的行列表；rowsMemo 已按 filters/groups/matches memo，
    // 但渲染需与 store 实时状态一致 → 直接从最新 state 构建（行数少，开销可忽略））
    const rows = buildVisibleRows(filters, groups, matches);

    // 视口二分：各 lane 的匹配事件已按 ts 升序 → 只取 [view.start, view.end] 子数组
    const visibleSlice = (evs: LogEvent[]): LogEvent[] => {
      if (evs.length === 0) return evs;
      let lo = bisectLeft(evs, viewRange.start);
      if (lo > 0) lo -= 1; // 左扩一个，保证边缘标记完整
      let hi = lo;
      const n = evs.length;
      while (hi < n && evs[hi].ts <= viewRange.end) hi++;
      return hi > lo ? evs.slice(lo, hi) : [];
    };

    // 计算当前鼠标悬停在哪一行（用于行高亮）
    const myMouse = mousePosRef.current?.y ?? null;
    let hoveredRowIdx = -1;
    if (myMouse !== null) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (myMouse >= r.y && myMouse < r.y + r.height) {
          hoveredRowIdx = i;
          break;
        }
      }
    }

    const rc: RenderContext = {
      ctx,
      width: w,
      height: h,
      view: viewRange,
      timeToX,
      xToTime,
      mouseRowY: myMouse,
    };

    drawAxis(rc, fullRange);

    // 序列链数据已 memo（chainDataMapRef），渲染时直接查表（见组件级 useMemo）
    const chainDataOf = (fid: string) => chainDataMapRef.current.get(fid) ?? null;

    // 遍历可见行绘制（group-header / filter / group-density）
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === 'group-header') {
        const sr = sequenceResults[row.group.id];
        drawGroupHeader(
          rc,
          row.group,
          row.y,
          row.height,
          row.childCount,
          i === hoveredRowIdx,
          sr
            ? {
                chains: sr.chains.length,
                anomalies: sr.uncoveredEvents.length,
                anomalyEnabled: row.group.sequence?.anomalyEnabled ?? false,
              }
            : null,
        );
      } else if (row.kind === 'group-density') {
        drawGroupDensity(
          rc,
          row.group,
          visibleSlice(row.events), // 视口二分：密度条也只统计可见窗口
          row.y,
          row.height,
          selectedEventId,
          hoveredEventId,
          correlatedEventIds,
        );
      } else {
        // filter 行：保持原有绘制逻辑，但 index 用行序映射 y
        const evs = row.match?.events ?? [];
        drawLaneBackgroundAt(
          rc,
          row.filter,
          row.y,
          row.height,
          evs.length,
          i === hoveredRowIdx,
        );
        const cd = chainDataOf(row.filter.id);
        drawLaneEventsAt(
          rc,
          row.filter,
          row.y,
          row.height,
          visibleSlice(evs), // 视口二分：只绘制可见窗口内事件
          selectedEventId,
          hoveredEventId,
          correlatedEventIds,
          cd?.chainIds ?? null,
          cd?.anomalyIds ?? null,
          cd?.chainColor ?? null,
          cd?.chainIndexOf ?? null,
          cd?.violationIds ?? null,
          cd?.jitterTs ?? null,
        );
      }
    }

    // 序列链跨 lane 箭头连线（在事件之上、游标之下）
    drawSequenceLinks(rc, rows, groups, sequenceResults);
    // NOT 违规红线 + periodic 段/缺口/抖动标记
    drawSequenceDecorations(rc, rows, groups, sequenceResults);

    const centerTs =
      selectedEventId !== null
        ? events.find((e) => e.id === selectedEventId)?.ts ?? null
        : scrubberTs;
    drawCorrelationLinks(rc, filters, matches, centerTs, selectedEventId);

    drawScrubber(rc, scrubberTs);

    drawMinimap(rc, fullRange, viewRange, matches, filters, minimapCacheRef.current);
  };

  // 尺寸变化 → 失效 minimap 缓存（下一帧由 useMemo key 重建）
  const invalidateMinimap = useCallback(() => {
    minimapCacheRef.current = null;
  }, []);

  // ---- 尺寸观察 + 脏标记渲染调度 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      invalidateMinimap();
      dirtyRef.current = true;
      scheduleRender();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        // 必须复位：React.StrictMode（dev）会"挂载→清理→重挂"，清理时 cancel 掉
        // 已排队的 RAF 后若不复位，scheduleRender 会永远误判"已排队"→ 画布空白。
        rafRef.current = 0;
      }
    };
  }, [scheduleRender, invalidateMinimap]);

  // 任何相关 store 状态变化 → 标脏重绘（替代每帧全量 RAF 循环）
  useEffect(() => {
    const unsub = useLogStore.subscribe(() => {
      dirtyRef.current = true;
      scheduleRender();
    });
    // 挂载时先绘一次
    dirtyRef.current = true;
    scheduleRender();
    return unsub;
  }, [scheduleRender]);

  // 鼠标位置（行高亮/tooltips 走 React state，不进 store 订阅）由事件处理器直接标脏
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  // ---- 序列链数据 memo（原 chainDataOf 每帧重建 Set/Map，百万链时是帧率杀手） ----
  const chainDataMapRef = useRef<Map<string, ChainData>>(new Map());
  const seqGroupsForChain = useLogStore((s) => s.groups);
  const seqResultsForChain = useLogStore((s) => s.sequenceResults);
  useMemo(() => {
    const m = new Map<string, ChainData>();
    for (const g of seqGroupsForChain) {
      const r = seqResultsForChain[g.id];
      if (!r) continue;
      // NOT 违规事件（from 与 to 都标红）：组内共享
      const violationIds = new Set<number>();
      for (const v of r.notViolations) {
        violationIds.add(v.fromEvent.id);
        violationIds.add(v.toEvent.id);
      }
      for (const fid of g.filterIds) {
        const chainIds = new Set<number>();
        const chainIdx = new Map<number, number>();
        for (const ch of r.chains) {
          for (const stp of ch.steps) {
            if (stp.filterId !== fid) continue;
            chainIds.add(stp.event.id);
            if (!chainIdx.has(stp.event.id)) chainIdx.set(stp.event.id, ch.chainIndex);
          }
        }
        const anomalyIds = g.sequence?.anomalyEnabled
          ? new Set(r.uncoveredEvents.map((u) => u.id))
          : null;
        // periodic 抖动事件（黄框，按 ts 存）
        const jitterIds = new Set<number>();
        for (const hb of r.heartbeats) {
          if (hb.filterId !== fid) continue;
          for (const jt of hb.jitters) jitterIds.add(jt.ts);
        }
        m.set(fid, {
          chainIds,
          chainColor: g.color,
          chainIndexOf: (id: number) => chainIdx.get(id) ?? null,
          anomalyIds,
          violationIds,
          jitterTs: jitterIds,
        });
      }
    }
    chainDataMapRef.current = m;
  }, [seqGroupsForChain, seqResultsForChain]);

  // ---- minimap 离屏预渲染（直方图只依赖 matches/filters/fullRange/宽度，重算时才重建） ----
  const minimapCacheRef = useRef<{
    canvas: HTMLCanvasElement;
    key: string;
  } | null>(null);
  const minimapMatches = useLogStore((s) => s.matches);
  const minimapFilters = useLogStore((s) => s.filters);
  const minimapFullRange = useLogStore((s) => s.fullRange);
  useMemo(() => {
    const { w, dpr } = sizeRef.current;
    if (!minimapFullRange || w === 0) return;
    const key = [
      minimapMatches.map((m) => `${m.filterId}:${m.events.length}`).join('|'),
      minimapFilters.map((f) => `${f.id}:${f.color}`).join('|'),
      minimapFullRange.start,
      minimapFullRange.end,
      w,
    ].join('#');
    if (minimapCacheRef.current?.key === key) return;
    const left = LAYOUT.LEFT_LABEL_WIDTH;
    const cw = w - left;
    if (cw <= 0) return;
    // 预渲染到物理像素位图（画时直接 drawImage，静止时零重算）
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(cw * dpr));
    off.height = Math.floor(LAYOUT.MINIMAP_HEIGHT * dpr);
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const span = minimapFullRange.end - minimapFullRange.start || 1;
    for (let i = 0; i < minimapMatches.length; i++) {
      const fm = minimapMatches[i];
      const color = minimapFilters.find((f) => f.id === fm.filterId)?.color ?? '#888';
      const bandTop = 6 + (i % 4) * 8;
      octx.fillStyle = color;
      for (const ev of fm.events) {
        const x = Math.floor(((ev.ts - minimapFullRange.start) / span) * cw);
        octx.fillRect(x, bandTop, 1, 7);
      }
    }
    minimapCacheRef.current = { canvas: off, key };
    // 重建后需要重绘一帧（useMemo 无渲染副作用）
    dirtyRef.current = true;
    scheduleRender();
  }, [minimapMatches, minimapFilters, minimapFullRange, scheduleRender]);

  // ---- 命中测试：根据鼠标位置找到 visibleRow 内最近事件 ----
  const rowsMemo = useMemo(
    () => buildVisibleRows(filters, groups, matches),
    [filters, groups, matches],
  );

  /** 找到鼠标 y 落在哪一行（返回 VisibleRow 或 null） */
  const rowAt = useCallback(
    (my: number): VisibleRow | null => {
      for (const r of rowsMemo) {
        if (my >= r.y && my < r.y + r.height) return r;
      }
      return null;
    },
    [rowsMemo],
  );

  const hitTest = useCallback(
    (mx: number, my: number): { event: LogEvent; filter: Filter } | null => {
      if (!viewRange) return null;
      const { w } = sizeRef.current;
      const { xToTime } = makeTimeFns(viewRange, w);
      if (my < LAYOUT.AXIS_HEIGHT) return null;
      if (mx < LAYOUT.LEFT_LABEL_WIDTH) return null;

      const row = rowAt(my);
      if (!row) return null;
      // group-header 行无事件
      if (row.kind === 'group-header') return null;

      let evs: LogEvent[] = [];
      let filter: Filter | null = null;
      if (row.kind === 'filter') {
        evs = row.match?.events ?? [];
        filter = row.filter;
      } else {
        // group-density 行：聚合事件，filter 用组内第一个子 filter 近似
        evs = row.events;
        const child = filters.find((f) => f.groupId === row.group.id);
        if (child) filter = child;
      }
      if (!filter || evs.length === 0) return null;

      const targetTs = xToTime(mx);
      const ev = nearestEvent(evs, targetTs);
      if (!ev) return null;

      // 容差：像素距离换算
      const span = viewRange.end - viewRange.start || 1;
      const chartW = w - LAYOUT.LEFT_LABEL_WIDTH;
      const pxToMs = span / chartW;
      if (Math.abs(ev.ts - targetTs) > pxToMs * 6) return null;
      return { event: ev, filter };
    },
    [viewRange, filters, rowAt, makeTimeFns],
  );

  // 判断是否在 minimap 区域
  const inMinimap = useCallback((my: number): boolean => {
    const { h } = sizeRef.current;
    return my >= h - LAYOUT.MINIMAP_HEIGHT;
  }, []);

  // ---- 鼠标事件 ----
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!viewRange || !fullRange) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { w } = sizeRef.current;
      const { xToTime } = makeTimeFns(viewRange, w);

      if (inMinimap(my)) {
        // minimap 拖拽：移动视图使点击位置成为视图中心
        const span = fullRange.end - fullRange.start || 1;
        const tRatio = (mx - LAYOUT.LEFT_LABEL_WIDTH) / (w - LAYOUT.LEFT_LABEL_WIDTH);
        const clickT = fullRange.start + tRatio * span;
        const viewSpan = viewRange.end - viewRange.start;
        let start = clickT - viewSpan / 2;
        let end = clickT + viewSpan / 2;
        if (start < fullRange.start) {
          start = fullRange.start;
          end = start + viewSpan;
        }
        if (end > fullRange.end) {
          end = fullRange.end;
          start = end - viewSpan;
        }
        setViewRange({ start, end });
        dragRef.current = {
          mode: 'minimap',
          startX: mx,
          startY: my,
          startView: { start, end },
          startMinimapView: null,
        };
        return;
      }

      // 轴区域：设为游标
      if (my < LAYOUT.AXIS_HEIGHT && mx >= LAYOUT.LEFT_LABEL_WIDTH) {
        const ts = xToTime(mx);
        setScrubber(ts, true);
        selectEvent(null);
        dragRef.current = {
          mode: 'scrubber',
          startX: mx,
          startY: my,
          startView: null,
          startMinimapView: null,
        };
        return;
      }

      // group-header 行点击：折叠/展开
      const row = rowAt(my);
      if (row && row.kind === 'group-header') {
        toggleGroupCollapsed(row.group.id);
        return;
      }

      // lane 区域：命中测试
      const hit = hitTest(mx, my);
      if (hit) {
        selectEvent(hit.event.id);
        return;
      }

      // 否则：pan
      dragRef.current = {
        mode: 'pan',
        startX: mx,
        startY: my,
        startView: { ...viewRange },
        startMinimapView: null,
      };
    },
    [
      viewRange,
      fullRange,
      makeTimeFns,
      inMinimap,
      setViewRange,
      setScrubber,
      selectEvent,
      hitTest,
      rowAt,
      toggleGroupCollapsed,
    ],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!viewRange) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { w } = sizeRef.current;
      const { xToTime } = makeTimeFns(viewRange, w);
      const drag = dragRef.current;

      if (drag.mode === 'scrubber') {
        const ts = xToTime(mx);
        setScrubber(ts, true);
        return;
      }

      if (drag.mode === 'pan' && drag.startView && fullRange) {
        const span = drag.startView.end - drag.startView.start;
        const chartW = w - LAYOUT.LEFT_LABEL_WIDTH;
        const dxMs = (-(mx - drag.startX) / chartW) * span;
        panBy(dxMs);
        dragRef.current.startX = mx;
        dragRef.current.startView = useLogStore.getState().viewRange;
        return;
      }

      if (drag.mode === 'minimap' && fullRange) {
        const span = fullRange.end - fullRange.start || 1;
        const tRatio = (mx - LAYOUT.LEFT_LABEL_WIDTH) / (w - LAYOUT.LEFT_LABEL_WIDTH);
        const clickT = fullRange.start + tRatio * span;
        const viewSpan = viewRange.end - viewRange.start;
        let start = clickT - viewSpan / 2;
        let end = clickT + viewSpan / 2;
        if (start < fullRange.start) {
          start = fullRange.start;
          end = start + viewSpan;
        }
        if (end > fullRange.end) {
          end = fullRange.end;
          start = end - viewSpan;
        }
        setViewRange({ start, end });
        return;
      }

      // 记录鼠标位置，供 WASD 以鼠标为中心缩放 / 悬停行高亮
      animator.onMouseMove(mx);
      mousePosRef.current = { x: mx, y: my };
      markDirty(); // 行高亮随鼠标 y 变化 → 重绘
      // 悬停命中
      const hit = hitTest(mx, my);
      setHovered(hit ? hit.event.id : null);
      setHoveredFilter(hit ? hit.filter : null);
      setMousePos(hit ? { x: mx, y: my } : null);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = hit
          ? 'pointer'
          : my < LAYOUT.AXIS_HEIGHT
            ? 'ew-resize'
            : inMinimap(my)
              ? 'move'
              : 'grab';
      }
    },
    [animator, viewRange, fullRange, makeTimeFns, inMinimap, panBy, setViewRange, setScrubber, setHovered, hitTest, markDirty],
  );

  const onMouseUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag.mode === 'scrubber') {
      setScrubber(useLogStore.getState().scrubberTs, false);
    }
    dragRef.current = {
      mode: 'none',
      startX: 0,
      startY: 0,
      startView: null,
      startMinimapView: null,
    };
  }, [setScrubber]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!viewRange) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const { w } = sizeRef.current;
      const { xToTime } = makeTimeFns(viewRange, w);
      const centerTs = xToTime(mx);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      zoomTo(centerTs, factor);
    },
    [viewRange, makeTimeFns, zoomTo],
  );

  const onMouseLeave = useCallback(() => {
    setHovered(null);
    setHoveredFilter(null);
    setMousePos(null);
    mousePosRef.current = null;
    animator.onMouseLeave();
    const drag = dragRef.current;
    if (drag.mode === 'scrubber') {
      setScrubber(useLogStore.getState().scrubberTs, false);
    }
    dragRef.current = {
      mode: 'none',
      startX: 0,
      startY: 0,
      startView: null,
      startMinimapView: null,
    };
  }, [animator, setHovered, setScrubber]);

  // 键盘快捷键（与 Perfetto 一致，弹簧式平滑缩放/平移）：
  //  W / S —— 以鼠标所在 X 为中心放大 / 缩小（持续按住会加速，松手缓出）
  //  A / D —— 向左 / 向右平移（持续按住会加速，松手缓出）
  //  ← / →  —— 在选中 lane 内前后跳转事件
  //  Esc   —— 取消选中 / 清除游标
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => animator.onKeyDown(e);
    const onKeyUp = (e: KeyboardEvent) => animator.onKeyUp(e);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [animator]);

  // 方向键 / Esc：事件跳转与取消选中
  useEffect(() => {
    const onNavKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'arrowleft' && key !== 'arrowright' && key !== 'escape') return;
      const st = useLogStore.getState();
      if (!st.viewRange || !st.fullRange) return;

      // 方向键：在选中 lane 内前后跳转事件
      if (st.selectedEventId !== null) {
        const owningMatch = st.matches.find((m) =>
          m.events.some((ev) => ev.id === st.selectedEventId),
        );
        if (!owningMatch) {
          if (key === 'escape') selectEvent(null);
          return;
        }
        const idx = owningMatch.events.findIndex((ev) => ev.id === st.selectedEventId);
        if (idx < 0) return;
        if (e.key === 'ArrowRight' && idx < owningMatch.events.length - 1) {
          selectEvent(owningMatch.events[idx + 1].id);
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          selectEvent(owningMatch.events[idx - 1].id);
          e.preventDefault();
        } else if (key === 'escape') {
          selectEvent(null);
        }
      } else if (key === 'escape') {
        // 无选中时 Esc 清除游标
        st.setScrubber(null, false);
      }
    };
    window.addEventListener('keydown', onNavKey);
    return () => window.removeEventListener('keydown', onNavKey);
  }, [selectEvent]);

  // 自动滚动详情面板到选中行由 DetailPanel 自身处理（DOM 滚动）

  // 悬停事件（用于 tooltip）
  const hoveredEvent =
    hoveredEventId !== null
      ? events.find((e) => e.id === hoveredEventId)
      : undefined;

  return (
    <div ref={containerRef} style={{ flex: '1 1 auto', position: 'relative', minWidth: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onWheel={onWheel}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      {hoveredEvent && mousePos && hoveredFilter && (
        <div
          className={tipStyles.tooltip}
          style={{
            left: Math.min(mousePos.x + 14, sizeRef.current.w - 320),
            top: Math.max(4, mousePos.y - 12),
          }}
        >
          <div className={tipStyles['tip-head']}>
            <span
              className={tipStyles['tip-dot']}
              style={{ background: hoveredFilter.color }}
            />
            <span className={tipStyles['tip-ts']}>
              {formatDateTime(hoveredEvent.ts)}
            </span>
            {hoveredEvent.thread && (
              <span className={tipStyles['tip-meta']}>{hoveredEvent.thread}</span>
            )}
            {hoveredEvent.level && (
              <span className={tipStyles['tip-meta']}>{hoveredEvent.level}</span>
            )}
            <span className={tipStyles['tip-meta']}>#{hoveredEvent.id + 1}</span>
          </div>
          <div className={tipStyles['tip-msg']}>{hoveredEvent.message}</div>
        </div>
      )}
    </div>
  );
}

// 占位：bisectLeft 在组件内未直接使用，但保留导出便于测试
export { bisectLeft };
