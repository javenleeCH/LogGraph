import { useState, useCallback } from 'react';
import { Toolbar } from './components/Toolbar';
import { FilterBar } from './components/FilterBar';
import { TimelineCanvas } from './timeline/TimelineCanvas';
import { DetailPanel } from './components/DetailPanel';
import { useLogStore } from './store/logStore';
import { loadFromDataTransfer } from './io/fileLoader';
import { LogParser } from './parser/LogParser';
import styles from './App.module.css';

const parser = new LogParser();

export default function App() {
  const [dragOver, setDragOver] = useState(false);
  const setLog = useLogStore((s) => s.setLog);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const loaded = await loadFromDataTransfer(e.dataTransfer);
      if (!loaded) return;
      try {
        const result = parser.parse(loaded.text);
        setLog(result.events, loaded.text.split(/\r?\n/), {
          fileName: loaded.name,
          fileSize: loaded.size,
          totalLines: result.totalLines,
          skipped: result.skipped,
          timestampFormatId: result.timestampFormatId,
        });
      } catch (err) {
        console.error(err);
        alert('解析日志失败：' + (err as Error).message);
      }
    },
    [setLog],
  );

  return (
    <div
      className={styles.app}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <Toolbar />
      <FilterBar />
      <div className={styles['app-center']}>
        <TimelineCanvas />
        <DetailPanel />
      </div>
      {dragOver && (
        <div className={styles['drop-overlay']}>释放以加载日志文件</div>
      )}
    </div>
  );
}
