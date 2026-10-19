import { describe, expect, it } from 'vitest';
import { explainNoMatch, explainAnomalies, ANOMALY_SCAN_CAP } from './explain';
import type { FilterMatch, LogEvent, SequenceConfig, SequenceEdge } from '../types';

let idc = 0;
function ev(ts: number): LogEvent {
  return {
    id: idc++,
    ts,
    line: idc,
    raw: `line-${idc}`,
    message: `line-${idc}`,
    level: undefined,
    thread: undefined,
  } as LogEvent;
}
function fm(filterId: string, tss: number[]): FilterMatch {
  return { filterId, events: tss.map(ev) };
}
function seq(cfg: Partial<SequenceConfig> & { edges: SequenceConfig['edges'] }): SequenceConfig {
  return { ...cfg, edges: cfg.edges } as SequenceConfig;
}
const edge = (
  id: string,
  from: string,
  to: string,
  maxGapMs: number,
  kind?: SequenceEdge['kind'],
) =>
  ({
    id,
    fromFilterId: from,
    toFilterId: to,
    kind: kind ?? 'seq',
    maxGapMs,
  }) as SequenceEdge;

describe('explainNoMatch', () => {
  it('过滤器零命中时只报这一条（其余分析无意义）', () => {
    const r = explainNoMatch(
      seq({
        edges: [edge('e1', 'A', 'B', 1000)],
      }),
      [fm('A', [100]), fm('B', [])],
      true,
    );
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe('blocker');
    expect(r[0].text).toContain('B');
    expect(r[0].text).toContain('0 命中');
  });

  it('间隔超限：给出最近间隔与设定窗口', () => {
    const r = explainNoMatch(
      seq({ edges: [edge('e1', 'A', 'B', 1000)] }),
      [fm('A', [0]), fm('B', [8000])],
      true,
    );
    expect(r[0].severity).toBe('blocker');
    expect(r[0].text).toContain('间隔超限');
    expect(r[0].text).toContain('8 秒');
    expect(r[0].detail).toContain('1 秒');
  });

  it('顺序颠倒：B 全部早于 A', () => {
    const r = explainNoMatch(
      seq({ edges: [edge('e1', 'A', 'B', 1000)] }),
      [fm('A', [5000]), fm('B', [100])],
      true,
    );
    expect(r[0].severity).toBe('blocker');
    expect(r[0].text).toContain('顺序不对');
  });

  it('被 A 的后续命中抢先 → 只给 hint（间隔是够的）', () => {
    // A 每 10ms 一条；B 唯一命中在 25ms——从 A@0 / A@10 出发间隔都够，
    // 但 B@25 晚于 A@10、A@20，按 CEP 语义这两对都不成立
    const r = explainNoMatch(
      seq({ edges: [edge('e1', 'A', 'B', 100)] }),
      [fm('A', [0, 10, 20, 30]), fm('B', [25])],
      true,
    );
    const hit = r.find((d) => d.text.includes('抢先'));
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('hint');
  });

  it('间隔够且不被抢先 → 无诊断（不该胡说）', () => {
    const r = explainNoMatch(
      seq({ edges: [edge('e1', 'A', 'B', 1000)] }),
      [fm('A', [0]), fm('B', [500])],
      true,
    );
    expect(r).toHaveLength(0);
  });

  it('nodeCounts 不足报 blocker 并给具体次数', () => {
    const r = explainNoMatch(
      seq({
        edges: [edge('e1', 'A', 'B', 1000)],
        nodeCounts: { A: { min: 3, max: 5 } },
      }),
      [fm('A', [0]), fm('B', [500])],
      true,
    );
    const hit = r.find((d) => d.text.includes('节点计数不足'));
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('blocker');
    expect(hit!.text).toContain('至少连续 3 次');
    expect(hit!.text).toContain('实际只有 1 次');
  });

  it('nodeConditions 只给 hint（可能是过严，但不必然阻塞）', () => {
    const r = explainNoMatch(
      seq({
        edges: [edge('e1', 'A', 'B', 1000)],
        nodeConditions: { B: "level == 'E'" },
      }),
      [fm('A', [0]), fm('B', [500])],
      true,
    );
    const hit = r.find((d) => d.text.includes('节点条件'));
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('hint');
  });

  it('空条件串不产生噪音', () => {
    const r = explainNoMatch(
      seq({
        edges: [edge('e1', 'A', 'B', 1000)],
        nodeConditions: { B: '   ' },
      }),
      [fm('A', [0]), fm('B', [500])],
      true,
    );
    expect(r).toHaveLength(0);
  });

  it('not / periodic 边不参与 A→B 推进分析', () => {
    const r = explainNoMatch(
      seq({ edges: [edge('e1', 'A', 'B', 10, 'not')] }),
      [fm('A', [0]), fm('B', [9999])],
      true,
    );
    expect(r).toHaveLength(0); // not 是断言，不应报「间隔超限」
  });

  it('blocker 排在 hint 之前', () => {
    const r = explainNoMatch(
      seq({
        edges: [edge('e1', 'A', 'B', 10)],
        nodeConditions: { A: 'x' },
      }),
      [fm('A', [0]), fm('B', [500])],
      true,
    );
    expect(r.length).toBeGreaterThan(1);
    expect(r[0].severity).toBe('blocker');
  });

  it('最多 4 条，避免刷屏', () => {
    const edges = ['C', 'D', 'E', 'F', 'G'].map((t, i) => edge(`e${i}`, 'A', t, 10));
    const r = explainNoMatch(
      seq({ edges, nodeConditions: { C: 'x', D: 'y', E: 'z' } }),
      [fm('A', [1000]), fm('C', [0]), fm('D', [0]), fm('E', [0]), fm('F', [0]), fm('G', [0])],
      true,
    );
    expect(r.length).toBeLessThanOrEqual(4);
  });
});

describe('explainAnomalies', () => {
  it('未覆盖为 0 → 无诊断', () => {
    expect(explainAnomalies(['A', 'B'], { ids: [], ts: [] }, [fm('A', [1]), fm('B', [2])])).toEqual([]);
  });

  it('按过滤器归因：只列有未覆盖命中的过滤器，带 n/总命中', () => {
    const A = fm('A', [100, 200, 300]);
    const B = fm('B', [150]);
    const C = fm('C', [120]); // 命中全部覆盖 → 不应出现
    const r = explainAnomalies(
      ['A', 'B', 'C'],
      { ids: [A.events[0].id, A.events[2].id, B.events[0].id], ts: [100, 300, 150] },
      [A, B, C],
    );
    expect(r).toHaveLength(2);
    expect(r[0].severity).toBe('anomaly');
    expect(r[0].text).toContain('3 条命中未成链');
    expect(r[0].detail).toContain('「A」2 / 3 条命中');
    expect(r[0].detail).toContain('「B」1 / 1 条命中');
    expect(r[0].detail).not.toContain('「C」');
    expect(r[1].severity).toBe('hint');
  });

  it('超扫描上限只归因前缀并明示', () => {
    // CAP+2 条命中全未覆盖，A 的 id 排在 uncovered 前缀内、B 的排在后缀
    const aTss: number[] = [];
    for (let i = 0; i < ANOMALY_SCAN_CAP; i++) aTss.push(i);
    const A = fm('A', aTss);
    const B = fm('B', [1_000_000, 1_000_001]);
    const r = explainAnomalies(
      ['A', 'B'],
      { ids: [...A.events.map((e) => e.id), ...B.events.map((e) => e.id)], ts: [...aTss, 1_000_000, 1_000_001] },
      [A, B],
    );
    expect(r[0].text).toContain(`${(ANOMALY_SCAN_CAP + 2).toLocaleString()} 条命中未成链`);
    expect(r[0].detail).toContain(`「A」${ANOMALY_SCAN_CAP.toLocaleString()} / ${ANOMALY_SCAN_CAP.toLocaleString()} 条命中`);
    expect(r[0].detail).not.toContain('「B」'); // 后缀在 cap 外，未被归因
    expect(r[0].detail).toContain(`仅归因前 ${ANOMALY_SCAN_CAP.toLocaleString()} 条`);
  });
});
