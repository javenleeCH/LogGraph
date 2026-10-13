import { useMemo } from 'react';
import { useLogStore } from '../store/logStore';
import { formatTime } from '../utils/timeFormat';
import type { FilterGroup, SequenceMatchResult } from '../types';
import styles from './CepTimelinePanel.module.css';

/** 单个 CEP 标记（链上一步 / 异常 / NOT 违规） */
interface CepMark {
  eventId: number;
  ts: number;
  /** 所属链号；异常事件为 0 */
  chainIndex: number;
  color: string;
  anomaly: boolean;
  /** NOT 边违规（A 的窗口内出现了禁止的 B） */
  violation?: boolean;
  /** 来源 filter 名（悬浮提示） */
  filterLabel?: string;
}

/** 一个 CEP 规则分组的独立时间轴块 */
interface CepBlock {
  groupId: string;
  label: string;
  color: string;
  chainCount: number;
  anomalyCount: number;
  /** 该组 CEP 事件按去重时间戳升序的行 */
  rows: { ts: number; marks: CepMark[] }[];
}

/** 链上一步 / 异常事件 → 标记（同事件只记首次；违规覆盖为异常标记） */
function collectMarks(
  g: Pick<FilterGroup, 'color' | 'sequence'>,
  r: SequenceMatchResult,
  filterLabels: Map<string, string>,
): { markOfEvent: Map<number, CepMark>; anomalyCount: number } {
  const markOfEvent = new Map<number, CepMark>();
  for (const ch of r.chains) {
    for (const stp of ch.steps) {
      if (!markOfEvent.has(stp.event.id)) {
        markOfEvent.set(stp.event.id, {
          eventId: stp.event.id,
          ts: stp.event.ts,
          chainIndex: ch.chainIndex,
          color: g.color,
          anomaly: false,
          filterLabel: filterLabels.get(stp.filterId),
        });
      }
    }
  }
  let anomalyCount = 0;
  if (g.sequence?.anomalyEnabled) {
    for (const ev of r.uncoveredEvents) {
      if (markOfEvent.has(ev.id)) continue;
      anomalyCount++;
      markOfEvent.set(ev.id, {
        eventId: ev.id,
        ts: ev.ts,
        chainIndex: 0,
        color: g.color,
        anomaly: true,
      });
    }
  }
  // NOT 违规：覆盖为异常标记（保留原链号与来源 filter）
  for (const v of r.notViolations) {
    for (const ev of [v.fromEvent, v.toEvent]) {
      const prev = markOfEvent.get(ev.id);
      markOfEvent.set(ev.id, {
        eventId: ev.id,
        ts: prev?.ts ?? ev.ts,
        chainIndex: prev?.chainIndex ?? 0,
        color: g.color,
        anomaly: true,
        violation: true,
        filterLabel: prev?.filterLabel,
      });
    }
  }
  return { markOfEvent, anomalyCount };
}

/**
 * 从 sequenceResults 构建每分组的独立时间轴块。
 * 时间行仅由该组 CEP 结果事件的去重时间戳决定——与右侧 filter
 * 视图的时间轴（viewRange / 对齐行）完全无关。
 */
function buildBlocks(
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
  filterLabels: Map<string, string>,
): CepBlock[] {
  const out: CepBlock[] = [];
  for (const g of groups) {
    const r = sequenceResults[g.id];
    if (!r) continue;
    const { markOfEvent, anomalyCount } = collectMarks(g, r, filterLabels);
    const marksByTs = new Map<number, CepMark[]>();
    for (const mark of markOfEvent.values()) {
      let arr = marksByTs.get(mark.ts);
      if (!arr) {
        arr = [];
        marksByTs.set(mark.ts, arr);
      }
      arr.push(mark);
    }
    const rows = Array.from(marksByTs.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, marks]) => ({
        ts,
        marks: marks.sort((a, b) => a.chainIndex - b.chainIndex || a.eventId - b.eventId),
      }));
    out.push({
      groupId: g.id,
      label: g.label,
      color: g.color,
      chainCount: r.chains.length,
      anomalyCount,
      rows,
    });
  }
  return out;
}

/** CEP 规则筛选结果面板：独立时间纵轴（左区，仅在有结果时显示） */
export function CepTimelinePanel() {
  const groups = useLogStore((s) => s.groups);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const filters = useLogStore((s) => s.filters);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const selectEvent = useLogStore((s) => s.selectEvent);

  const blocks = useMemo(() => {
    const filterLabels = new Map(filters.map((f) => [f.id, f.label] as const));
    return buildBlocks(groups, sequenceResults, filterLabels);
  }, [groups, sequenceResults, filters]);

  if (blocks.length === 0) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>CEP 规则</span>
        <span className={styles.panelCount}>{blocks.length} 组规则</span>
      </div>
      <div className={styles.panelBody}>
        {blocks.map((b) => (
          <div key={b.groupId} className={styles.block}>
            <div className={styles.blockHeader} style={{ borderLeftColor: b.color }}>
              <span className={styles.blockDot} style={{ background: b.color }} />
              <span className={styles.blockTitle} title={b.label}>{b.label}</span>
              <span className={styles.blockStat}>
                {b.chainCount} 链{b.anomalyCount > 0 ? ` · ${b.anomalyCount} 异常` : ''}
              </span>
            </div>
            {b.rows.length === 0 ? (
              <div className={styles.blockEmpty}>无匹配事件</div>
            ) : (
              b.rows.map((row) => (
                <div key={row.ts} className={styles.tsRow}>
                  <span className={styles.tsLabel}>{formatTime(row.ts)}</span>
                  <span className={styles.marks}>
                    {row.marks.map((m) => (
                      <button
                        key={m.eventId}
                        className={[
                          styles.mark,
                          m.anomaly ? styles.markAnomaly : '',
                          m.eventId === selectedEventId ? styles.markSelected : '',
                        ].join(' ')}
                        style={m.anomaly ? undefined : { background: m.color }}
                        title={`链 ${m.chainIndex}${m.filterLabel ? ` · ${m.filterLabel}` : ''}${m.anomaly ? ' · 异常' : ''}${m.violation ? ' · NOT 违规' : ''}`}
                        onClick={() => selectEvent(m.eventId)}
                      >
                        {m.violation ? '⃠' : m.anomaly ? '✕' : m.chainIndex}
                      </button>
                    ))}
                  </span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
