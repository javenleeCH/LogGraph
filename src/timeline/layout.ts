/** 时间线画布布局常量（对齐 CSS 变量） */

import type { Filter, FilterGroup, FilterMatch, LogEvent } from '../types';

export const LAYOUT = {
  /** 左侧 track 标题列宽 */
  LEFT_LABEL_WIDTH: 200,
  /** 顶部时间轴标尺高度 */
  AXIS_HEIGHT: 28,
  /** 单条 lane 高度 */
  LANE_HEIGHT: 40,
  /** lane 之间的间距 */
  LANE_GAP: 1,
  /** 底部 minimap 高度 */
  MINIMAP_HEIGHT: 44,
  /** minimap 与 lanes 之间的间距 */
  MINIMAP_GAP: 8,
  /** 事件标记最小宽度（像素） */
  EVENT_MIN_WIDTH: 2,
  /** 事件标记高度占 lane 的比例 */
  EVENT_HEIGHT_RATIO: 0.6,
  /** group 标题行高度（折叠/展开共用，比 filter 行矮） */
  GROUP_HEADER_HEIGHT: 28,
  /** group 折叠态密度热力条行高 */
  GROUP_DENSITY_HEIGHT: 40,
  /** filter lane 密度模式阈值：可见事件超过此数改画桶聚合密度柱
   *  （逐标记 fillRect 在十万级事件下每帧数百 ms，WASD 卡顿的根因） */
  DENSITY_EVENT_THRESHOLD: 4000,
  /** 序列链连线绘制上限：链数超过后连线已是色块噪声，跳过绘制
   *  （group 头部仍显示链数；放大到阈值内恢复连线） */
  SEQ_LINK_MAX_CHAINS: 1000,
};

/** 判断 Y 坐标是否落在轴区域 */
export function isInAxis(y: number): boolean {
  return y >= 0 && y < LAYOUT.AXIS_HEIGHT;
}

/** lanes 区域起始 Y（轴之后） */
export function lanesTop(): number {
  return LAYOUT.AXIS_HEIGHT;
}

// ---- 可见行模型（group 折叠/展开后的行列表） ----

/** 一行可见内容，带类型与 y 偏移/高度，统一驱动渲染与命中测试 */
export type VisibleRow =
  | {
      kind: 'group-header';
      group: FilterGroup;
      childCount: number;
      y: number;
      height: number;
    }
  | {
      kind: 'filter';
      filter: Filter;
      match: FilterMatch | undefined;
      y: number;
      height: number;
    }
  | {
      kind: 'group-density';
      group: FilterGroup;
      events: LogEvent[];
      y: number;
      height: number;
    };

/**
 * 根据 filters + groups 构建可见行列表（含 y 偏移与高度）。
 *
 * 顺序：
 * 1. 按 groups 数组顺序，每个 group 先一个 header 行
 * 2. collapsed → 再一个 group-density 行（聚合组内各 filter 匹配事件）
 * 3. 展开 → 各 child filter 行（按 filters 数组中的顺序）
 * 4. 顶层无 group 的 filter 行（groupId 为 null/undefined）
 */
export function buildVisibleRows(
  filters: Filter[],
  groups: FilterGroup[],
  matches: FilterMatch[],
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const laneH = LAYOUT.LANE_HEIGHT + LAYOUT.LANE_GAP;
  const headerH = LAYOUT.GROUP_HEADER_HEIGHT + LAYOUT.LANE_GAP;
  const densityH = LAYOUT.GROUP_DENSITY_HEIGHT + LAYOUT.LANE_GAP;
  let y = LAYOUT.AXIS_HEIGHT;

  const findMatch = (fid: string) => matches.find((m) => m.filterId === fid);

  // 预计算：所有 group（含隐藏）引用的 filter id 集合
  // → 隐藏组独占的 filter 不回流到顶层，实现"真隐藏"
  const referencedByAnyGroup = new Set<string>();
  for (const g of groups) {
    for (const fid of g.filterIds) referencedByAnyGroup.add(fid);
  }

  // 1. 按 groups 顺序（visible===false 的整组跳过）
  for (const g of groups) {
    if (g.visible === false) continue;
    // 多对多：按 g.filterIds 顺序找子 filter（跳过已删除的）
    const childFilters = g.filterIds
      .map((fid) => filters.find((f) => f.id === fid))
      .filter((f): f is Filter => !!f);
    // header 行
    rows.push({
      kind: 'group-header',
      group: g,
      childCount: childFilters.length,
      y,
      height: LAYOUT.GROUP_HEADER_HEIGHT,
    });
    y += headerH;

    if (g.collapsed) {
      // 折叠：聚合组内所有 filter 的事件为一行密度热力条
      // 注：逐个 push（不要 spread——百万级元素会栈溢出），且各列已按 ts 升序
      const merged: LogEvent[] = [];
      for (const cf of childFilters) {
        const fm = findMatch(cf.id);
        if (fm) for (const ev of fm.events) merged.push(ev);
      }
      // 按 ts 升序（合并各列已有序事件）
      merged.sort((a, b) => a.ts - b.ts);
      rows.push({
        kind: 'group-density',
        group: g,
        events: merged,
        y,
        height: LAYOUT.GROUP_DENSITY_HEIGHT,
      });
      y += densityH;
    } else {
      // 展开：各 child filter 一行
      for (const cf of childFilters) {
        rows.push({
          kind: 'filter',
          filter: cf,
          match: findMatch(cf.id),
          y,
          height: LAYOUT.LANE_HEIGHT,
        });
        y += laneH;
      }
    }
  }

  // 2. 顶层 filter = 不被任何 group 引用的 filter
  const topFilters = filters.filter((f) => !referencedByAnyGroup.has(f.id));
  for (const cf of topFilters) {
    rows.push({
      kind: 'filter',
      filter: cf,
      match: findMatch(cf.id),
      y,
      height: LAYOUT.LANE_HEIGHT,
    });
    y += laneH;
  }

  return rows;
}

/** 可见行的总高度（lanes 区域，含 group header / density / filter） */
export function visibleRowsHeight(rows: VisibleRow[]): number {
  if (rows.length === 0) return 0;
  const last = rows[rows.length - 1];
  return last.y + last.height - LAYOUT.AXIS_HEIGHT;
}
