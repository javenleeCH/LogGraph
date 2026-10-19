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
  /** 子条件备注（与 pattern 的非空条件行按序对齐；纯 UI 元数据，不参与匹配） */
  subNotes?: string[];
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
  /** 串行序列关系配置；undefined=未配置（不参与匹配） */
  sequence?: SequenceConfig;
}

/** 过滤器与其匹配到的事件集合 */
export interface FilterMatch {
  filterId: string;
  /** 按 ts 升序排列的匹配事件 */
  events: LogEvent[];
}

// ===== 串行序列匹配（group 图关联）=====

/** 边类型（缺省 'seq'，v1 数据向后兼容） */
export type EdgeKind = 'seq' | 'not' | 'and' | 'or' | 'periodic' | 'opt';

/** 序列边：group 内 filter 间的时序约束 */
export interface SequenceEdge {
  id: string;
  fromFilterId: string;
  /** seq/not：单一目标；and/or：以 toFilterIds 为准（非空时优先） */
  toFilterId: string;
  /** and/or 专用：多目标列表 */
  toFilterIds?: string[];
  /** 边类型，缺省 'seq' */
  kind?: EdgeKind;
  /**
   * seq/not/and/or：目标须在 (tsA, tsA+maxGapMs] 内；
   * periodic：期望周期 P 的容差 δ（间隔 ∈ [P-δ, P+δ] 为正常）
   */
  maxGapMs: number;
  /** periodic 专用：期望周期毫秒 */
  periodMs?: number;
}

/** 节点循环次数约束（EPL A{min,max}） */
export interface NodeCount {
  min: number;
  max: number; // Infinity 用 Number.POSITIVE_INFINITY
}

/** group 的序列匹配配置（挂在 FilterGroup 上） */
export interface SequenceConfig {
  edges: SequenceEdge[];
  /** 异常开关：开启后未覆盖事件在视图中标红 */
  anomalyEnabled: boolean;
  /** 匹配作用域：global=全局时间轴（默认）；thread=按 thread 字段分桶隔离；
   * key=按关联键（用户正则从 raw 提取，如 traceId/requestId）分桶隔离 */
  scope?: 'global' | 'thread' | 'key';
  /** scope='key' 时的关联键正则（须含 1 个捕获组，从事件原文提取 traceId/requestId…）。
   * 缺省/无效/无捕获组 ⇒ 该组退化为全局（保守，不误分桶） */
  keyPattern?: string;
  /** 节点循环次数：filterId → [min,max]；缺省 [1,1]（EPL A{2,5}） */
  nodeCounts?: Record<string, NodeCount>;
  /** 节点条件表达式：filterId → 表达式串（对 filter 匹配事件二次过滤；空/缺省=不过滤） */
  nodeConditions?: Record<string, string>;
}

/** 一条完整匹配链（链上各步按时间序，与边一一对应） */
export interface MatchedChain {
  /** 递增链号（同一 group 内唯一，视图角标用） */
  chainIndex: number;
  /** 各步：第 0 步只有 filterId+event，后续步带进入它的边 */
  steps: { edgeId: string | null; filterId: string; event: LogEvent }[];
  startTs: number;
  endTs: number;
  /** 该链所属桶（scope='thread' 时的 thread 值；scope='key' 时的关联键；global 为 null） */
  thread?: string | null;
}

/** 单条边的命中统计 */
export interface SequenceEdgeStat {
  edgeId: string;
  /** 成功推进次数（作为某链中的一步被消耗） */
  matchedCount: number;
  /** 从源事件出发在窗口内找不到目标事件的断裂次数 */
  missCount: number;
  /** periodic 专用：间隔超期次数（心跳延迟/缺失） */
  lateCount?: number;
  /** periodic 专用：间隔过密次数（抖动） */
  jitterCount?: number;
}

/** NOT 边违规：A 的窗口内出现了禁止的 B */
export interface NotViolation {
  edgeId: string;
  /** 违规的源事件（A） */
  fromEvent: LogEvent;
  /** 违规目标事件（B） */
  toEvent: LogEvent;
}

/** period 心跳断言结果（一组连续心跳 + 异常） */
export interface HeartbeatGroup {
  filterId: string;
  thread?: string | null;
  /** 连续心跳段的 [startTs, endTs]（间隔均在容差内） */
  segments: { startTs: number; endTs: number }[];
  /** 异常缺口：期望心跳时刻附近无心跳 */
  gaps: { afterTs: number; expectedTs: number }[];
  /** 异常抖动：间隔 < P-δ 的相邻对 */
  jitters: { ts: number; interval: number }[];
}

/** group 的序列匹配结果 */
export interface SequenceMatchResult {
  groupId: string;
  /** 完整匹配链（按 startTs 升序；引擎 maxChains 截断时仅前 N 条） */
  chains: MatchedChain[];
  /** 未被任何链覆盖的组内事件（异常候选，SoA 紧凑回传全量）：
   *  ids[i]/ts[i] 为第 i 个，按 (ts, id) 升序。百万级异常下对象数组
   *  载荷 150MB+，平铺数字数组 ~65MB；db 模式引擎只回 id+ts。 */
  uncovered: { ids: number[]; ts: number[] };
  /** 未覆盖事件全文（仅 TS 回退引擎填充，量级 ≤30 万事件护栏）：
   *  GroupMatchesTab 全文显示/关键字过滤用；db 模式缺省，按需经事件流取 */
  uncoveredFull?: LogEvent[];
  /** 每条边命中统计 */
  edgeStats: SequenceEdgeStat[];
  /** NOT 边违规列表 */
  notViolations: NotViolation[];
  /** periodic 心跳断言（仅当组内有 periodic 边时非空） */
  heartbeats: HeartbeatGroup[];
  /** 完整链数（引擎 maxChains 截断时 ≠ chains.length；未截断时缺省= chains.length） */
  totalChains?: number;
  /** fid → [事件id, 链号]：截断时链列表不全，全量 lane 标记由此回传（未截断时缺省） */
  coveredMarks?: Record<string, [number, number][]>;
  /** thread 解析质量统计（无论 scope 是否 thread 都产出，缺省=旧数据/未统计） */
  threadStats?: ThreadStats;
  /** 关联键提取质量统计（仅 scope='key' 且正则可用时产出；缺省=未走 key 路径/旧数据） */
  keyStats?: KeyStats;
}

/**
 * `thread` 字段的解析质量统计——纯可观测性，不改变任何匹配语义。
 *
 * thread 是**位置启发式**产物（解析器只认紧跟时间戳的 `[...]`），绝大多数
 * 日志格式解析不出来：level 在前的 Spring Boot / Logback 两种主流 Java 格式
 * 即落空，行首 `[INFO]` 还会被误当成线程名。解析不出时所有事件落 `∅` 单桶，
 * `scope: 'thread'` 就**静默退化成全局**——行为保守，但用户会误以为在按线程
 * 隔离，从而相信那些跨线程串出来的伪链。
 *
 * 两个可直接判读的指纹：
 * - `withThread === 0` ⇒ 按线程作用域等同全局；
 * - `distinctThreads` 接近 `withThread` ⇒ 几乎每个事件一个桶 ⇒ 疑似把
 *   traceId / requestId 之类非线程字段当成了 thread（链被拆碎 → 全部漏报）。
 */
export interface ThreadStats {
  /** 参与本组匹配的事件总数（与分桶、未覆盖统计用的是同一批事件） */
  totalEvents: number;
  /** 其中解析出非空 thread 的事件数 */
  withThread: number;
  /** distinct thread 数（`∅` 桶不计入） */
  distinctThreads: number;
}

/**
 * `scope='key'` 的关联键提取质量统计——与 ThreadStats 同构，纯可观测性。
 *
 * 键来自用户正则（`keyPattern` 捕获组 1，从事件原文提取 traceId/requestId…），
 * 失效同样是静默的：正则没提取到键时该组已按全局跑（跨请求串伪链），键粒度过细时
 * 每事件一桶、链全凑不齐（零链=全部漏报）。仅 key 路径真实生效时产出。
 */
export interface KeyStats {
  /** 参与本组匹配的事件总数（与分桶用的是同一批事件） */
  totalEvents: number;
  /** 其中正则提取到非空关联键的事件数 */
  withKey: number;
  /** distinct 关联键数（未命中正则的事件不计入） */
  distinctKeys: number;
}

// ===== 节点画布（draw.io 风格区域式画布）=====

/** 节点画布上一个节点的位置与尺寸（世界坐标，非屏幕坐标） */
export interface NodePos {
  id: string; // filter id 或 group id
  kind: 'group' | 'filterItem';
  x: number;
  y: number;
  /** group 节点容器宽高（filterItem 可选，存了也兼容） */
  w?: number;
  h?: number;
}

// ===== 视图状态 =====

/** 可见时间范围（epoch 毫秒） */
export interface TimeRange {
  start: number;
  end: number;
}

/** 已保存的时间范围书签（时间线框选 / 手动保存，跨会话持久化） */
export interface SavedRange {
  id: string;
  name: string;
  start: number;
  end: number;
}

/** 时间线上的光标 / 游标位置 */
export interface ScrubberState {
  /** 当前游标时间戳，null 表示未激活 */
  ts: number | null;
}
