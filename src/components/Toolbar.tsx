import { useRef } from 'react';
import { useLogStore } from '../store/logStore';
import { loadFile } from '../io/fileLoader';
import { LogParser } from '../parser/LogParser';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import {
  Diamond,
  FolderOpen,
  Folder,
  Table,
  BarChart,
  Database,
  Save,
  Maximize,
} from './Icon';
import styles from './Toolbar.module.css';
/* eslint-disable @typescript-eslint/no-explicit-any */

const parser = new LogParser();

export function Toolbar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const meta = useLogStore((s) => s.meta);
  const fullRange = useLogStore((s) => s.fullRange);
  const viewRange = useLogStore((s) => s.viewRange);
  const resetView = useLogStore((s) => s.resetView);
  const setLog = useLogStore((s) => s.setLog);
  const events = useLogStore((s) => s.events);
  const persistSupported = useLogStore((s) => s.persistSupported);
  const persistDirName = useLogStore((s) => s.persistDirName);
  const choosePersistDir = useLogStore((s) => s.choosePersistDir);
  const saveFiltersNow = useLogStore((s) => s.saveFiltersNow);
  const logsSupported = useLogStore((s) => s.persistSupported); // FSA 支持判定共用
  const logsDirName = useLogStore((s) => s.logsDirName);
  const chooseLogsDir = useLogStore((s) => s.chooseLogsDir);
  const splitOrientation = useLogStore((s) => s.splitOrientation);
  const setSplitOrientation = useLogStore((s) => s.setSplitOrientation);

  async function onFile(file: File) {
    try {
      const loaded = await loadFile(file);
      const result = parser.parse(loaded.text);
      setLog(result.events, loaded.text.split(/\r?\n/), {
        fileName: loaded.name,
        fileSize: loaded.size,
        totalLines: result.totalLines,
        skipped: result.skipped,
        timestampFormatId: result.timestampFormatId,
      });
    } catch (e) {
      console.error('解析日志失败', e);
      alert('解析日志失败：' + (e as Error).message);
    }
  }

  return (
    <div className={styles.toolbar}>
      <input
        ref={inputRef}
        type="file"
        accept=".log,.txt,.out,.csv,.tsv"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <div className={styles.brand}>
        <span className={styles.logo}>
          <Diamond size={16} />
        </span>
        <span>logGraph</span>
      </div>

      <div className={styles.sep} />

      <button className="primary" onClick={() => inputRef.current?.click()}>
        <FolderOpen size={14} />
        打开日志
      </button>

      {logsSupported && (
        <button
          className="ghost"
          onClick={chooseLogsDir}
          title={
            logsDirName
              ? `当前日志目录：${logsDirName}（点击重新选择）`
              : '选择一个日志文件夹，像 VS Code 一样浏览全部日志'
          }
        >
          <Folder size={14} />
          {logsDirName ?? '打开目录'}
        </button>
      )}

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

      {persistSupported && (
        <>
          <div className={styles.sep} />
          <button
            className="ghost"
            onClick={choosePersistDir}
            title={
              persistDirName
                ? `当前持久化目录：${persistDirName}（点击重新选择）`
                : '选择 .loggraph 目录以持久化过滤器'
            }
          >
            <Database size={14} />
            {persistDirName ?? '持久化目录'}
          </button>
          {persistDirName && (
            <button
              className="ghost"
              onClick={saveFiltersNow}
              title="立即保存过滤器到 filters.json"
            >
              <Save size={14} />
              保存
            </button>
          )}
        </>
      )}

      {meta && (
        <>
          <div className={styles.sep} />
          <div className={styles['file-info']}>
            <FolderOpen size={13} className={styles['file-info-icon']} />
            <span className={styles.fname}>{meta.fileName}</span>
            <span className={styles.stats}>
              {events.length.toLocaleString()} 行
              {meta.skipped > 0 ? ` · 跳过 ${meta.skipped}` : ''}
            </span>
          </div>
        </>
      )}

      <div className={styles.spacer} />

      {viewRange && fullRange && (
        <div className={styles['range-info']}>
          <span>
            <b>{formatDateTime(viewRange.start)}</b>
            <span className={styles.divider}>→</span>
            <b>{formatDateTime(viewRange.end)}</b>
          </span>
          <span className={styles.divider}>|</span>
          <span>窗宽 {formatDuration(viewRange.end - viewRange.start)}</span>
          <span className={styles.divider}>|</span>
          <span>总跨度 {formatDuration(fullRange.end - fullRange.start)}</span>
        </div>
      )}

      {viewRange && fullRange && (
        <button className="ghost" onClick={resetView} title="重置视图为全量">
          <Maximize size={14} />
          全量
        </button>
      )}
    </div>
  );
}
