//! 多行 filter 的子条件拆分与命中聚合 —— **单一事实来源**。
//!
//! 桌面引擎（`session.rs`）与 Web 端（`filter-wasm` → `dbStore.ts` /
//! `FilterEngine.ts`）都编译/引用本文件的**同一份**实现：
//! - [`split_sub_conditions`]：pattern 按 `\n` 拆成子条件（剥 `!` 前缀、trim、跳空行）。
//! - [`aggregate_sub_hits`]：正向 sub 行集**交集** − 排除 sub 行集**并集**
//!   （以最短正向 sub 为基）。
//!
//! 改这里一处，native 与 wasm 两端同时生效，杜绝两端分叉导致
//! 「同一 filter 在 UI 与引擎算出不同命中」且极难排查的问题
//! （`web-desktop-consistency-review.md` §1.1 / 契约 §3.14）。
//!
//! 注：Web 内存路径（`FilterEngine.ts`）的逐事件流式合流是同一布尔语义的
//! 性能优化变体（按事件 AND 各 sub），数学上等价于本聚合；其等价性由
//! `src/sequence` 下的跨语言测试锁定，不在此文件重复实现。

use serde::{Deserialize, Serialize};

/// 命中条目（line + ts）：与 `session::HitEntry` 字段一致（`{line, ts}`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggHit {
    pub line: u32,
    pub ts: i64,
}

/// 多行 filter 的子条件下推 id 分隔符（`fid\0i`）——与前端
/// `src/io/dbStore.ts::SUB_ID_SEP` 必须**逐字节一致**：引擎命中缓存按子条件
/// 独立存，两端同分隔符才能共享同一份缓存条目、不重复扫描；改任一侧都会
/// 导致命中错位（表现为「多行 filter 在引擎里零命中」）。
pub const SUB_ID_SEP: char = '\u{0}';

/// 多行 filter 的单行子条件：`negate` = 该行以 `!` 开头（排除语义）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubCond {
    pub source: String,
    pub negate: bool,
}

/// pattern → 子条件列表（与前端 `splitSubConditions` 逐字一致）。
/// 剥 `!` 前缀、去首尾空白、跳过空行、纯 `!` 无内容丢弃。
pub fn split_sub_conditions(pattern: &str) -> Vec<SubCond> {
    let mut out = Vec::new();
    for raw in pattern.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        match line.strip_prefix('!') {
            Some(rest) => {
                let source = rest.trim();
                if !source.is_empty() {
                    out.push(SubCond {
                        source: source.to_string(),
                        negate: true,
                    });
                }
            }
            None => out.push(SubCond {
                source: line.to_string(),
                negate: false,
            }),
        }
    }
    out
}

/// 行号升序命中数组的二分包含判断（命中扫描按行号升序写入）。
pub fn hits_contains_line(hits: &[AggHit], line: u32) -> bool {
    hits.binary_search_by_key(&line, |h| h.line).is_ok()
}

/// 子条件命中聚合：正向 sub 行集**交集** − 排除 sub 行集**并集**。
///
/// `pos`/`neg` 均为「行号升序、`ts` 对齐」的命中集列表（每个元素是一个 sub
/// 的全部命中）。以最短正向 sub 为基（候选最少），`ts` 取基列表的同行值
/// （同一物理行的 ts 由 `line_ts` 解析，各 sub 结果一致）。
pub fn aggregate_sub_hits(pos: &[Vec<AggHit>], neg: &[Vec<AggHit>]) -> Vec<AggHit> {
    if pos.is_empty() {
        return Vec::new();
    }
    let mut order: Vec<usize> = (0..pos.len()).collect();
    order.sort_by_key(|&i| pos[i].len());
    let base = &pos[order[0]];
    let mut out = Vec::with_capacity(base.len());
    'next: for e in base.iter() {
        for &i in order.iter().skip(1) {
            if !hits_contains_line(&pos[i], e.line) {
                continue 'next;
            }
        }
        for n in neg {
            if hits_contains_line(n, e.line) {
                continue 'next;
            }
        }
        out.push(*e);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_ports_frontend_semantics() {
        // 剥 ! / trim / 跳空行 / 纯!丢弃 —— 与前端 splitSubConditions 逐字一致
        let p = "  A  \n!B\n\n!  \nC";
        let subs = split_sub_conditions(p);
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0], SubCond { source: "A".into(), negate: false });
        assert_eq!(subs[1], SubCond { source: "B".into(), negate: true });
        assert_eq!(subs[2], SubCond { source: "C".into(), negate: false });
        // 纯空白 → 空
        assert!(split_sub_conditions("\n  \n").is_empty());
        // 纯 ! 行丢弃
        assert_eq!(
            split_sub_conditions("alpha\n!"),
            vec![SubCond { source: "alpha".into(), negate: false }]
        );
    }

    #[test]
    fn aggregate_intersect_minus_union() {
        let a = vec![
            AggHit { line: 1, ts: 10 },
            AggHit { line: 2, ts: 20 },
            AggHit { line: 3, ts: 30 },
        ];
        let b = vec![
            AggHit { line: 2, ts: 20 },
            AggHit { line: 3, ts: 30 },
        ];
        let c = vec![AggHit { line: 3, ts: 30 }]; // 排除
        let out = aggregate_sub_hits(&[a, b], &[c]);
        assert_eq!(out, vec![AggHit { line: 2, ts: 20 }]); // (1∩2) − {3}
    }

    #[test]
    fn aggregate_empty_when_no_positive() {
        let neg = vec![AggHit { line: 1, ts: 10 }];
        assert!(aggregate_sub_hits(&[], &[neg]).is_empty());
    }

    #[test]
    fn aggregate_picks_shortest_base() {
        // 正向 a(100 行) b(2 行) → 以 b 为基，结果只含 a∩b
        let a: Vec<AggHit> = (0..100).map(|i| AggHit { line: i, ts: i as i64 }).collect();
        let b = vec![AggHit { line: 5, ts: 5 }, AggHit { line: 7, ts: 7 }];
        let out = aggregate_sub_hits(&[a, b.clone()], &[]);
        assert_eq!(out, b);
    }
}
