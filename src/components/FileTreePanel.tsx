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
  type LogFileInfo,
} from '../io/dirLoader';
import { ChevronDown, ChevronRight, Folder, FileText } from './Icon';
import { toast } from '../store/uiStore';
import * as dbStore from '../io/dbStore';
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
  const setLog = useLogStore((s) => s.setLog);

  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);

  // 目录变化时枚举
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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
        <span className={styles.icon}><FileText size={14} /></span>
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
        </div>
      )}

      <div className={styles['fileTree-body']}>
        {files.length === 0 && !loading && (
          <div className={styles['fileTree-empty']}>
            {logsDirHandle
              ? '该目录下没有可识别的日志文件（.log/.txt/.out/.csv/.tsv）'
              : '点击工具栏「打开目录」选择一个日志文件夹'}
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
    </div>
  );
}
