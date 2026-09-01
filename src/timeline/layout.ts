/** 时间线画布布局常量（对齐 CSS 变量） */

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
};

/** 判断 Y 坐标是否落在轴区域 */
export function isInAxis(y: number): boolean {
  return y >= 0 && y < LAYOUT.AXIS_HEIGHT;
}

/** lanes 区域起始 Y（轴之后） */
export function lanesTop(): number {
  return LAYOUT.AXIS_HEIGHT;
}
