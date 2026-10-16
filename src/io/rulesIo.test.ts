import { describe, expect, it } from 'vitest';
import { buildCepJson, buildLoggraphJson, parseRuleFile, sanitizeRuleId } from './rulesIo';
import type { Filter, FilterGroup } from '../types';

function filter(over: Partial<Filter> & { id: string }): Filter {
  return {
    label: over.id,
    color: '#4ea2ff',
    pattern: 'x',
    isRegex: false,
    caseSensitive: false,
    enabled: true,
    scope: 'raw',
    ...over,
  } as Filter;
}

function group(over: Partial<FilterGroup> & { id: string }): FilterGroup {
  return {
    label: over.id,
    color: '#56b4e9',
    collapsed: false,
    visible: true,
    filterIds: [],
    ...over,
  } as FilterGroup;
}

const F1 = filter({ id: 'f1', label: '登录', pattern: 'login' });
const F2 = filter({ id: 'f2', label: '鉴权', pattern: 'auth', isRegex: true });
const F3 = filter({ id: 'f3', label: '登出', pattern: 'logout' });

describe('sanitizeRuleId', () => {
  it('合法 id 原样返回', () => {
    expect(sanitizeRuleId('f1')).toBe('f1');
    expect(sanitizeRuleId('a_b.c-d')).toBe('a_b.c-d');
  });

  it('非法字符改写为下划线，且首字符保证合法', () => {
    // 数字开头契约本来就允许（^[A-Za-z0-9_]），不该被改写
    expect(sanitizeRuleId('1abc')).toBe('1abc');
    expect(sanitizeRuleId('-abc')).toBe('f_-abc');
    expect(sanitizeRuleId('ab cd')).toBe('ab_cd');
    expect(sanitizeRuleId('ab/cd')).toBe('ab_cd');
  });

  it('超长截断到 64', () => {
    expect(sanitizeRuleId('a'.repeat(100)).length).toBe(64);
  });
});

describe('buildCepJson', () => {
  it('输出契约 §3 顶层结构', () => {
    const g = group({
      id: 'g1',
      filterIds: ['f1', 'f2'],
      sequence: {
        edges: [{ id: 'e1', fromFilterId: 'f1', toFilterId: 'f2', kind: 'seq', maxGapMs: 1000 }],
        anomalyEnabled: false,
      },
    });
    const { json, warnings } = buildCepJson([F1, F2], [g]);
    const data = JSON.parse(json);
    expect(data.version).toBe(1);
    expect(data.filters).toHaveLength(2);
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].edges[0]).toMatchObject({
      id: 'e1',
      fromFilterId: 'f1',
      toFilterId: 'f2',
      kind: 'seq',
      maxGapMs: 1000,
    });
    expect(warnings).toEqual([]);
  });

  it('and/or 边用 toFilterIds 且不带 toFilterId（S06）', () => {
    const g = group({
      id: 'g1',
      filterIds: ['f1', 'f2', 'f3'],
      sequence: {
        edges: [
          {
            id: 'e1',
            fromFilterId: 'f1',
            toFilterId: 'f2',
            toFilterIds: ['f2', 'f3'],
            kind: 'or',
            maxGapMs: 500,
          },
        ],
        anomalyEnabled: false,
      },
    });
    const data = JSON.parse(buildCepJson([F1, F2, F3], [g]).json);
    const e = data.groups[0].edges[0];
    expect(e.toFilterIds).toEqual(['f2', 'f3']);
    expect(e.toFilterId).toBeUndefined();
  });

  it('引擎 v1 不支持的特性逐条警告，不静默', () => {
    const g = group({
      id: 'g1',
      label: '会话',
      filterIds: ['f1', 'f2'],
      sequence: {
        edges: [
          { id: 'e1', fromFilterId: 'f1', toFilterId: 'f2', kind: 'opt', maxGapMs: 100 },
          { id: 'e2', fromFilterId: 'f1', toFilterId: 'f2', kind: 'seq', maxGapMs: 100 },
        ],
        anomalyEnabled: false,
        scope: 'thread',
        nodeCounts: { f2: { min: 2, max: 5 } },
        nodeConditions: { f2: "level == 'E'" },
      },
    });
    const { warnings } = buildCepJson([F1, F2], [g]);
    const all = warnings.join('\n');
    expect(all).toContain('W01');
    expect(all).toContain('W02');
    expect(all).toContain('W04');
    expect(all).toContain('W05');
  });

  it('scope=message 的过滤器按契约 §3.3 提示', () => {
    const f = filter({ id: 'f1', scope: 'message' });
    const { warnings } = buildCepJson([f], []);
    expect(warnings.join('\n')).toContain('整行匹配');
  });

  it('禁用的过滤器不导出', () => {
    const off = filter({ id: 'f9', enabled: false });
    const { json, warnings } = buildCepJson([F1, off], []);
    const data = JSON.parse(json);
    expect(data.filters.map((f: { id: string }) => f.id)).toEqual(['f1']);
    expect(warnings.join('\n')).toContain('已禁用');
  });

  it('边引用的 filter 不在组内时不导出该边（S04）', () => {
    const g = group({
      id: 'g1',
      filterIds: ['f1'],
      sequence: {
        edges: [{ id: 'e1', fromFilterId: 'f1', toFilterId: 'f2', kind: 'seq', maxGapMs: 10 }],
        anomalyEnabled: false,
      },
    });
    // f2 未启用 → 边失效
    const data = JSON.parse(buildCepJson([F1], [g]).json);
    expect(data.groups[0].edges).toHaveLength(0);
  });
});

describe('parseRuleFile', () => {
  it('识别 .cep.json 并恢复成 UI 形状', () => {
    const text = JSON.stringify({
      version: 1,
      filters: [
        { id: 'A', label: '起步', pattern: 'boot', isRegex: false, caseSensitive: true },
        { id: 'B', label: '就绪', pattern: 'ready', isRegex: true },
      ],
      groups: [
        {
          groupId: 'startup',
          label: '启动',
          filterIds: ['A', 'B'],
          edges: [{ id: 'e1', fromFilterId: 'A', toFilterId: 'B', kind: 'seq', maxGapMs: 3000 }],
        },
      ],
    });
    const parsed = parseRuleFile(text);
    expect(parsed.kind).toBe('cep');
    expect(parsed.filters).toHaveLength(2);
    expect(parsed.filters[0]).toMatchObject({
      id: 'A',
      label: '起步',
      pattern: 'boot',
      caseSensitive: true,
      enabled: true,
    });
    expect(parsed.groups[0].filterIds).toEqual(['A', 'B']);
    expect(parsed.groups[0].sequence!.edges[0]).toMatchObject({
      fromFilterId: 'A',
      toFilterId: 'B',
      maxGapMs: 3000,
    });
    // 颜色不在契约里 → 留空让 applyPersistedFilters 按调色板分配
    expect(parsed.filters[0].color).toBeUndefined();
  });

  it('识别 .loggraph.json', () => {
    const built = buildLoggraphJson([F1, F2], [group({ id: 'g1', filterIds: ['f1'] })]);
    const parsed = parseRuleFile(built.json);
    expect(parsed.kind).toBe('loggraph');
    expect(parsed.filters).toHaveLength(2);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.filters[0].color).toBe('#4ea2ff');
  });

  it('导入 cep 时把 v1 不支持的特性也报出来', () => {
    const text = JSON.stringify({
      version: 1,
      filters: [{ id: 'A', pattern: 'a' }],
      groups: [
        {
          groupId: 'g',
          label: '会话',
          scope: 'thread',
          filterIds: ['A'],
          edges: [],
          nodeCounts: { A: { min: 2 } },
          nodeConditions: { A: "level == 'E'" },
        },
      ],
    });
    const parsed = parseRuleFile(text);
    const all = parsed.warnings.join('\n');
    expect(all).toContain('W01');
    expect(all).toContain('W04');
    expect(all).toContain('W05');
    // 特性本身保留下来（UI 里能用，只是导出到 CLI 会 fallback）
    expect(parsed.groups[0].sequence!.scope).toBe('thread');
  });

  it('and/or 边恢复成 toFilterIds', () => {
    const text = JSON.stringify({
      version: 1,
      filters: [{ id: 'A', pattern: 'a' }, { id: 'B', pattern: 'b' }, { id: 'C', pattern: 'c' }],
      groups: [
        {
          groupId: 'g',
          filterIds: ['A', 'B', 'C'],
          edges: [
            { id: 'e1', fromFilterId: 'A', toFilterIds: ['B', 'C'], kind: 'and', maxGapMs: 50 },
          ],
        },
      ],
    });
    const e = parseRuleFile(text).groups[0].sequence!.edges[0];
    expect(e.kind).toBe('and');
    expect(e.toFilterIds).toEqual(['B', 'C']);
  });

  it('非法输入抛可读错误', () => {
    expect(() => parseRuleFile('not json')).toThrow(/JSON/);
    expect(() => parseRuleFile('{"version":1}')).toThrow(/filters/);
  });
});

describe('导出 → 导入 往返', () => {
  it('序列规则往返后边数与端点一致', () => {
    const g = group({
      id: 'g1',
      label: '会话',
      filterIds: ['f1', 'f2'],
      sequence: {
        edges: [{ id: 'e1', fromFilterId: 'f1', toFilterId: 'f2', kind: 'seq', maxGapMs: 2000 }],
        anomalyEnabled: false,
      },
    });
    const { json, warnings } = buildCepJson([F1, F2], [g]);
    expect(warnings).toEqual([]);
    const back = parseRuleFile(json);
    expect(back.groups[0].sequence!.edges).toHaveLength(1);
    expect(back.groups[0].sequence!.edges[0]).toMatchObject({
      fromFilterId: 'f1',
      toFilterId: 'f2',
      kind: 'seq',
      maxGapMs: 2000,
    });
  });
});
