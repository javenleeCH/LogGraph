// 回归测试：工作区恢复时 group.sequence（连线/节点约束）的保留与 filter-id 重映射
// 背景：刷新后连线丢失 — applyPersistedFilters 曾丢弃 sequence，且随后回写覆盖了存档
// 用法：node scripts/test-seq-restore.mjs   （在仓库根目录运行；仅依赖 vite，无需浏览器）
globalThis.window = {}; // 浏览器全局桩（isFSASupported 等仅做能力检测）

const { createServer } = await import('vite');
const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  logLevel: 'error',
});

const { useLogStore } = await server.ssrLoadModule('/src/store/logStore.ts');

const saved = {
  filters: [
    { id: 'f1', label: 'A', pattern: 'a', color: '#111111' },
    { id: 'f2', label: 'B', pattern: 'b', color: '#222222' },
  ],
  groups: [
    {
      id: 'g1', label: 'G', color: '#333333', collapsed: false, visible: true,
      filterIds: ['f1', 'f2'],
      sequence: {
        edges: [
          { id: 'e1', fromFilterId: 'f1', toFilterId: 'f2', maxGapMs: 800 },
          { id: 'e2', fromFilterId: 'f1', toFilterId: 'fGONE', maxGapMs: 500 }, // 端点已删 → 应丢弃
        ],
        anomalyEnabled: true,
        nodeCounts: { f1: { min: 1, max: 3 } },
        nodeConditions: { f2: 'tag=="x"' },
      },
    },
  ],
  graphNodes: {},
  savedAt: 0,
};

useLogStore.getState().applyPersistedFilters(saved);
const st = useLogStore.getState();
const g = st.groups[0];
const [fa, fb] = st.filters;

const checks = {
  'filters 恢复数=2': st.filters.length === 2,
  'group.sequence 保留': !!g?.sequence,
  '边仅保留 1 条（失效端点丢弃）': g?.sequence?.edges.length === 1,
  '边 from 重映射': g?.sequence?.edges[0]?.fromFilterId === fa?.id,
  '边 to 重映射': g?.sequence?.edges[0]?.toFilterId === fb?.id,
  'maxGapMs 保留': g?.sequence?.edges[0]?.maxGapMs === 800,
  'anomalyEnabled 保留': g?.sequence?.anomalyEnabled === true,
  'nodeCounts 键重映射': !!g?.sequence?.nodeCounts?.[fa?.id ?? ''],
  'nodeConditions 键重映射': g?.sequence?.nodeConditions?.[fb?.id ?? ''] === 'tag=="x"',
};

let fail = 0;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) fail++;
}

await server.close();
process.exit(fail ? 1 : 0);
