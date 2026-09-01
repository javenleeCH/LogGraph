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
