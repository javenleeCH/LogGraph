// 性能测试数据集生成器：基于 sample/ 模板放大到指定体积（默认 800MB）。
//
// 用法：node scripts/gen-perf-data.mjs [目标MB]
//
// - 模板 = sample/sample.log + sample/sample_large.log（同一时间段的原始行）
// - 每份拷贝把行首时间戳整体 +1h 平移：拷贝之间在时间轴上重叠交错，
//   模拟「多个服务在同一时段各自滚动写日志」的真实形态
// - 均分为 8 个文件输出到 perf-data/（已在 .gitignore，勿入库）
// - 时间戳变换用 Date.UTC + 儒略日逆推（civil-from-days），无时区语义
//
// 生成后用 app「打开目录」选 perf-data 测量；过滤器/分组由
// perf-data/.logGraph/filters.json 预置（首次手工播种一次即可）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'perf-data');
const TEMPLATE_FILES = ['sample/sample.log', 'sample/sample_large.log'];
const N_FILES = 8;
const COPY_STEP_MS = 60 * 60 * 1000; // 每份拷贝 +1h

const targetMB = Number.parseInt(process.argv[2] ?? '800', 10);
if (!Number.isFinite(targetMB) || targetMB <= 0) {
  console.error('用法: node scripts/gen-perf-data.mjs [目标MB]');
  process.exit(1);
}

// ---- 模板 ----
let template = TEMPLATE_FILES.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('');
if (!template.endsWith('\n')) template += '\n'; // 拷贝拼接不能把两行粘成一行
const unitBytes = Buffer.byteLength(template);
const templateLines = template.split('\n').length - 1; // 去掉尾空段

// ---- 日期格式化（epoch ms → "YYYY-MM-DD HH:MM:SS.mmm"，无 Date 对象开销） ----
const pad = (n, w) => String(n).padStart(w, '0');
function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}
function fmtEpoch(ms) {
  const d = civilFromDays(Math.floor(ms / 86400000));
  const t = ms % 86400000;
  return (
    `${pad(d.y, 4)}-${pad(d.m, 2)}-${pad(d.d, 2)} ` +
    `${pad(Math.floor(t / 3600000), 2)}:${pad(Math.floor(t / 60000) % 60, 2)}:` +
    `${pad(Math.floor(t / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`
  );
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/gm;
function shiftCopy(shiftMs) {
  return template.replace(
    TS_RE,
    (all, y, mo, d, h, mi, s, ms) =>
      fmtEpoch(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms) + shiftMs),
  );
}

// ---- 拷贝数分配：总量尽量贴近目标，均摊到 8 个文件 ----
const copiesTotal = Math.max(N_FILES, Math.round((targetMB * 1024 * 1024) / unitBytes));
const base = Math.floor(copiesTotal / N_FILES);
const rem = copiesTotal % N_FILES;
let copyIndex = 0;

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const t0 = Date.now();
let totalBytes = 0;
for (let f = 0; f < N_FILES; f++) {
  const copies = base + (f < rem ? 1 : 0);
  const file = path.join(OUT_DIR, `perf_${pad(f + 1, 2)}.log`);
  const ws = createWriteStream(file, { encoding: 'utf8' });
  for (let c = 0; c < copies; c++) {
    const chunk = shiftCopy(copyIndex * COPY_STEP_MS);
    copyIndex++;
    if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((r) => ws.end(r));
  const size = unitBytes * copies;
  totalBytes += size;
  console.log(`${path.basename(file)}: ${copies} copies, ${(size / 1024 / 1024).toFixed(1)} MB`);
}

const totalLines = templateLines * copiesTotal;
const first = template.match(TS_RE)?.[0] ?? '?';
console.log(
  `done: ${N_FILES} files, ${copiesTotal} copies, ${totalLines} lines, ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB, span +${(copiesTotal - 1)}h, ${(Date.now() - t0) / 1000 | 0}s`,
);
