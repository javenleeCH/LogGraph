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
  readVar,
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

  // ---- 渲染 ----
  // 稳定的渲染函数：每帧从 store 实时读取最新状态，避免闭包陈旧值
  // 且无依赖，RAF 循环只订阅一次，拖拽时不会反复取消/重建。
  const renderRef = useRef<() => void>(() => {});
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
    } = st;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!viewRange || !fullRange) {
      ctx.fillStyle = readVar('--text-faint', '#80868b');
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('打开日志文件并添加过滤器以开始', w / 2, h / 2);
      return;
    }

    const { timeToX, xToTime } = makeTimeFns(viewRange, w);

    // 构建可见行（group 折叠/展开后的行列表）
    const rows = buildVisibleRows(filters, groups, matches);

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

    // 遍历可见行绘制（group-header / filter / group-density）
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === 'group-header') {
        drawGroupHeader(
          rc,
          row.group,
          row.y,
          row.height,
          row.childCount,
          i === hoveredRowIdx,
        );
      } else if (row.kind === 'group-density') {
        drawGroupDensity(
          rc,
          row.group,
          row.events,
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
        drawLaneEventsAt(
          rc,
          row.filter,
          row.y,
          row.height,
          evs,
          selectedEventId,
          hoveredEventId,
          correlatedEventIds,
        );
      }
    }

    const centerTs =
      selectedEventId !== null
        ? events.find((e) => e.id === selectedEventId)?.ts ?? null
        : scrubberTs;
    drawCorrelationLinks(rc, filters, matches, centerTs, selectedEventId);

    drawScrubber(rc, scrubberTs);

    drawMinimap(rc, fullRange, viewRange, matches, filters);
  };
  const render = useCallback(() => renderRef.current(), []);

  // ---- 尺寸观察 + RAF ----
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
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    const loop = () => {
      render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [render]);

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
    [animator, viewRange, fullRange, makeTimeFns, inMinimap, panBy, setViewRange, setScrubber, setHovered, hitTest],
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
