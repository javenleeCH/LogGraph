// 样本数据端到端验证（不依赖 UT）：
//   解析层（格式族 thread 提取）→ CEP 层（thread/key 分桶链）→ 跨行 filter（§3.14 聚合）
// 每个新特性都必须有样本数据可跑；本脚本即「样本数据的验收测试」。
//
// 用法：node scripts/verify-samples.mjs
// 退出码 0 = 全部通过；1 = 有失败项（明细打印到 stdout）。
//
// 说明：
// - 优先用已构建的 target/debug/loggraph[.exe]；找不到则 cargo build -p loggraph-cli。
//   Windows Git Bash 下 cargo 需 MSVC bin 前置 PATH（与 MEMORY.md 记载一致）。
// - 期望值全部来自样本数据的「故事线」（见各样本文件与规则文件 description），
//   不是从输出反推的快照——改样本/改语义时必须同步改这里的期望值。

import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const isWin = process.platform === 'win32';

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? `  —— ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `期望 ${e}，实得 ${a}`);
}

// ---- CLI 定位/构建 ----

function findCli() {
  for (const p of ['target/debug/loggraph.exe', 'target/debug/loggraph']) {
    if (existsSync(join(ROOT, p))) return join(ROOT, p);
  }
  return null;
}

let CLI = findCli();
if (!CLI) {
  console.log('# 未找到已构建 CLI，执行 cargo build -p loggraph-cli ...');
  const env = { ...process.env };
  if (isWin) {
    // MEMORY.md：Git Bash 跑 cargo 需 MSVC bin 前置（本机 msvc-kit 布局）
    const msvc = 'D:/ProgramData/msvc-kit/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
    if (existsSync(msvc)) env.PATH = `${msvc}:${env.PATH}`;
  }
  // Windows 上 bash 导出的 PATH 是 MSYS 风格，CreateProcess 认不得；
  // 依次尝试 cargo / cargo.exe，都失败则把 PATH 还原为 Windows 风格再试。
  const cargoCandidates = isWin ? ['cargo.exe', 'cargo'] : ['cargo'];
  let built = false;
  let lastErr = null;
  for (const bin of cargoCandidates) {
    try {
      execFileSync(bin, ['build', '-p', 'loggraph-cli'], { cwd: ROOT, env, stdio: 'inherit' });
      built = true;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!built && isWin) {
    const winPath = (process.env.PATH ?? '')
      .split(':')
      .map((p) => p.replace(/^\/([a-z])\//i, '$1:\\').replace(/\//g, '\\'))
      .join(';');
    try {
      execFileSync('cargo', ['build', '-p', 'loggraph-cli'], {
        cwd: ROOT,
        env: { ...env, PATH: winPath },
        stdio: 'inherit',
      });
      built = true;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!built) {
    console.error('cargo build 失败：', lastErr?.message ?? lastErr);
    process.exit(1);
  }
  CLI = findCli();
  if (!CLI) {
    console.error('cargo build 后仍未找到 CLI 二进制');
    process.exit(1);
  }
}

function cli(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(CLI, args, { cwd: ROOT, encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    if (!allowFail) throw e;
    // 负例（validate 失败）退出码非零，但 stdout 仍是完整 JSON
    return JSON.parse(e.stdout);
  }
}

// ---- 工具 ----

const traceRe = /traceId=([0-9a-f]{8})/;
const chainTraces = (chain) => {
  const set = new Set();
  for (const s of chain.steps ?? []) {
    const m = traceRe.exec(s.event?.raw ?? '');
    if (m) set.add(m[1]);
  }
  return [...set];
};
const chainShape = (chain) => (chain.steps ?? []).map((s) => s.filterId);

// =====================================================================
console.log('# A. 解析层：格式族 thread 提取（B 解析覆盖样本）');

{
  const r = cli(['parse', 'file', 'sample/springboot/order-service.log']);
  const evs = r.events.filter((e) => e.raw.trim());
  const withThread = evs.filter((e) => e.thread);
  const threads = [...new Set(withThread.map((e) => e.thread))].sort();
  eq('springboot：25 行全部解析出事件', evs.length, 25);
  eq('springboot：25/25 提取到 thread（Spring Boot 布局族）', withThread.length, 25);
  eq(
    'springboot：6 个线程桶齐全',
    threads,
    ['HikariPool-1', 'http-nio-8080-exec-1', 'http-nio-8080-exec-2', 'http-nio-8080-exec-3', 'main', 'scheduling-1'],
  );
  ok(
    'springboot：级别提取 INFO/DEBUG/WARN/ERROR',
    ['INFO', 'DEBUG', 'WARN', 'ERROR'].every((l) => evs.some((e) => e.level === l)),
  );
  ok(
    'springboot：message 已剥掉 `--- [thread]` 标记段',
    evs.every((e) => !e.message.includes('--- [')) && evs.some((e) => e.message.includes('GET /api/orders/1001')),
  );
}

{
  const r = cli(['parse', 'file', 'sample/log4j2/legacy-service.log']);
  const evs = r.events.filter((e) => e.raw.trim());
  const withThread = evs.filter((e) => e.thread);
  const threads = [...new Set(withThread.map((e) => e.thread))].sort();
  eq('log4j2：15 行全部解析出事件', evs.length, 15);
  eq('log4j2：15/15 提取到 thread（log4j2 变体布局族）', withThread.length, 15);
  eq('log4j2：4 个线程桶齐全', threads, ['main', 'pool-1', 'pool-2', 'pool-3']);
  ok('log4j2：message 已剥掉级别后首个 [thread]', evs.every((e) => !e.message.startsWith('[')));
}

{
  const r = cli(['parse', 'dir', 'sample/distributed', '--full']);
  const evs = r.events.filter((e) => e.raw.trim());
  eq('distributed：三服务共 19 事件', evs.length, 19);
  ok(
    'distributed：每事件带 sourceFile（多文件会话身份）',
    evs.every((e) => typeof e.sourceFile === 'string' && e.sourceFile.length > 0),
  );
  ok(
    'distributed：每行都带 traceId（关联键原料）',
    evs.every((e) => traceRe.test(e.raw)),
  );
}

// =====================================================================
console.log('# B. CEP 层：scope=thread 线程分桶（格式族样本 + 线程规则）');

{
  const r = cli(['cep', 'sample/springboot/order-service.log', '-R', 'sample/cep-rules-thread.example.json', '--json']);
  const res = r.response.results;
  eq('springboot/recovery：恰 1 条链', res.recovery.chains.length, 1);
  eq('springboot/recovery：链在 exec-1 桶', res.recovery.chains[0]?.thread, 'http-nio-8080-exec-1');
  eq('springboot/recovery：reset→retry→done 三步', chainShape(res.recovery.chains[0]), ['reset', 'retry', 'done']);
  eq('springboot/healthy：恰 3 条链（exec-1×2 + exec-2×1）', res.healthy.chains.length, 3);
  ok(
    'springboot/healthy：三条链分属两个线程桶',
    new Set(res.healthy.chains.map((c) => c.thread)).size === 2,
  );
  eq(
    'springboot/no-reset：0 链 0 违规（健康 NOT）',
    [res['no-reset-after-startup'].chains.length, res['no-reset-after-startup'].notViolations.length],
    [0, 0],
  );
  ok(
    'springboot：threadStats 可见（withThread=参与事件数）',
    res.recovery.threadStats?.withThread === res.recovery.threadStats?.totalEvents &&
      res.recovery.threadStats?.totalEvents > 0,
  );
}

{
  const r = cli(['cep', 'sample/log4j2/legacy-service.log', '-R', 'sample/cep-rules-thread-log4j2.example.json', '--json']);
  const res = r.response.results;
  eq('log4j2/batch-recovery：恰 1 条链', res['batch-recovery'].chains.length, 1);
  eq('log4j2/batch-recovery：链在 pool-2 桶', res['batch-recovery'].chains[0]?.thread, 'pool-2');
  eq('log4j2/lifecycle：恰 1 条链（main 桶）', [res.lifecycle.chains.length, res.lifecycle.chains[0]?.thread], [1, 'main']);
  eq(
    'log4j2/no-fail：0 链 0 违规',
    [res['no-fail-after-startup'].chains.length, res['no-fail-after-startup'].notViolations.length],
    [0, 0],
  );
}

// =====================================================================
console.log('# C. CEP 层：scope=key 关联键分桶（#43 跨服务关联样本）');

{
  const r = cli(['cep', 'sample/distributed', '-R', 'sample/cep-rules-key.example.json', '--json']);
  const res = r.response.results;

  const key = res['trace-failure'];
  eq('key/trace-failure：恰 2 条链', key.chains.length, 2);
  ok(
    'key/trace-failure：每条链的所有步骤同属一个 traceId（桶隔离）',
    key.chains.every((c) => chainTraces(c).length === 1),
    key.chains.map((c) => chainTraces(c)).join(' | '),
  );
  ok(
    'key/trace-failure：含完整 5 步链（entry→…→gw500，traceId=a1b2c3d4）',
    key.chains.some((c) => chainShape(c).length === 5 && chainTraces(c)[0] === 'a1b2c3d4'),
  );
  ok(
    'key/trace-failure：含孤儿 trace 的 4 步后缀链（f00dcafe，无入口行）',
    key.chains.some((c) => chainShape(c).length === 4 && chainTraces(c)[0] === 'f00dcafe'),
  );
  eq('key/trace-failure：keyStats 质量指纹', key.keyStats, { totalEvents: 13, withKey: 13, distinctKeys: 5 });

  const glob = res['trace-failure-global-contrast'];
  eq('global/对照：2 条链', glob.chains.length, 2);
  ok(
    'global/对照：至少 1 条链跨 traceId（伪链，4bf92f35 入口 + f00dcafe 后续）',
    glob.chains.some((c) => chainTraces(c).length >= 2),
    glob.chains.map((c) => chainTraces(c)).join(' | '),
  );
  ok('global/对照：无 keyStats（未走 key 路径）', glob.keyStats === undefined);
  ok(
    '对照组证明：key 组零伪链、global 组有伪链',
    key.chains.every((c) => chainTraces(c).length === 1) && glob.chains.some((c) => chainTraces(c).length >= 2),
  );
}

// =====================================================================
console.log('# D. 跨行 filter（契约 §3.14，ws filters 路径 + ctx 限定单文件）');

{
  // ws info --file 把会话限定到 sample/sample.log，避免扫到 sample_large.log（5 万行）
  const ctxPath = join(tmpdir(), 'loggraph-verify-ctx.json');
  const ctxJson = execFileSync(CLI, ['ws', 'info', 'sample', '--file', 'sample.log'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  writeFileSync(ctxPath, ctxJson);

  const r = cli(['ws', 'filters', 'sample', '-q', 'sample/filters-crossline.example.json', '--ctx', ctxPath]);
  const byId = Object.fromEntries(r.filters.map((f) => [f.filterId, f.hits.map((h) => h.line)]));
  const SEP = '\u0000';
  // 子条件条目（引擎内部表示，顺带断言下推正确）
  eq('crossline/reset 正子条件（全部 Connection reset 行）', byId[`reset-104-only${SEP}0`], [8, 22, 30, 41, 49]);
  eq('crossline/reset 负子条件（errno=110 行）', byId[`reset-104-only${SEP}1`], [30]);
  // 聚合 = 正交集 − 负并集
  eq('crossline/reset 聚合（排除 110 后剩 4 行）', byId['reset-104-only'], [8, 22, 41, 49]);
  eq('crossline/slow-query 聚合（两个正向子条件交集）', byId['slow-query-with-ms'], [33, 47]);
  ok(
    'crossline：聚合条目与子条件条目同时可见（契约 §3.14 缓存表示）',
    Array.isArray(byId['reset-104-only']) && Array.isArray(byId[`reset-104-only${SEP}0`]),
  );
  rmSync(ctxPath, { force: true });
}

// =====================================================================
console.log('# E. 规则校验层：S12 关联键闸门 + schema 同步');

{
  for (const f of [
    'sample/cep-rules-thread.example.json',
    'sample/cep-rules-thread-log4j2.example.json',
    'sample/cep-rules-key.example.json',
  ]) {
    const r = cli(['validate', f, '--json']);
    ok(`validate ${f}：0 错 0 警`, r.valid && r.errors.length === 0 && r.warnings.length === 0, JSON.stringify(r));
  }

  const bad1 = join(tmpdir(), 'loggraph-verify-key-nopattern.json');
  const bad2 = join(tmpdir(), 'loggraph-verify-key-nogroup.json');
  const bad3 = join(tmpdir(), 'loggraph-verify-key-ignored.json');
  writeFileSync(
    bad1,
    JSON.stringify({
      filters: [{ id: 'a', pattern: 'x' }],
      groups: [{ groupId: 'g', scope: 'key', filterIds: ['a'], edges: [] }],
    }),
  );
  writeFileSync(
    bad2,
    JSON.stringify({
      filters: [{ id: 'a', pattern: 'x' }],
      groups: [{ groupId: 'g', scope: 'key', keyPattern: 'traceId=\\w+', filterIds: ['a'], edges: [] }],
    }),
  );
  writeFileSync(
    bad3,
    JSON.stringify({
      filters: [{ id: 'a', pattern: 'x' }],
      groups: [{ groupId: 'g', scope: 'global', keyPattern: 'traceId=(\\w+)', filterIds: ['a'], edges: [] }],
    }),
  );
  const r1 = cli(['validate', bad1, '--json'], { allowFail: true });
  const r2 = cli(['validate', bad2, '--json'], { allowFail: true });
  const r3 = cli(['validate', bad3, '--json'], { allowFail: true });
  ok('S12：scope=key 缺 keyPattern → 报错', !r1.valid && r1.errors.some((e) => e.rule === 'S12'));
  ok('S12：keyPattern 无捕获组 → 报错', !r2.valid && r2.errors.some((e) => e.rule === 'S12'));
  ok(
    'S12：非 key 作用域带 keyPattern → 合法但告警',
    r3.valid && r3.warnings.length === 1 && r3.warnings[0].rule === 'S12',
  );
  rmSync(bad1, { force: true });
  rmSync(bad2, { force: true });
  rmSync(bad3, { force: true });

  const schema = cli(['schema', 'cep']);
  const group = schema.$defs.group;
  ok('schema：scope enum 含 key', group.properties.scope.enum.includes('key'));
  ok('schema：group 含 keyPattern 属性', typeof group.properties.keyPattern === 'object');
}

// =====================================================================
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}  — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
