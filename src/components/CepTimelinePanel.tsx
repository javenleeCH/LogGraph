import { useMemo, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatTime } from '../utils/timeFormat';
import type { Filter, FilterGroup, LogEvent, SequenceMatchResult } from '../types';
import styles from './CepTimelinePanel.module.css';
import { ChevronLeft, ChevronRight } from './Icon';

interface CepNode {
  eventId: number;
  /** 图标色：链节点=来源 filter 色；异常/违规=红 */
  color: string;
  /** 节点序号（链内第几步，1-based）——图标上显示的数字 */
  stepNo: number;
  /** 悬浮提示：来源 filter 名 */
  filterLabel?: string;
  anomaly?: boolean;
  violation?: boolean;
}

/** CEP 面板一行：一条匹配链 / 一个异常事件 / 一对 NOT 违规 */
interface CepRow {
  /** 行序号（块内按 startTime 排序后 1-based） */
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
  /** 超出渲染上限被截掉的行数（按时间序保留前 MAX_RENDER_ROWS 行） */
  omitted: number;
}

/**
 * 单组最多渲染的行数。大目录（百 MB 级）下宽松规则的链可达数十万条，
 * 全量渲染（每链一行、每步一个按钮）会把渲染进程 OOM 拖死——按时间序
 * 截断展示，真实链数仍显示在块头统计里。
 */
const MAX_RENDER_ROWS = 200;

/** 链行：节点=各步 filter 色块 + 链内步序号 */
function chainRow(
  g: FilterGroup,
  chain: SequenceMatchResult['chains'][number],
  filters: Map<string, Filter>,
): CepRow {
  return {
    count: 0,
    startTs: chain.startTs,
    endTs: chain.endTs,
    kind: 'chain',
    chainIndex: chain.chainIndex,
    nodes: chain.steps.map((stp, i) => {
      const f = filters.get(stp.filterId);
      return {
        eventId: stp.event.id,
        color: f?.color ?? g.color,
        stepNo: i + 1,
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
          count: 0,
          startTs: ev.ts,
          endTs: ev.ts,
          kind: 'anomaly',
          chainIndex: 0,
          nodes: [{ eventId: ev.id, color: 'var(--danger, #e5484d)', stepNo: 1, anomaly: true }],
        });
      }
    }
    for (const v of r.notViolations) {
      const from = v.fromEvent as LogEvent;
      const to = v.toEvent as LogEvent;
      rows.push({
        count: 0,
        startTs: Math.min(from.ts, to.ts),
        endTs: Math.max(from.ts, to.ts),
        kind: 'violation',
        chainIndex: 0,
        nodes: [
          { eventId: from.id, color: 'var(--danger, #e5484d)', stepNo: 1, violation: true },
          { eventId: to.id, color: 'var(--danger, #e5484d)', stepNo: 2, violation: true },
        ],
      });
    }
    rows.sort((a, b) => a.startTs - b.startTs || a.chainIndex - b.chainIndex);
    // 行序号：块内按 startTime 排序后 1-based
    rows.forEach((row, i) => {
      row.count = i + 1;
    });
    const omitted = Math.max(0, rows.length - MAX_RENDER_ROWS);
    out.push({
      groupId: g.id,
      label: g.label,
      color: g.color,
      chainCount: r.chains.length,
      anomalyCount,
      rows: rows.slice(0, MAX_RENDER_ROWS),
      omitted,
    });
  }
  return out;
}

function rowTitle(row: CepRow): string {
  if (row.kind === 'chain') return `链 ${row.chainIndex} · ${row.nodes.length} 节点`;
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
  // 面板收纳（收纳后留 24px 竖条作展开入口）
  const [collapsed, setCollapsed] = useState(false);

  const blocks = useMemo(() => {
    const filterMap = new Map(filters.map((f) => [f.id, f] as const));
    return buildBlocks(groups, sequenceResults, filterMap);
  }, [groups, sequenceResults, filters]);

  if (blocks.length === 0) return null;

  if (collapsed) {
    return (
      <div className={styles.panelCollapsed}>
        <button
          className={styles.collapseBtn}
          title="展开 CEP 规则面板"
          onClick={() => setCollapsed(false)}
        >
          <ChevronRight size={16} strokeWidth={2.5} />
        </button>
      </div>
    );
  }

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
                      >
                        {n.stepNo}
                      </button>
                    ))}
                  </span>
                </div>
              ))
            )}
            {b.omitted > 0 && (
              <div className={styles.blockMore}>
                已按时间序显示前 {MAX_RENDER_ROWS} 行，另有 {b.omitted} 条未渲染
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={styles.panelFooter}>
        <button
          className={styles.collapseBtn}
          title="收纳 CEP 面板"
          onClick={() => setCollapsed(true)}
        >
          <ChevronLeft size={16} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
