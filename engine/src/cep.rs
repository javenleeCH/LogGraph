//! CEP（Complex Event Processing）：EPL 风格的事件序列模式匹配。
//!
//! 本模块从原 `src-tauri/src/sequence.rs` 抽出为**纯算法**：不再直连 SQLite，
//! 事件源由调用方以 `filter_id -> 事件流` 的形式提供（引擎层可接 rg 直扫结果、
//! 内存数组或瘦 SQL 查询）。
//!
//! 当前覆盖（global 作用域）：`seq` / `not` / `and` / `or` 四类边。
//! 未覆盖（调用方应回退/后续迭代）：`thread` 分桶、`opt`、`periodic`、
//! 节点循环计数、节点条件表达式——见 [`GroupSpec::is_supported`]。
//! DTO 形状按契约 §2.4/§3：camelCase + `deny_unknown_fields`，
//! `toFilterId` 对 and/or 边不提供（S06），多目标走 `toFilterIds`。

use crate::error::EngineResult;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

// ---- 请求 DTO ----

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupSpec {
    pub group_id: String,
    /// 展示名（UI 元数据，引擎忽略，契约 §3.4）
    #[serde(default)]
    pub label: Option<String>,
    /// "global" | "thread"（缺省 global，契约 §3.4）
    #[serde(default = "default_scope")]
    pub scope: String,
    pub filter_ids: Vec<String>,
    pub edges: Vec<EdgeSpec>,
    #[serde(default)]
    pub node_conditions: Option<HashMap<String, String>>,
    #[serde(default)]
    pub node_counts: Option<HashMap<String, NodeCountSpec>>,
}

fn default_scope() -> String {
    "global".to_string()
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeSpec {
    pub id: String,
    pub from_filter_id: String,
    /// seq/not/opt/periodic 必填；and/or 禁止（S06，契约 §3.5）
    #[serde(default)]
    pub to_filter_id: Option<String>,
    /// and/or 必填（2..16 项）；其余 kind 禁止（S06）
    #[serde(default)]
    pub to_filter_ids: Option<Vec<String>>,
    /// seq（默认）/ not / and / or / opt / periodic
    #[serde(default)]
    pub kind: Option<String>,
    pub max_gap_ms: i64,
    /// 仅 periodic（S07）
    #[serde(default)]
    pub period_ms: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct NodeCountSpec {
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

// ---- 事件与响应 DTO（camelCase，对齐前端 SequenceMatchResult） ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeqEvent {
    pub id: u32,
    pub ts: i64,
    #[serde(default)]
    pub raw: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub thread: Option<String>,
}

impl SeqEvent {
    pub fn new(id: u32, ts: i64) -> Self {
        SeqEvent { id, ts, raw: String::new(), message: String::new(), thread: None }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    #[serde(rename = "edgeId")]
    pub edge_id: Option<String>,
    #[serde(rename = "filterId")]
    pub filter_id: String,
    pub event: SeqEvent,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchedChain {
    #[serde(rename = "chainIndex")]
    pub chain_index: u32,
    pub steps: Vec<Step>,
    #[serde(rename = "startTs")]
    pub start_ts: i64,
    #[serde(rename = "endTs")]
    pub end_ts: i64,
    pub thread: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EdgeStat {
    #[serde(rename = "edgeId")]
    pub edge_id: String,
    #[serde(rename = "matchedCount")]
    pub matched_count: u32,
    #[serde(rename = "missCount")]
    pub miss_count: u32,
    #[serde(rename = "lateCount", skip_serializing_if = "Option::is_none")]
    pub late_count: Option<u32>,
    #[serde(rename = "jitterCount", skip_serializing_if = "Option::is_none")]
    pub jitter_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotViolation {
    #[serde(rename = "edgeId")]
    pub edge_id: String,
    #[serde(rename = "fromEvent")]
    pub from_event: SeqEvent,
    #[serde(rename = "toEvent")]
    pub to_event: SeqEvent,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    #[serde(rename = "filterId")]
    pub filter_id: String,
    pub thread: Option<String>,
    pub segments: Vec<Seg>,
    pub gaps: Vec<Gap>,
    pub jitters: Vec<Jitter>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Seg {
    #[serde(rename = "startTs")]
    pub start_ts: i64,
    #[serde(rename = "endTs")]
    pub end_ts: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Gap {
    #[serde(rename = "afterTs")]
    pub after_ts: i64,
    #[serde(rename = "expectedTs")]
    pub expected_ts: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Jitter {
    pub ts: i64,
    pub interval: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SeqResult {
    #[serde(rename = "groupId")]
    pub group_id: String,
    pub chains: Vec<MatchedChain>,
    #[serde(rename = "uncoveredEvents")]
    pub uncovered_events: Vec<SeqEvent>,
    #[serde(rename = "edgeStats")]
    pub edge_stats: Vec<EdgeStat>,
    #[serde(rename = "notViolations")]
    pub not_violations: Vec<NotViolation>,
    pub heartbeats: Vec<Heartbeat>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunSeqResponse {
    /// true → 存在引擎当前不支持的 group，调用方应整体回退
    pub fallback: bool,
    /// BTreeMap：--json 输出按 groupId 字典序（agent 可依赖键序，契约 §5.2）
    pub results: BTreeMap<String, SeqResult>,
}

/// 事件源：filter_id -> 按 (ts, id) 升序的事件流
pub type EventStore<'a> = HashMap<String, Vec<SeqEvent>>;

// ---- 匹配核心（忠实移植原 sequence.rs 的 global 语义） ----

fn targets_of(e: &EdgeSpec) -> Vec<String> {
    let kind = e.kind.as_deref().unwrap_or("seq");
    if (kind == "and" || kind == "or")
        && e.to_filter_ids.as_ref().map(|v| !v.is_empty()).unwrap_or(false)
    {
        e.to_filter_ids.clone().unwrap()
    } else {
        e.to_filter_id.clone().map(|t| vec![t]).unwrap_or_default()
    }
}

/// 链推进的后继锚点：单目标边即 `toFilterId`；and/or 多目标边取首个目标
/// （对齐 TS `SequenceMatcher.dfsChain` 用 `e.toFilterId` 作延续锚点的
/// 语义，UI 约定 toFilterId = 首个目标；契约 §3.5）。
fn anchor_of(e: &EdgeSpec) -> String {
    e.to_filter_id
        .clone()
        .or_else(|| e.to_filter_ids.as_ref().and_then(|v| v.first().cloned()))
        .unwrap_or_default()
}

fn edge_kind(e: &EdgeSpec) -> String {
    e.kind.clone().unwrap_or_else(|| "seq".to_string())
}

fn bisect_left(events: &[SeqEvent], lo: i64) -> usize {
    let mut lo_i = 0usize;
    let mut hi_i = events.len();
    while lo_i < hi_i {
        let mid = (lo_i + hi_i) / 2;
        if events[mid].ts < lo {
            lo_i = mid + 1;
        } else {
            hi_i = mid
        }
    }
    lo_i
}

fn next_unused_idx(events: &[SeqEvent], consumed: &HashSet<u32>, lo: i64) -> usize {
    let mut i = bisect_left(events, lo);
    if i > 0 && events[i - 1].ts > lo {
        i -= 1;
    }
    while i < events.len() && (events[i].ts <= lo || consumed.contains(&events[i].id)) {
        i += 1;
    }
    i
}

/// 单边推进判定：ok(None)=not 通过且不断链；ok(Some)=推进到目标事件；
/// violation=not 违规；break=断裂（目标缺失/插队/窗口耗尽）。
enum Advance {
    Ok(Option<SeqEvent>),
    Violation(SeqEvent),
    Break,
}

/// 在窗口内找最早就绪目标（ts 升序，ts 相同按 filterId 字典序）。
fn earliest_ready(
    targets: &[String],
    events_by_target: &HashMap<String, Vec<SeqEvent>>,
    consumed: &HashSet<u32>,
    from_ts: i64,
    idx: &mut HashMap<String, usize>,
) -> Option<(String, SeqEvent)> {
    let mut best: Option<(String, SeqEvent)> = None;
    for t in targets {
        let evs = events_by_target.get(t).cloned().unwrap_or_default();
        let mut i = *idx.get(t).unwrap_or(&evs.len());
        while i < evs.len() && (evs[i].ts <= from_ts || consumed.contains(&evs[i].id)) {
            i += 1;
        }
        idx.insert(t.clone(), i);
        if i < evs.len() {
            let ev = evs[i].clone();
            match &best {
                None => best = Some((t.clone(), ev)),
                Some(b) => {
                    if ev.ts < b.1.ts || (ev.ts == b.1.ts && t < &b.0) {
                        best = Some((t.clone(), ev));
                    }
                }
            }
        }
    }
    best
}

#[allow(clippy::too_many_arguments)]
fn advance_edge(
    edge: &EdgeSpec,
    from_events: &[SeqEvent],
    events_by_target: &HashMap<String, Vec<SeqEvent>>,
    consumed: &HashSet<u32>,
    from_ts: i64,
) -> Advance {
    let hi = from_ts + edge.max_gap_ms;
    let kind = edge_kind(edge);
    let targets = targets_of(edge);

    let mut idx: HashMap<String, usize> = HashMap::new();
    for t in &targets {
        let evs = events_by_target.get(t).cloned().unwrap_or_default();
        idx.insert(t.clone(), next_unused_idx(&evs, consumed, from_ts));
    }
    let i_from = next_unused_idx(from_events, consumed, from_ts);

    if kind == "not" {
        let from_ev = if i_from < from_events.len() { Some(&from_events[i_from]) } else { None };
        let ready = earliest_ready(&targets, events_by_target, consumed, from_ts, &mut idx);
        if let Some(r) = ready {
            if r.1.ts <= hi && (from_ev.is_none() || r.1.ts < from_ev.unwrap().ts) {
                return Advance::Violation(r.1);
            }
        }
        return Advance::Ok(None);
    }

    let mut and_ready: HashMap<String, SeqEvent> = HashMap::new();
    let target_set: HashSet<String> = targets.iter().cloned().collect();
    loop {
        let from_ev = if i_from < from_events.len() { Some(&from_events[i_from]) } else { None };
        let from_ts_next = from_ev.map(|e| e.ts).unwrap_or(i64::MAX);
        let ready = earliest_ready(&targets, events_by_target, consumed, from_ts, &mut idx);
        let ready_ts = ready.as_ref().map(|r| r.1.ts).unwrap_or(i64::MAX);

        if ready_ts > hi && from_ts_next > hi {
            return Advance::Break;
        }
        if ready_ts <= hi && ready_ts < from_ts_next && ready.is_some() {
            let r = ready.unwrap();
            if kind == "and" {
                and_ready.insert(r.0.clone(), r.1.clone());
                if let Some(slot) = idx.get_mut(&r.0) {
                    *slot += 1;
                }
                if and_ready.len() == target_set.len() {
                    let mut first: Option<SeqEvent> = None;
                    for ev in and_ready.values() {
                        match &first {
                            None => first = Some(ev.clone()),
                            Some(f) => {
                                if ev.ts < f.ts {
                                    first = Some(ev.clone());
                                }
                            }
                        }
                    }
                    return Advance::Ok(first);
                }
                continue;
            }
            return Advance::Ok(Some(r.1));
        }
        return Advance::Break;
    }
}

/// 解析推进链（排除 not/periodic 自环；环从各节点各试一次）。
fn resolve_chains(edges: &[EdgeSpec]) -> Vec<Vec<EdgeSpec>> {
    let flow: Vec<EdgeSpec> = edges
        .iter()
        .filter(|e| {
            let k = edge_kind(e);
            k != "periodic" && k != "not"
        })
        .cloned()
        .collect();
    let mut in_deg: HashMap<String, usize> = HashMap::new();
    let mut out_edges: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, e) in flow.iter().enumerate() {
        for t in targets_of(e) {
            *in_deg.entry(t).or_insert(0) += 1;
        }
        out_edges.entry(e.from_filter_id.clone()).or_default().push(i);
    }

    let mut chains: Vec<Vec<EdgeSpec>> = Vec::new();
    fn dfs(
        start: usize,
        acc: &mut Vec<usize>,
        used: &mut HashSet<usize>,
        all: &HashMap<String, Vec<usize>>,
        flow: &[EdgeSpec],
        out: &mut Vec<Vec<EdgeSpec>>,
    ) {
        let nexts = all.get(&anchor_of(&flow[start])).cloned().unwrap_or_default();
        let mut extended = false;
        for nx in nexts {
            if used.contains(&nx) {
                continue;
            }
            used.insert(nx);
            acc.push(nx);
            dfs(nx, acc, used, all, flow, out);
            acc.pop();
            used.remove(&nx);
            extended = true;
        }
        if !extended {
            out.push(acc.iter().map(|&i| flow[i].clone()).collect());
        }
    }

    for (i, e) in flow.iter().enumerate() {
        if in_deg.get(&e.from_filter_id).copied().unwrap_or(0) == 0 {
            dfs(i, &mut vec![i], &mut HashSet::new(), &out_edges, &flow, &mut chains);
        }
    }
    let mut visited: HashSet<String> = HashSet::new();
    for (i, e) in flow.iter().enumerate() {
        if in_deg.get(&e.from_filter_id).copied().unwrap_or(0) > 0
            && !visited.contains(&e.from_filter_id)
        {
            visited.insert(e.from_filter_id.clone());
            dfs(i, &mut vec![i], &mut HashSet::new(), &out_edges, &flow, &mut chains);
        }
    }
    chains
}

fn stat_mut<'a>(stats: &'a mut Vec<EdgeStat>, id: &str) -> Option<&'a mut EdgeStat> {
    stats.iter_mut().find(|s| s.edge_id == id)
}

impl GroupSpec {
    /// 引擎当前是否支持该 group（不支持则调用方回退）
    pub fn is_supported(&self) -> bool {
        if self.scope == "thread" {
            return false;
        }
        if self.node_conditions.as_ref().map(|m| !m.is_empty()).unwrap_or(false) {
            return false;
        }
        if self.node_counts.as_ref().map(|m| !m.is_empty()).unwrap_or(false) {
            return false;
        }
        for e in &self.edges {
            let k = edge_kind(e);
            if k == "opt" || k == "periodic" {
                return false;
            }
        }
        true
    }
}

/// 对单个 group 跑序列匹配。事件流由 [`EventStore`] 提供（纯算法，不接触存储层）。
pub fn match_group(spec: &GroupSpec, store: &EventStore<'_>) -> EngineResult<SeqResult> {
    let get_events = |fid: &str| -> &[SeqEvent] {
        store.get(fid).map(|v| v.as_slice()).unwrap_or(&[])
    };

    let mut edge_stats: Vec<EdgeStat> = spec
        .edges
        .iter()
        .map(|e| EdgeStat {
            edge_id: e.id.clone(),
            matched_count: 0,
            miss_count: 0,
            late_count: None,
            jitter_count: None,
        })
        .collect();

    let mut violations: Vec<NotViolation> = Vec::new();

    // NOT 边：纯断言（不消耗事件）
    for edge in &spec.edges {
        if edge_kind(edge) != "not" {
            continue;
        }
        let Some(to_fid) = edge.to_filter_id.as_deref() else {
            continue;
        };
        let from_events = get_events(&edge.from_filter_id).to_vec();
        let to_events = get_events(to_fid).to_vec();
        let no_consumed = HashSet::new();
        for fe in &from_events {
            let ev_by_target = HashMap::from([(to_fid.to_string(), to_events.clone())]);
            let r = advance_edge(edge, &from_events, &ev_by_target, &no_consumed, fe.ts);
            if let Advance::Violation(tgt) = r {
                violations.push(NotViolation {
                    edge_id: edge.id.clone(),
                    from_event: fe.clone(),
                    to_event: tgt,
                });
                if let Some(st) = stat_mut(&mut edge_stats, &edge.id) {
                    st.miss_count += 1;
                }
            }
        }
    }

    // 推进链匹配
    let resolved = resolve_chains(&spec.edges);
    let mut consumed: HashSet<u32> = HashSet::new();
    let mut chains: Vec<MatchedChain> = Vec::new();
    let mut chain_index = 0u32;

    for chain in &resolved {
        let head_fid = &chain[0].from_filter_id;
        let head_events = get_events(head_fid).to_vec();
        if head_events.is_empty() {
            if let Some(st) = stat_mut(&mut edge_stats, &chain[0].id) {
                st.miss_count += 1;
            }
            continue;
        }
        for e0 in &head_events {
            if consumed.contains(&e0.id) {
                continue;
            }
            let mut steps: Vec<Step> = vec![Step {
                edge_id: None,
                filter_id: head_fid.clone(),
                event: e0.clone(),
            }];
            let mut cur = e0.clone();
            let mut ok = true;
            for edge in chain {
                let kind = edge_kind(edge);
                let from_events = get_events(&edge.from_filter_id).to_vec();
                let mut ev_by_target: HashMap<String, Vec<SeqEvent>> = HashMap::new();
                for t in targets_of(edge) {
                    ev_by_target.insert(t.clone(), get_events(&t).to_vec());
                }
                let r = advance_edge(edge, &from_events, &ev_by_target, &consumed, cur.ts);
                match r {
                    Advance::Break => {
                        if let Some(st) = stat_mut(&mut edge_stats, &edge.id) {
                            st.miss_count += 1;
                        }
                        ok = false;
                        break;
                    }
                    Advance::Violation(tgt) => {
                        violations.push(NotViolation {
                            edge_id: edge.id.clone(),
                            from_event: cur.clone(),
                            to_event: tgt,
                        });
                        if let Some(st) = stat_mut(&mut edge_stats, &edge.id) {
                            st.miss_count += 1;
                        }
                        ok = false;
                        break;
                    }
                    Advance::Ok(moved_to) => {
                        if let Some(st) = stat_mut(&mut edge_stats, &edge.id) {
                            st.matched_count += 1;
                        }
                        if let Some(mt) = moved_to {
                            if kind == "and" {
                                for t in targets_of(edge) {
                                    let evs = ev_by_target.get(&t).cloned().unwrap_or_default();
                                    let i = next_unused_idx(&evs, &consumed, cur.ts);
                                    if i < evs.len() && evs[i].ts <= cur.ts + edge.max_gap_ms {
                                        steps.push(Step {
                                            edge_id: Some(edge.id.clone()),
                                            filter_id: t.clone(),
                                            event: evs[i].clone(),
                                        });
                                    }
                                }
                                cur = mt;
                            } else {
                                let t_fid = if kind == "or" || kind == "seq" {
                                    ev_by_target
                                        .iter()
                                        .find(|(_, evs)| evs.contains(&mt))
                                        .map(|(k, _)| k.clone())
                                        .unwrap_or_else(|| anchor_of(edge))
                                } else {
                                    anchor_of(edge)
                                };
                                steps.push(Step {
                                    edge_id: Some(edge.id.clone()),
                                    filter_id: t_fid,
                                    event: mt.clone(),
                                });
                                cur = mt;
                            }
                        }
                    }
                }
            }
            if !ok {
                continue;
            }
            chain_index += 1;
            for s in &steps {
                consumed.insert(s.event.id);
            }
            let start_ts = steps[0].event.ts;
            let end_ts = steps.last().unwrap().event.ts;
            chains.push(MatchedChain {
                chain_index,
                steps,
                start_ts,
                end_ts,
                thread: None,
            });
        }
    }

    let mut uncovered: Vec<SeqEvent> = Vec::new();
    for fid in &spec.filter_ids {
        for ev in get_events(fid) {
            if !consumed.contains(&ev.id) {
                uncovered.push(ev.clone());
            }
        }
    }
    uncovered.sort_by_key(|e| (e.ts, e.id));

    chains.sort_by_key(|c| (c.start_ts, c.end_ts));
    for (i, c) in chains.iter_mut().enumerate() {
        c.chain_index = (i as u32) + 1;
    }

    Ok(SeqResult {
        group_id: spec.group_id.clone(),
        chains,
        uncovered_events: uncovered,
        edge_stats,
        not_violations: violations,
        heartbeats: Vec::new(),
    })
}

/// 批量入口：对每个 group 跑匹配；任一不支持 → fallback=true（调用方整体回退）。
pub fn run_sequences(groups: &[GroupSpec], store: &EventStore<'_>) -> RunSeqResponse {
    let mut results: BTreeMap<String, SeqResult> = BTreeMap::new();
    let mut fallback = false;
    for spec in groups {
        if !spec.is_supported() {
            fallback = true;
            continue;
        }
        match match_group(spec, store) {
            Ok(r) => {
                results.insert(spec.group_id.clone(), r);
            }
            Err(_) => fallback = true,
        }
    }
    RunSeqResponse { fallback, results }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(pairs: &[(&str, &[(u32, i64)])]) -> EventStore<'static> {
        pairs
            .iter()
            .map(|(fid, evs)| {
                (fid.to_string(), evs.iter().map(|&(id, ts)| SeqEvent::new(id, ts)).collect())
            })
            .collect()
    }

    fn seq_edge() -> EdgeSpec {
        EdgeSpec {
            id: "e1".into(),
            from_filter_id: "A".into(),
            to_filter_id: Some("B".into()),
            to_filter_ids: None,
            kind: Some("seq".into()),
            max_gap_ms: 1000,
            period_ms: None,
        }
    }

    #[test]
    fn seq_edge_within_window_matches() {
        // A: 100, 200 ; B: 150 (在 A@100 窗口内), 5000 (窗口外)
        let s = store(&[("A", &[(1, 100), (2, 200)]), ("B", &[(3, 150), (4, 5000)])]);
        let spec = GroupSpec {
            group_id: "g1".into(),
            filter_ids: vec!["A".into(), "B".into()],
            label: None,
            scope: "global".into(),
            edges: vec![seq_edge()],
            node_conditions: None,
            node_counts: None,
        };
        let r = match_group(&spec, &s).unwrap();
        assert_eq!(r.chains.len(), 1, "应只有 1 条链");
        assert_eq!(r.chains[0].steps.len(), 2);
        assert_eq!(r.chains[0].steps[0].event.id, 1);
        assert_eq!(r.chains[0].steps[1].event.id, 3);
        let st = &r.edge_stats[0];
        assert_eq!(st.matched_count, 1);
        assert_eq!(st.miss_count, 1);
        assert_eq!(r.uncovered_events.len(), 2);
    }

    #[test]
    fn not_edge_violation_detected() {
        let s = store(&[("A", &[(1, 100)]), ("B", &[(2, 120)])]);
        let spec = GroupSpec {
            group_id: "g2".into(),
            filter_ids: vec!["A".into(), "B".into()],
            label: None,
            scope: "global".into(),
            edges: vec![EdgeSpec { kind: Some("not".into()), ..seq_edge() }],
            node_conditions: None,
            node_counts: None,
        };
        let r = match_group(&spec, &s).unwrap();
        assert_eq!(r.not_violations.len(), 1);
        assert_eq!(r.not_violations[0].from_event.id, 1);
        assert_eq!(r.not_violations[0].to_event.id, 2);
    }

    #[test]
    fn and_edge_requires_all_targets() {
        // A@100，B@150，C@200，窗口 1000 → A -> (B AND C) 成链
        let s = store(&[("A", &[(1, 100)]), ("B", &[(2, 150)]), ("C", &[(3, 200)])]);
        let spec = GroupSpec {
            group_id: "g3".into(),
            filter_ids: vec!["A".into(), "B".into(), "C".into()],
            label: None,
            scope: "global".into(),
            edges: vec![EdgeSpec {
                id: "e_and".into(),
                from_filter_id: "A".into(),
                to_filter_id: None,
                to_filter_ids: Some(vec!["B".into(), "C".into()]),
                kind: Some("and".into()),
                max_gap_ms: 1000,
                period_ms: None,
            }],
            node_conditions: None,
            node_counts: None,
        };
        let r = match_group(&spec, &s).unwrap();
        assert_eq!(r.chains.len(), 1);
        assert_eq!(r.chains[0].steps.len(), 3);
    }

    #[test]
    fn unsupported_scope_falls_back() {
        let spec = GroupSpec {
            group_id: "g4".into(),
            filter_ids: vec!["A".into()],
            label: None,
            scope: "thread".into(),
            edges: vec![],
            node_conditions: None,
            node_counts: None,
        };
        assert!(!spec.is_supported());
    }

    #[test]
    fn and_edge_chain_anchor_is_first_target() {
        // and 边作链中段：锚点 = toFilterIds[0]（B），链 A→(B∧C)→D 中
        // B 之后应从 edge2（B→D）继续推进
        let s = store(&[
            ("A", &[(1, 100)]),
            ("B", &[(2, 150)]),
            ("C", &[(3, 160)]),
            ("D", &[(4, 300)]),
        ]);
        let spec = GroupSpec {
            group_id: "g5".into(),
            filter_ids: vec!["A".into(), "B".into(), "C".into(), "D".into()],
            label: None,
            scope: "global".into(),
            edges: vec![
                EdgeSpec {
                    id: "e_and".into(),
                    from_filter_id: "A".into(),
                    to_filter_id: None,
                    to_filter_ids: Some(vec!["B".into(), "C".into()]),
                    kind: Some("and".into()),
                    max_gap_ms: 1000,
                    period_ms: None,
                },
                EdgeSpec {
                    id: "e_bd".into(),
                    from_filter_id: "B".into(),
                    to_filter_id: Some("D".into()),
                    to_filter_ids: None,
                    kind: Some("seq".into()),
                    max_gap_ms: 1000,
                    period_ms: None,
                },
            ],
            node_conditions: None,
            node_counts: None,
        };
        let r = match_group(&spec, &s).unwrap();
        assert_eq!(r.chains.len(), 1, "应成一条 A→(B∧C)→D 链");
        let ids: Vec<u32> = r.chains[0].steps.iter().map(|st| st.event.id).collect();
        assert_eq!(ids, vec![1, 2, 3, 4]);
    }
}
