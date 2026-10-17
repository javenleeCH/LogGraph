/**
 * CEP 规则模板库（P1⑥：把最高价值功能门槛削平）
 *
 * 用户常见故障模式 → 可一键生成的规则脚手架。每条模板会：
 *   1) 为每个节点创建「建议过滤器」（带占位匹配模式，用户需改成自己日志里的真实模式）
 *   2) 创建分组并把节点挂上去
 *   3) 按模板连线（含边类型 / 时间窗 / 周期 / 循环次数 / 条件表达式）
 *   4) 按需开启异常开关
 *
 * 之后用户在过滤器详情里把 pattern 改成真实日志文本即可复用。
 * 这是「引导式创建」的最小可用形态：从命令面板 ⌘K → 「规则模板」组选一条即可。
 */

import type { EdgeKind } from '../types';
import { useLogStore } from '../store/logStore';
import { notify } from '../store/uiStore';

/** 单个模板节点（对应一个过滤器） */
export interface TemplateNode {
  /** 显示名 → 过滤器 label */
  label: string;
  /** 建议匹配模式（占位，用户需改） */
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  scope: 'raw' | 'message';
  /** 循环次数 [min,max]（EPL A{min,max}，可选） */
  count?: [number, number];
  /** 条件表达式（nodeConditions，可选） */
  condition?: string;
}

/** 模板边（节点下标 from/to → 实际创建时映射成 filterId） */
export interface TemplateEdge {
  from: number;
  to: number;
  kind: EdgeKind;
  maxGapMs: number;
  periodMs?: number;
  /** and/or 多目标（节点下标列表） */
  toFilterIds?: number[];
}

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  /** 创建后该组是否开启异常（未覆盖事件标红） */
  anomalyEnabled: boolean;
  scope?: 'global' | 'thread';
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

const FILTER_COLORS = ['#4ea2ff', '#f59e0b', '#22c55e', '#ef4444', '#a855f7', '#14b8a6'];

/**
 * 从模板一键创建规则脚手架。
 * 返回新创建的分组 id（供 UI 选中 / 聚焦）。
 */
export function createGroupFromTemplate(tpl: RuleTemplate): string {
  const store = useLogStore.getState();
  const groupId = store.addGroup({ label: tpl.name });
  const filterIds: string[] = [];

  tpl.nodes.forEach((n, i) => {
    const fid = store.addFilter({
      label: n.label,
      pattern: n.pattern,
      isRegex: n.isRegex,
      caseSensitive: n.caseSensitive,
      scope: n.scope,
      color: FILTER_COLORS[i % FILTER_COLORS.length],
      enabled: true,
    });
    filterIds.push(fid);
    store.addFilterToGroup(fid, groupId);
  });

  if (tpl.scope) store.setSequenceScope(groupId, tpl.scope);

  tpl.edges.forEach((e) => {
    const from = filterIds[e.from];
    const to = filterIds[e.to];
    store.addSequenceEdge(groupId, from, to, e.maxGapMs, {
      kind: e.kind,
      periodMs: e.periodMs,
      toFilterIds: e.toFilterIds?.map((i) => filterIds[i]),
    });
  });

  // 节点循环次数 / 条件表达式
  tpl.nodes.forEach((n, i) => {
    if (n.count) store.setNodeCount(groupId, filterIds[i], { min: n.count[0], max: n.count[1] });
    if (n.condition) store.setNodeCondition(groupId, filterIds[i], n.condition);
  });

  // 异常开关（toggle 是翻转语义，确保最终为开）
  if (tpl.anomalyEnabled) {
    const g = useLogStore.getState().groups.find((x) => x.id === groupId);
    if (!g?.sequence?.anomalyEnabled) useLogStore.getState().toggleSequenceAnomaly(groupId);
  }

  notify(`已创建规则「${tpl.name}」`, {
    kind: 'success',
    detail: `含 ${tpl.nodes.length} 个建议过滤器，请在过滤器详情里改成你的真实匹配模式`,
  });
  return groupId;
}

/** 内置模板库 */
export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'timeout',
    name: '超时未响应',
    description: '请求发起后 N 毫秒内未收到响应，即判定为超时（标红）。未覆盖的「发起」事件即超时。',
    anomalyEnabled: true,
    nodes: [
      {
        label: '请求发起',
        pattern: 'request sent|发起请求|send req',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
      {
        label: '响应返回',
        pattern: 'response received|响应返回|request done',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
    ],
    edges: [{ from: 0, to: 1, kind: 'seq', maxGapMs: 2000 }],
  },
  {
    id: 'fail-retry',
    name: '失败→重试',
    description: '一次失败之后很快又出现重试/重连，形成「失败→重试」对（一条链）。单独一次失败不计入。',
    anomalyEnabled: false,
    nodes: [
      {
        label: '失败/错误',
        pattern: 'error|fail|失败|异常',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
      {
        label: '重试/重连',
        pattern: 'retry|reconnect|重连|重试',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
    ],
    edges: [{ from: 0, to: 1, kind: 'seq', maxGapMs: 10000 }],
  },
  {
    id: 'heartbeat-lost',
    name: '心跳丢失',
    description: '周期心跳出现缺口（间隔超出容差）即判为丢失。在 CEP 面板的「心跳」分组里看缺口/抖动。',
    anomalyEnabled: false,
    nodes: [
      {
        label: '心跳',
        pattern: 'heartbeat|心跳|ping',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
    ],
    edges: [{ from: 0, to: 0, kind: 'periodic', maxGapMs: 200, periodMs: 1000 }],
  },
  {
    id: 'crash-after-startup',
    name: '启动后崩溃',
    description: '启动完成后的短时间内出现崩溃/致命错误，形成「启动→崩溃」对（一条链）。查看链即为事故窗口。',
    anomalyEnabled: false,
    nodes: [
      {
        label: '启动完成',
        pattern: 'started|启动完成|server up|boot ok',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
      {
        label: '崩溃/致命',
        pattern: 'panic|crash|fatal|崩溃|abort',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
    ],
    edges: [{ from: 0, to: 1, kind: 'seq', maxGapMs: 30000 }],
  },
  {
    id: 'deadlock',
    name: '死锁征兆',
    description: '获取锁之后出现等待锁，但窗口内始终没有锁释放 → NOT 违规（标红连线）。',
    anomalyEnabled: false,
    nodes: [
      {
        label: '获取锁',
        pattern: 'acquiring lock|try lock|获取锁',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
      {
        label: '等待锁',
        pattern: 'waiting for lock|blocked|等待锁',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
      {
        label: '锁释放',
        pattern: 'lock acquired|released|锁释放',
        isRegex: true,
        caseSensitive: false,
        scope: 'message',
      },
    ],
    edges: [
      { from: 0, to: 1, kind: 'seq', maxGapMs: 1000 },
      { from: 1, to: 2, kind: 'not', maxGapMs: 5000 },
    ],
  },
];
