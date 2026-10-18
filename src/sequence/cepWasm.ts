/**
 * WASM CEP 引擎封装 —— 引擎 `engine/src/cep.rs` 的 WebAssembly 构建（cep-wasm/）。
 *
 * 背景（消除双实现）：
 * - 桌面端（dbMode/非 dbMode）走 Rust 引擎（Tauri IPC / native 编译的同一份
 *   `cep.rs`），是 CEP 语义的单一事实来源；
 * - Web 端原先用 `SequenceMatcher.ts`（TS 双实现），两端语义靠人工同步；
 * - 现在 Web 端与 dbMode 跨行组都用**同一份 `cep.rs`** 的 wasm 构建
 *   （cep-wasm/，通过 `#[path]` 共享源文件），两端语义逐字节一致。
 *   **TS 副本（SequenceMatcher.ts）已删除**，wasm 是唯一 Web 引擎。
 *
 * 失败策略（不再有静默回退）：`runCepWasm` 返回显式 outcome，
 * 调用方必须分别处理——
 * - `loading`：wasm 首次加载窗口期。调用方应注册 `onCepWasmSettled` 延后重算，
 *   保留旧结果不闪空；
 * - `failed`：加载或运行失败。调用方应把错误呈现在 UI（横幅 + 重试），
 *   **不得**悄悄给出空结果冒充"没有匹配"；
 * - `unsupported`：引擎整体回退（`GroupSpec::is_supported()` 恒 true 后不应出现，
 *   保留供引擎未来新增门控）；
 * - `ok`：正常结果。
 */

import type { FilterMatch, SequenceConfig, SequenceMatchResult } from '../types';
import { CEP_MAX_CHAINS } from '../store/logStore';

/** wasm-bindgen 生成的 pkg 模块形状 */
interface CepPkgModule {
  default: (input?: unknown) => Promise<unknown>;
  run_sequences_json: (groups_json: string, events_json: string) => string;
}

/** 引擎运行结局：调用方按 kind 显式分派，不存在"默认回退" */
export type CepWasmOutcome =
  | { kind: 'loading' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'unsupported' }
  | { kind: 'ok'; results: Record<string, SequenceMatchResult> };

let initPromise: Promise<CepPkgModule | null> | null = null;
let module: CepPkgModule | null = null;
let loadFailed = false;
let loadError: unknown = null;
/** 等待加载结束（成功或失败）的一次性回调；两端（成功/失败）都会唤醒 */
const settledWaiters: Array<() => void> = [];

function flushSettledWaiters(): void {
  const waiters = settledWaiters.splice(0);
  for (const w of waiters) w();
}

/** 启动 wasm 引擎加载（幂等，fire-and-forget 安全）。 */
export function ensureCepWasm(): Promise<CepPkgModule | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // 字面量动态导入：Vite 会把它连同 .wasm 资源一起打进产物；
      // 该模块顶层无副作用，wasm 只有在调用 init（即 default()）时才真正实例化。
      const m = (await import(
        './wasm-cep/pkg/cep_wasm.js'
      )) as unknown as CepPkgModule;
      await m.default();
      module = m;
      flushSettledWaiters();
      return m;
    } catch (e) {
      loadFailed = true;
      loadError = e;
      // 失败也要唤醒等待者：让延后的重算立刻去走报错路径，
      // 而不是把「加载中」挂成永久状态。
      flushSettledWaiters();
      console.warn('[cep-wasm] 加载失败：', e);
      return null;
    }
  })();
  return initPromise;
}

/** wasm 引擎是否就绪（就绪后 Web 端 CEP 走引擎，与桌面端一致） */
export function isCepWasmReady(): boolean {
  return module !== null;
}

/** wasm 引擎是否加载失败（UI 据此显示「引擎不可用」横幅 + 重试） */
export function isCepWasmFailed(): boolean {
  return loadFailed;
}

/**
 * 注册「加载结束」一次性回调（已结束则同步不触发）。
 * 用于加载窗口期延后的重算：wasm 就绪/失败后由调用方重新 recomputeSequences。
 */
export function onCepWasmSettled(cb: () => void): void {
  if (module || loadFailed) return;
  settledWaiters.push(cb);
}

/** 重置并重试加载（UI「重试」按钮）。成功后调用方应重新 recomputeSequences。 */
export function retryCepWasm(): void {
  initPromise = null;
  module = null;
  loadFailed = false;
  loadError = null;
  void ensureCepWasm();
}

/** 把 web 的 group 序列配置转成引擎 GroupSpec（对齐 engine/src/cep.rs DTO）。 */
function toGroupSpec(g: {
  id: string;
  filterIds: string[];
  sequence?: SequenceConfig;
}) {
  const s = g.sequence!;
  return {
    groupId: g.id,
    filterIds: g.filterIds,
    scope: s.scope ?? 'global',
    // scope='key' 的关联键正则；undefined 时 JSON 省略 ⇒ 引擎 serde 缺省 None
    keyPattern: s.keyPattern,
    edges: s.edges.map((e) => ({
      id: e.id,
      fromFilterId: e.fromFilterId,
      toFilterId: e.toFilterId,
      toFilterIds: e.toFilterIds,
      kind: e.kind,
      maxGapMs: e.maxGapMs,
      periodMs: e.periodMs,
    })),
    nodeConditions: s.nodeConditions,
    nodeCounts: s.nodeCounts
      ? Object.fromEntries(
          Object.entries(s.nodeCounts).map(([fid, nc]) => [
            fid,
            { min: nc.min, max: Number.isFinite(nc.max) ? nc.max : 9_000_000_000_000 },
          ]),
        )
      : undefined,
    maxChains: CEP_MAX_CHAINS,
  };
}

/**
 * 用引擎跑一组 group 的序列匹配。
 *
 * 返回显式 outcome（见文件头说明）：调用方**必须**分别处理 loading /
 * failed / unsupported，不再有 TS 兜底可回退。
 */
export function runCepWasm(
  groups: { id: string; filterIds: string[]; sequence?: SequenceConfig }[],
  matches: FilterMatch[],
): CepWasmOutcome {
  if (!module) {
    return loadFailed ? { kind: 'failed', error: loadError } : { kind: 'loading' };
  }
  const seqGroups = groups.filter((g) => g.sequence && g.sequence.edges.length > 0);
  if (seqGroups.length === 0) return { kind: 'ok', results: {} };
  const store: Record<string, unknown[]> = {};
  for (const fm of matches) store[fm.filterId] = fm.events;
  try {
    const resp = JSON.parse(
      module.run_sequences_json(JSON.stringify(seqGroups.map(toGroupSpec)), JSON.stringify(store)),
    );
    if (resp.fallback) return { kind: 'unsupported' };
    return { kind: 'ok', results: resp.results as Record<string, SequenceMatchResult> };
  } catch (e) {
    console.warn('[cep-wasm] 运行失败：', e);
    return { kind: 'failed', error: e };
  }
}
