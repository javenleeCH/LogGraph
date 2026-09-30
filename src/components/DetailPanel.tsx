import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatDateTime } from '../utils/timeFormat';
import { levelStyle } from '../constants';
import { FileText } from './Icon';
import { GroupMatchesTab } from './GroupMatchesTab';
import type { DbContextRow } from '../io/dbStore';
import styles from './DetailPanel.module.css';

const CONTEXT_LINES = 4;

/** 详情面板 tab 标识：'detail' = 事件详情；'group:<id>' = group 匹配结果 */
type DetailTab = string;

export function DetailPanel() {
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const events = useLogStore((s) => s.events);
  const rawLines = useLogStore((s) => s.rawLines);
  const dbMode = useLogStore((s) => s.dbMode);
  /** dbMode：选中事件 ±CONTEXT_LINES 的真实行（异步拉取） */
  const [dbCtx, setDbCtx] = useState<DbContextRow[] | null>(null);
  const dbCtxSeq = useRef(0);
  const matches = useLogStore((s) => s.matches);
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const correlatedEventIds = useLogStore((s) => s.correlatedEventIds);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('detail');

  // group 匹配 tab 是否展示（配置了序列关系且有匹配结果）
  const seqGroups = useMemo(
    () => groups.filter((g) => sequenceResults[g.id]),
    [groups, sequenceResults],
  );

  // group 被删除时若其 tab 激活，回落到详情 tab
  useEffect(() => {
    if (activeTab !== 'detail' && !seqGroups.some((g) => `group:${g.id}` === activeTab)) {
      setActiveTab('detail');
    }
  }, [seqGroups, activeTab]);

  const selected = useMemo(
    () =>
      selectedEventId !== null
        ? events.find((e) => e.id === selectedEventId)
        : undefined,
    [selectedEventId, events],
  );

  // 选中行时滚动到视图
  useEffect(() => {
    if (selected && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selected]);

  // dbMode：选中事件 → 异步拉取 ±CONTEXT_LINES 上下文（带序号防过期覆盖）
  useEffect(() => {
    if (!dbMode || selectedEventId === null) {
      setDbCtx(null);
      return;
    }
    const seq = ++dbCtxSeq.current;
    const from = Math.max(0, selectedEventId - CONTEXT_LINES);
    const to = selectedEventId + CONTEXT_LINES;
    void (async () => {
      try {
        const { fetchContextLines } = await import('../io/dbStore');
        const rows = await fetchContextLines(from, to);
        if (dbCtxSeq.current === seq) setDbCtx(rows);
      } catch (err) {
        console.warn('[DetailPanel] db 上下文拉取失败:', err);
        if (dbCtxSeq.current === seq) setDbCtx([]);
      }
    })();
  }, [dbMode, selectedEventId]);

  const owningFilters = useMemo(() => {
    if (!selected) return [];
    return filters.filter((f) =>
      matches.find((m) => m.filterId === f.id)?.events.some(
        (e) => e.id === selected.id,
      ),
    );
  }, [selected, filters, matches]);

  // 选中事件所属的匹配链（MEASURES 展示）
  const owningChain = useMemo(() => {
    if (!selected) return null;
    for (const g of groups) {
      const r = sequenceResults[g.id];
      if (!r) continue;
      for (const ch of r.chains) {
        if (ch.steps.some((st) => st.event.id === selected.id)) {
          return { group: g, chain: ch };
        }
      }
    }
    return null;
  }, [selected, groups, sequenceResults]);

  const copyChainJson = () => {
    if (!owningChain) return;
    const { group, chain } = owningChain;
    const payload = {
      group: group.label,
      chainIndex: chain.chainIndex,
      thread: chain.thread ?? null,
      startTs: chain.startTs,
      endTs: chain.endTs,
      measures: chain.steps.map((st) => ({
        filter: filters.find((f) => f.id === st.filterId)?.label ?? st.filterId,
        ts: st.event.ts,
        thread: st.event.thread ?? null,
        level: st.event.level ?? null,
        sourceFile: st.event.sourceFile ?? null,
        raw: st.event.raw,
      })),
    };
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  };

  const activeGroupId = activeTab.startsWith('group:')
    ? activeTab.slice(6)
    : null;
  const activeGroup = activeGroupId
    ? groups.find((g) => g.id === activeGroupId)
    : undefined;

  // ===== group 匹配 tab =====
  if (activeGroup) {
    return (
      <div className={styles.detail}>
        <div className={styles['detail-header']}>
          <button
            className={`${styles.tabBtn} ${styles.tabBtnActive}`}
            style={{ borderColor: activeGroup.color, color: activeGroup.color }}
          >
            匹配结果
          </button>
          {seqGroups
            .filter((g) => g.id !== activeGroup.id)
            .map((g) => {
              const r = sequenceResults[g.id];
              const anomaly =
                r.uncoveredEvents.length + r.notViolations.length;
              return (
                <button
                  key={g.id}
                  className={styles.tabBtn}
                  onClick={() => setActiveTab(`group:${g.id}`)}
                  title={`切换到「${g.label}」匹配结果`}
                >
                  <span className={styles.tabDot} style={{ background: g.color }} />
                  {g.label}
                  <span className={styles.tabBadge}>{r.chains.length}</span>
                  {anomaly > 0 && (
                    <span className={`${styles.tabBadge} ${styles.tabBadgeWarn}`}>
                      {anomaly}
                    </span>
                  )}
                </button>
              );
            })}
          <span className={styles.tabSep} />
          <button
            className={styles.tabBtn}
            onClick={() => setActiveTab('detail')}
          >
            详情
          </button>
        </div>
        <GroupMatchesTab group={activeGroup} />
      </div>
    );
  }

  // ===== 详情 tab =====
  if (!selected) {
    return (
      <div className={styles.detail}>
        <div className={styles['detail-header']}>
          <button className={`${styles.tabBtn} ${styles.tabBtnActive}`}>详情</button>
          {seqGroups.map((g) => {
            const r = sequenceResults[g.id];
            const anomaly = r.uncoveredEvents.length + r.notViolations.length;
            return (
              <button
                key={g.id}
                className={styles.tabBtn}
                onClick={() => setActiveTab(`group:${g.id}`)}
                title={`查看「${g.label}」匹配结果`}
              >
                <span className={styles.tabDot} style={{ background: g.color }} />
                {g.label}
                <span className={styles.tabBadge}>{r.chains.length}</span>
                {anomaly > 0 && (
                  <span className={`${styles.tabBadge} ${styles.tabBadgeWarn}`}>
                    {anomaly}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className={styles['detail-empty']}>
          点击时间线上的事件以查看详情与上下文行
        </div>
      </div>
    );
  }

  // dbMode：上下文来自异步拉取的 dbCtx（行文本真值）；selected 的 thread/level 也从 dbCtx 补
  const dbSel = dbMode
    ? dbCtx?.find((r) => r.no === selected.id)
    : undefined;
  const startLine = Math.max(0, selected.id - CONTEXT_LINES);
  const endLine = Math.min(rawLines.length - 1, selected.id + CONTEXT_LINES);
  const ctxLines: { lineno: number; text: string; lineId: number }[] = [];
  if (dbMode) {
    for (const r of dbCtx ?? []) {
      ctxLines.push({ lineno: r.no + 1, text: r.text, lineId: r.no });
    }
    if (!dbCtx) {
      ctxLines.push({ lineno: selected.id + 1, text: '加载上下文…', lineId: selected.id });
    }
  } else {
    for (let i = startLine; i <= endLine; i++) {
      ctxLines.push({ lineno: i + 1, text: rawLines[i] ?? '', lineId: i });
    }
  }

  const selThread = dbMode ? dbSel?.thread : selected.thread;
  const selLevel = dbMode ? dbSel?.level : selected.level;
  const selSource = dbMode ? dbSel?.sourceFile : selected.sourceFile;
  const lvlStyle = levelStyle(selLevel);

  return (
    <div className={styles.detail}>
      <div className={styles['detail-header']}>
        <button
          className={`${styles.tabBtn} ${activeTab === 'detail' ? styles.tabBtnActive : ''}`}
          onClick={() => setActiveTab('detail')}
        >
          详情
        </button>
        {seqGroups.map((g) => {
          const r = sequenceResults[g.id];
          const anomaly = r.uncoveredEvents.length + r.notViolations.length;
          return (
            <button
              key={g.id}
              className={`${styles.tabBtn} ${activeTab === `group:${g.id}` ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab(`group:${g.id}`)}
              title={`查看「${g.label}」匹配结果`}
            >
              <span className={styles.tabDot} style={{ background: g.color }} />
              {g.label}
              <span className={styles.tabBadge}>{r.chains.length}</span>
              {anomaly > 0 && (
                <span className={`${styles.tabBadge} ${styles.tabBadgeWarn}`}>
                  {anomaly}
                </span>
              )}
            </button>
          );
        })}
        <span className={styles.spacer} />
        <span className={styles.linenum}>行 #{selected.id + 1}</span>
        <span className={styles.ts}>{formatDateTime(selected.ts)}</span>
        {selSource && (
          <span className={styles.tag} title={`来源文件：${selSource}`}>
            <FileText size={11} />
            {selSource}
          </span>
        )}
        {selThread && (
          <span className={styles.tag}>{selThread}</span>
        )}
        {selLevel && (
          <span
            className={`${styles.tag} ${styles.level}`}
            style={lvlStyle}
          >
            {selLevel}
          </span>
        )}
        {owningFilters.map((f) => (
          <span
            key={f.id}
            className={styles.tag}
            style={{ borderColor: f.color, color: f.color }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: f.color,
              }}
            />
            {f.label}
          </span>
        ))}
      </div>
      {/* 匹配链卡片（MEASURES）：选中事件在链上时展示整链 */}
      {owningChain && (
        <div
          className={styles.tag}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 4,
            margin: '0 12px 8px',
            padding: '8px 10px',
            border: `1px solid ${owningChain.group.color}`,
            borderRadius: 8,
            background: 'var(--bg-panel)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span style={{ color: owningChain.group.color }}>
              ⛓ 链 #{owningChain.chain.chainIndex}
            </span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
              {owningChain.group.label}
              {owningChain.chain.thread ? ` · ${owningChain.chain.thread}` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="ghost"
              style={{ fontSize: 11, padding: '1px 8px' }}
              onClick={copyChainJson}
              title="复制链 MEASURES 为 JSON（各步 ts/thread/level/raw）"
            >
              复制 JSON
            </button>
          </div>
          {owningChain.chain.steps.map((st, i) => {
            const stFilter = filters.find((f) => f.id === st.filterId);
            const isSel = st.event.id === selected.id;
            return (
              <div
                key={i}
                onClick={() => selectEvent(st.event.id)}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: '2px 4px',
                  borderRadius: 5,
                  background: isSel ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                <span
                  style={{
                    color: stFilter?.color ?? 'var(--text-dim)',
                    fontWeight: 600,
                    minWidth: 60,
                  }}
                >
                  {stFilter?.label ?? st.filterId}
                </span>
                <span style={{ color: 'var(--text-faint)' }}>
                  {formatDateTime(st.event.ts)}
                </span>
                <span
                  style={{
                    color: 'var(--text-dim)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                  title={st.event.raw}
                >
                  {st.event.raw}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className={styles['detail-body']}>
        {ctxLines.map((l) => {
          const isSelected = l.lineId === selected.id;
          const isCorrelated = correlatedEventIds.has(l.lineId);
          const cls = [
            styles['ctx-line'],
            isSelected ? styles.selected : '',
            isCorrelated && !isSelected ? styles.correlated : '',
            !isSelected && !isCorrelated ? styles.context : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={l.lineId}
              ref={isSelected ? selectedRef : undefined}
              className={cls}
              onClick={() => selectEvent(l.lineId)}
              style={{ cursor: 'pointer' }}
            >
              <span className={styles.lineno}>{l.lineno}</span>
              <span className={styles.content}>{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
