import { useRef } from 'react';
import { useLogStore } from '../store/logStore';
import { loadFile } from '../io/fileLoader';
import { LogParser } from '../parser/LogParser';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import styles from './Toolbar.module.css';

const parser = new LogParser();

export function Toolbar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const meta = useLogStore((s) => s.meta);
  const fullRange = useLogStore((s) => s.fullRange);
  const viewRange = useLogStore((s) => s.viewRange);
  const resetView = useLogStore((s) => s.resetView);
  const setLog = useLogStore((s) => s.setLog);
  const events = useLogStore((s) => s.events);

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
        <span className={styles.logo}>◈</span>
        <span>logGraph</span>
      </div>

      <div className={styles.sep} />

      <button className="primary" onClick={() => inputRef.current?.click()}>
        打开日志
      </button>

      {meta && (
        <>
          <div className={styles.sep} />
          <div className={styles['file-info']}>
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
            <span className={styles.divider}> → </span>
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
          全量
        </button>
      )}
    </div>
  );
}
