import { useMemo } from 'react';
import { useLogStore } from '../store/logStore';
import { formatTime } from '../utils/timeFormat';
import type { Filter, FilterGroup, LogEvent, SequenceMatchResult } from '../types';
import styles from './CepTimelinePanel.module.css';

/** 行内单个节点图标（链上一步 / 异常 / 违规事件） */
interface CepNode {
  eventId: number;
  /** 图标色：链节点=来源 filter 色；异常/违规=红 */
  color: string;
  /** 悬浮提示：来源 filter 名 */
  filterLabel?: string;
  anomaly?: boolean;
  violation?: boolean;
}

/** CEP 面板一行：一条匹配链 / 一个异常事件 / 一对 NOT 违规 */
interface CepRow {
  /** 左侧计数：链=节点数；异常=1；违规=2 */
  count: number;
  startTs: number;
  endTs: number;
  /** 行类型（悬浮提示与样式） */
  kind: 'chain' | 'anomaly' | 'violation';
  /** 链号（链行标识；异常/违规为 0） */
  chainIndex: number;
  /** 右侧节点图标：有多少节点就有多少个 */
  nodes: CepNode[];
}

/** 一个 CEP 规则分组的块 */
interface CepBlock {
  groupId: string;
  label: string;
  color: string;
  chainCount: number;
  anomalyCount: number;
  /** 行按 startTs 升序 */
  rows: CepRow[];
}

/** 链行：count=节点数，图标=各步 filter 色块 */
function chainRow(
  g: FilterGroup,
  chain: SequenceMatchResult['chains'][number],
  filters: Map<string, Filter>,
): CepRow {
  return {
    count: chain.steps.length,
    startTs: chain.startTs,
    endTs: chain.endTs,
    kind: 'chain',
    chainIndex: chain.chainIndex,
    nodes: chain.steps.map((stp) => {
      const f = filters.get(stp.filterId);
      return {
        eventId: stp.event.id,
        color: f?.color ?? g.color,
        filterLabel: f?.label,
      };
    }),
  };
}

/** 从 sequenceResults 构建每分组的行列表（按 startTs 升序，时间纵轴与 filter 视图无关） */
function buildBlocks(
  groups: FilterGroup[],
  sequenceResults: Record<string, SequenceMatchResult>,
  filters: Map<string, Filter>,
): CepBlock[] {
  const out: CepBlock[] = [];
  for (const g of groups) {
    const r = sequenceResults[g.id];
    if (!r) continue;
    const rows: CepRow[] = r.chains.map((ch) => chainRow(g, ch, filters));
    let anomalyCount = 0;
    if (g.sequence?.anomalyEnabled) {
      for (const ev of r.uncoveredEvents) {
        anomalyCount++;
        rows.push({
          count: 1,
          startTs: ev.ts,
          endTs: ev.ts,
          kind: 'anomaly',
          chainIndex: 0,
          nodes: [{ eventId: ev.id, color: 'var(--danger, #e5484d)', anomaly: true }],
        });
      }
    }
    for (const v of r.notViolations) {
      const from = v.fromEvent as LogEvent;
      const to = v.toEvent as LogEvent;
      rows.push({
        count: 2,
        startTs: Math.min(from.ts, to.ts),
        endTs: Math.max(from.ts, to.ts),
        kind: 'violation',
        chainIndex: 0,
        nodes: [
          { eventId: from.id, color: 'var(--danger, #e5484d)', violation: true },
          { eventId: to.id, color: 'var(--danger, #e5484d)', violation: true },
        ],
      });
    }
    rows.sort((a, b) => a.startTs - b.startTs || a.chainIndex - b.chainIndex);
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

function rowTitle(row: CepRow): string {
  if (row.kind === 'chain') return `链 ${row.chainIndex} · ${row.count} 节点`;
  if (row.kind === 'violation') return `NOT 违规 · A 窗口内出现禁止事件`;
  return `异常 · 未被任何链覆盖`;
}

/** CEP 规则筛选结果面板：每行一条匹配链/异常（独立时间纵轴，仅在有结果时显示） */
export function CepTimelinePanel() {
  const groups = useLogStore((s) => s.groups);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const filters = useLogStore((s) => s.filters);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const focusEvent = useLogStore((s) => s.focusEvent);

  const blocks = useMemo(() => {
    const filterMap = new Map(filters.map((f) => [f.id, f] as const));
    return buildBlocks(groups, sequenceResults, filterMap);
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
              <div className={styles.blockEmpty}>无匹配结果</div>
            ) : (
              b.rows.map((row, ri) => (
                <div
                  key={`${row.startTs}-${ri}`}
                  className={`${styles.row} ${row.kind !== 'chain' ? styles.rowAnomaly : ''}`}
                  title={rowTitle(row)}
                >
                  <span className={styles.count}>{row.count}</span>
                  <span className={styles.timeRange}>
                    {formatTime(row.startTs)}
                    {row.endTs > row.startTs ? ` ~ ${formatTime(row.endTs)}` : ''}
                  </span>
                  <span className={styles.nodes}>
                    {row.nodes.map((n) => (
                      <button
                        key={n.eventId}
                        className={[
                          styles.node,
                          n.eventId === selectedEventId ? styles.nodeSelected : '',
                        ].join(' ')}
                        style={{ background: n.color }}
                        title={`${n.filterLabel ? n.filterLabel + ' · ' : ''}${n.anomaly ? '异常' : n.violation ? 'NOT 违规' : '点击跳转'}（事件 #${n.eventId}）`}
                        onClick={() => focusEvent(n.eventId)}
                      />
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
