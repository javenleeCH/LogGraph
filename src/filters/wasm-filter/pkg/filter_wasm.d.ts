/* tslint:disable */
/* eslint-disable */

export class MatchSpan {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    end: number;
    start: number;
}

/**
 * 编译后的正则表达式，底层是 Rust 标准 `regex` crate —— 与桌面（Tauri）后端
 * 用于过滤的引擎逐字节一致。导出到 JS，让 Web 端过滤结果与桌面端完全相同。
 *
 * 默认启用 Unicode 模式（与 `regex::Regex::new` 一致），因此 `\b` 按 Unicode
 * 词边界解释，与桌面端一致；且同样**不支持**环视断言 / 反向引用（编译即报错），
 * 从而消除 web/desktop 的过滤引擎分歧（web-desktop-consistency-review.md §1.1）。
 */
export class Regex {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 返回首个匹配的 [start, end) 字节区间，无匹配返回 null。
     */
    find(text: string): MatchSpan | undefined;
    /**
     * 若 pattern 在 text 中任意位置匹配则返回 true。
     */
    isMatch(text: string): boolean;
    /**
     * 编译一个 pattern。`case_insensitive` 对应桌面过滤器的同名开关。
     */
    constructor(pattern: string, case_insensitive: boolean);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_matchspan_end: (a: number) => number;
    readonly __wbg_get_matchspan_start: (a: number) => number;
    readonly __wbg_matchspan_free: (a: number, b: number) => void;
    readonly __wbg_regex_free: (a: number, b: number) => void;
    readonly __wbg_set_matchspan_end: (a: number, b: number) => void;
    readonly __wbg_set_matchspan_start: (a: number, b: number) => void;
    readonly regex_find: (a: number, b: number, c: number) => number;
    readonly regex_isMatch: (a: number, b: number, c: number) => number;
    readonly regex_new: (a: number, b: number, c: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
