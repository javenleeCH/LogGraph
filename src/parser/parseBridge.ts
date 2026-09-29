/**
 * 解析桥：统一解析入口，双通道架构（plans/rust-parser-design.md）。
 *
 * - Tauri 桌面：invoke('parse_log') → Rust 原生引擎（读文件 + 解析均不过 IPC 大文本桥）；
 *   invoke 失败（命令未注册/读取异常/返回形状异常）→ 自动回退 JS 引擎，功能永不中断。
 * - 浏览器    ：直接走现有 JS LogParser，不加载任何 @tauri-apps/* 模块
 *   （沿用 lib/tauri.ts 的动态 import 约定，保证 npm run dev 纯净）。
 *
 * 结果形状 = JS ParseResult + rawLines（Rust 侧已对齐），前端调用方零适配。
 */

import type { LogEvent } from '../types';
import { isTauri } from '../lib/tauri';
import { LogParser, type ParseResult } from './LogParser';

/** JS ParseResult + 逐行原文（与 text.split(/\r?\n/) 一致，DetailPanel 上下文索引用） */
export interface FullParseResult extends ParseResult {
  rawLines: string[];
  /** 实际执行引擎（dualengine 自检 / 排障用） */
  engine: 'rust' | 'js';
}

/** Rust parse_log 返回的 DTO（serde camelCase；thread/level/sourceFile 可缺省） */
interface RustLogEvent {
  id: number;
  ts: number;
  raw: string;
  thread?: string;
  level?: string;
  message: string;
  sourceFile?: string;
}

interface RustParseResult {
  events: RustLogEvent[];
  rawLines: string[];
  timestampFormatId: string | null;
  skipped: number;
  totalLines: number;
}

/** 浏览器 JS 引擎（原路径，逐字符等价于改造前 parser.parse + text.split） */
function parseWithJs(text: string, engine: 'rust' | 'js'): FullParseResult {
  const r = new LogParser().parse(text);
  return { ...r, rawLines: text.split(/\r?\n/), engine };
}

/** 形状校验：防 Rust 侧异常返回把脏数据塞进 store */
function isRustResult(v: unknown): v is RustParseResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as RustParseResult;
  return (
    Array.isArray(r.events) &&
    Array.isArray(r.rawLines) &&
    typeof r.skipped === 'number' &&
    typeof r.totalLines === 'number' &&
    (r.timestampFormatId === null || typeof r.timestampFormatId === 'string')
  );
}

/** Rust DTO → 前端 LogEvent（字段同名直拷；Rust 已按 JS 语义生成） */
function fromRustDto(r: RustParseResult): FullParseResult {
  const events: LogEvent[] = r.events.map((e) => ({
    id: e.id,
    ts: e.ts,
    raw: e.raw,
    thread: e.thread,
    level: e.level,
    message: e.message,
    sourceFile: e.sourceFile,
  }));
  return {
    events,
    rawLines: r.rawLines,
    timestampFormatId: r.timestampFormatId,
    skipped: r.skipped,
    totalLines: r.totalLines,
    engine: 'rust',
  };
}

/** invoke('parse_log')；不可用返回 null（不抛出，调用方回退） */
async function invokeRust(
  args: { path?: string; text?: string },
): Promise<FullParseResult | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const r = await invoke<RustParseResult>('parse_log', {
      path: args.path ?? null,
      text: args.text ?? null,
    });
    if (!isRustResult(r)) {
      console.warn('[parseBridge] Rust 返回形状异常，回退 JS 引擎', r);
      return null;
    }
    return fromRustDto(r);
  } catch (err) {
    console.warn('[parseBridge] invoke parse_log 失败，回退 JS 引擎:', err);
    return null;
  }
}

// ---- 双引擎一致性自检（dev 排障用）----
// Tauri 环境下 URL 加 ?dualengine=1：同一输入 JS/Rust 各跑一遍，深度比对关键字段，
// 差异打 console.error（不阻断加载，以 Rust 结果为准）。

function deepEqualEvents(a: LogEvent[], b: LogEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.ts !== y.ts ||
      x.raw !== y.raw ||
      x.thread !== y.thread ||
      x.level !== y.level ||
      x.message !== y.message
    ) {
      return false;
    }
  }
  return true;
}

function dualEngineCheck(rust: FullParseResult, js: FullParseResult): void {
  const diffs: string[] = [];
  if (!deepEqualEvents(rust.events, js.events)) diffs.push('events');
  if (rust.rawLines.length !== js.rawLines.length) diffs.push('rawLines.length');
  else {
    const rawDiffAt = rust.rawLines.findIndex((l, i) => l !== js.rawLines[i]);
    if (rawDiffAt >= 0) diffs.push(`rawLines[${rawDiffAt}]`);
  }
  if (rust.skipped !== js.skipped) diffs.push(`skipped ${rust.skipped} vs ${js.skipped}`);
  if (rust.totalLines !== js.totalLines) diffs.push(`totalLines ${rust.totalLines} vs ${js.totalLines}`);
  if (rust.timestampFormatId !== js.timestampFormatId) {
    diffs.push(`formatId ${rust.timestampFormatId} vs ${js.timestampFormatId}`);
  }
  if (diffs.length) {
    console.error(
      `[dualengine] Rust/JS 解析不一致（以 Rust 结果继续）：${diffs.join('; ')}，` +
        `events=${rust.events.length}/${js.events.length}`,
    );
  } else {
    console.info(
      `[dualengine] 一致 ✓ events=${rust.events.length} lines=${rust.totalLines} skipped=${rust.skipped}`,
    );
  }
}

// ---- 对外 API ----

/**
 * 解析一段已就位的文本。
 * - Tauri：text 过 IPC 给 Rust 解析（文本已在手上时用；有文件路径请优先 parseLogPath）；
 * - 浏览器：JS 引擎。
 */
export async function parseLogText(text: string): Promise<FullParseResult> {
  const rust = await invokeRust({ text });
  if (rust) {
    if (new URLSearchParams(location.search).get('dualengine') === '1') {
      dualEngineCheck(rust, parseWithJs(text, 'js'));
    }
    return rust;
  }
  return parseWithJs(text, 'js');
}

/**
 * Tauri 专用：按绝对路径解析（核心红利：Rust 进程内读文件，大文本不过 IPC）。
 * 返回 null 表示 Tauri 不可用 / Rust 失败，调用方需回退（如再用 plugin-fs 读文本走 JS）。
 */
export async function parseLogPath(path: string): Promise<FullParseResult | null> {
  return invokeRust({ path });
}

// ---- 目录批量解析（P2：141 文件场景 1 次 IPC 替代 141 次）----

/** Rust parse_dir 返回的 DTO（serde camelCase） */
export interface RustDirEvent {
  id: number;
  ts: number;
  raw: string;
  thread?: string;
  level?: string;
  message: string;
  sourceFile?: string;
}

export interface RustDirParseResult {
  events: RustDirEvent[];
  rawLines: string[];
  fileNames: string[];
  totalLines: number;
  skipped: number;
  timestampFormatId: string | null;
}

/** 形状校验：防 Rust 侧异常返回把脏数据塞进 store */
function isRustDirResult(v: unknown): v is RustDirParseResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as RustDirParseResult;
  return (
    Array.isArray(r.events) &&
    Array.isArray(r.rawLines) &&
    Array.isArray(r.fileNames) &&
    typeof r.totalLines === 'number' &&
    typeof r.skipped === 'number' &&
    (r.timestampFormatId === null || typeof r.timestampFormatId === 'string')
  );
}

/**
 * Tauri 专用：批量解析整个目录（枚举+解析+合并+全局排序 全在 Rust 进程内）。
 * 返回 null 表示不可用/失败，调用方回退逐文件路径。
 * 进度通过 Tauri event `parse_dir_progress` 推送（onProgress 订阅由调用方管理）。
 */
export async function parseLogDir(
  dir: string,
): Promise<RustDirParseResult | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const r = await invoke<RustDirParseResult>('parse_dir', { dir });
    if (!isRustDirResult(r)) {
      console.warn('[parseBridge] Rust parse_dir 返回形状异常，回退逐文件路径', r);
      return null;
    }
    return r;
  } catch (err) {
    console.warn('[parseBridge] invoke parse_dir 失败，回退逐文件路径:', err);
    return null;
  }
}

/**
 * 统一入口：加载一个「文件」（可能只有 text，或 Tauri 下带 path）。
 * - Tauri + path：Rust 读文件解析（不读 text）；
 * - Tauri + 无 path（text 已就位）：Rust 解析 text；
 * - 浏览器 / invoke 失败：JS 引擎（path 且 text 为空时先用 plugin-fs 读文本再解析，保证降级完整）。
 */
export async function parseLoadedFile(loaded: {
  name: string;
  text: string;
  path?: string;
}): Promise<FullParseResult> {
  // Tauri + path：优先 Rust 直读
  if (loaded.path) {
    const rust = await invokeRust({ path: loaded.path });
    if (rust) {
      if (new URLSearchParams(location.search).get('dualengine') === '1' && loaded.text) {
        dualEngineCheck(rust, parseWithJs(loaded.text, 'js'));
      }
      return rust;
    }
    // Rust 不可用且调用方没给 text（新流程 openLogFileDialog 不再 readTextFile）→
    // 降级：plugin-fs 读文本走 JS，功能不中断
    if (!loaded.text) {
      return parseWithJs(await fallbackReadText(loaded.path), 'js');
    }
  }
  // 浏览器 / text 就位 / path 失败但有 text
  return parseLogText(loaded.text);
}

/** 降级读文本：plugin-fs readTextFile（仅 Tauri 降级路径用） */
async function fallbackReadText(path: string): Promise<string> {
  const { loadFs } = await import('../lib/tauri');
  const fs = await loadFs();
  return fs.readTextFile(path);
}
