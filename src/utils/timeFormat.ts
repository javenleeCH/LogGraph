/**
 * 时间格式化工具：epoch ms <-> 可读字符串。
 * 统一用 UTC 处理（日志时间通常无时区），显示时带毫秒。
 */

const PAD = (n: number, l = 2) => String(n).padStart(l, '0');

/** epoch ms -> "HH:mm:ss.SSS" */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return (
    PAD(d.getUTCHours()) +
    ':' +
    PAD(d.getUTCMinutes()) +
    ':' +
    PAD(d.getUTCSeconds()) +
    '.' +
    PAD(d.getUTCMilliseconds(), 3)
  );
}

/** epoch ms -> "YYYY-MM-DD HH:mm:ss.SSS" */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() + '-' +
    PAD(d.getUTCMonth() + 1) + '-' +
    PAD(d.getUTCDate()) + ' ' +
    formatTime(ms)
  );
}

/** epoch ms -> 带本地时区显示 */
export function formatDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  return (
    d.getFullYear() + '-' +
    PAD(d.getMonth() + 1) + '-' +
    PAD(d.getDate()) + ' ' +
    PAD(d.getHours()) + ':' +
    PAD(d.getMinutes()) + ':' +
    PAD(d.getSeconds()) + '.' +
    PAD(d.getMilliseconds(), 3)
  );
}

/**
 * 可读时间字符串 -> epoch ms（UTC，formatDateTime 的逆运算）。
 * 兼容：
 *  - "YYYY-MM-DD HH:mm:ss.SSS"（分隔符 T 或空格，秒/毫秒可省略）
 *  - "YYYY-MM-DD"（当日 0 点）
 *  - "HH:mm:ss.SSS"（日期取 fallbackDateMs 的日期，用于只改时间）
 *  - 纯整数（直接视为 epoch 毫秒）
 * 无法识别返回 null。
 */
export function parseDateTime(input: string, fallbackDateMs?: number): number | null {
  const s = input.trim();
  if (s === '') return null;
  if (/^-?\d{1,16}$/.test(s)) return Number(s);

  const num = (v: string | undefined, min: number, max: number) =>
    v === undefined ? 0 : (Number(v) >= min && Number(v) <= max ? Number(v) : NaN);

  const assemble = (y: number, mo: number, d: number, h: number, mi: number, sec: number, msec: number) => {
    if ([y, mo, d, h, mi, sec, msec].some(Number.isNaN)) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const t = Date.UTC(y, mo - 1, d, h, mi, sec, msec);
    // 滚动日期（如 2 月 30）视为非法
    const dt = new Date(t);
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return t;
  };

  const full = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (full) {
    return assemble(
      Number(full[1]),
      Number(full[2]),
      Number(full[3]),
      num(full[4], 0, 23),
      num(full[5], 0, 59),
      num(full[6], 0, 59),
      full[7] === undefined ? 0 : Number(full[7].padEnd(3, '0')),
    );
  }

  const timeOnly = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?$/);
  if (timeOnly && fallbackDateMs !== undefined) {
    const fd = new Date(fallbackDateMs);
    return assemble(
      fd.getUTCFullYear(),
      fd.getUTCMonth() + 1,
      fd.getUTCDate(),
      num(timeOnly[1], 0, 23),
      num(timeOnly[2], 0, 59),
      num(timeOnly[3], 0, 59),
      timeOnly[4] === undefined ? 0 : Number(timeOnly[4].padEnd(3, '0')),
    );
  }
  return null;
}

/**
 * 根据时间跨度选择合适的刻度间隔（用于轴刻度）。
 * 返回毫秒。
 */
export function chooseTickStep(spanMs: number, targetTicks = 8): number {
  const raw = spanMs / targetTicks;
  // 1-2-5 序列适配到合理量级
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow10;
  let step: number;
  if (n < 1.5) step = 1;
  else if (n < 3.5) step = 2;
  else if (n < 7.5) step = 5;
  else step = 10;
  return step * pow10;
}

/** 把毫秒跨度格式化为简短时长，如 "1.2s"、"340ms"、"5m" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/** 相对时间（最近项目列表用）：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
export function formatRelativeTime(ms: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(ms).slice(0, 10);
}
