//! 引擎性质测试（proptest）
//!
//! 针对「单一实现」语义核心（engine）的**不变量**做随机化验证，而非具体样例：
//! - **CEP 序列匹配 soundness**：任意输入事件流上跑序列匹配，输出的每条链必须是
//!   输入流的子序列（成员 + 链内保序），且「覆盖 ∪ 未覆盖」构成对参与事件集的划分
//!   （不虚算、不双计、不漏算）。
//! - **parser / expr / rules 全量性**：任意输入（含畸形/含换行/超长字符串）不 panic，
//!   且纯函数输出确定。
//!
//! 与具体断言的单测互补：单测锁住已知边界，性质测试扫未知边界。
//! 覆盖门禁：`cargo llvm-cov -p loggraph-engine`（CI 已设 lines ≥ 85%），
//! 本文件为 engine 覆盖率贡献 parser/cep/expr/rules 的高价值路径。

use std::collections::{HashMap, HashSet};

use proptest::prelude::*;

use loggraph_engine::cep::{run_sequences, EdgeSpec, GroupSpec, SeqEvent};
use loggraph_engine::expr::{compile_expr, validate_expr};
use loggraph_engine::parser::line::{detect_log_family, js_trim, parse_rest};
use loggraph_engine::parser::timestamp::{detect_timestamp_format, extract_timestamp, formats};
use loggraph_engine::rules::validate_rules;

// ---------------------------------------------------------------------------
// 1. CEP 序列匹配 soundness（核心不变量）
// ---------------------------------------------------------------------------
// 生成：2~4 条事件流（fid ∈ {A,B,C,D}），每条 0~8 个事件，全局 id 严格递增、
// 流内 ts 严格递增；相邻 fid 连成 seq 边 A→B→C→D，gap 足够大保证可成链。
// 期望输出对任意输入都满足：
//   (a) 不 panic、不产生输入流之外的事件（成员）；
//   (b) 链内步骤事件 id 严格递增（保序）；
//   (c) covered ∪ uncovered == 参与事件全集，且不相交（划分，无漏无重）；
//   (d) uncovered SoA 双列等长。
prop_compose! {
    fn store_and_spec()(n_per_fid in prop::collection::vec(0..8usize, 2..=4))
        -> (HashMap<String, Vec<SeqEvent>>, GroupSpec) {
        let fids: Vec<String> = ["A", "B", "C", "D"][..n_per_fid.len()]
            .iter().map(|s| s.to_string()).collect();
        let mut store: HashMap<String, Vec<SeqEvent>> = HashMap::new();
        let mut gid: u32 = 0;
        for (i, fid) in fids.iter().enumerate() {
            let n = n_per_fid[i];
            let mut evs = Vec::with_capacity(n);
            for k in 0..n {
                let ts = 1_000_000i64 + (i as i64) * 1_000_000 + (k as i64) * 1_000;
                evs.push(SeqEvent::new(gid, ts));
                gid += 1;
            }
            store.insert(fid.clone(), evs);
        }
        let edges = fids.windows(2).map(|w| EdgeSpec {
            id: format!("e-{}", w[0]),
            from_filter_id: w[0].clone(),
            to_filter_id: Some(w[1].clone()),
            to_filter_ids: None,
            kind: Some("seq".to_string()),
            max_gap_ms: 1_000_000,
            period_ms: None,
        }).collect();
        let spec = GroupSpec {
            group_id: "g".to_string(),
            label: None,
            scope: "global".to_string(),
            key_pattern: None,
            filter_ids: fids.clone(),
            edges,
            node_conditions: None,
            node_counts: None,
            max_chains: None,
        };
        (store, spec)
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, .. ProptestConfig::default() })]

    #[test]
    fn cep_soundness_partition_membership((store, spec) in store_and_spec()) {
        let all: HashSet<u32> = store.values().flatten().map(|e| e.id).collect();
        let r = run_sequences(&[spec], &store);
        prop_assert!(!r.fallback, "global scope 应受支持，不应 fallback");
        let res = r.results.get("g").expect("group 'g' 存在");

        let mut covered: HashSet<u32> = HashSet::new();
        for c in &res.chains {
            prop_assert!(c.start_ts <= c.end_ts, "链时间窗 start>end（逆序）");
            let mut prev: Option<u32> = None;
            for st in &c.steps {
                let present = store
                    .get(&st.filter_id)
                    .map(|s| s.iter().any(|e| e.id == st.event.id))
                    .unwrap_or(false);
                prop_assert!(present,
                    "链步骤事件 {}/{} 不在输入流中（虚算）", st.filter_id, st.event.id);
                if let Some(p) = prev {
                    prop_assert!(p < st.event.id, "链内步骤事件 id 非严格递增（重排/复用）");
                }
                prev = Some(st.event.id);
                covered.insert(st.event.id);
            }
        }

        // 未覆盖事件必须是输入流内事件（不虚算）
        for &id in &res.uncovered.ids {
            prop_assert!(all.contains(&id), "未覆盖事件 {id} 不在输入流中（虚算）");
        }
        let uncov: HashSet<u32> = res.uncovered.ids.iter().copied().collect();
        prop_assert!(covered.is_disjoint(&uncov), "覆盖与未覆盖重叠（双计）");
        prop_assert_eq!(covered.len() + uncov.len(), all.len(),
            "覆盖({}) + 未覆盖({}) != 参与事件({})：存在漏算或虚算",
            covered.len(), uncov.len(), all.len());
        prop_assert_eq!(res.uncovered.ids.len(), res.uncovered.ts.len(),
            "uncovered SoA 双列不等长");
    }
}

// ---------------------------------------------------------------------------
// 2. parser::line 全量性 + js_trim 幂等
// ---------------------------------------------------------------------------
proptest! {
    #[test]
    fn detect_log_family_total(rest in any::<String>()) {
        // 任意输入（含换行/超长/畸形）不 panic，且必须返回良构 LogFamily
        let _ = detect_log_family(&[&rest]);
    }

    #[test]
    fn parse_rest_total(rest in any::<String>()) {
        let p = parse_rest(&rest);
        let _ = (p.thread, p.level, p.message);
    }

    #[test]
    fn js_trim_idempotent(s in any::<String>()) {
        prop_assert_eq!(js_trim(&js_trim(&s)), js_trim(&s), "trim 应幂等");
    }
}

// ---------------------------------------------------------------------------
// 3. parser::timestamp 全量性 + 确定性
// ---------------------------------------------------------------------------
proptest! {
    #[test]
    fn timestamp_extract_total_deterministic(line in any::<String>()) {
        // 格式探测：任意输入不 panic
        let _ = detect_timestamp_format(&[line.as_str()]);
        // 每种格式 + 自动探测，任意输入不 panic；重复调用结果一致
        let auto_a = extract_timestamp(&line, None);
        let auto_b = extract_timestamp(&line, None);
        prop_assert_eq!(auto_a.is_some(), auto_b.is_some(), "自动探测不应有副作用");
        if let (Some(a), Some(b)) = (&auto_a, &auto_b) {
            prop_assert_eq!(a.ts, b.ts);
            prop_assert_eq!(a.start, b.start);
            prop_assert_eq!(a.end, b.end);
        }
        for f in formats() {
            let x = extract_timestamp(&line, Some(f));
            let y = extract_timestamp(&line, Some(f));
            prop_assert_eq!(x.is_some(), y.is_some(), "格式提取不应有副作用");
            if let (Some(a), Some(b)) = (&x, &y) {
                prop_assert_eq!(a.ts, b.ts);
                prop_assert_eq!(a.start, b.start);
                prop_assert_eq!(a.end, b.end);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 4. expr 全量性 + 确定性（compile 产物对同一事件应稳定）
// ---------------------------------------------------------------------------
proptest! {
    #[test]
    fn expr_total_deterministic(
        src in any::<String>(),
        id in any::<u32>(),
        ts in any::<i64>(),
        message in any::<String>(),
        raw in any::<String>(),
    ) {
        // 语法校验：任意输入不 panic
        let _ = validate_expr(&src);
        // 编译：任意输入不 panic；编译成功则产物对同一事件确定
        if let Some(f) = compile_expr(&src) {
            let ev = SeqEvent {
                id, ts, raw,
                message,
                thread: None,
                level: None,
                source_file: None,
            };
            let a = f(&ev);
            let b = f(&ev);
            prop_assert_eq!(a, b, "编译后的表达式对同一事件应确定（无隐藏状态）");
        }
    }
}

// ---------------------------------------------------------------------------
// 5. rules 全量性 + 确定性
// ---------------------------------------------------------------------------
proptest! {
    #[test]
    fn rules_validate_total_deterministic(json in any::<String>()) {
        // 任意 JSON 输入不 panic；重复校验结果一致
        let a = validate_rules(&json);
        let b = validate_rules(&json);
        prop_assert_eq!(a.valid, b.valid);
        prop_assert_eq!(a.errors.len(), b.errors.len());
        prop_assert_eq!(a.warnings.len(), b.warnings.len());
    }
}
