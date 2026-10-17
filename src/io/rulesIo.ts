/**
 * 规则集（Filter + Group）导入导出。
 *
 * 此前规则只活在 `<日志目录>/.logGraph/filters.json` 里，跟目录绑死：真实场景
 * 的日志常常在服务器上、只读，或是临时拉下来的一批，规则根本带不出工作区，
 * 也就没法交给同事、没法进 CI。
 *
 * 两种格式（映射关系见 `plans/engine-cli-api-contract.md` §3.12）：
 * 1. `.loggraph.json`——完整规则集（含颜色 / 折叠 / 画布坐标），GUI 之间互导、
 *    备份、分享；与工作区 `filters.json` 同构，能直接喂给 applyPersistedFilters。
 * 2. `.cep.json`——CLI / CI 直接消费的规则。早期引擎 v1 跑不了的四种特性
 *    （`scope:thread`/W01、`nodeCounts`/W04、`nodeConditions`/W05、`opt`/W02、
 *    `periodic`/W03）曾在导出时逐条列出警告 —— 这是「规则资产化」的前提：
 *    静默降级会让用户在 CI 里以为规则在跑，其实它早就被 fallback 掉了。
 *    **engine ≥ 0.2.1 起这五种特性全部支持**（见契约 §3.5/§3.6），
 *    故此处不再告警，只保留真正与引擎语义有别的提示（如 message 作用域）。
 *
 * 本模块纯文本进出，不碰 IO / store，便于单测。
 */
import type { Filter, FilterGroup, SequenceEdge, NodePos } from '../types';

const RULE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** 契约 S01/S02：id 必须 ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$，不合规则改写 */
export function sanitizeRuleId(id: string, fallbackPrefix = 'f'): string {
  if (RULE_ID_RE.test(id)) return id;
  const cleaned = id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const withHead = /^[A-Za-z0-9_]/.test(cleaned) ? cleaned : `${fallbackPrefix}_${cleaned}`;
  return withHead.slice(0, 64);
}

export interface BuiltFile {
  json: string;
  /** 导出后需要告知用户的降级 / 跳过说明（不是错误，是事实） */
  warnings: string[];
}

/** 完整规则集（.loggraph.json） */
export function buildLoggraphJson(
  filters: readonly Filter[],
  groups: readonly FilterGroup[],
  graphNodes?: Record<string, NodePos>,
): BuiltFile {
  const warnings: string[] = [];
  const payload: Record<string, unknown> = {
    kind: 'loggraph-rules',
    version: 1,
    savedAt: Date.now(),
    filters: filters.map((f) => ({
      id: f.id,
      label: f.label,
      color: f.color,
      pattern: f.pattern,
      isRegex: f.isRegex,
      caseSensitive: f.caseSensitive,
      enabled: f.enabled,
      scope: f.scope,
      ...(f.subNotes?.length ? { subNotes: f.subNotes } : {}),
      groupId: f.groupId ?? null,
    })),
    groups: groups.map((g) => ({
      id: g.id,
      label: g.label,
      color: g.color,
      collapsed: g.collapsed,
      visible: g.visible,
      filterIds: g.filterIds,
      ...(g.sequence ? { sequence: g.sequence } : {}),
    })),
  };
  if (graphNodes && Object.keys(graphNodes).length) payload.graphNodes = graphNodes;
  return { json: JSON.stringify(payload, null, 2), warnings };
}

function toCepEdge(e: SequenceEdge): Record<string, unknown> {
  const kind = e.kind ?? 'seq';
  const base = { id: sanitizeRuleId(e.id, 'e'), kind, maxGapMs: e.maxGapMs };
  const from = sanitizeRuleId(e.fromFilterId);
  if (kind === 'and' || kind === 'or') {
    // and/or 走 toFilterIds（S06：禁止 toFilterId）
    const tos = e.toFilterIds?.length ? e.toFilterIds : [e.toFilterId];
    return { ...base, fromFilterId: from, toFilterIds: tos.map((t) => sanitizeRuleId(t)) };
  }
  if (kind === 'periodic') {
    // S07：periodic 必填 periodMs，其余 kind 禁止
    return { ...base, fromFilterId: from, toFilterId: sanitizeRuleId(e.toFilterId), periodMs: e.periodMs ?? e.maxGapMs };
  }
  return { ...base, fromFilterId: from, toFilterId: sanitizeRuleId(e.toFilterId) };
}

/** CLI / CI 可消费的 .cep.json（契约 §3） */
export function buildCepJson(
  filters: readonly Filter[],
  groups: readonly FilterGroup[],
): BuiltFile {
  const warnings: string[] = [];
  const enabled = filters.filter((f) => f.enabled);
  const disabled = filters.length - enabled.length;
  if (disabled > 0) {
    warnings.push(`${disabled} 个已禁用的过滤器未导出（.cep 无 enabled 概念，导出等于启用）`);
  }
  const msgScoped = enabled.filter((f) => f.scope === 'message');
  if (msgScoped.length > 0) {
    warnings.push(
      `${msgScoped.length} 个过滤器在 UI 里按「正文」匹配，但引擎只按整行匹配（§3.3）：` +
        msgScoped.map((f) => f.label).slice(0, 3).join('、') +
        (msgScoped.length > 3 ? ' 等' : ''),
    );
  }
  if (enabled.length === 0) {
    warnings.push('没有启用的过滤器，导出文件将是非法的（filters 至少 1 条）');
  }

  const enabledIds = new Set(enabled.map((f) => f.id));
  const cepGroups: Record<string, unknown>[] = [];
  for (const g of groups) {
    const seq = g.sequence;
    if (!seq) continue;
    const counts = seq.nodeCounts ?? {};
    const countKeys = Object.keys(counts).filter((k) => {
      const c = counts[k];
      return (c.min ?? 1) > 1 || (c.max ?? Infinity) < Infinity;
    });
    const condKeys = Object.keys(seq.nodeConditions ?? {}).filter(
      (k) => (seq.nodeConditions![k] ?? '').trim().length > 0,
    );
    const edges = seq.edges ?? [];
    // 注：scope:thread / nodeCounts / nodeConditions / opt / periodic 均已由
    // engine ≥ 0.2.1 支持，导出不再告警降级（仅旧 v1 引擎需要提示）。

    const group: Record<string, unknown> = {
      groupId: sanitizeRuleId(g.id, 'g'),
      label: g.label,
      scope: seq.scope ?? 'global',
      // S03/S04：边引用的 filter 必须声明在本 group 内
      filterIds: g.filterIds.filter((id) => enabledIds.has(id)).map((id) => sanitizeRuleId(id)),
      edges: edges
        .filter((e) => {
          const from = enabledIds.has(e.fromFilterId);
          const tos = (e.toFilterIds?.length ? e.toFilterIds : [e.toFilterId]).filter((t) =>
            enabledIds.has(t),
          );
          return from && tos.length > 0;
        })
        .map(toCepEdge),
    };
    if (countKeys.length > 0) {
      const nc: Record<string, Record<string, number>> = {};
      for (const k of countKeys) {
        const c = counts[k];
        const entry: Record<string, number> = {};
        if ((c.min ?? 1) > 1) entry.min = c.min;
        if ((c.max ?? Infinity) < Infinity) entry.max = c.max;
        if (Object.keys(entry).length) nc[sanitizeRuleId(k)] = entry;
      }
      if (Object.keys(nc).length) group.nodeCounts = nc;
    }
    if (condKeys.length > 0) {
      const ncd: Record<string, string> = {};
      for (const k of condKeys) ncd[sanitizeRuleId(k)] = seq.nodeConditions![k];
      group.nodeConditions = ncd;
    }
    cepGroups.push(group);
  }

  const payload = {
    $schema: 'https://loggraph.dev/schemas/cep-rules-1.schema.json',
    version: 1,
    description: '由 logGraph GUI 导出',
    filters: enabled.map((f) => ({
      id: sanitizeRuleId(f.id),
      label: f.label,
      pattern: f.pattern,
      isRegex: f.isRegex,
      caseSensitive: f.caseSensitive,
    })),
    groups: cepGroups,
  };
  return { json: JSON.stringify(payload, null, 2), warnings };
}

// ---- 导入 ----

export interface ParsedRules {
  kind: 'loggraph' | 'cep';
  /** 已是 UI 形状（缺字段由 applyPersistedFilters 兜底）；cep 来源时颜色缺省 */
  filters: Filter[];
  groups: FilterGroup[];
  graphNodes?: Record<string, NodePos>;
  warnings: string[];
}

/** 识别格式：含 kind:'loggraph-rules' 或 savedAt = 完整规则集；含 groups[].edges / filters[].pattern 且无 color = .cep */
export function detectRuleKind(data: any): 'loggraph' | 'cep' {
  if (data && (data.kind === 'loggraph-rules' || typeof data.savedAt === 'number')) {
    return 'loggraph';
  }
  return 'cep';
}

/**
 * 解析规则文件。抛出 Error 表示格式无法识别（调用方转成 toast）。
 *
 * 返回的 filters/groups 刻意留了缺省字段（颜色、折叠等），交给
 * applyPersistedFilters 统一补全——那里已有成熟的 id 重映射与兼容逻辑。
 */
export function parseRuleFile(text: string): ParsedRules {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (!data || typeof data !== 'object') throw new Error('文件内容为空或不是对象');
  const kind = detectRuleKind(data);
  const warnings: string[] = [];

  if (kind === 'loggraph') {
    if (!Array.isArray(data.filters)) throw new Error('缺少 filters 数组');
    return {
      kind,
      filters: data.filters as Filter[],
      groups: Array.isArray(data.groups) ? (data.groups as FilterGroup[]) : [],
      ...(data.graphNodes && typeof data.graphNodes === 'object'
        ? { graphNodes: data.graphNodes as Record<string, NodePos> }
        : {}),
      warnings,
    };
  }

  // .cep.json：颜色 / 折叠 / 可见性不在契约里，按 UI 缺省补齐
  if (!Array.isArray(data.filters)) throw new Error('缺少 filters 数组（不是 .cep.json？）');
  const filters: Filter[] = (data.filters as any[]).map((f, i) => ({
    id: typeof f?.id === 'string' && f.id ? sanitizeRuleId(f.id) : `f_cep_${i}`,
    label: typeof f?.label === 'string' && f.label ? f.label : `Filter ${i + 1}`,
    // 留空让 applyPersistedFilters 按调色板顺序分配
    color: undefined as unknown as string,
    pattern: typeof f?.pattern === 'string' ? f.pattern : '',
    isRegex: !!f?.isRegex,
    caseSensitive: !!f?.caseSensitive,
    enabled: true,
    scope: 'raw',
    groupId: null,
  }));
  const rawGroups: any[] = Array.isArray(data.groups) ? data.groups : [];
  const groups: FilterGroup[] = rawGroups.map((g: any, i: number) => {
    const rawEdges: any[] = Array.isArray(g?.edges) ? g.edges : [];
    const edges: SequenceEdge[] = rawEdges
      .map((e: any, ei: number) => {
        const kind = e?.kind ?? 'seq';
        const rawTargets: string[] =
          kind === 'and' || kind === 'or'
            ? Array.isArray(e?.toFilterIds)
              ? e.toFilterIds
              : []
            : [e?.toFilterId].filter((x) => typeof x === 'string');
        return {
          id: typeof e?.id === 'string' && e.id ? e.id : `e_cep_${i}_${ei}`,
          fromFilterId: e?.fromFilterId ?? '',
          toFilterId: rawTargets[0] ?? '',
          ...(rawTargets.length > 1 ? { toFilterIds: rawTargets } : {}),
          kind,
          maxGapMs: Number.isFinite(e?.maxGapMs) ? e.maxGapMs : 0,
          ...(kind === 'periodic'
            ? { periodMs: Number.isFinite(e?.periodMs) ? e.periodMs : e?.maxGapMs ?? 0 }
            : {}),
        } as SequenceEdge;
      })
      .filter((e) => !!e.fromFilterId && !!e.toFilterId);
    const seq: Record<string, unknown> = { edges, anomalyEnabled: false };
    // 注：scope:thread / nodeCounts / nodeConditions 均已由 engine ≥ 0.2.1
    // 支持，导入不再告警降级（仅旧 v1 引擎需要提示）。
    if (g?.scope === 'thread') {
      seq.scope = 'thread';
    }
    if (g?.nodeCounts && Object.keys(g.nodeCounts).length) {
      const nc: Record<string, { min: number; max: number }> = {};
      for (const [k, v] of Object.entries<any>(g.nodeCounts)) {
        nc[k] = {
          min: Number.isFinite(v?.min) ? v.min : 1,
          max: Number.isFinite(v?.max) ? v.max : Number.POSITIVE_INFINITY,
        };
      }
      seq.nodeCounts = nc;
    }
    if (g?.nodeConditions && Object.keys(g.nodeConditions).length) {
      seq.nodeConditions = g.nodeConditions;
    }
    return {
      id: typeof g?.groupId === 'string' && g.groupId ? sanitizeRuleId(g.groupId, 'g') : `g_cep_${i}`,
      label: typeof g?.label === 'string' && g.label ? g.label : `Group ${i + 1}`,
      color: undefined as unknown as string,
      collapsed: false,
      visible: true,
      filterIds: Array.isArray(g?.filterIds) ? g.filterIds.filter((x: unknown) => typeof x === 'string') : [],
      sequence: seq as any,
    };
  });
  return { kind, filters, groups, warnings };
}
