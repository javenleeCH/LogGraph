/**
 * 文件树侧栏：类似 VS Code Explorer。
 * - 选择目录后枚举日志文件，展示为树
 * - 复选框多选，点"加载勾选"合并解析
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import {
  listLogFiles,
  loadMultiple,
  tauriPathAsDirectory,
  type LogFileInfo,
} from '../io/dirLoader';
import { ChevronDown, ChevronRight, Folder, FolderOpen, LogFile } from './Icon';
import { toast } from '../store/uiStore';
import * as dbStore from '../io/dbStore';
import { loadOpener } from '../lib/tauri';
import { recordOpenProject } from '../io/recentProjects';
import styles from './FileTreePanel.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 树节点 */
interface TreeNode {
  name: string;
  isDir: boolean;
  size: number;
  children: TreeNode[];
  /** 文件相对路径（目录无此项） */
  fullPath?: string;
}

/** 把扁平 LogFileInfo[] 构建为树 */
function buildTree(files: LogFileInfo[]): TreeNode {
  const root: TreeNode = { name: '', isDir: true, size: 0, children: [] };
  for (const f of files) {
    const segs = f.path;
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isLast = i === segs.length - 1;
      let child = cur.children.find((c) => c.name === seg && c.isDir !== isLast);
      if (!child) {
        child = {
          name: seg,
          isDir: !isLast,
          size: isLast ? f.size : 0,
          children: [],
          fullPath: isLast ? f.name : undefined,
        };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  // 目录排前、文件排后，各自按名排序
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

export function FileTreePanel() {
  const logsDirHandle = useLogStore((s) => s.logsDirHandle);
  const logsDirName = useLogStore((s) => s.logsDirName);
  const sessionFiles = useLogStore((s) => s.sessionFiles);
  const toggleSessionFile = useLogStore((s) => s.toggleSessionFile);
  const setLog = useLogStore((s) => s.setLog);

  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string; path: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Tauri 目录句柄携带绝对路径（浏览器 FSA 句柄无路径 → 按钮不显示）
  const logsDirPathStr =
    logsDirHandle && typeof logsDirHandle === 'object' && 'path' in logsDirHandle
      ? typeof logsDirHandle.path === 'string'
        ? logsDirHandle.path
        : null
      : null;
  const mountedRef = useRef(true);

  // 目录变化时枚举
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 右键菜单打开时：点任意处 / Escape 关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (!logsDirHandle) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setProgress('枚举目录中…');
      try {
        const list = await listLogFiles(logsDirHandle, { recursive: true });
        if (cancelled) return;
        setFiles(list);
        // 默认勾选全部
        setChecked(new Set(list.map((f) => f.name)));
      } catch (e) {
        console.error('枚举日志文件失败', e);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setProgress('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [logsDirHandle]);

  const tree = useMemo(() => buildTree(files), [files]);

  const totalSelectedSize = useMemo(
    () => files.filter((f) => checked.has(f.name)).reduce((s, f) => s + f.size, 0),
    [files, checked],
  );

  function toggleCheck(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleCollapse(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function onLoadSelected() {
    if (!logsDirHandle) return;
    const names = files.filter((f) => checked.has(f.name)).map((f) => f.name);
    if (names.length === 0) return;
    setLoading(true);
    try {
      // ---- 快速路径：SQLite 数据驻留（Tauri + 全目录加载时）----
      // v4：便宜通道建库（读+偏移+计数+范围）；无事件索引——命中 ts 扫描时解析
      const handle: unknown = logsDirHandle;
      const isTauriDir =
        !!handle && typeof handle === 'object' && '__tauriDir' in handle && handle.__tauriDir === true;
      const allSelected = names.length === files.length;
      if (isTauriDir && allSelected) {
        const dir =
          handle && typeof handle === 'object' && 'path' in handle && typeof handle.path === 'string'
            ? handle.path
            : '';
        const { dbOpen } = dbStore;
        const opened = await dbOpen(dir, (loaded, total, cur) => {
          if (mountedRef.current) {
            setProgress(`索引 ${loaded}/${total} ${cur}`);
          }
        });
        if (opened) {
          useLogStore.getState().setLogDb(
            { start: opened.rangeStart, end: opened.rangeEnd },
            {
              fileName: `${logsDirName ?? dir} (${opened.fileCount} 文件)`,
              fileSize: totalSelectedSize,
              totalLines: opened.totalLines,
              skipped: opened.skipped,
              timestampFormatId: opened.timestampFormatId,
            },
          );
          return;
        }
        // dbOpen 失败 → 落回旧全量路径
      }

      const result = await loadMultiple(logsDirHandle, names, (loaded, total, cur) => {
        if (mountedRef.current) {
          setProgress(`加载中 ${loaded}/${total} ${cur}`);
        }
      });
      setLog(result.events, result.rawLines, {
        ...result.meta,
        // 用目录名作为显示名
        fileName: logsDirName
          ? `${logsDirName} (${names.length} 文件)`
          : result.meta.fileName,
        fileSize: totalSelectedSize,
      });
    } catch (e) {
      console.error('加载日志失败', e);
      toast.error('加载日志失败', (e as Error).message);
    } finally {
      setLoading(false);
      setProgress('');
    }
  }

  /** 右键菜单：资源管理器中显示该文件（Tauri opener 插件） */
  async function revealInFileManager(path: string) {
    try {
      const opener = await loadOpener();
      await opener.revealItemInDir(path);
    } catch (e) {
      console.error('打开所在目录失败', e);
      toast.error('打开所在目录失败', (e as Error).message);
    }
  }

  /** 右键菜单：以该文件所在目录为工作区切换到目录模式（文件树变目录树） */
  async function loadSessionDirAsWorkspace(path: string) {
    const norm = path.replace(/\\/g, '/');
    const i = norm.lastIndexOf('/');
    if (i < 0) return;
    const dirPath = norm.slice(0, i);
    try {
      const handle = await tauriPathAsDirectory(dirPath);
      if (!handle) {
        toast.error('目录不存在或无法访问', dirPath);
        return;
      }
      useLogStore.getState().setLogsDir(handle, handle.name);
      await useLogStore.getState().openWorkspace(handle);
      await recordOpenProject({ name: handle.name, kind: 'dir', path: dirPath });
      toast.success(`已打开工作区 ${handle.name}`, '左侧文件树可浏览目录内日志');
    } catch (e) {
      console.error('加载目录失败', e);
      toast.error('加载目录失败', (e as Error).message);
    }
  }

  /** 目录模式「打开目录」：资源管理器中打开该目录（Tauri opener openPath） */
  async function openDirInFileManager(dirPath: string) {
    try {
      const opener = await loadOpener();
      await opener.openPath(dirPath);
    } catch (e) {
      console.error('打开目录失败', e);
      toast.error('打开目录失败', (e as Error).message);
    }
  }

  // 渲染树（递归）
  function renderNode(node: TreeNode, depth: number, parentPath: string): React.ReactNode {
    if (!node.name) {
      // root
      return node.children.map((c) => renderNode(c, depth, parentPath));
    }
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    const indent = depth * 14;
    if (node.isDir) {
      const isCollapsed = collapsed.has(path);
      return (
        <div key={path}>
          <div
            className={styles['tree-item'] + ' ' + styles.dir}
            onClick={() => toggleCollapse(path)}
          >
            <span className={styles.indent} style={{ width: indent }} />
            <span className={styles.chevron}>
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </span>
            <span className={styles.icon}><Folder size={14} /></span>
            <span className={styles.name}>{node.name}</span>
          </div>
          {!isCollapsed && node.children.length > 0 && (
            <div className={styles['tree-children']}>
              {node.children.map((c) => renderNode(c, depth + 1, path))}
            </div>
          )}
        </div>
      );
    }
    // 文件
    const isChecked = checked.has(node.fullPath ?? path);
    return (
      <div
        key={path}
        className={styles['tree-item']}
        onClick={() => toggleCheck(node.fullPath ?? path)}
      >
        <span className={styles.indent} style={{ width: indent }} />
        <span className={styles.chevron + ' ' + styles.spacer}>·</span>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => toggleCheck(node.fullPath ?? path)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className={styles.icon}><LogFile size={14} /></span>
        <span className={styles.name}>{node.name}</span>
        <span className={styles.size}>{fmtSize(node.size)}</span>
      </div>
    );
  }

  const checkedCount = checked.size;

  return (
    <div className={styles.fileTree}>
      <div className={styles['fileTree-header']}>
        <span>日志文件</span>
        {logsDirName && (
          <span className={styles['dir-name']} title={logsDirName}>{logsDirName}</span>
        )}
      </div>

      {files.length > 0 && (
        <div className={styles['tree-checkbox-col']}>
          <label
            onClick={(e) => {
              e.stopPropagation();
              setChecked((prev) => {
                if (prev.size === files.length) return new Set();
                return new Set(files.map((f) => f.name));
              });
            }}
          >
            全选
          </label>
          <span>|</span>
          <span>{checkedCount}/{files.length}</span>
          {logsDirPathStr && (
            <button
              className={styles.openDirBtn}
              title={`在资源管理器中打开 ${logsDirPathStr}`}
              onClick={(e) => {
                e.stopPropagation();
                void openDirInFileManager(logsDirPathStr);
              }}
            >
              <FolderOpen size={12} />
              <span>打开目录</span>
            </button>
          )}
        </div>
      )}

      <div className={styles['fileTree-body']}>
        {/* 独立文件会话：未绑定目录但已载入日志 → 显示会话文件清单
            （右侧勾选控制该文件是否参与分析，取消失效） */}
        {!logsDirHandle &&
          sessionFiles.map((f) => (
            <div
              key={f.name}
              className={styles['tree-item']}
              style={{ opacity: f.enabled ? 1 : 0.5 }}
              title={
                f.enabled
                  ? `${f.name} · 参与分析中，取消勾选使其失效`
                  : `${f.name} · 已失效，勾选恢复参与分析`
              }
              onContextMenu={(e) => {
                // Tauri 拖入的文件带绝对路径，才提供定位/目录模式能力
                if (!f.path) return;
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, name: f.name, path: f.path });
              }}
            >
              <span className={styles.indent} style={{ width: 0 }} />
              <span className={styles.chevron + ' ' + styles.spacer}>·</span>
              <span className={styles.icon}><LogFile size={14} /></span>
              <span className={styles.name}>{f.name}</span>
              <span className={styles.size}>{fmtSize(f.size)}</span>
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={() => toggleSessionFile(f.name)}
                onClick={(e) => e.stopPropagation()}
                title="启用 / 失效该文件"
              />
            </div>
          ))}
        {files.length === 0 && !loading && !(!logsDirHandle && sessionFiles.length > 0) && (
          <div className={styles['fileTree-empty']}>
            {logsDirHandle
              ? '该目录下没有可识别的日志文件（.log/.txt/.out/.csv/.tsv）'
              : '拖入日志文件，或点击工具栏「打开文件 / 打开目录」'}
          </div>
        )}
        {loading && (
          <div className={styles['fileTree-loading']}>{progress || '加载中…'}</div>
        )}
        {renderNode(tree, 0, '')}
      </div>

      {files.length > 0 && (
        <div className={styles['fileTree-actions']}>
          <span className={styles['fileTree-total']}>
            {checkedCount > 0 ? `合计 ${fmtSize(totalSelectedSize)}` : ''}
          </span>
          <button
            className="primary"
            onClick={onLoadSelected}
            disabled={checkedCount === 0 || loading}
            title="合并勾选的文件并解析"
          >
            {loading ? '加载中…' : `加载 ${checkedCount > 0 ? `(${checkedCount})` : ''}`}
          </button>
        </div>
      )}
      {ctxMenu && (
        <div
          className={styles.ctxMenu}
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={styles.ctxTitle} title={ctxMenu.path}>{ctxMenu.name}</div>
          <button
            className={styles.ctxItem}
            onClick={() => {
              setCtxMenu(null);
              void revealInFileManager(ctxMenu.path);
            }}
          >
            打开文件所在目录
          </button>
          <button
            className={styles.ctxItem}
            onClick={() => {
              setCtxMenu(null);
              void loadSessionDirAsWorkspace(ctxMenu.path);
            }}
          >
            加载所在目录（切换目录模式）
          </button>
        </div>
      )}
    </div>
  );
}
