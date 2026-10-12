import { useMemo } from 'react';
import { useLogStore, selectEventCount } from '../store/logStore';
import { useTheme } from '../hooks/useTheme';
import { openSingleLogFile, openLogDirectory } from '../io/openLogFlow';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import { FolderOpen, Folder, Table, BarChart, Maximize, Sun, Moon, Search, Keyboard } from './Icon';
import { RangeChips } from './RangeChips';
import { RecentProjectsMenu } from './RecentProjectsMenu';
import { TimestampFormatEditor } from './TimestampFormatEditor';
import { useCommandPalette } from './CommandPalette';
import styles from './Toolbar.module.css';
/* eslint-disable @typescript-eslint/no-explicit-any */

const IS_MAC =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export function Toolbar() {
  const meta = useLogStore((s) => s.meta);
  const fullRange = useLogStore((s) => s.fullRange);
  const viewRange = useLogStore((s) => s.viewRange);
  const resetView = useLogStore((s) => s.resetView);
  const eventCount = useLogStore(selectEventCount);
  const matches = useLogStore((s) => s.matches);
  const filters = useLogStore((s) => s.filters);
  const selectedEventId = useLogStore((s) => s.selectedEventId);
  const logsSupported = useLogStore((s) => s.persistSupported); // FSA 支持判定（目录/工作区）
  const logsDirName = useLogStore((s) => s.logsDirName);
  const splitOrientation = useLogStore((s) => s.splitOrientation);
  const setSplitOrientation = useLogStore((s) => s.setSplitOrientation);
  const { theme, toggle } = useTheme();
  const setPaletteOpen = useCommandPalette();

  const showShortcuts = () =>
    window.dispatchEvent(new CustomEvent('loggraph-show-shortcuts'));

  // 命中统计只算「启用中」的过滤器：禁用项不该污染总量判断
  const hitInfo = useMemo(() => {
    const enabledIds = new Set(filters.filter((f) => f.enabled).map((f) => f.id));
    let total = 0;
    let activeCount = 0;
    for (const m of matches) {
      if (!enabledIds.has(m.filterId)) continue;
      activeCount += 1;
      total += m.events.length;
    }
    return { total, activeCount };
  }, [filters, matches]);

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
      <div className={styles.brand}>
        <span className={styles.logo}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 13h4l2-6 3 10 2-8 1.5 4H21"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span>logGraph</span>
      </div>

      <div className={styles.sep} />

      <button
        className="primary"
        onClick={() => void openSingleLogFile()}
        title="打开单个日志文件"
      >
        <FolderOpen size={14} />
        打开日志
      </button>

      {logsSupported && (
        <button
          className="ghost"
          onClick={() => void openLogDirectory()}
          title={
            logsDirName
              ? `当前日志目录：${logsDirName}（点击重新选择；工作区状态自动保存在目录内 .logGraph）`
              : '选择一个日志文件夹，像 VS Code 一样浏览全部日志（工作区状态自动保存在 .logGraph）'
          }
        >
          <Folder size={14} />
          {logsDirName ?? '打开目录'}
        </button>
      )}

      {/* 已载入日志时的最近项目 / 收藏夹入口（欢迎页之外也能切换项目） */}
      <RecentProjectsMenu />

      {/* 时间格式编辑器：内置预设识别不了时自定义（已载入才有意义） */}
      {meta && <TimestampFormatEditor />}

      <div className={styles['seg-control']} title="切换主视图模式">
        <button
          className={`${styles.segBtn} ${splitOrientation === 'vertical' ? styles.segBtnActive : ''}`}
          onClick={() => setSplitOrientation('vertical')}
          title="表格流（LogStreamView）"
        >
          <Table size={14} />
          <span>表格流</span>
        </button>
        <button
          className={`${styles.segBtn} ${splitOrientation === 'horizontal' ? styles.segBtnActive : ''}`}
          onClick={() => setSplitOrientation('horizontal')}
          title="时间线画布（TimelineCanvas）"
        >
          <BarChart size={14} />
          <span>时间线</span>
        </button>
      </div>



      <div className={styles.spacer} />

      {/* 命令面板入口：把散落各处的操作收敛到一处可搜索入口 */}
      <button
        className={styles.paletteBtn}
        onClick={() => setPaletteOpen(true)}
        title="命令面板：搜索并执行任意操作"
      >
        <Search size={13} />
        <span className={styles.paletteLabel}>命令面板</span>
        <kbd className={styles.paletteKbd}>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <button
        className="ghost"
        onClick={toggle}
        title={theme === 'dark' ? '切换到浅色主题' : '切换到暗黑主题'}
        aria-label="切换主题"
      >
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      </button>

      <button
        className="ghost"
        onClick={showShortcuts}
        title="键盘快捷键速查表（?）"
        aria-label="快捷键速查"
      >
        <Keyboard size={14} />
      </button>
      </div>

      {viewRange && fullRange && (
        <div className={styles.statusbar}>
          <div className={styles['status-left']}>
            {meta && (
              <span className={styles['status-file']}>
                {meta.fileName} · {eventCount.toLocaleString()} 行
                {meta.skipped > 0 ? ` · 跳过 ${meta.skipped}` : ''}
              </span>
            )}
          </div>
          <div className={styles['status-right']}>
            {hitInfo.total > 0 && (
              <span
                className={styles['status-pill']}
                title={`${hitInfo.activeCount} 个启用中的过滤器共命中 ${hitInfo.total} 条事件`}
              >
                命中 {hitInfo.total.toLocaleString()}
              </span>
            )}
            {selectedEventId !== null && (
              <span className={styles['status-line']} title="当前选中行（Ctrl / ⌘ + C 复制原文）">
                选中 #{selectedEventId + 1}
              </span>
            )}
            <span className={styles['status-range']}>
              <b>{formatDateTime(viewRange.start)}</b>
              <span className={styles.divider}>→</span>
              <b>{formatDateTime(viewRange.end)}</b>
            </span>
            <span className={styles['status-pill']}>窗宽 {formatDuration(viewRange.end - viewRange.start)}</span>
            <span className={styles['status-pill']}>总跨度 {formatDuration(fullRange.end - fullRange.start)}</span>
            <RangeChips />
            <button className={styles['status-btn']} onClick={resetView} title="重置视图为全量">
              <Maximize size={12} />
              全量
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
