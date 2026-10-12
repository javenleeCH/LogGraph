import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatDateTime } from '../utils/timeFormat';
import { Link, AlertTriangle } from './Icon';
import type { FilterGroup, MatchedChain, LogEvent } from '../types';
import styles from './DetailPanel.module.css';

/** 区块内循环导航：cur<0 时按方向从第一条/最后一条开始 */
function navIdx(cur: number, dir: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (cur < 0) return dir > 0 ? 0 : count - 1;
  return (cur + dir + count) % count;
}

/** 区块标题右侧导航：‹ › 循环跳转 + 当前位置计数 */
function SeqNav({ count, cur, onNav }: { count: number; cur: number; onNav: (dir: 1 | -1) => void }) {
  if (count === 0) return null;
  return (
    <span className={styles['gm-nav']}>
      <span className={styles['gm-nav-pos']}>
        {cur < 0 ? `—` : cur + 1}/{count}
      </span>
      <button className={styles['gm-nav-btn']} onClick={() => onNav(-1)} title="上一条">
        ‹
      </button>
      <button className={styles['gm-nav-btn']} onClick={() => onNav(1)} title="下一条">
        ›
      </button>
    </span>
  );
}

/** group 匹配结果 tab：链列表 + 异常列表 + 筛选按钮 + 关键字检索 */
/** memo：group 引用稳定；缩放期间（correlatedEventIds 更新等父级重渲）跳过
 *  本组件重渲——2 万链 + 数十万 uncovered 的 DOM reconcile 是长帧来源 */
export const GroupMatchesTab = memo(function GroupMatchesTab({ group }: { group: FilterGroup }) {
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

  /** 三区块导航指针（-1=未开始；关键字过滤/mode 切换后数据变短时自动钳制） */
  const [chainIdx, setChainIdx] = useState(-1);
  const [violIdx, setViolIdx] = useState(-1);
  const [uncovIdx, setUncovIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  /** 指针越界（过滤后列表变短）时钳回范围 */
  if (chainIdx >= chains.length) setChainIdx(-1);
  if (violIdx >= violations.length) setViolIdx(-1);
  if (uncovIdx >= uncovered.length) setUncovIdx(-1);

  /** 跳转落地：时间线定位（选中+居中）+ 列表滚动到可视区 */
  useEffect(() => {
    if (chainIdx < 0) return;
    const ch = chains[chainIdx];
    if (!ch) return;
    focusEvent(ch.steps[0].event.id);
    listRef.current
      ?.querySelector(`[data-ci="${ch.chainIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [chainIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (violIdx < 0) return;
    const v = violations[violIdx];
    if (!v) return;
    focusEvent(v.fromEvent.id);
    listRef.current
      ?.querySelector(`[data-vi="${violIdx}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [violIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (uncovIdx < 0) return;
    const e = uncovered[uncovIdx];
    if (!e) return;
    focusEvent(e.id);
    listRef.current
      ?.querySelector(`[data-ui="${e.id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [uncovIdx]); // eslint-disable-line react-hooks/exhaustive-deps
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

      <div className={styles['gm-list']} ref={listRef}>
        {/* 匹配链 */}
        {showChains && (
          <>
            <div className={styles['gm-section-title']}>
              <span>匹配链（{chains.length}/{result.chains.length}）</span>
              <SeqNav count={chains.length} cur={chainIdx} onNav={(d) => setChainIdx(navIdx(chainIdx, d, chains.length))} />
            </div>
            {chains.length === 0 && (
              <div className={styles['gm-empty']}>无匹配链</div>
            )}
            {chains.map((ch, ci) => (
              <div
                key={ch.chainIndex}
                data-ci={ch.chainIndex}
                className={`${styles['gm-chain']} ${ci === chainIdx ? styles['gm-chain-current'] : ''}`}
              >
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
              <span>NOT 违规（{violations.length}）</span>
              <SeqNav count={violations.length} cur={violIdx} onNav={(d) => setViolIdx(navIdx(violIdx, d, violations.length))} />
            </div>
            {violations.map((v, i) => {
              const edge = group.sequence?.edges.find((e) => e.id === v.edgeId);
              return (
                <div
                  key={i}
                  data-vi={i}
                  className={`${styles['gm-step']} ${styles['gm-anomaly']} ${i === violIdx ? styles['gm-current'] : ''}`}
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
              <span>未覆盖事件（{result.uncoveredEvents.length}）</span>
              <SeqNav count={uncovered.length} cur={uncovIdx} onNav={(d) => setUncovIdx(navIdx(uncovIdx, d, uncovered.length))} />
            </div>
            {result.uncoveredEvents.length === 0 && (
              <div className={styles['gm-empty']}>全部事件均已匹配</div>
            )}
            {uncovered.map((e, ui) => (
              <div
                key={e.id}
                data-ui={e.id}
                className={`${styles['gm-step']} ${styles['gm-anomaly']} ${ui === uncovIdx ? styles['gm-current'] : ''}`}
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
});
