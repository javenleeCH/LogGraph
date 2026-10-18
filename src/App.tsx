import { useState, useCallback, useRef, useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { LogStreamView } from './components/LogStreamView';
import { TimelineCanvas } from './timeline/TimelineCanvas';
import { DetailPanel } from './components/DetailPanel';
import { SidePanel } from './components/SidePanel';
import { ChevronLeft, ChevronRight } from './components/Icon';
import { FilterChips } from './components/FilterChips';
import { GroupEditorPage, FilterDetailModal } from './components/NodeCanvasView';
import { useLogStore, selectEventCount } from './store/logStore';
import {
  loadFromDataTransfer,
  loadTauriPaths,
  getDroppedDirectoryEntry,
  getDroppedDirectoryHandle,
} from './io/fileLoader';
import { ingestLoadedFile } from './io/openLogFlow';
import {
  listLogFiles,
  loadMultiple,
  loadDroppedDirectory,
  tauriPathAsDirectory,
  type MultiLoadResult,
} from './io/dirLoader';
import { recordOpenProject } from './io/recentProjects';
import { setupTauriDragDrop, isTauri } from './lib/tauri';
import { ensureRegexWasm } from './filters/regexWasm';
import { ensureCepWasm } from './sequence/cepWasm';
import { startTailWatcher, stopTailWatcher } from './io/tailWatcher';
import { ParserDriftBanner } from './components/ParserDriftBanner';
import { ToastHost, BusyIndicator } from './components/ToastHost';
import { CommandPalette } from './components/CommandPalette';
import { ManualCopyDialog } from './components/ManualCopyDialog';
import { WelcomeState, NoFilterState } from './components/EmptyState';
import { beginBusy, toast } from './store/uiStore';
import { LOG_EXT_HINT } from './constants';
import styles from './App.module.css';

export default function App() {
  const [dragOver, setDragOver] = useState(false);
  const setLog = useLogStore((s) => s.setLog);
  const initLogsDir = useLogStore((s) => s.initLogsDir);
  const logsDirHandle = useLogStore((s) => s.logsDirHandle);
  const splitOrientation = useLogStore((s) => s.splitOrientation);
  const activeGroupId = useLogStore((s) => s.activeGroupId);
  const editingFilterId = useLogStore((s) => s.editingFilterId);
  const filters = useLogStore((s) => s.filters);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const workspaceDirName = useLogStore((s) => s.workspaceDirName);
  const eventCount = useLogStore(selectEventCount);
  const sessionFiles = useLogStore((s) => s.sessionFiles);
  const fullRange = useLogStore((s) => s.fullRange);

  // 左侧文件树 / 主区域 可拖拽分隔：treeRatio = 文件树占比 [0, 0.4]
  const [treeRatio, setTreeRatio] = useState(0.18);
  // 左侧栏整体收纳（收纳后留 24px 竖条作展开入口）
  const [sideCollapsed, setSideCollapsed] = useState(false);
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
  // 表格流 / 时间线 由 splitOrientation 决定；dbMode（SQLite 驻留）下 LogStreamView 会惰性加载行文本
  const showTimeline = splitOrientation === 'horizontal';

  const onSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // 启动时恢复日志目录句柄 + 其 .logGraph 工作区状态
  useEffect(() => {
    initLogsDir();
  }, [initLogsDir]);

  // 预热 wasm 正则引擎：Web 端过滤改用与桌面端同一 Rust regex crate（§1.1 引擎统一）。
  // 异步加载，失败自动回退 JS RegExp（结果可能与桌面端不一致，静默降级）。
  // 仅 Web 预热：桌面 dbMode 过滤全在 Rust 侧，无需加载 wasm（桌面非 dbMode
  // 会在首次过滤时由 FilterEngine 惰性触发加载）。
  useEffect(() => {
    if (!isTauri()) void ensureRegexWasm();
  }, []);

  // 预热 wasm CEP 引擎：与桌面 native 同一份 cep.rs，是 Web 端唯一序列引擎
  // （TS 副本已删除）。启动即加载，让加载窗口与日志解析重叠——CEP 需要
  // 时它基本已就绪；未就绪时 recomputeSequences 延后到 onCepWasmSettled 重算，
  // 不再有静默回退。
  useEffect(() => {
    void ensureCepWasm();
  }, []);

  // 启动实时 tail 轮询器（C 阶段一）：全局 1s 定时器，仅单文件 standalone 且
  // 用户开启「实时跟随」时真正读文件；其余情况空转，开销可忽略。
  useEffect(() => {
    startTailWatcher();
    return () => stopTailWatcher();
  }, []);

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

  // 加载日志后若已绑定工作区，自动把当前状态写入一次（保证文件与状态同步）
  const wsDirNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (workspaceDirName) wsDirNameRef.current = workspaceDirName;
  }, [workspaceDirName]);
  useEffect(() => {
    if (wsDirNameRef.current && eventCount > 0) {
      useLogStore.getState().saveFiltersNow();
    }
  }, [eventCount]);

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
      const endBusy = beginBusy(`扫描 ${dirName}`);
      try {
        const list = await listLogFiles(dirHandle, { recursive: true });
        if (list.length === 0) {
          toast.warn('没有找到可识别的日志文件', `支持 ${LOG_EXT_HINT}`);
          return;
        }
        const names = list.map((f) => f.name);
        const result = await loadMultiple(dirHandle, names);
        setLog(result.events, result.rawLines, {
          ...result.meta,
          fileName: `${dirName} (${names.length} 文件)`,
          fileSize: list.reduce((s, f) => s + f.size, 0),
        });
        toast.success(
          `已载入目录 ${dirName}`,
          `${names.length} 个文件 · ${result.events.length.toLocaleString()} 条事件`,
        );
      } catch (err) {
        console.error(err);
        toast.error('加载文件夹失败', (err as Error).message);
      } finally {
        endBusy();
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
            // 目录即工作区：先绑定 .logGraph（恢复存档/继承播种），再加载日志
            await useLogStore.getState().openWorkspace(dirHandle);
            await handleDirectory(dirHandle, dirHandle.name);
            await recordOpenProject({ name: dirHandle.name, kind: 'dir', path: paths[0] });
            return;
          }
          const loaded = await loadTauriPaths(paths);
          if (loaded) await ingestLoadedFile(loaded);
        } catch (err) {
          console.error(err);
          toast.error('加载失败', (err as Error).message);
        }
      },
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [handleDirectory]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      // 注意：DataTransfer.items 在首个 await 后失效，两路目录句柄都必须同步先取
      const dirHandlePromise = getDroppedDirectoryHandle(e.dataTransfer);
      // 目录拖拽（Chromium webkitGetAsEntry，兜底路径）
      const dirEntry = getDroppedDirectoryEntry(e.dataTransfer);
      // 优先 FSA 句柄：可绑定 .logGraph 工作区（拖放手势内提权写权限）
      const dirHandle = await dirHandlePromise;
      if (dirHandle) {
        try {
          await useLogStore.getState().openWorkspace(dirHandle);
          const list = await listLogFiles(dirHandle, { recursive: true });
          if (list.length === 0) {
            toast.warn('没有找到可识别的日志文件', `支持 ${LOG_EXT_HINT}`);
            return;
          }
          const names = list.map((f) => f.name);
          const result = await loadMultiple(dirHandle, names);
          applyDirectoryResult(result, dirHandle.name, names.length);
          await recordOpenProject({ name: dirHandle.name, kind: 'dir', handle: dirHandle });
        } catch (err) {
          console.error(err);
          toast.error('加载文件夹失败', (err as Error).message);
        }
        return;
      }
      if (dirEntry) {
        try {
          const res = await loadDroppedDirectory(dirEntry);
          if (res) applyDirectoryResult(res.result, dirEntry.name, res.count);
          else toast.warn('没有找到可识别的日志文件', `支持 ${LOG_EXT_HINT}`);
        } catch (err) {
          console.error(err);
          toast.error('加载文件夹失败', (err as Error).message);
        }
        return;
      }
      // 单文件拖拽
      const loaded = await loadFromDataTransfer(e.dataTransfer);
      if (!loaded) return;
      await ingestLoadedFile(loaded);
    },
    [applyDirectoryResult],
  );

  const topFlex = 1 - splitRatio;
  // 侧栏（文件树 / 分组 / 过滤器）可见条件：
  // 绑了目录 / 有事件 / 独立会话有文件清单（文件全部失效时
  // events 为 0，但勾选框必须在侧栏里才能恢复——不能把侧栏藏掉）
  const hasContent = !!logsDirHandle || eventCount > 0 || sessionFiles.length > 0;

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
      <ParserDriftBanner />
      <Toolbar />
      <div className={styles['main-row']}>
        {hasContent &&
          (sideCollapsed ? (
            <div className={styles.treeCollapsed}>
              <button
                className={styles.treeCollapseBtn}
                title="展开左侧栏"
                onClick={() => setSideCollapsed(false)}
              >
                <ChevronRight size={16} strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            <>
              <div
                className={styles.treePane}
                style={{ flex: `${treeRatio} 1 0` }}
              >
                <SidePanel />
                <button
                  className={styles.treeCollapseBtn + ' ' + styles.treeCollapseFloat}
                  title="收纳左侧栏"
                  onClick={() => setSideCollapsed(true)}
                >
                  <ChevronLeft size={16} strokeWidth={2.5} />
                </button>
              </div>
              <div
                className={styles['resizer-v']}
                onMouseDown={onTreeSplitMouseDown}
                title="拖拽调节左侧栏宽度"
              />
            </>
          ))}
        <div
          ref={centerRef}
          className={styles['app-center']}
          style={{ flex: `${hasContent ? (1 - treeRatio) : 1} 1 0` }}
        >
          <div className={styles.paneTop} style={{ flex: `${topFlex} 1 0` }}>
            {!showTimeline ? (
              <>
                {/* 表格流同样需要过滤器启停条：列是按过滤器分的，不显示就没法临时隐藏某一列 */}
                <FilterChips />
                <LogStreamView />
              </>
            ) : fullRange && filters.length > 0 ? (
              <>
                <FilterChips />
                <TimelineCanvas />
              </>
            ) : fullRange ? (
              <NoFilterState />
            ) : (
              <WelcomeState />
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
      <BusyIndicator />
      <ToastHost />
      <CommandPalette />
      <ManualCopyDialog />
    </div>
  );
}
