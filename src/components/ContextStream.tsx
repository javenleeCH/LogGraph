/**
 * dbMode 详情面板的无限上下文流（v3.1）。
 *
 * 替代旧版「选中行 ±ctxSpan 固定区间」：
 * - 全局行号连续空间 [0, totalLines)，**可无限滚动**，跨文件继续显示；
 * - 文件边界渲染分隔条（含文件名，右键同样可打开目录/外部打开）；
 * - 行文本按视口 ±PREFETCH 懒加载（db_lines_by_ids 分批），LRU 上限防内存膨胀；
 * - 右键行/分隔条：在文件管理器中定位、用外部应用打开。
 *
 * 为什么不用原生滚动容器：百万行 × 22px 总高远超浏览器 scrollTop 上限
 * （Chrome ~33.5M px，500 万行 = 1.1 亿 px），改为 wheel 驱动自管 offset +
 * 自绘滚动条，行号空间任意大小都精确。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLogStore } from '../store/logStore';
import { toast } from '../store/uiStore';
import {
  fetchLinesByIds,
  revealInDir,
  openFileExternally,
  type DbFileInfo,
} from '../io/dbStore';
import { Folder } from './Icon';
import styles from './ContextStream.module.css';

/** 单行/分隔条高度（px）；虚拟化基准 */
const ROW_H = 22;
/** 视口外预取行数（上下各） */
const PREFETCH = 120;
/** 行文本批量拉取大小 */
const BATCH = 500;
/** 行文本缓存上限（超过驱逐最旧；约 4000×200B ≈ 800KB） */
const LRU_MAX = 4000;

/** 在有序数组中找 < v 的元素个数（bisectLeft） */
function bisectLeft(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Menu = { x: number; y: number; file: DbFileInfo } | null;

export function ContextStream({
  files,
  selectedLine,
}: {
  files: DbFileInfo[];
  selectedLine: number;
}) {
  const meta = useLogStore((s) => s.meta);
  const totalLines = meta?.totalLines ?? 0;
  const selectEvent = useLogStore((s) => s.selectEvent);
  const correlatedEventIds = useLogStore((s) => s.correlatedEventIds);

  const wrapRef = useRef<HTMLDivElement>(null);
  /** 滚动偏移（px）；行号空间任意大都成立 */
  const [offset, setOffset] = useState(0);
  const [viewportH, setViewportH] = useState(240);
  /** 行文本缓存（Map 插入序 = 新旧序，LRU） */
  const [lineText, setLineText] = useState<Map<number, string>>(new Map());
  const [menu, setMenu] = useState<Menu>(null);

  // ---- item 空间映射：行 + 文件分隔条，统一 ROW_H ----
  // files[i] 的分隔条 item = firstLine_i + i；行 L（文件 i）item = L + i + 1。
  // totalItems = totalLines + files.length。全部 O(log files) bisect。
  const sepIdx = useMemo(
    () => files.map((f, i) => f.firstLine + i),
    [files],
  );
  const totalItems = totalLines + files.length;
  const maxOffset = Math.max(0, totalItems * ROW_H - viewportH);

  /** 行号 → item 序号 */
  const lineToItem = useCallback(
    (line: number): number => {
      let i = bisectLeft(
        files.map((f) => f.firstLine),
        line + 1,
      ) - 1;
      if (i < 0) i = 0;
      return line + i + 1;
    },
    [files],
  );

  /** item 序号 → 分隔条(文件 idx) 或 行(行号+文件 idx) */
  const itemAt = useCallback(
    (k: number): { sep: number } | { line: number; file: number } => {
      let i = bisectLeft(sepIdx, k + 1) - 1;
      if (i < 0) i = 0;
      if (sepIdx[i] === k) return { sep: i };
      return { line: k - (i + 1), file: i };
    },
    [sepIdx],
  );

  // ---- 视口高度 ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // ---- wheel 驱动滚动（passive:false 才能 preventDefault，React onWheel 不行）----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? viewportH : 1;
      setOffset((o) => Math.min(maxOffset, Math.max(0, o + e.deltaY * scale)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [maxOffset, viewportH]);

  // ---- 键盘滚动（容器聚焦后 ↑↓ / PgUp PgDn）----
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step =
        e.key === 'ArrowUp' ? ROW_H :
        e.key === 'ArrowDown' ? -ROW_H :
        e.key === 'PageUp' ? viewportH :
        e.key === 'PageDown' ? -viewportH :
        0;
      if (step === 0) return;
      e.preventDefault();
      setOffset((o) => Math.min(maxOffset, Math.max(0, o - step)));
    },
    [maxOffset, viewportH],
  );

  // ---- 选中定位：外部选中且不在视口 → 居中；本地点击不重定位 ----
  const localSel = useRef(-1);
  useEffect(() => {
    if (localSel.current === selectedLine) return;
    const y = lineToItem(selectedLine) * ROW_H;
    if (y < offset || y > offset + viewportH - ROW_H) {
      setOffset(
        Math.min(maxOffset, Math.max(0, y - viewportH / 2 + ROW_H / 2)),
      );
    }
    // offset 变化不重触发（仅外部选中变化时定位）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLine]);

  // ---- 懒加载：视口 ±PREFETCH 行号 → 缺失批量拉取（LRU 驱逐）----
  const firstItem = Math.floor(offset / ROW_H);
  const visibleCount = Math.ceil(viewportH / ROW_H) + 1;
  const wantLines = useMemo(() => {
    const out: number[] = [];
    if (files.length === 0) return out;
    const from = Math.max(0, firstItem - PREFETCH);
    const to = Math.min(totalItems, firstItem + visibleCount + PREFETCH);
    for (let k = from; k < to; k++) {
      const e = itemAt(k);
      if ('line' in e && e.line >= 0 && e.line < totalLines) out.push(e.line);
    }
    return out;
  }, [firstItem, visibleCount, files, totalItems, totalLines, itemAt]);

  useEffect(() => {
    if (wantLines.length === 0) return;
    const missing = wantLines.filter((l) => !lineText.has(l));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += BATCH) {
        try {
          const got = await fetchLinesByIds(missing.slice(i, i + BATCH));
          if (cancelled) return;
          setLineText((prev) => {
            const next = new Map(prev);
            for (const [k, v] of got) next.set(k, v);
            // LRU：Map 插入序即新旧序，超限删最旧（刚取回的不驱逐）
            if (next.size > LRU_MAX) {
              let over = next.size - LRU_MAX;
              for (const k of next.keys()) {
                if (over <= 0) break;
                if (got.has(k)) continue;
                next.delete(k);
                over -= 1;
              }
            }
            return next;
          });
        } catch (err) {
          if (!cancelled) console.warn('[ContextStream] 行文本拉取失败:', err);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantLines, lineText]);

  // ---- 右键菜单：全局点击关闭 ----
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const runReveal = useCallback((f: DbFileInfo) => {
    setMenu(null);
    revealInDir(f.path).catch((err: unknown) => {
      toast.warn('打开目录失败', String(err));
    });
  }, []);

  const runOpen = useCallback((f: DbFileInfo) => {
    setMenu(null);
    openFileExternally(f.path).catch((err: unknown) => {
      toast.warn('打开文件失败', String(err));
    });
  }, []);

  // ---- 自绘滚动条拖动 ----
  const dragRef = useRef<{ startY: number; startOffset: number } | null>(null);
  const onThumbDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { startY: e.clientY, startOffset: offset };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [offset],
  );
  const onThumbMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const trackH = viewportH - 20; // thumb 最小高 20 的近似
      setOffset(
        Math.min(
          maxOffset,
          Math.max(0, d.startOffset + ((e.clientY - d.startY) * maxOffset) / Math.max(1, trackH)),
        ),
      );
    },
    [maxOffset, viewportH],
  );
  const onThumbUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ---- 渲染窗口 ----
  const renderFrom = Math.max(0, firstItem - 1);
  const renderTo = Math.min(totalItems, firstItem + visibleCount + 1);
  const items: React.ReactNode[] = [];
  for (let k = renderFrom; k < renderTo; k++) {
    const e = itemAt(k);
    const top = k * ROW_H - offset;
    if ('sep' in e) {
      const f = files[e.sep];
      if (!f) continue;
      items.push(
        <div
          key={`s${e.sep}`}
          className={styles.sep}
          style={{ top }}
          title={f.path}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setMenu({ x: ev.clientX, y: ev.clientY, file: f });
          }}
        >
          <Folder size={11} />
          <span className={styles.sepName}>{f.name}</span>
          <span className={styles.sepLine}>第 {f.firstLine + 1} 行起</span>
        </div>,
      );
      continue;
    }
    const { line, file } = e;
    if (line < 0 || line >= totalLines) continue;
    const text = lineText.get(line);
    const isSelected = line === selectedLine;
    const isCorrelated = !isSelected && correlatedEventIds.has(line);
    const cls = [
      styles.row,
      isSelected ? styles.selected : '',
      isCorrelated ? styles.correlated : '',
    ]
      .filter(Boolean)
      .join(' ');
    items.push(
      <div
        key={`l${line}`}
        className={cls}
        style={{ top }}
        title={text ?? ''}
        onClick={() => {
          localSel.current = line;
          selectEvent(line);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          const f = files[file];
          if (f) setMenu({ x: ev.clientX, y: ev.clientY, file: f });
        }}
      >
        <span className={styles.lineno}>{line + 1}</span>
        <span className={styles.content}>{text ?? '…'}</span>
      </div>,
    );
  }

  const thumbH = Math.max(
    20,
    (viewportH / Math.max(1, totalItems * ROW_H)) * viewportH,
  );
  const thumbTop =
    (offset / Math.max(1, maxOffset)) * Math.max(0, viewportH - thumbH);

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {items}
      {totalItems * ROW_H > viewportH && (
        <div
          className={styles.thumb}
          style={{ height: thumbH, top: thumbTop }}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
          role="scrollbar"
          aria-orientation="vertical"
        />
      )}
      {menu && (
        <div
          className={styles.menu}
          style={{
            left: menu.x,
            top: Math.min(menu.y, window.innerHeight - 96),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className={styles.menuItem} onClick={() => runReveal(menu.file)}>
            <Folder size={12} />
            在文件管理器中显示
          </button>
          <button className={styles.menuItem} onClick={() => runOpen(menu.file)}>
            用外部应用打开
          </button>
          <div className={styles.menuPath} title={menu.file.path}>
            {menu.file.path}
          </div>
        </div>
      )}
    </div>
  );
}
