/**
 * WASM CEP 引擎封装 —— 引擎 `engine/src/cep.rs` 的 WebAssembly 构建（cep-wasm/）。
 *
 * 背景（消除双实现）：
 * - 桌面端（dbMode/非 dbMode）走 Rust 引擎（Tauri IPC / native 编译的同一份
 *   `cep.rs`），是 CEP 语义的单一事实来源；
 * - Web 端原先用 `SequenceMatcher.ts`（TS 双实现），两端语义靠人工同步，
 *   是冲 9 分的最大工程债；
 * - 现在 Web 端直接用**同一份 `cep.rs`** 的 wasm 构建（cep-wasm/，通过
 *   `#[path]` 共享源文件），两端语义逐字节一致，分歧从根上消除。
 *
 * 兜底策略：wasm 加载完成前（首次运行的极短窗口）或加载失败时，回退
 * `SequenceMatcher.ts` 保证可用性（与 regexWasm 同款策略）。回退激活时 UI
 * 可通过 isCepWasmFallback() 提示。
 *
 * 注意：`SequenceMatcher.ts` 现已是**仅兜底用的冻结副本**——新增/修改 CEP
 * 语义只改 `engine/src/cep.rs`（native 与 wasm 同时生效），不要再在 TS 里并行维护。
 */

import type { FilterMatch, SequenceConfig, SequenceMatchResult } from '../types';
import { CEP_MAX_CHAINS } from '../store/logStore';

/** wasm-bindgen 生成的 pkg 模块形状 */
interface CepPkgModule {
  default: (input?: unknown) => Promise<unknown>;
  run_sequences_json: (groups_json: string, events_json: string) => string;
}

let initPromise: Promise<CepPkgModule | null> | null = null;
let module: CepPkgModule | null = null;
let loadFailed = false;

/** 启动 wasm 引擎加载（幂等，fire-and-forget 安全）。失败标记 fallback 不影响 TS 兜底。 */
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
      return m;
    } catch (e) {
      loadFailed = true;
      console.warn('[cep-wasm] 加载失败，回退 TS 引擎：', e);
      return null;
    }
  })();
  return initPromise;
}

/** wasm 引擎是否就绪（就绪后 Web 端 CEP 走 engine，与桌面端一致） */
export function isCepWasmReady(): boolean {
  return module !== null;
}

/** 是否处于 TS 兜底模式（wasm 加载失败）—— UI 可据此提示 */
export function isCepWasmFallback(): boolean {
  return loadFailed;
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
 * 返回 null 的两种情况，调用方都应回退 `SequenceMatcher.runSequenceMatching`：
 * 1. wasm 未就绪（首次加载窗口期）；
 * 2. 引擎 fallback=true（含不支持的特性）。
 */
export function runCepWasm(
  groups: { id: string; filterIds: string[]; sequence?: SequenceConfig }[],
  matches: FilterMatch[],
): Record<string, SequenceMatchResult> | null {
  if (!module) return null;
  const seqGroups = groups.filter((g) => g.sequence && g.sequence.edges.length > 0);
  if (seqGroups.length === 0) return {};
  const store: Record<string, unknown[]> = {};
  for (const fm of matches) store[fm.filterId] = fm.events;
  try {
    const resp = JSON.parse(
      module.run_sequences_json(JSON.stringify(seqGroups.map(toGroupSpec)), JSON.stringify(store)),
    );
    if (resp.fallback) return null;
    return resp.results as Record<string, SequenceMatchResult>;
  } catch (e) {
    console.warn('[cep-wasm] 运行失败，回退 TS 引擎：', e);
    return null;
  }
}
