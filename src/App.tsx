import { useState, useCallback, useRef, useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { LogStreamView } from './components/LogStreamView';
import { TimelineCanvas } from './timeline/TimelineCanvas';
import { DetailPanel } from './components/DetailPanel';
import { SidePanel } from './components/SidePanel';
import { GroupEditorPage, FilterDetailModal } from './components/NodeCanvasView';
import { useLogStore } from './store/logStore';
import { loadFromDataTransfer, loadTauriPaths, type LoadedFile } from './io/fileLoader';
import { setupTauriDragDrop } from './lib/tauri';
import { LogParser } from './parser/LogParser';
import styles from './App.module.css';

const parser = new LogParser();

export default function App() {
  const [dragOver, setDragOver] = useState(false);
  const setLog = useLogStore((s) => s.setLog);
  const initPersistence = useLogStore((s) => s.initPersistence);
  const initLogsDir = useLogStore((s) => s.initLogsDir);
  const logsDirHandle = useLogStore((s) => s.logsDirHandle);
  const splitOrientation = useLogStore((s) => s.splitOrientation);
  const activeGroupId = useLogStore((s) => s.activeGroupId);
  const editingFilterId = useLogStore((s) => s.editingFilterId);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const persistDirName = useLogStore((s) => s.persistDirName);
  const events = useLogStore((s) => s.events);

  // 左侧文件树 / 主区域 可拖拽分隔：treeRatio = 文件树占比 [0, 0.4]
  const [treeRatio, setTreeRatio] = useState(0.18);
  const treeDragging = useRef(false);

  const onTreeSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    treeDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // 上方视图组件切换：横排(init版)=TimelineCanvas，竖排(当前)=LogStreamView
  // splitOrientation 来自 store（Toolbar 切换）；splitRatio = 详情面板占比 [0.12, 0.85]
  const [splitRatio, setSplitRatio] = useState(0.34);
  const centerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const showTimeline = splitOrientation === 'horizontal';

  const onSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // 启动时恢复持久化目录 + 日志目录句柄
  useEffect(() => {
    initPersistence();
    initLogsDir();
  }, [initPersistence, initLogsDir]);

  // 横向文件树分隔拖拽
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!treeDragging.current) return;
      const w = window.innerWidth;
      if (w <= 0) return;
      let ratio = e.clientX / w;
      ratio = Math.max(0.05, Math.min(0.4, ratio));
      setTreeRatio(ratio);
    };
    const onUp = () => {
      if (treeDragging.current) {
        treeDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 加载日志后若已有持久化目录，自动把过滤器写入一次（保证文件与状态同步）
  const dirNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (persistDirName) dirNameRef.current = persistDirName;
  }, [persistDirName]);
  useEffect(() => {
    if (dirNameRef.current && events.length > 0) {
      useLogStore.getState().saveFiltersNow();
    }
  }, [events.length]);

  // 上方视图 / 详情面板 上下分隔拖拽（两种模式均纵向堆叠）
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !centerRef.current) return;
      const rect = centerRef.current.getBoundingClientRect();
      const h = rect.height;
      if (h <= 0) return;
      // 详情在下方，占比 = (底部 - 鼠标Y) / 高度
      let ratio = (rect.bottom - e.clientY) / h;
      ratio = Math.max(0.12, Math.min(0.85, ratio));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 解析并载入一段日志文本（浏览器拖拽 / Tauri 原生拖拽共用）
  const handleLoaded = useCallback(
    async (loaded: LoadedFile | null) => {
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

  // Tauri 原生拖拽：浏览器下为 no-op，不注册任何监听
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    setupTauriDragDrop({
      onDragOver: () => setDragOver(true),
      onDragLeave: () => setDragOver(false),
      onDrop: async (paths) => {
        setDragOver(false);
        try {
          await handleLoaded(await loadTauriPaths(paths));
        } catch (err) {
          console.error(err);
          alert('加载日志失败：' + (err as Error).message);
        }
      },
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [handleLoaded]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const loaded = await loadFromDataTransfer(e.dataTransfer);
      if (!loaded) return;
      await handleLoaded(loaded);
    },
    [handleLoaded],
  );

  const topFlex = 1 - splitRatio;

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
      <div className={styles['main-row']}>
        {logsDirHandle && (
          <>
            <div
              className={styles.treePane}
              style={{ flex: `${treeRatio} 1 0` }}
            >
              <SidePanel />
            </div>
            <div
              className={styles['resizer-v']}
              onMouseDown={onTreeSplitMouseDown}
              title="拖拽调节左侧栏宽度"
            />
          </>
        )}
        <div
          ref={centerRef}
          className={styles['app-center']}
          style={{ flex: `${logsDirHandle ? (1 - treeRatio) : 1} 1 0` }}
        >
          <div className={styles.paneTop} style={{ flex: `${topFlex} 1 0` }}>
            {showTimeline ? <TimelineCanvas /> : <LogStreamView />}
          </div>
          <div
            className={styles.resizer}
            onMouseDown={onSplitMouseDown}
            title="拖拽调节上下区域高度"
          />
          <div className={styles.paneBottom} style={{ flex: `${splitRatio} 1 0` }}>
            <DetailPanel />
          </div>
        </div>
      </div>
      {dragOver && (
        <div className={styles['drop-overlay']}>释放以加载日志文件</div>
      )}
      {activeGroupId && <GroupEditorPage />}
      {editingFilterId && <FilterDetailModal />}
    </div>
  );
}
