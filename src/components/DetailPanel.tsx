import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLogStore, hitTsByLine } from '../store/logStore';
import { formatDateTime } from '../utils/timeFormat';
import { copyWithFallback } from '../utils/copyFlow';
import { getRawLine } from '../utils/rawLine';
import { levelStyle } from '../constants';
import { FileText, Copy } from './Icon';
import { GroupMatchesTab } from './GroupMatchesTab';
import { ContextStream } from './ContextStream';
import { fetchDbFiles, type DbFileInfo } from '../io/dbStore';
import styles from './DetailPanel.module.css';

/** 上下文行数可选档位（非 dbMode；dbMode 详情为无限上下文流） */
const CONTEXT_PRESETS = [4, 8, 16, 32, 64];
const DEFAULT_CONTEXT = 8;

/** 详情面板 tab 标识：'detail' = 事件详情；'group:<id>' = group 匹配结果 */
type DetailTab = string;

export function DetailPanel() {
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const matches = useLogStore((s) => s.matches);
  const events = useLogStore((s) => s.events);
  const rawLines = useLogStore((s) => s.rawLines);
  const dbMode = useLogStore((s) => s.dbMode);
  /** dbMode：文件清单（无限上下文流的行号→文件定位 + 右键打开 + 头部来源 tag） */
  const [dbFiles, setDbFiles] = useState<DbFileInfo[]>([]);
  const filters = useLogStore((s) => s.filters);
  const groups = useLogStore((s) => s.groups);
  const sequenceResults = useLogStore((s) => s.sequenceResults);
  const correlatedEventIds = useLogStore((s) => s.correlatedEventIds);
  const selectEvent = useLogStore((s) => s.selectEvent);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('detail');
  /** 上下文行数（选中行上下各取这么多行） */
  const [ctxSpan, setCtxSpan] = useState<number>(DEFAULT_CONTEXT);

  /**
   * 复制当前选中行。
   * dbMode 下 rawLines 为空，必须回源到 SQLite 拉这一行，否则复制出来是空字符串
   * （会被误判成「剪贴板不可用」）。自动复制全失败时 copyWithFallback 会弹
   * 手动复制窗口兜底。
   */
  const copySelectedLine = useCallback(async () => {
    const id = useLogStore.getState().selectedEventId;
    if (id === null) return;
    const text = await getRawLine(id);
    await copyWithFallback(text, {
      successTitle: '已复制原始行',
      successDetail: `第 ${id + 1} 行 · ${text.length} 字符`,
      fallbackTitle: '手动复制该行',
    });
  }, []);

  // 注：全局复制快捷键（Ctrl/⌘+C）集中登记在 CommandPalette 里，此处不再重复监听，
  // 否则一次按键会触发两遍复制。

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

  // dbMode：事件不物化（events=[]），用命中骨架查 ts 构造轻量对象
  // （selected 为命中行；raw/message 留空，上下文/详情由 dbCtx 拉取）
  const selected = useMemo(
    () =>
      selectedEventId !== null
        ? dbMode
          ? {
              id: selectedEventId,
              ts: hitTsByLine({ matches }, selectedEventId) ?? 0,
              raw: '',
              message: '',
            }
          : events.find((e) => e.id === selectedEventId)
        : undefined,
    [selectedEventId, dbMode, matches, events],
  );

  // 选中行时滚动到视图（非 dbMode；dbMode 由 ContextStream 的虚拟滚动定位）
  useEffect(() => {
    if (!dbMode && selected && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [selected, dbMode]);

  // dbMode：拉文件清单一次（目录切换 = dbMode 翻转时重拉；ContextStream 定位/右键用）
  useEffect(() => {
    if (!dbMode) {
      setDbFiles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const files = await fetchDbFiles();
        if (!cancelled) setDbFiles(files);
      } catch (err) {
        console.warn('[DetailPanel] 文件清单拉取失败:', err);
        if (!cancelled) setDbFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbMode]);

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
    void copyWithFallback(JSON.stringify(payload, null, 2), {
      successTitle: '已复制匹配链 JSON',
      fallbackTitle: '手动复制匹配链 JSON',
    });
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
          <Copy size={22} />
          <div style={{ marginTop: 10 }}>点击任意事件查看详情：原始行、上下文、时间戳与所属过滤器</div>
          <div style={{ marginTop: 6, opacity: 0.75 }}>
            选中后可按 <b>Ctrl / ⌘ + C</b> 直接复制该行原文
          </div>
        </div>
      </div>
    );
  }

  // 非 dbMode：±ctxSpan 固定窗口（数据全在内存，无懒加载需求）
  const startLine = Math.max(0, selected.id - ctxSpan);
  const endLine = Math.min(rawLines.length - 1, selected.id + ctxSpan);
  const ctxLines: { lineno: number; text: string; lineId: number }[] = [];
  for (let i = startLine; i <= endLine; i++) {
    ctxLines.push({ lineno: i + 1, text: rawLines[i] ?? '', lineId: i });
  }

  // dbMode：选中行所属文件（头部来源 tag；文件清单按 firstLine 升序 → 线性找最后一个 firstLine ≤ id 的）
  let selFile: DbFileInfo | undefined;
  let selSource: string | undefined = dbMode ? undefined : selected.sourceFile;
  if (dbMode) {
    for (const f of dbFiles) {
      if (f.firstLine <= selected.id) selFile = f;
      else break;
    }
    selSource = selFile?.name;
  }
  // v2（rg+瘦SQL）：瘦表不存 thread/level → dbMode 下隐藏这些 tag
  const selThread = dbMode ? undefined : selected.thread;
  const selLevel = dbMode ? undefined : selected.level;
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

        {/* 高频操作：复制原始行 / 调节上下文行数 */}
        {!dbMode && (
          <span className={styles.ctxCtrl}>
            <label htmlFor="lg-ctx" title="选中行上下各显示的上下文行数">
              上下文
            </label>
            <select
              id="lg-ctx"
              className={styles.ctxSelect}
              value={ctxSpan}
              onChange={(e) => setCtxSpan(Number(e.target.value))}
            >
              {CONTEXT_PRESETS.map((n) => (
                <option key={n} value={n}>
                  ±{n}
                </option>
              ))}
            </select>
          </span>
        )}
        <button
          className={styles.copyBtn}
          onClick={() => void copySelectedLine()}
          title="复制这一行的原始文本（Ctrl / ⌘ + C）"
        >
          <Copy size={12} />
          复制行
        </button>

        {selSource && (
          <span
            className={styles.tag}
            title={selFile ? `来源文件：${selFile.path}` : `来源文件：${selSource}`}
          >
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
      <div className={dbMode ? styles['detail-body-flush'] : styles['detail-body']}>
        {dbMode ? (
          <ContextStream files={dbFiles} selectedLine={selected.id} />
        ) : (
          ctxLines.map((l) => {
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
          })
        )}
      </div>
    </div>
  );
}
