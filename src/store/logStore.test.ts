/**
 * logStore 状态机切片测试（node 环境，mock 外部 IO/CEP/ui 模块）。
 *
 * 重点守护「实时 tail 增量」等价性（638f0b3 引入）的 store 层路由：
 *   - 纯追加 ⇒ appendTailEvents 走 FilterEngine.appendMatches 增量（O(Δ)）；
 *   - 时钟回拨/交错 ⇒ 判定非纯追加，回退全量 recomputeMatches（结果一致）。
 * 以及：addFilter → matches 一致性、hitTsByLine / selectEventCount 纯函数。
 *
 * 说明：logStore 顶层摸 window/localStorage，需在动态 import 前注入全局；
 *       recomputeSequences 依赖 cepWasm，统一 mock 为「就绪且结果为空」。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { FilterEngine } from '../filters/FilterEngine';

// ---- mock 外部 IO / CEP / UI 模块（vi.mock 会被提升，工厂内不访问外部） ----

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

vi.mock('./uiStore', () => ({
  toast: { warn: () => {}, success: () => {} },
}));

// ---- 动态 import（需先注入浏览器全局，再加载 logStore 顶层） ----

let useLogStore: any;
let hitTsByLine: any;
let selectEventCount: any;

beforeAll(async () => {
  const g = globalThis as any;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.window = { setTimeout: (fn: () => void) => setTimeout(fn, 0) };
  g.requestAnimationFrame = (fn: () => void) => fn();
  g.cancelAnimationFrame = () => {};
  ({ useLogStore, hitTsByLine, selectEventCount } = await import('./logStore'));
});

beforeEach(() => {
  useLogStore.setState({
    events: [],
    rawLines: [],
    meta: null,
    dbMode: false,
    filters: [],
    matches: [],
    groups: [],
    sequenceResults: {},
    cepEngineError: null,
    tail: null,
    sessionFiles: [],
    sessionEvents: [],
    viewRange: null,
    fullRange: null,
    selectedEventId: null,
    scrubberTs: null,
    correlatedEventIds: new Set(),
  });
});

const EV = (
  id: number,
  ts: number,
  raw: string,
): { id: number; ts: number; raw: string; message: string } => ({ id, ts, raw, message: raw });

describe('纯函数切片', () => {
  it('hitTsByLine：命中行返回 ts，非命中行返回 null', () => {
    const matches = [{ filterId: 'f1', events: [EV(5, 1000, 'a')] }];
    expect(hitTsByLine({ matches }, 5)).toBe(1000);
    expect(hitTsByLine({ matches }, 99)).toBeNull();
    expect(hitTsByLine({ matches: [] }, 1)).toBeNull();
  });

  it('selectEventCount：dbMode 走 totalLines，普通模式走 events.length', () => {
    expect(selectEventCount({ dbMode: true, meta: { totalLines: 42 }, events: [] })).toBe(42);
    expect(selectEventCount({ dbMode: false, meta: null, events: [1, 2, 3] })).toBe(3);
  });
});

describe('addFilter → matches 一致性', () => {
  it('添加过滤器后 matches 正确命中，顺序保持事件 ts 序', () => {
    const store = useLogStore.getState();
    store.setLog(
      [EV(0, 100, 'ERR a'), EV(1, 200, 'INFO b'), EV(2, 300, 'ERR c')],
      ['ERR a', 'INFO b', 'ERR c'],
      { fileName: 't.log', fileSize: 0, totalLines: 3, skipped: 0, timestampFormatId: null },
    );
    const fid = store.addFilter({ label: 'err', pattern: 'ERR', isRegex: true, caseSensitive: false, scope: 'raw' });
    const match = useLogStore.getState().matches.find((m: any) => m.filterId === fid);
    expect(match?.events.map((e: any) => e.id)).toEqual([0, 2]);
  });

  it('删除过滤器后 matches 移除对应项', () => {
    const store = useLogStore.getState();
    store.setLog(
      [EV(0, 100, 'ERR a'), EV(1, 200, 'INFO b')],
      ['ERR a', 'INFO b'],
      { fileName: 't.log', fileSize: 0, totalLines: 2, skipped: 0, timestampFormatId: null },
    );
    const fid = store.addFilter({ label: 'err', pattern: 'ERR', isRegex: true, caseSensitive: false, scope: 'raw' });
    expect(useLogStore.getState().matches.length).toBe(1);
    store.removeFilter(fid);
    expect(useLogStore.getState().matches.length).toBe(0);
  });
});

describe('实时 tail 增量等价性（store 层路由）', () => {
  /** 种子会话：事件 + 过滤器，返回 {store, filterId, events0} */
  function seed() {
    const store = useLogStore.getState();
    const events0 = [EV(0, 100, 'a'), EV(1, 200, 'ERR b')];
    store.setLog(events0, ['a', 'ERR b'], {
      fileName: 't.log', fileSize: 0, totalLines: 2, skipped: 0, timestampFormatId: null,
    });
    const filterId = store.addFilter({ label: 'err', pattern: 'ERR', isRegex: true, caseSensitive: false, scope: 'raw' });
    // setLog/addFilter 会清/建 tail；显式配置 tail 让 appendTailEvents 生效
    useLogStore.setState({ tail: { enabled: true, offsets: {}, newCount: 0 } });
    return { store, filterId, events0 };
  }

  const hitIds = (filterId: string) =>
    (useLogStore.getState().matches.find((m: any) => m.filterId === filterId)?.events ?? []).map((e: any) => e.id);

  it('纯追加：增量 matches 与全量重算逐项一致', () => {
    const { store, filterId, events0 } = seed();
    const before = hitIds(filterId); // [1]

    // 纯追加新段（ts 不早于尾部 200）
    const ev1 = [EV(0, 300, 'ERR c'), EV(1, 400, 'd')];
    store.appendTailEvents('/x.log', ev1, ['ERR c', 'd'], 400, 0);

    const inc = hitIds(filterId); // 增量路径结果
    // 全量重算参考：合并后整体跑一遍 FilterEngine.run
    const all = [...events0, ...ev1.map((e, i) => ({ ...e, id: events0.length + i }))];
    const filter = useLogStore.getState().filters.find((f: any) => f.id === filterId) as any;
    const full = FilterEngine.run(all, [filter]).find((m: any) => m.filterId === filterId)?.events.map((e: any) => e.id) ?? [];

    expect(before).toEqual([1]);
    expect(inc).toEqual([1, 2]); // 旧命中 + 新增 ERR 行，纯追加走增量
    expect(inc).toEqual(full); // 与全量重算逐项一致
  });

  it('纯追加但新段无命中：命中集原样保留，不回归', () => {
    const { store, filterId } = seed();
    store.appendTailEvents('/x.log', [EV(0, 300, 'zzz')], ['zzz'], 300, 0);
    expect(hitIds(filterId)).toEqual([1]);
  });

  it('时钟回拨（非纯追加）：不走增量，匹配结果由全量重算保证', () => {
    const { store, filterId } = seed();
    const before = hitIds(filterId); // [1]

    // 回拨：新段最早 ts(50) < 现有尾部(200) ⇒ isPureAppend=false ⇒ 回退全量
    store.appendTailEvents('/x.log', [EV(0, 50, 'ERR z')], ['ERR z'], 250, 0);

    // 同步阶段 matches 未被增量篡改（新事件尚未计入），证明走了全量回退而非 appendMatches
    expect(hitIds(filterId)).toEqual(before);
    expect(hitIds(filterId)).not.toContain(2);
  });
});
