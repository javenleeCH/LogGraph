/**
 * 时间格式编辑器：当内置 5 种时间戳预设识别不了（或识别错）时，
 * 用户用 %Y %m %d %H %M %S %f %z %b 自定义格式并重新解析当前文件。
 * 入口：工具栏「格式」按钮（已载入时）+ 命令面板「自定义时间格式…」。
 * 弹层 createPortal 到 body + fixed（同 RecentProjectsMenu / RangeChips 策略）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLogStore } from '../store/logStore';
import { toast } from '../store/uiStore';
import { compileCustomFormat, extractTimestamp } from '../parser/timestampFormats';
import { parseLogText } from '../parser/parseBridge';
import { formatDateTime } from '../utils/timeFormat';
import { Type, ChevronDown } from './Icon';
import styles from './TimestampFormatEditor.module.css';

const POPOVER_W = 420;
/** 上次使用的自定义 pattern（空串 = 曾显式恢复自动） */
const TS_CUSTOM_KEY = 'loggraph.ts-custom-pattern';

/** 命令面板等外部入口的打开事件 */
export const OPEN_TS_FORMAT_EVENT = 'loggraph:open-ts-format';

export function TimestampFormatEditor() {
  const meta = useLogStore((s) => s.meta);
  const firstLine = useLogStore((s) => (s.rawLines.length ? s.rawLines.find((l) => l.trim()) ?? '' : ''));

  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState('');
  const [sample, setSample] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const isCustom = !!meta?.timestampFormatId?.startsWith('custom:');

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_TS_FORMAT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TS_FORMAT_EVENT, onOpen);
  }, []);

  // 打开时：预填上次 pattern + 首个非空行样例 + 定位 + 外点/Esc
  useEffect(() => {
    if (!open) return;
    setPattern(localStorage.getItem(TS_CUSTOM_KEY) ?? '');
    setSample((s) => s || firstLine);
    const place = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({
        left: Math.min(Math.max(8, rect.left), window.innerWidth - POPOVER_W - 8),
        top: rect.bottom + 8,
      });
    };
    place();
    const onDocDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null;
      if (t && (btnRef.current?.contains(t) || popRef.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 实时预览：用 pattern 编译出的格式在样例行上试提取 */
  const preview = useMemo(() => {
    if (!pattern.trim()) return { kind: 'empty' as const };
    const fmt = compileCustomFormat(pattern);
    if (!fmt) return { kind: 'invalid' as const };
    if (!sample.trim()) return { kind: 'noSample' as const };
    const m = extractTimestamp(sample, fmt);
    if (!m) return { kind: 'noMatch' as const, label: fmt.label };
    return { kind: 'ok' as const, matchStr: m.matchStr, iso: formatDateTime(m.ts) };
  }, [pattern, sample]);

  /** 应用（pattern=null 表示恢复自动探测）：用当前 rawLines 重新解析 */
  const apply = useCallback(async (pat: string | null) => {
    const s = useLogStore.getState();
    if (!s.meta || s.dbMode) {
      toast.warn('当前模式不支持重新解析', '目录工作区（数据驻留模式）暂不支持自定义时间格式');
      return;
    }
    const format = pat ? compileCustomFormat(pat) : null;
    if (pat && !format) {
      toast.error('时间格式无效', '检查 token：%Y %m %d %H %M %S %f %z %b，其余字符按字面匹配');
      return;
    }
    setBusy(true);
    try {
      const text = s.rawLines.join('\n');
      const result = await parseLogText(text, format ? { format } : undefined);
      if (result.events.length === 0) {
        toast.warn('该格式没有解析出任何事件', '对照样例行检查格式写法（可先看下方预览）');
        return;
      }
      localStorage.setItem(TS_CUSTOM_KEY, pat ?? '');
      s.setLog(result.events, result.rawLines, {
        fileName: s.meta.fileName,
        fileSize: s.meta.fileSize,
        totalLines: result.totalLines,
        skipped: result.skipped,
        timestampFormatId: result.timestampFormatId,
      });
      setOpen(false);
      toast.success(
        pat ? `已按自定义格式重新解析（${result.events.length} 条事件）` : `已恢复自动探测（${result.events.length} 条事件）`,
        `跳过 ${result.skipped} 行`,
      );
    } catch (err) {
      toast.error('重新解析失败', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        className="ghost"
        onClick={() => setOpen((v) => !v)}
        title={
          meta?.timestampFormatId
            ? `当前时间戳格式：${meta.timestampFormatId}（点击自定义）`
            : '自定义时间戳格式'
        }
      >
        <Type size={14} />
        {isCustom ? '自定义' : '自动'}
        <ChevronDown size={11} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div ref={popRef} className={styles.popover} style={{ left: pos.left, top: pos.top }}>
            <div className={styles.head}>
              自定义时间格式
              {meta?.timestampFormatId && (
                <span className={styles.current}>当前：{meta.timestampFormatId}</span>
              )}
            </div>

            <label className={styles.label}>
              格式 pattern
              <input
                className={styles.input}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="如 %Y/%m/%d %H:%M:%S 或 [%b %d %H:%M:%S]"
                spellCheck={false}
              />
            </label>
            <div className={styles.tokens}>
              <code>%Y</code>年 <code>%m</code>月 <code>%d</code>日 <code>%H</code>时 <code>%M</code>分{' '}
              <code>%S</code>秒 <code>%f</code>小数秒 <code>%z</code>时区 <code>%b</code>月份缩写
              ；其余字符按字面匹配，<code>%%</code> 表示 %
            </div>

            <label className={styles.label}>
              样例行（预填自当前日志，可改）
              <input
                className={styles.input}
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder="粘贴一行真实日志用于预览"
                spellCheck={false}
              />
            </label>

            <div className={styles.preview} data-kind={preview.kind}>
              {preview.kind === 'empty' && '输入 pattern 后这里显示解析预览'}
              {preview.kind === 'invalid' && '✗ 无法识别的 token（或缺少 %H/%M/%S 时间字段）'}
              {preview.kind === 'noSample' && '（无样例行）'}
              {preview.kind === 'noMatch' && '✗ 该 pattern 在样例行上没有匹配到时间戳'}
              {preview.kind === 'ok' && (
                <>
                  ✓ 匹配 <code>{preview.matchStr}</code> → <code>{preview.iso}</code>
                </>
              )}
            </div>

            <div className={styles.actions}>
              <button
                className="primary"
                disabled={busy || !pattern.trim() || preview.kind !== 'ok'}
                onClick={() => void apply(pattern)}
                title="按此格式重新解析当前文件（过滤器/分组保留）"
              >
                应用并重新解析
              </button>
              <button
                className="ghost"
                disabled={busy || !isCustom}
                onClick={() => void apply(null)}
                title="清除自定义格式，回到自动探测"
              >
                恢复自动
              </button>
            </div>
            {meta && meta.skipped > 0 && (
              <div className={styles.hint}>
                当前有 {meta.skipped} 行没有识别出时间戳——若时间轴不对或事件偏少，试试自定义格式。
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
