/**
 * WASM 正则引擎封装 —— 标准 Rust `regex` crate 的 WebAssembly 构建。
 *
 * 背景（web-desktop-consistency-review.md §1.1）：
 * - 桌面端(dbMode)过滤走 Rust `regex` crate；
 * - Web 端原先用 JS `RegExp`，两端引擎不同 → 同一过滤器结果可能不一致
 *   （环视/反向引用：Web 能匹配、桌面静默零命中；`\b`：Unicode vs ASCII）。
 * - 现在 Web 端直接用**同一 crate** 的 wasm 构建（filter-wasm/），
 *   两端引擎逐字节一致，分歧从根上消除。
 *
 * 兜底策略：wasm 加载完成前（首次运行的极短窗口）或加载失败时，
 * 回退 JS RegExp 保证可用性；回退激活时 UI 可通过 isRegexWasmFallback() 提示。
 */

/** 编译后的 wasm 正则实例（filter-wasm crate 导出的 Regex 类的实例） */
interface WasmRegexInstance {
  isMatch(text: string): boolean;
}

/** wasm-bindgen 生成的 pkg 模块形状 */
interface WasmPkgModule {
  default: (input?: unknown) => Promise<unknown>;
  Regex: new (pattern: string, caseInsensitive: boolean) => WasmRegexInstance;
  /** 多行 filter 命中聚合（与桌面引擎同源），入参/出参均为 JSON 字符串 */
  aggregateFilterHits?: (posJson: string, negJson: string) => string;
}

let initPromise: Promise<WasmPkgModule | null> | null = null;
let module: WasmPkgModule | null = null;
let loadFailed = false;

/** pattern+flags → 编译后的 wasm 正则缓存 */
const compiled = new Map<string, WasmRegexInstance>();

/**
 * 启动 wasm 引擎加载（幂等，fire-and-forget 安全）。
 * 失败时标记 fallback，不影响 JS 兜底路径继续工作。
 */
export function ensureRegexWasm(): Promise<WasmPkgModule | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // 字面量动态导入：Vite 会把它连同 .wasm 资源一起打进产物；
      // 该模块顶层无副作用，wasm 只有在调用 init（即 default()）时才真正实例化。
      const m = (await import(
        './wasm-filter/pkg/filter_wasm.js'
      )) as unknown as WasmPkgModule;
      await m.default();
      module = m;
      return m;
    } catch (e) {
      loadFailed = true;
      console.warn('[regex-wasm] 加载失败，回退 JS RegExp：', e);
      return null;
    }
  })();
  return initPromise;
}

/** wasm 引擎是否就绪（就绪后所有正则过滤走 wasm，与桌面端一致） */
export function isRegexWasmReady(): boolean {
  return module !== null;
}

/** 是否处于 JS 兜底模式（wasm 加载失败）—— UI 可据此提示 */
export function isRegexWasmFallback(): boolean {
  return loadFailed;
}

/**
 * 取编译后的 wasm 正则（带缓存）。
 * 返回 null 的两种情况，调用方（FilterEngine）都应回退 JS RegExp：
 * 1. wasm 未就绪（首次加载窗口期）；
 * 2. pattern 编译失败 —— 桌面端同样无法编译（同样零命中），这是**对齐**的行为。
 */
export function getWasmRegex(
  pattern: string,
  caseInsensitive: boolean,
): WasmRegexInstance | null {
  if (!module) return null;
  const key = (caseInsensitive ? 'i:' : 's:') + pattern;
  let re = compiled.get(key);
  if (re) return re;
  try {
    re = new module.Regex(pattern, caseInsensitive);
  } catch {
    return null; // 编译失败不缓存，让调用方走 JS（JS 同样可能失败→不命中）
  }
  compiled.set(key, re);
  return re;
}

/**
 * 用桌面同款引擎校验 pattern 是否合法。
 * 返回错误信息（非法）或 null（合法）；
 * wasm 未就绪时返回 undefined 表示"无法判定"，调用方走 JS 校验兜底。
 */
export function validateWithWasm(pattern: string): string | null | undefined {
  if (!module) return undefined;
  try {
    new module.Regex(pattern, false);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 多行 filter 聚合的单条命中（与 filter-wasm AggHit 形状一致） */
interface WasmAggHit {
  line: number;
  ts: number;
}

/**
 * 多行 filter 命中聚合（与桌面引擎逐字节同源）。
 * 入参为「行号升序、ts 对齐」的命中集列表；返回聚合后的命中集。
 *
 * 优先走 wasm（`filter-wasm::aggregate_filter_hits`，= 桌面
 * `engine/src/filter_agg.rs` 的同一份实现），未就绪/失败时返回 `null`，
 * 调用方（`dbStore.aggregateSubHits`）回退 JS 实现——两者算法一致，仅执行位置不同。
 */
export function aggregateFilterHits(
  pos: { lines: Uint32Array; ts: Float64Array }[],
  neg: { lines: Uint32Array; ts: Float64Array }[],
): { lines: Uint32Array; ts: Float64Array } | null {
  if (!module || typeof module.aggregateFilterHits !== 'function') return null;
  const toJson = (sets: { lines: Uint32Array; ts: Float64Array }[]) =>
    JSON.stringify(
      sets.map((s) =>
        Array.from(s.lines, (line, i) => ({ line, ts: s.ts[i] })),
      ),
    );
  try {
    const out: WasmAggHit[] = JSON.parse(
      module.aggregateFilterHits(toJson(pos), toJson(neg)),
    );
    const lines = new Uint32Array(out.length);
    const ts = new Float64Array(out.length);
    out.forEach((h, i) => {
      lines[i] = h.line;
      ts[i] = h.ts;
    });
    return { lines, ts };
  } catch {
    return null;
  }
}
