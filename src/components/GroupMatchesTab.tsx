import { useMemo, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatDateTime } from '../utils/timeFormat';
import { Link, AlertTriangle } from './Icon';
import type { FilterGroup, MatchedChain, LogEvent } from '../types';
import styles from './DetailPanel.module.css';

/** group 匹配结果 tab：链列表 + 异常列表 + 筛选按钮 + 关键字检索 */
export function GroupMatchesTab({ group }: { group: FilterGroup }) {
  const [keyword, setKeyword] = useState('');
  /** 内容筛选：all=匹配+异常；chains=仅匹配链；anomaly=仅异常 */
  const [mode, setMode] = useState<'all' | 'chains' | 'anomaly'>('all');
  const filters = useLogStore((s) => s.filters);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const focusEvent = useLogStore((s) => s.focusEvent);

  const result = sequenceResults[group.id];

  const anomalyCount = useMemo(() => {
    if (!result) return 0;
    return result.uncoveredEvents.length + result.notViolations.length;
  }, [result]);

  const kw = keyword.trim().toLowerCase();

  /** 关键字过滤链：任一步的 raw / filter label 命中即保留 */
  const chains = useMemo(() => {
    if (!result) return [] as MatchedChain[];
    if (!kw) return result.chains;
    return result.chains.filter((ch) =>
      ch.steps.some((st) => {
        const label = filters.find((f) => f.id === st.filterId)?.label ?? '';
        return (
          st.event.raw.toLowerCase().includes(kw) ||
          label.toLowerCase().includes(kw)
        );
      }),
    );
  }, [result, kw, filters]);

  /** 关键字过滤未覆盖事件（异常候选） */
  const uncovered = useMemo(() => {
    if (!result || mode === 'chains') return [] as LogEvent[];
    if (!kw) return result.uncoveredEvents;
    return result.uncoveredEvents.filter((e) =>
      e.raw.toLowerCase().includes(kw),
    );
  }, [result, kw, mode]);

  /** NOT 边违规（异常） */
  const violations = useMemo(() => {
    if (!result || mode === 'chains') return [];
    return result.notViolations;
  }, [result, mode]);

  if (!result) {
    return (
      <div className={styles['detail-empty']}>
        该分组未配置序列关系（无边），无匹配结果
      </div>
    );
  }

  const filterLabel = (fid: string) =>
    filters.find((f) => f.id === fid)?.label ?? fid;
  const filterColor = (fid: string) =>
    filters.find((f) => f.id === fid)?.color ?? 'var(--text-dim)';

  const showChains = mode !== 'anomaly';
  const showAnomaly = mode !== 'chains';

  return (
    <div className={styles['gm-root']}>
      {/* 筛选按钮组：全部 / 匹配 / 异常（可点击切换） */}
      <div className={styles['gm-stats']}>
        <button
          className={`${styles['gm-stat']} ${mode === 'all' ? styles['gm-stat-active'] : ''}`}
          onClick={() => setMode('all')}
          title="显示匹配链 + 异常"
        >
          全部
        </button>
        <button
          className={`${styles['gm-stat']} ${mode === 'chains' ? styles['gm-stat-active'] : ''}`}
          onClick={() => setMode('chains')}
          title="仅显示匹配链"
        >
          <Link size={12} />
          匹配 <b>{chains.length}</b>
        </button>
        <button
          className={`${styles['gm-stat']} ${mode === 'anomaly' ? styles['gm-stat-active'] : ''} ${anomalyCount > 0 && mode !== 'anomaly' ? styles['gm-stat-warn'] : ''}`}
          onClick={() => setMode('anomaly')}
          title="仅显示异常（未覆盖事件 + NOT 违规）"
        >
          <AlertTriangle size={12} />
          异常 <b>{anomalyCount}</b>
        </button>
      </div>

      {/* 检索框 */}
      <div className={styles['gm-search']}>
        <input
          className={styles['gm-input']}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="检索链内容 / 过滤器名…"
          spellCheck={false}
        />
        {keyword && (
          <button className="ghost" onClick={() => setKeyword('')} title="清空">
            ×
          </button>
        )}
      </div>

      <div className={styles['gm-list']}>
        {/* 匹配链 */}
        {showChains && (
          <>
            <div className={styles['gm-section-title']}>
              匹配链（{chains.length}/{result.chains.length}）
            </div>
            {chains.length === 0 && (
              <div className={styles['gm-empty']}>无匹配链</div>
            )}
            {chains.map((ch) => (
              <div key={ch.chainIndex} className={styles['gm-chain']}>
                <div className={styles['gm-chain-head']}>
                  <span className={styles['gm-chain-idx']} style={{ color: group.color }}>
                    ⛓ #{ch.chainIndex}
                  </span>
                  {ch.thread && (
                    <span className={styles['gm-chain-thread']}>{ch.thread}</span>
                  )}
                  <span className={styles['gm-chain-ts']}>
                    {formatDateTime(ch.startTs)} ~ {formatDateTime(ch.endTs)}
                  </span>
                </div>
                {ch.steps.map((st, i) => (
                  <div
                    key={i}
                    className={styles['gm-step']}
                    onClick={() => focusEvent(st.event.id)}
                    title={`点击定位到行 #${st.event.id + 1}`}
                  >
                    <span className={styles['gm-step-dot']} style={{ background: filterColor(st.filterId) }} />
                    <span className={styles['gm-step-label']} style={{ color: filterColor(st.filterId) }}>
                      {filterLabel(st.filterId)}
                    </span>
                    <span className={styles['gm-step-ts']}>{formatDateTime(st.event.ts)}</span>
                    <span className={styles['gm-step-raw']} title={st.event.raw}>
                      {st.event.raw}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {/* 异常：NOT 违规 */}
        {showAnomaly && violations.length > 0 && (
          <>
            <div className={styles['gm-section-title']}>
              NOT 违规（{violations.length}）
            </div>
            {violations.map((v, i) => {
              const edge = group.sequence?.edges.find((e) => e.id === v.edgeId);
              return (
                <div
                  key={i}
                  className={`${styles['gm-step']} ${styles['gm-anomaly']}`}
                  onClick={() => focusEvent(v.fromEvent.id)}
                  title={`在 ${filterLabel(edge?.fromFilterId ?? '')} 窗口内出现禁止的 ${filterLabel(edge?.toFilterId ?? '')}（点击定位源事件）`}
                >
                  <AlertTriangle size={11} className={styles['gm-warn-icon']} />
                  <span className={styles['gm-step-label']}>
                    {filterLabel(edge?.fromFilterId ?? '')} ✕ {filterLabel(edge?.toFilterId ?? '')}
                  </span>
                  <span className={styles['gm-step-ts']}>{formatDateTime(v.fromEvent.ts)}</span>
                  <span className={styles['gm-step-raw']} title={v.toEvent.raw}>
                    {v.toEvent.raw}
                  </span>
                </div>
              );
            })}
          </>
        )}

        {/* 异常：未覆盖事件 */}
        {showAnomaly && (
          <>
            <div className={styles['gm-section-title']}>
              未覆盖事件（{result.uncoveredEvents.length}）
            </div>
            {result.uncoveredEvents.length === 0 && (
              <div className={styles['gm-empty']}>全部事件均已匹配</div>
            )}
            {uncovered.map((e) => (
              <div
                key={e.id}
                className={`${styles['gm-step']} ${styles['gm-anomaly']}`}
                onClick={() => focusEvent(e.id)}
                title={`点击定位到行 #${e.id + 1}`}
              >
                <span className={styles['gm-step-dot']} style={{ background: 'var(--warn)' }} />
                <span className={styles['gm-step-label']}>{e.level ?? ''}</span>
                <span className={styles['gm-step-ts']}>{formatDateTime(e.ts)}</span>
                <span className={styles['gm-step-raw']} title={e.raw}>
                  {e.raw}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
