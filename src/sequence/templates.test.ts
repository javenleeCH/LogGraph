/**
 * templates.ts 模板库单测（P0-2）：createGroupFromTemplate 一键生成脚手架的结构正确性。
 * 校验每个模板 → 分组 / 过滤器 / 连边（类型/时间窗/周期）/ 循环计数 / 条件表达式 / 异常开关。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createGroupFromTemplate, RULE_TEMPLATES } from './templates';

// ---- mock 外部 IO / CEP / UI 模块（与 logStore.test 同源；templates 额外用 notify） ----

vi.mock('../io/dbStore', () => ({
  dbClose: () => {},
  runDbFiltersBatch: async () => new Map(),
  runDbSequences: async () => ({ results: {}, fallback: false }),
}));

vi.mock('../io/filterPersist', () => ({
  openWorkspaceDir: async () => null,
  readFilters: async () => null,
  writeFilters: async () => {},
  readLegacyPersistedFilters: async () => null,
  clearLegacyPersistDir: async () => {},
  isFSASupported: () => false,
}));

vi.mock('../io/dirLoader', () => ({
  pickLogDirectory: async () => null,
  getSavedLogDirectory: async () => null,
  ensureReadPermission: async () => true,
  isFSASupported: () => false,
}));

vi.mock('../io/recentProjects', () => ({
  recordOpenProject: async () => {},
}));

vi.mock('../sequence/cepWasm', () => ({
  ensureCepWasm: () => {},
  isCepWasmFailed: () => false,
  isCepWasmReady: () => true,
  onCepWasmSettled: () => {},
  retryCepWasm: () => {},
  runCepWasm: () => ({ kind: 'ok', results: {} }),
}));

vi.mock('../store/uiStore', () => ({
  toast: { warn: () => {}, success: () => {} },
  notify: () => {},
}));

let useLogStore: any;

beforeAll(async () => {
  const g = globalThis as any;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.window = { setTimeout: (fn: () => void) => setTimeout(fn, 0) };
  g.requestAnimationFrame = (fn: () => void) => fn();
  g.cancelAnimationFrame = () => {};
  ({ useLogStore } = await import('../store/logStore'));
});

beforeEach(() => {
  useLogStore.setState({
    events: [],
    rawLines: [],
    meta: null,
    filters: [],
    matches: [],
    groups: [],
    sequenceResults: {},
    cepEngineError: null,
    tail: null,
    viewRange: null,
    fullRange: null,
    selectedEventId: null,
    correlatedEventIds: new Set(),
  });
});

describe('RULE_TEMPLATES 内置库', () => {
  it('包含预期模板集（P1⑥ 五类故障模式）', () => {
    const ids = RULE_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(['timeout', 'fail-retry', 'heartbeat-lost', 'crash-after-startup', 'deadlock']);
  });

  it('模板自洽：边端点下标均落在节点范围内', () => {
    for (const t of RULE_TEMPLATES) {
      for (const e of t.edges) {
        expect(e.from, `${t.id} from 越界`).toBeLessThan(t.nodes.length);
        expect(e.to, `${t.id} to 越界`).toBeLessThan(t.nodes.length);
        for (const tgt of e.toFilterIds ?? []) expect(tgt).toBeLessThan(t.nodes.length);
      }
    }
  });
});

describe('createGroupFromTemplate 脚手架结构', () => {
  it('创建分组：名称/作用域/异常开关正确', () => {
    const gid = createGroupFromTemplate(RULE_TEMPLATES.find((t) => t.id === 'timeout')!);
    const g = useLogStore.getState().groups.find((x: any) => x.id === gid);
    expect(g.label).toBe('超时未响应');
    expect(g.sequence.anomalyEnabled).toBe(true);
    // timeout 无 scope → 保持默认（无 scope 字段）
    expect(g.sequence.scope).toBeUndefined();
  });

  it('节点 → 过滤器：数量/顺序/属性/颜色全部对齐', () => {
    const tpl = RULE_TEMPLATES.find((t) => t.id === 'fail-retry')!;
    const gid = createGroupFromTemplate(tpl);
    const g = useLogStore.getState().groups.find((x: any) => x.id === gid);
    const filters = g.filterIds.map((fid: string) =>
      useLogStore.getState().filters.find((f: any) => f.id === fid),
    );

    expect(g.filterIds.length).toBe(tpl.nodes.length);
    expect(filters.length).toBe(2);
    filters.forEach((f: any, i: number) => {
      const n = tpl.nodes[i];
      expect(f.label).toBe(n.label);
      expect(f.pattern).toBe(n.pattern);
      expect(f.isRegex).toBe(n.isRegex);
      expect(f.caseSensitive).toBe(n.caseSensitive);
      expect(f.scope).toBe(n.scope);
      expect(typeof f.color).toBe('string');
      expect(f.color.startsWith('#')).toBe(true);
    });
  });

  it('scope=thread / key 的分组正确设置作用域', () => {
    // 构造一个带 scope 的模板验证
    const tpl = { ...RULE_TEMPLATES.find((t) => t.id === 'fail-retry')!, scope: 'thread' as const };
    const gid = createGroupFromTemplate(tpl);
    const g = useLogStore.getState().groups.find((x: any) => x.id === gid);
    expect(g.sequence.scope).toBe('thread');
  });

  it('边：from/to 映射到真实 filter id，类型/时间窗/周期正确', () => {
    const tpl = RULE_TEMPLATES.find((t) => t.id === 'heartbeat-lost')!;
    const gid = createGroupFromTemplate(tpl);
    const g = useLogStore.getState().groups.find((x: any) => x.id === gid);
    const edges = g.sequence.edges;
    expect(edges.length).toBe(1);
    const e = edges[0];
    // 心跳：periodic 自环（from === to）
    expect(e.kind).toBe('periodic');
    expect(e.fromFilterId).toBe(g.filterIds[0]);
    expect(e.toFilterId).toBe(g.filterIds[0]);
    expect(e.maxGapMs).toBe(200);
    expect(e.periodMs).toBe(1000);
  });

  it('deadlock：含 NOT 边，from→to 指向不同过滤器', () => {
    const tpl = RULE_TEMPLATES.find((t) => t.id === 'deadlock')!;
    const gid = createGroupFromTemplate(tpl);
    const g = useLogStore.getState().groups.find((x: any) => x.id === gid);
    const edges = g.sequence.edges;
    expect(edges.length).toBe(2);
    const notEdge = edges.find((e: any) => e.kind === 'not');
    expect(notEdge).toBeTruthy();
    expect(notEdge.fromFilterId).not.toBe(notEdge.toFilterId);
    expect(notEdge.maxGapMs).toBe(5000);
    // seq 边不显式存 kind（缺省即 'seq'），用回退匹配
    const seqEdge = edges.find((e: any) => (e.kind ?? 'seq') === 'seq');
    expect(seqEdge.maxGapMs).toBe(1000);
  });

  it('含节点约束的模板：循环计数 / 条件表达式落位', () => {
    // 构造带 count + condition 的模板
    const tpl: any = {
      ...RULE_TEMPLATES.find((t) => t.id === 'timeout')!,
      nodes: [
        ...RULE_TEMPLATES.find((t) => t.id === 'timeout')!.nodes,
        {
          label: '三次失败', pattern: 'fail', isRegex: false, caseSensitive: false, scope: 'message',
          count: [3, 5], condition: "level == 'ERROR'",
        },
      ],
    };
    const gid = createGroupFromTemplate(tpl);
    const g = useLogStore.getState().groups.find((x: any) => x.id === gid);
    const fid = g.filterIds[2];
    expect(g.sequence.nodeCounts[fid]).toEqual({ min: 3, max: 5 });
    expect(g.sequence.nodeConditions[fid]).toBe("level == 'ERROR'");
  });
});
