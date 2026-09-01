// 生成大样本日志：约 50000 行，时间戳严格递增，混合级别/线程/消息。
import { writeFileSync } from 'node:fs';

const msgs = [
  'Application starting up v3.2.1',
  'Initializing network pool with 8 workers',
  'Loading configuration from app.config',
  'Database connection established (host=db01.internal)',
  'Sending heartbeat to upstream',
  'Upstream response slow: 450ms',
  'Configuration loaded successfully',
  'Executing query: SELECT * FROM users WHERE active=1',
  'Connection reset by peer (errno=104)',
  'Retry policy triggered for upstream call',
  'Retrying upstream request attempt 1/3',
  'Query returned 1524 rows in 1200ms',
  'Upstream recovered, response ok',
  'Startup phase complete',
  'Processing task batch #1 (50 items)',
  'Cache refresh triggered',
  'Periodic health check: all systems nominal',
  'Deadlock detected, rolling back transaction',
  'Deadlock resolved after retry',
  'Slow query detected: 2100ms',
  'Query optimized via index hint',
  'Failed health check: upstream degraded',
  'Task queue drained',
  'Memory usage: 412MB / 1024MB',
  'GC pause 18ms (minor)',
  'Request latency p99=320ms',
  'Config hot-reload triggered',
  'Worker pool scaled to 16',
  'Connection pool exhausted, queuing request',
  'Session expired, redirecting to login',
  'Rate limit exceeded for client 10.0.0.5',
  'Background job scheduler tick',
  'Snapshot persisted to s3://logs/snap-001',
  'Schema migration step 3/5 applied',
  'Feature flag new-billing enabled for 12%',
  'Health probe ok (200)',
  'Cache hit ratio 0.87',
];
const threads = ['MainThread', 'NetPool-1', 'NetPool-2', 'DBWorker', 'Worker-3', 'Worker-4', 'Scheduler', 'ApiGW'];
const levels = ['INFO', 'DEBUG', 'WARN', 'ERROR'];

function pad(n, w) {
  return String(n).padStart(w, '0');
}

const start = new Date('2024-01-01T09:00:00.000Z');
const lines = [];
let ts = start.getTime();
const N = 50000;
for (let i = 0; i < N; i++) {
  const lvl = levels[Math.floor(Math.random() * levels.length)];
  const th = threads[Math.floor(Math.random() * threads.length)];
  const msg = msgs[Math.floor(Math.random() * msgs.length)];
  const d = new Date(ts);
  const line =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}` +
    ` [${th}] ${lvl.padEnd(5)} ${msg} #${i}`;
  lines.push(line);
  ts += 40 + Math.floor(Math.random() * 610); // 40~650ms 间隔
}

const out = lines.join('\n') + '\n';
const path = new URL('./sample_large.log', import.meta.url);
writeFileSync(path, out, 'utf8');
console.log(`Generated ${lines.length} lines, ${(out.length / 1024 / 1024).toFixed(2)} MB`);
