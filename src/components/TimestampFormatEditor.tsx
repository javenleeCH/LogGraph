/**
 * 时间格式选择器：预设列表优先（自动探测 / 5 种内置格式），都选不到再展开自定义 pattern。
 * 任何状态下打开都会显示当前生效的 pattern，用户可以直接抄去改。
 * 入口：工具栏「格式」按钮（已载入时）+ 命令面板「自定义时间格式…」。
 * 弹层 createPortal 到 body + fixed（同 RecentProjectsMenu / RangeChips 策略）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLogStore } from '../store/logStore';
import { toast } from '../store/uiStore';
import {
  compileCustomFormat,
  extractTimestamp,
  TIMESTAMP_FORMATS,
  type TimestampFormat,
} from '../parser/timestampFormats';
import { parseLogText } from '../parser/parseBridge';
import { formatDateTime } from '../utils/timeFormat';
import { Type, ChevronDown, Check } from './Icon';
import styles from './TimestampFormatEditor.module.css';

const POPOVER_W = 440;
/** 上次使用的自定义 pattern（打开时回填输入框） */
const TS_CUSTOM_KEY = 'loggraph.ts-custom-pattern';

/** 命令面板等外部入口的打开事件 */
export const OPEN_TS_FORMAT_EVENT = 'loggraph:open-ts-format';

/** 当前生效格式的 pattern 描述（自定义返回 pattern 本身；探测/预设返回展示 pattern） */
function currentPatternDesc(formatId: string | null | undefined): string {
  if (!formatId) return '未识别';
  if (formatId.startsWith('custom:')) return formatId.slice('custom:'.length);
  const preset = TIMESTAMP_FORMATS.find((f) => f.id === formatId);
  return preset?.pattern ?? preset?.label ?? formatId;
}

export function TimestampFormatEditor() {
  const meta = useLogStore((s) => s.meta);
  const firstLine = useLogStore((s) => (s.rawLines.length ? s.rawLines.find((l) => l.trim()) ?? '' : ''));

  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
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

  // 打开时：回填上次 pattern + 首个非空行样例；当前是自定义则展开自定义区
  useEffect(() => {
    if (!open) return;
    setPattern(localStorage.getItem(TS_CUSTOM_KEY) ?? '');
    setSample((s) => s || firstLine);
    setCustomOpen(isCustom);
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
    if (!m) return { kind: 'noMatch' as const };
    return { kind: 'ok' as const, matchStr: m.matchStr, iso: formatDateTime(m.ts) };
  }, [pattern, sample]);

  /** 应用一个格式并重新解析（fmt=null 表示恢复自动探测） */
  const applyFormat = useCallback(async (fmt: TimestampFormat | null) => {
    const s = useLogStore.getState();
    if (!s.meta || s.dbMode) {
      toast.warn('当前模式不支持重新解析', '目录工作区（数据驻留模式）暂不支持切换时间格式');
      return;
    }
    setBusy(true);
    try {
      const text = s.rawLines.join('\n');
      const result = await parseLogText(text, fmt ? { format: fmt } : undefined);
      if (result.events.length === 0) {
        toast.warn('该格式没有解析出任何事件', '已保持原格式；对照样例行检查（可先看下方预览）');
        return;
      }
      if (fmt?.id.startsWith('custom:')) localStorage.setItem(TS_CUSTOM_KEY, fmt.id.slice('custom:'.length));
      s.setLog(result.events, result.rawLines, {
        fileName: s.meta.fileName,
        fileSize: s.meta.fileSize,
        totalLines: result.totalLines,
        skipped: result.skipped,
        timestampFormatId: result.timestampFormatId,
      });
      setOpen(false);
      toast.success(
        `已按「${fmt ? fmt.label : '自动探测'}」重新解析（${result.events.length} 条事件）`,
        `跳过 ${result.skipped} 行`,
      );
    } catch (err) {
      toast.error('重新解析失败', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  /** 应用自定义 pattern（编译 + 预检） */
  const applyCustom = useCallback(() => {
    const fmt = compileCustomFormat(pattern);
    if (!fmt) {
      toast.error('时间格式无效', '检查 token：%Y %m %d %H %M %S %f %z %b，其余字符按字面匹配');
      return;
    }
    void applyFormat(fmt);
  }, [pattern, applyFormat]);

  return (
    <>
      <button
        ref={btnRef}
        className="ghost"
        onClick={() => setOpen((v) => !v)}
        title={
          meta?.timestampFormatId
            ? `当前时间戳格式：${currentPatternDesc(meta.timestampFormatId)}（点击切换）`
            : '选择时间戳格式'
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
            <div className={styles.head}>时间格式</div>

            {/* 当前生效格式（任何状态都显示，可直接抄去自定义） */}
            <div className={styles.currentBox}>
              <span className={styles.currentLabel}>当前生效</span>
              <code className={styles.currentPattern}>{currentPatternDesc(meta?.timestampFormatId)}</code>
              <span className={styles.currentSource}>
                {isCustom ? '（自定义）' : `（${meta?.timestampFormatId ?? '未识别'}）`}
              </span>
            </div>

            {/* 预设列表 */}
            <div className={styles.list}>
              <button className={styles.item} disabled={busy} onClick={() => void applyFormat(null)}>
                <span className={styles.itemName}>自动探测</span>
                <span className={styles.itemSub}>按内容自动选择下方格式（载入时的默认行为）</span>
              </button>
              {TIMESTAMP_FORMATS.map((f) => (
                <button
                  key={f.id}
                  className={styles.item}
                  disabled={busy}
                  onClick={() => void applyFormat(f)}
                >
                  <span className={styles.itemName}>{f.label}</span>
                  <span className={styles.itemSub}>
                    <code>{f.pattern ?? 'Unix 时间戳数字（秒 / 毫秒）'}</code>
                    <span className={styles.itemSample}>{f.sample}</span>
                  </span>
                  {meta?.timestampFormatId === f.id && !isCustom && (
                    <Check size={13} className={styles.check} />
                  )}
                </button>
              ))}
              <button className={styles.item} onClick={() => setCustomOpen((v) => !v)}>
                <span className={styles.itemName}>自定义…</span>
                <span className={styles.itemSub}>
                  都选不到时，用 %Y %m %d %H %M %S %f %z %b 手写格式
                </span>
                {isCustom && <Check size={13} className={styles.check} />}
              </button>
            </div>

            {/* 自定义区（折叠兜底；当前为自定义时默认展开） */}
            {customOpen && (
              <>
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
                    onClick={applyCustom}
                    title="按此格式重新解析当前文件（过滤器/分组保留）"
                  >
                    应用并重新解析
                  </button>
                </div>
              </>
            )}

            {meta && meta.skipped > 0 && (
              <div className={styles.hint}>
                当前有 {meta.skipped} 行没有识别出时间戳——若时间轴不对或事件偏少，试试切换格式。
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
