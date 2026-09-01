// ===== 核心数据模型 =====

/** 一条解析后的日志事件 */
export interface LogEvent {
  /** 行索引（从 0 开始，多文件合并后为全局行号） */
  id: number;
  /** 解析得到的时间戳（epoch 毫秒） */
  ts: number;
  /** 原始整行文本 */
  raw: string;
  /** 线程/组件标识，如 [Thread1]，可空 */
  thread?: string;
  /** 日志级别，如 INFO/WARN/ERROR，可空 */
  level?: string;
  /** 时间戳之后的正文部分 */
  message: string;
  /** 来源文件名（多文件合并时标记出处） */
  sourceFile?: string;
}

/** 用户定义的过滤器 */
export interface Filter {
  id: string;
  label: string;
  /** 16 进制颜色，如 #4ea2ff */
  color: string;
  /** 用户输入的搜索词或正则表达式 */
  pattern: string;
  /** 是否当作正则表达式匹配 */
  isRegex: boolean;
  /** 是否区分大小写 */
  caseSensitive: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 匹配字段范围：完整行 raw，或正文 message */
  scope: 'raw' | 'message';
  /** 所属 group id；null 或 undefined=未分组（顶层） */
  groupId?: string | null;
}

/** 用户定义的过滤器分组（类比 Perfetto 进程） */
export interface FilterGroup {
  id: string;
  label: string;
  /** 16 进制颜色，如 #4ea2ff */
  color: string;
  /** 是否折叠（折叠=合并成一行密度热力条） */
  collapsed: boolean;
  /** 是否显示（false 时整组及其子 filter 在所有视图隐藏） */
  visible: boolean;
  /** 组内 filter 引用列表（多对多：一个 filter 可属于多个 group） */
  filterIds: string[];
}

/** 过滤器与其匹配到的事件集合 */
export interface FilterMatch {
  filterId: string;
  /** 按 ts 升序排列的匹配事件 */
  events: LogEvent[];
}

// ===== 视图状态 =====

/** 可见时间范围（epoch 毫秒） */
export interface TimeRange {
  start: number;
  end: number;
}

/** 时间线上的光标 / 游标位置 */
export interface ScrubberState {
  /** 当前游标时间戳，null 表示未激活 */
  ts: number | null;
}
