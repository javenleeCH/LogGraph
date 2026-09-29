import { useState, useCallback, useRef, useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { LogStreamView } from './components/LogStreamView';
import { TimelineCanvas } from './timeline/TimelineCanvas';
import { DetailPanel } from './components/DetailPanel';
import { SidePanel } from './components/SidePanel';
import { FilterChips } from './components/FilterChips';
import { GroupEditorPage, FilterDetailModal } from './components/NodeCanvasView';
import { useLogStore } from './store/logStore';
import {
  loadFromDataTransfer,
  loadTauriPaths,
  getDroppedDirectoryEntry,
  type LoadedFile,
} from './io/fileLoader';
import {
  listLogFiles,
  loadMultiple,
  loadDroppedDirectory,
  tauriPathAsDirectory,
  type MultiLoadResult,
} from './io/dirLoader';
import { setupTauriDragDrop } from './lib/tauri';
import { parseLoadedFile } from './parser/parseBridge';
import styles from './App.module.css';

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
  const [splitRatio, setSplitRatio] = useState(0.40);
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
  // 双通道：Tauri→Rust parse_log（path 直读）；浏览器/invoke 失败→JS 引擎
  const handleLoaded = useCallback(
    async (loaded: LoadedFile | null) => {
      if (!loaded) return;
      try {
        const result = await parseLoadedFile(loaded);
        setLog(result.events, result.rawLines, {
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

  // 把目录合并结果写入 store（浏览器拖拽目录 / Tauri 拖拽目录共用展示名）
  const applyDirectoryResult = useCallback(
    (result: MultiLoadResult, dirName: string, count: number) => {
      setLog(result.events, result.rawLines, {
        ...result.meta,
        fileName: `${dirName} (${count} 文件)`,
      });
    },
    [setLog],
  );

  // 加载一个目录句柄（Tauri 拖拽目录）：枚举 + 合并 + 写入 store
  const handleDirectory = useCallback(
    async (dirHandle: any, dirName: string) => {
      try {
        const list = await listLogFiles(dirHandle, { recursive: true });
        if (list.length === 0) {
          alert('该文件夹下没有可识别的日志文件（.log / .txt / .out / .csv / .tsv）');
          return;
        }
        const names = list.map((f) => f.name);
        const result = await loadMultiple(dirHandle, names);
        setLog(result.events, result.rawLines, {
          ...result.meta,
          fileName: `${dirName} (${names.length} 文件)`,
          fileSize: list.reduce((s, f) => s + f.size, 0),
        });
      } catch (err) {
        console.error(err);
        alert('加载文件夹失败：' + (err as Error).message);
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
          if (!paths.length) return;
          const dirHandle = await tauriPathAsDirectory(paths[0]);
          if (dirHandle) {
            await handleDirectory(dirHandle, dirHandle.name);
            return;
          }
          await handleLoaded(await loadTauriPaths(paths));
        } catch (err) {
          console.error(err);
          alert('加载失败：' + (err as Error).message);
        }
      },
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [handleLoaded, handleDirectory]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      // 目录拖拽（Chromium webkitGetAsEntry）
      const dirEntry = getDroppedDirectoryEntry(e.dataTransfer);
      if (dirEntry) {
        try {
          const res = await loadDroppedDirectory(dirEntry);
          if (res) applyDirectoryResult(res.result, dirEntry.name, res.count);
          else alert('该文件夹下没有可识别的日志文件（.log / .txt / .out / .csv / .tsv）');
        } catch (err) {
          console.error(err);
          alert('加载文件夹失败：' + (err as Error).message);
        }
        return;
      }
      // 单文件拖拽
      const loaded = await loadFromDataTransfer(e.dataTransfer);
      if (!loaded) return;
      await handleLoaded(loaded);
    },
    [handleLoaded, applyDirectoryResult],
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
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setDragOver(false);
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
            {showTimeline ? (
              <>
                <FilterChips />
                <TimelineCanvas />
              </>
            ) : (
              <LogStreamView />
            )}
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
        <div className={styles['drop-overlay']}>
          <div className={styles['drop-card']}>
            <div className={styles['drop-icon']}>
              <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
                <circle
                  cx="28"
                  cy="28"
                  r="25"
                  stroke="#8ab4f8"
                  strokeWidth="2"
                  strokeDasharray="6 6"
                />
                <path d="M28 14v20" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
                <path
                  d="M19 27l9 9 9-9"
                  stroke="#fff"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M18 42h20" stroke="#8ab4f8" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
            <div className={styles['drop-title']}>释放以加载日志</div>
            <div className={styles['drop-sub']}>
              支持 .log / .txt / .out / .csv / .tsv 文件或整个文件夹
            </div>
          </div>
        </div>
      )}
      {activeGroupId && <GroupEditorPage />}
      {editingFilterId && <FilterDetailModal />}
    </div>
  );
}
