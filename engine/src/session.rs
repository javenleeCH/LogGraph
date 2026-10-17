//! 目录工作区：便宜通道建库 + REST 式请求（无会话状态）。
//!
//! v1.2 自 src-tauri 壳层下沉；REST 化后接口无状态自描述：
//! - [`Session::build_ctx`]：付唯一一次整读价（并行读 + 行偏移 + 计数 + 首/末行 ts），
//!   产出 [`WsCtx`]（文件表 + 行数/范围/格式 id）——客户端持有、每请求回传。
//! - [`Session::from_ctx`]：按回传 ctx 零 I/O 重建工作视图（快照语义：信任
//!   ctx 记录的行号布局，活日志追加不炸、不做 mtime 校验拒绝）。
//!
//! 原始文件是唯一事实源。ctx 只描述「行号 → 文件/行」布局；两种大产物不做
//! 请求参数，走 `.logGraph` 透明内容寻址磁盘缓存（可删、只影响延迟）：
//! - 行偏移表 `index/<fnv64(name)>.off`：单文件懒建（line/lines seek 直读用），
//!   头部 size/mtime/行数三验防陈旧；
//! - filter 命中集 `cache/filters/<hex(fnv(ctx_sig+定义指纹))>.bin`：miss 重扫。
//! 引擎零写副作用：产物经 [`Session::take_persistable`] 以数据返回，
//! 壳层（Tauri/CLI）尽力落盘（写失败只降速不变错）。
//!
//! 过滤扫描本就重读原文件，命中行的 ts 在扫描时内联解析（`line_ts_of`），
//! 不做逐行 ts 提取/排序/直查表。

use crate::cep::{self, GroupSpec, RunSeqResponse, SeqEvent};
use crate::error::{EngineError, EngineResult};
use crate::parser::timestamp::{
    detect_timestamp_format, extract_timestamp, find_format, TsFormat,
};
use crate::parser::{js_trim, walk_log_files};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

// ---- DTO ----

/// 命中条目（line + ts）：过滤扫描内联解析写入命中缓存（ts = NO_TS 表示该行无 ts）
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HitEntry {
    pub line: u32,
    pub ts: i64,
}

/// 过滤参数（对齐前端 Filter 匹配字段）
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterQuery {
    pub filter_id: String,
    pub pattern: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    /// raw=整行；message=时间戳后正文
    pub scope: String,
}

/// 多行 filter 子条件的下推 id 分隔符（`fid\0i`）——与前端
/// `src/io/dbStore.ts::SUB_ID_SEP` 必须**逐字节一致**：引擎命中缓存按子条件
/// 独立存，两端同分隔符才能共享同一份缓存条目，不重复扫描；改任一侧都会
/// 导致命中错位（表现为「多行 filter 在引擎里零命中」）。
const SUB_ID_SEP: char = '\u{0}';

/// 多行 filter 的单行子条件：negate=该行以 `!` 开头（排除语义）
struct SubCond {
    source: String,
    negate: bool,
}

/// 展开计划里的单个子条件下推条目
struct SubPlan {
    id: String,
    negate: bool,
}

/// 一个多行 filter 的展开计划：原始 id + 定义指纹 + 子条件清单。
/// 持有原始指纹是为了聚合完成后按原始 id 落缓存，使下次整条命中。
struct MultiPlan {
    filter_id: String,
    fp: String,
    subs: Vec<SubPlan>,
}

/// 行号升序命中数组的二分包含判断（命中扫描按行号升序写入）
fn hits_contains_line(hits: &[HitEntry], line: u32) -> bool {
    hits.binary_search_by_key(&line, |h| h.line).is_ok()
}

/// ctx 文件表条目：行号 → 文件定位的最小描述（客户端不透明持有、原样回传）
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CtxFile {
    /// 相对路径
    pub name: String,
    /// 该文件首行的全局行号
    pub first_line: u32,
    /// 行数（split('\n') 分段语义，含尾空段）
    pub line_count: u32,
    /// 内容字节数（磁盘缓存内容寻址成分）
    pub size: u64,
}

/// 工作区上下文（`ws_info` 返回，客户端持有、后续请求回传）。
/// 快照语义：引擎信任回传布局（活日志追加不炸、不做 mtime 校验拒绝）；
/// 行为等价旧会话的「骨架」——`total_lines`/`skipped`/`file_count`/范围/格式 id
/// 字段名与前端 `DbOpenResult` 完全一致。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WsCtx {
    /// 文件表（first_line 升序）
    pub files: Vec<CtxFile>,
    pub total_lines: u32,
    pub skipped: u32,
    /// 打开时的文件数（含读取失败被跳过的——与历史 IPC 语义一致）
    pub file_count: u32,
    /// 时间戳格式 id（探测失败 → None；回传未知 id 视为损坏 ctx）
    pub timestamp_format_id: Option<String>,
    /// 时间轴范围（epoch ms）；目录无任何 ts → None（前端退回非 dbMode）
    pub range_start: Option<i64>,
    pub range_end: Option<i64>,
}

/// 文件清单条目（无限上下文用：行号 → 所属文件定位 + 右键打开）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// 该文件首行的全局行号
    pub first_line: u32,
    /// 相对路径（显示用）
    pub name: String,
    /// 绝对路径（reveal / 外部打开用）
    pub path: String,
}

/// 批量过滤结果：(filter_id, (line, ts)[] 按 ts 升序；无 ts 命中被丢弃)。
/// 二进制 SoA 编码（~12B/命中）属壳层输出格式化，留在 Tauri/CLI。
pub type FilterBatchOut = Vec<(String, Vec<HitEntry>)>;

/// 批量过滤产物：结果 + 指纹/扫描诊断（壳层自行落地 perf 日志）
pub struct FiltersBatchOutcome {
    pub out: FilterBatchOut,
    /// 指纹命中的 filter 数（未重扫）
    pub cached: usize,
    /// 重扫的 filter 数
    pub miss: usize,
    /// 单遍扫描的每文件计时行（"scan {file} ... read/iter/msg hits"）
    pub scan_perf: Vec<String>,
}

// ---- 内存会话 ----

/// 命中行的「无时间戳」哨兵（该行时间线上无位置）
pub const NO_TS: i64 = i64::MIN;

pub(crate) struct FileEntry {
    /// 相对路径
    pub name: String,
    /// 该文件首行的全局行号
    pub first_line: u32,
    /// 行数（split('\n') 分段语义；ctx 往返 + .off 缓存三验成分）
    pub line_count: u32,
    /// 内容字节数（磁盘缓存内容寻址成分）
    pub size: u64,
    /// 每行起始字节偏移；行 i 字节区间 = [off[i], off[i+1] 或文件尾)。
    /// 建库路径自带；from_ctx 路径恒空（懒建：`Session::ensure_offsets`）
    pub offsets: Arc<Vec<u64>>,
}

/// filter 命中缓存：filter_id → 升序 (line, ts) 命中 + 定义指纹（命中则免重扫）
#[derive(Default)]
struct FilterCache {
    hits: HashMap<String, Arc<Vec<HitEntry>>>,
    fps: HashMap<String, String>,
}

/// 请求级工作视图：`build_ctx`（建库路径，自带偏移）或 `from_ctx`（ctx 路径，
/// 偏移懒建）构造。骨架（files/行偏移/行数）构造后不可变；filter 命中缓存在
/// 内层 Mutex 中累积；待落盘缓存工件在 `persist` 中累积（引擎不写盘）。
pub struct Session {
    root: PathBuf,
    /// first_line 升序
    pub(crate) files: Vec<FileEntry>,
    pub(crate) total_lines: u32,
    pub(crate) skipped: u32,
    /// 打开时的文件数（含读取失败被跳过的——与历史 IPC 语义一致）
    file_count: u32,
    /// 时间轴范围：各文件首/末行 ts 的全局 min/max（无任何 ts → None）
    pub(crate) range: Option<(i64, i64)>,
    pub(crate) fmt: Option<&'static TsFormat>,
    filters: Mutex<FilterCache>,
    /// 工作区内容指纹（= 旧会话身份）：fnv(root + Σ(name, first_line, line_count, size))。
    /// filter 命中盘缓存的键成分——布局/内容变化自然换键，免清理。
    pub(crate) ctx_sig: String,
    /// 待落盘工件（.logGraph 相对路径 → 字节），壳层 take_persistable 后尽力写
    pub(crate) persist: Mutex<Vec<(String, Vec<u8>)>>,
}

impl Session {
    /// 建工作区上下文（`ws_info` 背后；REST 化后唯一付整读价的入口）。
    /// 便宜通道建库：并行读 + 行偏移 + 计数 + 首/末行 ts，产出客户端持有的
    /// [`WsCtx`]（建库会话本身即弃——偏移随其丢弃，后续请求按需懒建）。
    /// `files`：相对路径清单（None=目录全集）。前端是文件清单的唯一权威
    /// （glob 排除 + 勾选都在前端算好），这里只按清单 retain——避免引擎
    /// 再实现第二套 glob 导致两边语义漂移。emit(loaded, total, current)
    /// 报告逐文件进度（建库内部并行，emit 已串行化）。
    pub fn build_ctx(
        root: &Path,
        files: Option<&[String]>,
        // 不标 mut：emit 在本函数内只被**转发**给 build_session（移动所有权），
        // 从不在此处调用，故无需可变绑定。
        emit: impl FnMut(usize, usize, &str) + Send,
    ) -> EngineResult<WsCtx> {
        if !root.is_dir() {
            return Err(EngineError::Usage {
                message: format!("目录不存在: {}", root.display()),
            });
        }
        let mut names: Vec<String> = Vec::new();
        walk_log_files(root, "", 0, &mut names);
        names.sort();
        if let Some(want) = files {
            names.retain(|n| want.iter().any(|w| w == n));
        }
        if names.is_empty() {
            return Err(EngineError::Usage {
                message: if files.is_some() {
                    "所选文件不在该目录中（或均不是可识别的日志文件）".into()
                } else {
                    "该目录下没有可识别的日志文件（.log/.txt/.out/.csv/.tsv）".into()
                },
            });
        }
        let file_count = names.len() as u32;
        let mut s = build_session(root, &names, emit)?;
        s.file_count = file_count;
        Ok(s.ctx())
    }

    /// 按客户端回传 ctx 重建请求级工作视图（零 I/O、快照语义）。
    /// 信任回传的行号布局——活日志追加不炸、不做 mtime 校验拒绝；
    /// 但结构性损坏（空文件表 / first_line 非升序 / 未知格式 id）直接报错，
    /// 避免定位二分与 ts 解析静默错乱。
    pub fn from_ctx(root: &Path, ctx: &WsCtx) -> EngineResult<Session> {
        if ctx.files.is_empty() {
            return Err(EngineError::Usage {
                message: "ctx 损坏: 文件表为空".into(),
            });
        }
        let mut prev_first = None;
        for f in &ctx.files {
            match prev_first {
                Some(p) if f.first_line < p => {
                    return Err(EngineError::Usage {
                        message: format!("ctx 损坏: first_line 非升序（{}）", f.name),
                    });
                }
                _ => prev_first = Some(f.first_line),
            }
        }
        let fmt = match &ctx.timestamp_format_id {
            Some(id) => Some(find_format(id).ok_or_else(|| EngineError::Usage {
                message: format!("ctx 损坏: 未知时间戳格式 {id}"),
            })?),
            None => None,
        };
        let files: Vec<FileEntry> = ctx
            .files
            .iter()
            .map(|f| FileEntry {
                name: f.name.clone(),
                first_line: f.first_line,
                line_count: f.line_count,
                size: f.size,
                offsets: Arc::new(Vec::new()),
            })
            .collect();
        Ok(Session {
            root: root.to_path_buf(),
            ctx_sig: files_sig(root, &files),
            files,
            total_lines: ctx.total_lines,
            skipped: ctx.skipped,
            file_count: ctx.file_count,
            range: match (ctx.range_start, ctx.range_end) {
                (Some(s), Some(e)) => Some((s, e)),
                _ => None,
            },
            fmt,
            filters: Mutex::new(FilterCache::default()),
            persist: Mutex::new(Vec::new()),
        })
    }

    /// 导出 ctx（建库路径返回给客户端；`build_ctx`/CLI 也可用于快照落盘）
    pub fn ctx(&self) -> WsCtx {
        let (range_start, range_end) = match self.range {
            Some((s, e)) => (Some(s), Some(e)),
            None => (None, None),
        };
        WsCtx {
            files: self
                .files
                .iter()
                .map(|fe| CtxFile {
                    name: fe.name.clone(),
                    first_line: fe.first_line,
                    line_count: fe.line_count,
                    size: fe.size,
                })
                .collect(),
            total_lines: self.total_lines,
            skipped: self.skipped,
            file_count: self.file_count,
            timestamp_format_id: self.fmt.map(|f| f.id.to_string()),
            range_start,
            range_end,
        }
    }

    /// 工作区根（壳层 perf 日志 / `.logGraph` 目录定位用）
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 骨架内存基准：Σ 每文件行偏移表字节数（行数 × 8；from_ctx 懒建口径一致）
    pub fn skeleton_bytes(&self) -> usize {
        self.files.iter().map(|f| f.line_count as usize * 8).sum()
    }


    /// 取走待落盘缓存工件（`.logGraph` 相对路径 → 字节），壳层尽力写
    /// （建父目录 + 写临时文件 + 原子改名；写失败只降速不变错）。
    pub fn take_persistable(&self) -> Vec<(PathBuf, Vec<u8>)> {
        self.persist
            .lock()
            .drain(..)
            .map(|(rel, bytes)| (self.root.join(".logGraph").join(rel), bytes))
            .collect()
    }

    // ---- 多行 filter 子条件（与前端 dbStore.ts / FilterEngine.ts 逐字对齐）----

    /// pattern → 子条件列表（端口自 `src/filters/FilterEngine.ts::splitSubConditions`）。
    /// 语义必须逐字一致——剥 `!` 前缀、去首尾空白、跳过空行、纯 `!` 无内容丢弃。
    /// 两端一旦分叉，同一个 filter 会在 UI 与引擎算出不同命中，且极难排查。
    fn split_sub_conditions(pattern: &str) -> Vec<SubCond> {
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
                        out.push(SubCond { source: source.to_string(), negate: true });
                    }
                }
                None => out.push(SubCond { source: line.to_string(), negate: false }),
            }
        }
        out
    }

    /// 多行 filter 展开为单行子条件（端口自 `src/io/dbStore.ts::runDbFiltersBatch`
    /// 的拆分下推）。返回 (下推用的子条件 queries, 聚合计划)。
    ///
    /// 单行 pattern 直通（与旧行为逐字节一致）；含 `\n` 的按子条件展开，
    /// 下推 id 为 `fid\0i`——与前端 `SUB_ID_SEP` 同分隔符，故与前端 ws_filters
    /// 路径产出的子条件条目**共享同一份命中缓存**，不重复扫描。
    /// 全排除（无正向锚，需全量行基集）与全空白一律跳过，与前端同为「无命中」。
    fn expand_multi_queries(queries: &[FilterQuery]) -> (Vec<FilterQuery>, Vec<MultiPlan>) {
        let mut expanded = Vec::with_capacity(queries.len());
        let mut plans = Vec::new();
        for q in queries {
            if !q.pattern.contains('\n') {
                expanded.push(q.clone());
                continue;
            }
            let subs = Self::split_sub_conditions(&q.pattern);
            if subs.is_empty() || subs.iter().all(|s| s.negate) {
                continue;
            }
            let mut plan = MultiPlan {
                filter_id: q.filter_id.clone(),
                fp: filter_def_fp(q),
                subs: Vec::with_capacity(subs.len()),
            };
            for (i, s) in subs.iter().enumerate() {
                let sub_id = format!("{}{}{}", q.filter_id, SUB_ID_SEP, i);
                expanded.push(FilterQuery {
                    filter_id: sub_id.clone(),
                    pattern: s.source.clone(),
                    is_regex: q.is_regex,
                    case_sensitive: q.case_sensitive,
                    scope: q.scope.clone(),
                });
                plan.subs.push(SubPlan { id: sub_id, negate: s.negate });
            }
            plans.push(plan);
        }
        (expanded, plans)
    }

    /// 子条件命中聚合（端口自 `src/io/dbStore.ts::aggregateSubHits`）：
    /// 正向 sub 行集交集 − 排除 sub 行集并集。以最短正向 sub 为基（候选最少），
    /// ts 取基列表的同行值（同一物理行的 ts 由 line_ts 解析，各 sub 一致）。
    fn aggregate_sub_hits(pos: &[Arc<Vec<HitEntry>>], neg: &[Arc<Vec<HitEntry>>]) -> Vec<HitEntry> {
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

    /// 批量运行过滤器（recomputeMatches / 单 filter 编辑共用）：
    /// 1. 逐个比对定义指纹——命中的直接取内存命中（不扫描）；
    /// 2. miss 查 `.logGraph` 命中盘缓存（键 = ctx_sig + 定义指纹，内容寻址）；
    /// 3. 仍 miss 的单遍批量直扫原文件，结果写入内存命中 + 待落盘队列；
    /// 4. 返回 (filter_id, (line, ts)[] 按 ts 升序，无 ts 命中被丢弃)。
    pub fn filters_batch(&self, queries: &[FilterQuery]) -> EngineResult<FiltersBatchOutcome> {
        // 含跨行 pattern 的 filter 展开成单行子条件下推——否则引擎侧只有
        // `fid\0i` 子条目、拿不到整条命中，前端只能把整组 CEP 回退 TS 引擎。
        let (expanded, plans) = Self::expand_multi_queries(queries);
        let mut out: FilterBatchOut = Vec::new();
        let mut miss: Vec<FilterQuery> = Vec::new();
        {
            let fc = self.filters.lock();
            for q in &expanded {
                let hit = fc
                    .fps
                    .get(&q.filter_id)
                    .map(|s| s == &filter_def_fp(q))
                    .unwrap_or(false)
                    .then(|| fc.hits.get(&q.filter_id).cloned())
                    .flatten();
                match hit {
                    Some(h) => out.push((q.filter_id.clone(), hits_with_ts(&h))),
                    None => miss.push(q.clone()),
                }
            }
        }
        let cached = expanded.len() - miss.len();
        let mut miss = miss; // 盘缓存命中出队后的剩余（真正要扫的）
        let mut scan_perf = Vec::new();
        // ---- 盘缓存层：RAM miss → `.logGraph/cache/filters/<hex(key)>.bin` ----
        // 键即校验（内容寻址）：ctx_sig 保证工作区布局/内容相同，定义指纹保证
        // filter 定义相同 → 同键同结果，无需版本协商。
        {
            let mut fc = self.filters.lock();
            miss.retain(|q| {
                let key = hits_cache_key(&self.ctx_sig, q);
                match load_hits_cache(&self.root, &key) {
                    Some(hits) => {
                        fc.fps.insert(q.filter_id.clone(), filter_def_fp(q));
                        fc.hits.insert(q.filter_id.clone(), Arc::new(hits.clone()));
                        out.push((q.filter_id.clone(), hits_with_ts(&hits)));
                        false
                    }
                    None => true,
                }
            });
        }
        // 计数按展开后的子条件计（一个多行 filter 贡献 K 个子条件条目）
        let disk_cached = cached + (expanded.len() - cached - miss.len());
        if !miss.is_empty() {
            let (mut per_filter, perf) =
                scan_filters_once(&self.root, &self.files, &miss, self.fmt)?;
            scan_perf = perf;
            let mut fc = self.filters.lock();
            let mut pend = self.persist.lock();
            for (qi, q) in miss.iter().enumerate() {
                let hits = Arc::new(std::mem::take(&mut per_filter[qi]));
                let key = hits_cache_key(&self.ctx_sig, q);
                pend.push((format!("cache/filters/{key}.bin"), encode_hits_cache(&hits)));
                fc.fps.insert(q.filter_id.clone(), filter_def_fp(q));
                fc.hits.insert(q.filter_id.clone(), Arc::clone(&hits));
                out.push((q.filter_id.clone(), hits_with_ts(&hits)));
            }
        }
        // ---- 聚合：子条件命中 → 整条 filter 命中 ----
        // 必须在子条件全部落位后（内存/盘/扫描任一路径）执行，故放最后。
        if !plans.is_empty() {
            let mut fc = self.filters.lock();
            for plan in &plans {
                let mut pos = Vec::new();
                let mut neg = Vec::new();
                for s in &plan.subs {
                    if let Some(h) = fc.hits.get(&s.id).cloned() {
                        if s.negate {
                            neg.push(h);
                        } else {
                            pos.push(h);
                        }
                    }
                }
                let agg = Arc::new(Self::aggregate_sub_hits(&pos, &neg));
                // 按原始 id 落缓存 + 记原始指纹：下次 filters_batch 直接在
                // 内存层整条命中，不再展开聚合。
                fc.fps.insert(plan.filter_id.clone(), plan.fp.clone());
                fc.hits.insert(plan.filter_id.clone(), Arc::clone(&agg));
                out.push((plan.filter_id.clone(), hits_with_ts(&agg)));
            }
        }
        Ok(FiltersBatchOutcome {
            out,
            cached: disk_cached,
            miss: expanded.len() - disk_cached,
            scan_perf,
        })
    }

    /// 懒取行偏移表：建库路径（`build_ctx` 内部会话）自带偏移直接复用；
    /// ctx 路径恒空 → 读 `.logGraph/index/<fnv64(name)>.off`（头部
    /// size/mtime/行数三验，防陈旧误用），盘 miss 则现读现建并入待落盘队列。
    fn ensure_offsets(&self, fi: usize) -> EngineResult<Arc<Vec<u64>>> {
        let fe = &self.files[fi];
        if !fe.offsets.is_empty() {
            return Ok(Arc::clone(&fe.offsets));
        }
        let path = self.root.join(&fe.name);
        if let Some(offs) = load_offsets_cache(&self.root, &path, fe) {
            return Ok(Arc::new(offs));
        }
        let bytes = std::fs::read(&path).map_err(|e| EngineError::Usage {
            message: e.to_string(),
        })?;
        let (offsets, _) = line_spans(&bytes);
        self.persist.lock().push((
            format!("index/{}.off", off_key(&fe.name)),
            encode_offsets_cache(&path, &offsets),
        ));
        Ok(Arc::new(offsets))
    }

    /// 单行文本（tooltip/复制用）：行偏移 seek 直读，不整文件重读
    pub fn line(&self, no: u32) -> EngineResult<String> {
        let (fi, path, local) = locate(self, no)?;
        let offsets = self.ensure_offsets(fi)?;
        read_line_range(&path, &offsets, local, local)?
            .into_iter()
            .next()
            .ok_or_else(|| EngineError::Usage {
                message: format!("行号越界: {no}"),
            })
    }

    /// 视口行文本：按全局行号集合取行（任意顺序；内部排序去重）。
    /// 同文件行号 gap<=64 合并成一整段 seek 读取（段内多余行无害，调用方按需取用）。
    /// 返回 (line, text)[]；二进制编码属壳层输出格式化。
    pub fn lines_by_ids(&self, ids: &[u32]) -> Vec<(u32, String)> {
        if ids.is_empty() {
            return Vec::new();
        }
        let root = &self.root;
        let files = &self.files;
        let mut sorted = ids.to_vec();
        sorted.sort_unstable();
        sorted.dedup();

        let mut rows: Vec<(u32, String)> = Vec::with_capacity(sorted.len());
        let mut i = 0usize;
        let mut fi = 0usize; // files 与 sorted 均升序 → 双指针
        while i < sorted.len() {
            let line = sorted[i];
            while fi + 1 < files.len() && files[fi + 1].first_line <= line {
                fi += 1;
            }
            let fe = &files[fi];
            let file_limit = files
                .get(fi + 1)
                .map(|f| f.first_line)
                .unwrap_or(u32::MAX);
            let mut j = i;
            while j < sorted.len() && sorted[j] < file_limit {
                j += 1;
            }
            if line < fe.first_line {
                i = j;
                continue;
            }
            let locals: Vec<u32> = sorted[i..j].iter().map(|&l| l - fe.first_line).collect();
            let segs = merge_line_segments(&locals, 64);
            for (lo, hi) in segs {
                // 偏移懒建失败（文件自建库后被删/不可读）→ 跳过该段行，
                // 与 read_line_range 失败同策略：缺行不炸，尽力返回
                if let Ok(offsets) = self.ensure_offsets(fi) {
                    if let Ok(texts) = read_line_range(
                        &root.join(&fe.name),
                        &offsets,
                        lo,
                        hi,
                    ) {
                        for (k, text) in texts.into_iter().enumerate() {
                            rows.push((fe.first_line + lo + k as u32, text));
                        }
                    }
                }
            }
            i = j;
        }
        rows
    }

    /// 关联窗口下推：filter_ids 任一命中的行中，ts ∈ [start, end] 的全局行号。
    /// 命中缓存自带 ts（扫描时内联解析）——直接按窗口过滤，无事件索引查询。
    pub fn corr_ids(&self, filter_ids: &[String], start: i64, end: i64) -> Vec<u32> {
        if filter_ids.is_empty() {
            return Vec::new();
        }
        // 命中并集（各 filter line 升序 → 归并后 sort+dedup；无 ts 命中自然出局）
        let mut out: Vec<u32> = Vec::new();
        for fid in filter_ids {
            if let Some(h) = self.filter_hits_arc(fid) {
                out.extend(
                    h.iter()
                        .filter(|e| e.ts != NO_TS && e.ts >= start && e.ts <= end)
                        .map(|e| e.line),
                );
            }
        }
        if out.is_empty() {
            return Vec::new();
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// 文件清单（first_line 升序）。无限上下文滚动需要知道每个文件的行号区间与绝对路径。
    pub fn file_infos(&self) -> Vec<FileInfo> {
        self.files
            .iter()
            .map(|fe| FileInfo {
                first_line: fe.first_line,
                path: self.root.join(&fe.name).to_string_lossy().into_owned(),
                name: fe.name.clone(),
            })
            .collect()
    }

    /// 序列匹配（CEP）：group 引用的 filter 命中（有 ts）→ SeqEvent 事件流，
    /// 按 (ts, line) 升序喂给 cep 匹配核心。无命中/未扫描的 filter → 空流。
    pub fn run_sequences(&self, groups: &[GroupSpec]) -> RunSeqResponse {
        let mut store = cep::EventStore::new();
        for g in groups {
            for fid in &g.filter_ids {
                if !store.contains_key(fid) {
                    let evs = self
                        .filter_hits_arc(fid)
                        .map(|h| {
                            hits_with_ts(&h)
                                .into_iter()
                                .map(|x| SeqEvent::new(x.line, x.ts))
                                .collect()
                        })
                        .unwrap_or_default();
                    store.insert(fid.clone(), evs);
                }
            }
        }
        cep::run_sequences(groups, &store)
    }

    /// 取某 filter 的命中快照（Arc clone，锁瞬时持有）
    fn filter_hits_arc(&self, filter_id: &str) -> Option<Arc<Vec<HitEntry>>> {
        self.filters.lock().hits.get(filter_id).cloned()
    }
}

// ---- 工具 ----

/// 全局行号 → (文件下标, 绝对路径, 文件内行号)。files 按 first_line 升序，二分定位。
fn locate(db: &Session, global_line: u32) -> EngineResult<(usize, PathBuf, u32)> {
    let files = &db.files;
    if files.is_empty() {
        return Err(EngineError::Usage {
            message: "文件清单为空".into(),
        });
    }
    let mut lo = 0usize;
    let mut hi = files.len();
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if files[mid].first_line <= global_line {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let f = &files[lo];
    if global_line < f.first_line {
        return Err(EngineError::Usage {
            message: format!(
                "行号 {global_line} 越界（首个文件起始 {}）",
                f.first_line
            ),
        });
    }
    if let Some(next) = files.get(lo + 1) {
        if global_line >= next.first_line {
            return Err(EngineError::Usage {
                message: format!("行号 {global_line} 落在文件间隙"),
            });
        }
    }
    Ok((lo, db.root.join(&f.name), global_line - f.first_line))
}

/// 命中(含 NO_TS) → 有效 (line, ts)[]，按 (ts, line) 升序。无 ts 命中被丢弃
/// （时间线上无位置，与旧版事件 SoA JOIN 语义一致）。
fn hits_with_ts(hits: &[HitEntry]) -> Vec<HitEntry> {
    let mut out: Vec<HitEntry> = hits.iter().filter(|h| h.ts != NO_TS).cloned().collect();
    out.sort_unstable_by_key(|h| (h.ts, h.line));
    out
}

// ---- 行偏移 seek 读取 ----

/// 按行偏移 seek 读取一个文件 [lo, hi] 闭区间的行（不整文件重读）。
/// 返回行文本列表（已去 \r\n），下标 0 = 第 lo 行。
fn read_line_range(
    path: &Path,
    offsets: &[u64],
    lo: u32,
    hi: u32,
) -> EngineResult<Vec<String>> {
    let (lo, hi) = (lo as usize, hi as usize);
    if lo > hi || hi >= offsets.len() {
        return Err(EngineError::Usage {
            message: format!("行号越界: {lo}..={hi}（文件共 {} 行）", offsets.len()),
        });
    }
    let start = offsets[lo];
    let end = if hi + 1 < offsets.len() {
        offsets[hi + 1]
    } else {
        std::fs::metadata(path)
            .map_err(|e| EngineError::Usage {
                message: e.to_string(),
            })?
            .len()
    };
    let mut f = std::fs::File::open(path).map_err(|e| EngineError::Usage {
        message: e.to_string(),
    })?;
    f.seek(SeekFrom::Start(start)).map_err(|e| EngineError::Usage {
        message: e.to_string(),
    })?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).map_err(|e| EngineError::Usage {
        message: e.to_string(),
    })?;
    // 块边界都落在行首（\n 单字节）→ UTF-8 安全；lossy 与整文件读语义一致
    let text = String::from_utf8_lossy(&buf);
    let mut out: Vec<String> = text
        .split('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s).to_string())
        .collect();
    // 块以 \n 结尾时 split 会多出一个尾空段 → 裁到目标行数
    out.truncate(hi - lo + 1);
    Ok(out)
}

/// 升序行号 → 读取段列表：相邻行号 gap<=max_gap 合并为一段（减少 seek 次数）。
/// 段读取会带出 gap 内的行（调用方只挑需要的，多余行无害）。
fn merge_line_segments(sorted: &[u32], max_gap: u32) -> Vec<(u32, u32)> {
    let mut segs: Vec<(u32, u32)> = Vec::new();
    for &n in sorted {
        match segs.last_mut() {
            Some((_, hi)) if n <= *hi + max_gap => *hi = (*hi).max(n),
            _ => segs.push((n, n)),
        }
    }
    segs
}

// ---- 建库（便宜通道：读 + 行偏移 + 计数 + 首/末行 ts） ----

/// 行 ts 提取：bytes[s..e) 为一行（不含 \n，可能含 \r），整行 lossy 后提取。
/// 与旧版事件索引逐字节同语义（整行搜索，时间戳可在行内任意位置——
/// 长前缀行如 `LEVEL [very.long.module.path] 2024-01-01 ...` 的 ts 远超 64B）；
/// 合法 UTF-8 下 from_utf8_lossy 为零拷贝，仅命中行付费。无 ts → NO_TS。
fn line_ts_of(bytes: &[u8], s: usize, e: usize, fmt: Option<&TsFormat>) -> i64 {
    let mut end = e;
    if end > s && bytes[end - 1] == b'\r' {
        end -= 1;
    }
    let line = String::from_utf8_lossy(&bytes[s..end]);
    extract_timestamp(&line, fmt).map(|x| x.ts).unwrap_or(NO_TS)
}

/// 读文件头部（最多 max 字节，UTF-8 lossy）；时间戳格式探测用，避免为探测整读首文件。
fn read_head_lossy(path: &Path, max: usize) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; max];
    let mut filled = 0usize;
    while filled < buf.len() {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(k) => filled += k,
            Err(e) => return Err(e),
        }
    }
    buf.truncate(filled);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 扫描目录建会话（便宜通道）。emit(loaded, total, current) 报告逐文件进度。
///
/// 文件级并行 worker 池：读 + 行偏移 + 空行计数 + 首/末行 ts。
/// **不做**逐行 ts 提取/事件排序/行号直查表——过滤扫描本就重读原文件，
/// 命中行的 ts 扫描时内联解析（`line_ts_of`）；时间轴范围取各文件首/末行
/// ts 的全局 min/max（时间序日志 = 精确值；乱序日志近似，命中点渲染不受影响）。
fn build_session(
    root: &Path,
    names: &[String],
    mut emit: impl FnMut(usize, usize, &str) + Send,
) -> EngineResult<Session> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 单文件扫描产物（偏移只做首/末行 ts 的中转，不入骨架——统一懒建）
    struct FileOut {
        name: String,
        line_count: u32,
        /// 内容字节数（ctx/盘缓存内容寻址成分）
        size: u64,
        skipped: u32,
        first_ts: Option<i64>,
        last_ts: Option<i64>,
    }

    // 格式探测：仅首个文件头 1MB 的前 100 个非空行（读失败 → None = 全格式回退）
    let fmt: Option<&'static TsFormat> = names.first().and_then(|rel| {
        let head = read_head_lossy(&root.join(rel), 1024 * 1024).ok()?;
        let sample: Vec<&str> = head
            .split('\n')
            .take(100)
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .filter(|l| !js_trim(l).is_empty())
            .collect();
        detect_timestamp_format(&sample)
    });

    let n = names.len();
    let threads = std::thread::available_parallelism()
        .map(|c| c.get())
        .unwrap_or(4)
        .min(n.max(1))
        .max(1);
    let cursor = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let emit_m = Mutex::new(&mut emit);
    let mut slots: Vec<Option<FileOut>> = (0..n).map(|_| None).collect();

    std::thread::scope(|scope| -> EngineResult<()> {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    // 成果攒本地、汇合后按索引回填（免每槽加锁）
                    let mut mine: Vec<(usize, FileOut)> = Vec::new();
                    loop {
                        let i = cursor.fetch_add(1, Ordering::Relaxed);
                        if i >= n {
                            break;
                        }
                        let rel = &names[i];
                        let Ok(bytes) = std::fs::read(root.join(rel)) else {
                            continue; // 读取失败跳过（建库/扫描同语义）
                        };
                        // 单趟行扫描：行起始偏移 + 空行计数（split('\n') 分段语义）
                        let (offsets, skipped) = line_spans(&bytes);
                        // 首/末行 ts（时间轴范围）：首行 + 尾部回找首个有 ts 的
                        // 非空行（≤8 行，尾空段跳过）
                        let line_span = |li: usize| -> (usize, usize) {
                            let s = offsets[li] as usize;
                            let e = if li + 1 < offsets.len() {
                                offsets[li + 1] as usize - 1 // 剥 \n
                            } else {
                                bytes.len()
                            };
                            (s, e)
                        };
                        let first_ts = {
                            let (s, e) = line_span(0);
                            let ts = line_ts_of(&bytes, s, e, fmt);
                            (ts != NO_TS).then_some(ts)
                        };
                        let mut last_ts: Option<i64> = None;
                        for li in (0..offsets.len()).rev().take(8) {
                            let (s, e) = line_span(li);
                            if js_trim_bytes(&bytes[s..e]).is_empty() {
                                continue;
                            }
                            let ts = line_ts_of(&bytes, s, e, fmt);
                            if ts != NO_TS {
                                last_ts = Some(ts);
                                break;
                            }
                        }
                        mine.push((
                            i,
                            FileOut {
                                name: rel.clone(),
                                line_count: offsets.len() as u32,
                                size: bytes.len() as u64,
                                skipped,
                                first_ts,
                                last_ts,
                            },
                        ));
                        let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                        (emit_m.lock())(d, n, rel);
                    }
                    mine
                })
            })
            .collect();
        for h in handles {
            for (i, out) in h
                .join()
                .map_err(|_| EngineError::Usage {
                    message: "建库 worker 崩溃".into(),
                })?
            {
                slots[i] = Some(out);
            }
        }
        Ok(())
    })?;

    // ---- 汇合（串行 O(文件数)）：first_line 前缀 + 范围 min/max ----
    let mut files: Vec<FileEntry> = Vec::with_capacity(n);
    let mut total_lines: u32 = 0;
    let mut skipped: u32 = 0;
    let mut range: Option<(i64, i64)> = None;
    let fold = |ts: i64, range: &mut Option<(i64, i64)>| {
        *range = Some(match *range {
            None => (ts, ts),
            Some((lo, hi)) => (lo.min(ts), hi.max(ts)),
        });
    };
    for out in slots.into_iter().flatten() {
        let first_line = total_lines;
        total_lines += out.line_count;
        skipped += out.skipped;
        if let Some(ts) = out.first_ts {
            fold(ts, &mut range);
        }
        if let Some(ts) = out.last_ts {
            fold(ts, &mut range);
        }
        files.push(FileEntry {
            name: out.name,
            first_line,
            line_count: out.line_count,
            size: out.size,
            offsets: Arc::new(Vec::new()),
        });
    }

    let ctx_sig = files_sig(root, &files);
    Ok(Session {
        root: root.to_path_buf(),
        files,
        total_lines,
        skipped,
        file_count: 0,
        range,
        fmt,
        filters: Mutex::new(FilterCache::default()),
        ctx_sig,
        persist: Mutex::new(Vec::new()),
    })
}

/// 单趟行扫描：行起始偏移（与 split('\n') 分段语义一致，尾部换行会产生一个
/// 末尾空行段）+ 空行计数。建库 worker 与 ctx 路径的偏移懒建共用。
fn line_spans(bytes: &[u8]) -> (Vec<u64>, u32) {
    let mut offsets: Vec<u64> = Vec::with_capacity(64 + bytes.len() / 16 * 8);
    let mut skipped: u32 = 0;
    let mut pos = 0usize;
    loop {
        let start = pos;
        let end = match bytes[pos..].iter().position(|&b| b == b'\n') {
            Some(k) => pos + k,
            None => bytes.len(),
        };
        offsets.push(start as u64);
        if js_trim_bytes(&bytes[start..end]).is_empty() {
            skipped += 1;
        }
        if end == bytes.len() {
            break;
        }
        pos = end + 1;
    }
    (offsets, skipped)
}

// ---- 过滤：批量直扫 + 内存命中缓存 ----

/// 字节级 JS trim（White_Space + U+FEFF 的 UTF-8 序列全集）。
/// msg 域精筛用——域匹配走 bytes regex，免整行 utf8 str 化。
fn js_trim_bytes(b: &[u8]) -> &[u8] {
    /// b[i..] 起始的空白序列长度（非 0 = 命中）
    #[inline]
    fn ws_at(b: &[u8], i: usize) -> usize {
        match b[i] {
            c if (0x09..=0x0d).contains(&c) || c == 0x20 => 1,
            // U+0085 / U+00A0
            0xc2 if i + 1 < b.len() && (b[i + 1] == 0x85 || b[i + 1] == 0xa0) => 2,
            // U+1680
            0xe1 if i + 2 < b.len() && b[i + 1] == 0x9a && b[i + 2] == 0x80 => 3,
            0xe2 if i + 2 < b.len() => {
                // U+2000-200A / U+2028 / U+2029 / U+202F（80 前缀）/ U+205F（81 前缀）
                let (a, c) = (b[i + 1], b[i + 2]);
                if (a == 0x80
                    && ((0x80..=0x8a).contains(&c) || c == 0xa8 || c == 0xa9 || c == 0xaf))
                    || (a == 0x81 && c == 0x9f)
                {
                    3
                } else {
                    0
                }
            }
            // U+3000
            0xe3 if i + 2 < b.len() && b[i + 1] == 0x80 && b[i + 2] == 0x80 => 3,
            // U+FEFF
            0xef if i + 2 < b.len() && b[i + 1] == 0xbb && b[i + 2] == 0xbf => 3,
            _ => 0,
        }
    }
    let mut s = 0usize;
    let mut e = b.len();
    while s < e {
        let n = ws_at(b, s);
        if n == 0 {
            break;
        }
        s += n;
    }
    while e > s {
        // 尾部按最长序列检查（先 3 后 2 后 1）
        let start = if e >= 3 && ws_at(b, e - 3) == 3 {
            Some(e - 3)
        } else if e >= 2 && ws_at(b, e - 2) == 2 {
            Some(e - 2)
        } else if ws_at(b, e - 1) == 1 {
            Some(e - 1)
        } else {
            None
        };
        match start {
            Some(st) => e = st,
            None => break,
        }
    }
    &b[s..e]
}

/// 单遍多过滤器扫描（文件级并行）。
/// - **每 expr 独立正则**对文件全文 find_iter：match 直接归属该 expr 的
///   filter 集（无二次确认）；regex 引擎 prefilter（memchr/Aho-Corasick
///   SIMD）跳过 miss 字节，与 rg 同款。expr 去重后 K 趟全文扫描（K =
///   不同 pattern 数，prefilter 后每趟 ~0.3s/GB）。
/// - 命中 match → line_offsets 二分行号；同行多 match 由「上一个行号」去重
///   （match 按位置升序）。
/// - message scope：expr 粗筛（msg ⊆ line，整行命中是必要条件）收集候选
///   行去重后精筛——ts 只在前 64B 前缀提取（**指定格式**单次调用，探测
///   失败/格式突变回退全格式），msg 域字节级匹配（免整行 utf8 转换）。
///   无 ts 行 message 域为空 → 不可能命中。
/// - ^/$ 以 multi_line 语义锚定行边界；CRLF 行尾 `$` 与 \r 相邻的边缘
///   差异不处理。
/// - 每文件单线程、行号升序 → 免 sort/dedup（msg 候选除外，跨 expr 需去重）。
/// - 命中行 ts **内联解析**（`line_ts_of`，仅命中行付费；无逐行事件索引）。
/// 返回 (与 queries 同序的命中列表（line 升序；ts = NO_TS 表示该行无 ts）,
/// 每文件计时诊断行)。诊断行由壳层落地（引擎不写文件）。
#[allow(clippy::type_complexity)]
fn scan_filters_once(
    root: &Path,
    files: &[FileEntry],
    queries: &[FilterQuery],
    ts_fmt: Option<&'static TsFormat>,
) -> EngineResult<(Vec<Vec<HitEntry>>, Vec<String>)> {
    // ---- pattern 编译（同 expr 多 filter 共享）----
    let mut raw_pats: Vec<String> = Vec::new();
    let mut raw_idx: HashMap<String, usize> = HashMap::new();
    // expr 序号 → (query 序号, 是否 message 需精筛)
    let mut raw_slots: Vec<Vec<(usize, bool)>> = Vec::new();
    let mut msg_pats: Vec<String> = Vec::new();
    let mut msg_idx: HashMap<String, usize> = HashMap::new();
    let mut msg_slots: Vec<Vec<usize>> = Vec::new();
    for (qi, q) in queries.iter().enumerate() {
        if q.pattern.is_empty() {
            continue;
        }
        // flags 用 group 形式 (?i:...)：裸 (?i) 在交替中会泄漏到后续分支
        let body = if q.is_regex {
            q.pattern.as_str()
        } else {
            &regex::escape(&q.pattern)
        };
        let expr = if q.case_sensitive {
            body.to_string()
        } else {
            format!("(?i:{body})")
        };
        let si = match raw_idx.get(&expr) {
            Some(&s) => s,
            None => {
                raw_pats.push(expr.clone());
                raw_slots.push(Vec::new());
                let s = raw_pats.len() - 1;
                raw_idx.insert(expr.clone(), s);
                s
            }
        };
        let is_msg = q.scope == "message";
        raw_slots[si].push((qi, is_msg));
        if is_msg {
            let ms = match msg_idx.get(&expr) {
                Some(&m) => m,
                None => {
                    msg_pats.push(expr.clone());
                    msg_slots.push(Vec::new());
                    let m = msg_pats.len() - 1;
                    msg_idx.insert(expr, m);
                    m
                }
            };
            msg_slots[ms].push(qi);
        }
    }
    if raw_pats.is_empty() {
        // 全部 pattern 为空 → 无可扫描（调用方已过滤，防御）
        return Ok((vec![Vec::new(); queries.len()], Vec::new()));
    }
    // 每 expr 独立正则（multi_line：^/$ 锚定行边界）
    let build = |pats: &[String]| -> EngineResult<Vec<regex::bytes::Regex>> {
        pats.iter()
            .map(|p| {
                regex::bytes::RegexBuilder::new(p)
                    .multi_line(true)
                    .build()
                    .map_err(|e| EngineError::PatternBuild {
                        input: p.clone(),
                        source: e,
                    })
            })
            .collect()
    };
    let regexes = build(&raw_pats)?;
    let msg_regexes = build(&msg_pats)?;

    // 每文件计时(读/迭代/精筛)聚合，随结果返回（壳层落地 perf 日志）
    let perf: Arc<Mutex<Vec<String>>> = Default::default();

    // ---- 文件级并行（stride 交错，first_line 升序 → 大文件分散） ----
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files.len())
        .max(1);
    let n_q = queries.len();
    let scan = |part: &[FileEntry]| -> Vec<Vec<HitEntry>> {
        let mut buckets: Vec<Vec<HitEntry>> = (0..n_q).map(|_| Vec::new()).collect();
        for fe in part {
            let t_read = Instant::now();
            let Ok(bytes) = std::fs::read(root.join(&fe.name)) else {
                continue; // 读取失败跳过（与建库语义一致）
            };
            let ms_read = t_read.elapsed().as_millis();
            // 行起始偏移：直接借用建库时的 Arc 偏移（零拷贝）；
            // 空/越界（异常）→ 手扫 \n 兜底
            let offsets = &fe.offsets;
            let fallback: Vec<u64>;
            let starts: &[u64] = if !offsets.is_empty()
                && offsets[0] == 0
                && *offsets.last().unwrap() <= bytes.len() as u64
            {
                offsets
            } else {
                let mut v = vec![0u64];
                let mut i = 0usize;
                while i < bytes.len() {
                    match bytes[i..].iter().position(|&b| b == b'\n') {
                        Some(k) => {
                            i += k + 1;
                            v.push(i as u64);
                        }
                        None => break,
                    }
                }
                fallback = v;
                &fallback
            };
            // 每 expr 独立 find_iter（prefilter SIMD 跳过 miss 字节）；
            // match 直接归属该 expr 的 filter 集；同行多 match 用 last_li 去重。
            let t_iter = Instant::now();
            let mut raw_hits = 0usize; // 粗筛命中数(同行去重后)
            let mut msg_candidates: Vec<(usize, u32)> = Vec::new();
            for (ei, re) in regexes.iter().enumerate() {
                let mut last_li = usize::MAX;
                for m in re.find_iter(&bytes) {
                    let li = starts.partition_point(|&s| s <= m.start() as u64) - 1;
                    if li == last_li {
                        continue;
                    }
                    last_li = li;
                    raw_hits += 1;
                    let global = fe.first_line + li as u32;
                    let mut need_msg = false;
                    // 惰性 ts：仅存在 raw（非 msg）归属时才解析（msg 精筛时另解析）
                    let mut hit_ts = NO_TS;
                    let mut ts_ready = false;
                    for &(qi, is_msg) in &raw_slots[ei] {
                        if is_msg {
                            need_msg = true;
                        } else {
                            if !ts_ready {
                                let s = starts[li] as usize;
                                let e = if li + 1 < starts.len() {
                                    starts[li + 1] as usize - 1 // 剥 \n
                                } else {
                                    bytes.len()
                                };
                                hit_ts = line_ts_of(&bytes, s, e, ts_fmt);
                                ts_ready = true;
                            }
                            buckets[qi].push(HitEntry { line: global, ts: hit_ts });
                        }
                    }
                    if need_msg {
                        msg_candidates.push((li, global));
                    }
                }
            }
            let ms_iter = t_iter.elapsed().as_millis();
            let n_cand = msg_candidates.len(); // for 会 move,提前取
            let t_msg = Instant::now();
            // message 精筛：候选行去重（跨 expr 同行可能重复入列）后逐行
            // ts 提取 → msg 域匹配
            if !msg_regexes.is_empty() {
                msg_candidates.sort_unstable_by_key(|&(li, _)| li);
                msg_candidates.dedup_by_key(|e| e.0);
                for (li, global) in msg_candidates {
                    let s = starts[li] as usize;
                    let e = if li + 1 < starts.len() {
                        starts[li + 1] as usize - 1 // 剥 \n
                    } else {
                        bytes.len()
                    };
                    let mut line = &bytes[s..e];
                    if line.last() == Some(&b'\r') {
                        line = &line[..line.len() - 1];
                    }
                    // ts 只在前 64B 前缀找（截断回退到 UTF-8 字符边界，
                    // 避免 lossy 替换改变字节布局）；指定格式失败回退全格式
                    let mut plen = line.len().min(64);
                    while plen < line.len() && (line[plen] & 0xc0) == 0x80 {
                        plen -= 1;
                    }
                    let prefix = String::from_utf8_lossy(&line[..plen]);
                    let ext = match extract_timestamp(&prefix, ts_fmt) {
                        Some(x) => Some(x),
                        None if ts_fmt.is_some() => extract_timestamp(&prefix, None),
                        None => None,
                    };
                    let Some(ext) = ext else {
                        continue; // 无 ts → message 域为空
                    };
                    // msg 域 = 原始行 ts 之后（字节级匹配 + 字节级 trim，免整行 str 化）
                    let msg = js_trim_bytes(&line[ext.end..]);
                    // 命中 ts 内联解析（fmt-only，与旧版 JOIN 语义一致；
                    // ext 仅用于域切分——带全格式回退，不可复用）
                    let hit_ts = line_ts_of(&bytes, s, e, ts_fmt);
                    for (mi, mre) in msg_regexes.iter().enumerate() {
                        if mre.is_match(msg) {
                            for &qi in &msg_slots[mi] {
                                buckets[qi].push(HitEntry { line: global, ts: hit_ts });
                            }
                        }
                    }
                }
            }
            {
                let mut v = perf.lock();
                v.push(format!(
                    "scan {} {:.1}MB read={}ms iter={}ms msg={:?} hits={raw_hits} cand={n_cand}",
                    fe.name,
                    bytes.len() as f64 / 1048576.0,
                    ms_read,
                    ms_iter,
                    t_msg.elapsed()
                ));
            }
        }
        buckets
    };
    let results: Vec<Vec<Vec<HitEntry>>> = if threads <= 1 {
        vec![scan(files)]
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|t| {
                    // Arc clone（offsets 不复制），stride 均摊大文件
                    let part: Vec<FileEntry> = files
                        .iter()
                        .skip(t)
                        .step_by(threads)
                        .map(|fe| FileEntry {
                            name: fe.name.clone(),
                            first_line: fe.first_line,
                            line_count: fe.line_count,
                            size: fe.size,
                            offsets: Arc::clone(&fe.offsets),
                        })
                        .collect();
                    scope.spawn(move || scan(&part))
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        })
    };
    let mut per_filter: Vec<Vec<HitEntry>> = (0..n_q).map(|_| Vec::new()).collect();
    for b in results {
        for (qi, v) in b.into_iter().enumerate() {
            per_filter[qi].extend(v);
        }
    }
    // 行号升序:多线程 stride 合并后乱序
    for v in per_filter.iter_mut() {
        v.sort_unstable_by_key(|h| h.line);
    }
    Ok((per_filter, Arc::try_unwrap(perf).map(|m| m.into_inner()).unwrap_or_default()))
}

/// filter 定义指纹：pattern/正则/大小写/scope 任一变化 → 缓存失效重扫。
/// （目录变化由重新打开目录全量重建保证，无需纳入。）
fn filter_def_fp(q: &FilterQuery) -> String {
    let mut h: u64 = 1469598103934665603;
    let part = format!(
        "{}\u{0}{}\u{0}{}\u{0}{}\n",
        q.pattern, q.is_regex, q.case_sensitive, q.scope
    );
    for b in part.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{h:016x}")
}

// ---- `.logGraph` 透明磁盘缓存（内容寻址；引擎只读，写入由壳层落地） ----

/// FNV-1a 64 位（与 filter_def_fp 同参数）
fn fnv64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 1469598103934665603;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

/// 工作区内容指纹：fnv(root + Σ(name, first_line, line_count, size))。
/// 含 root 路径——防「同布局不同内容」的两个目录共用命中缓存；
/// 含布局/行数/字节数——内容或清单变化自然换键，免清理。
fn files_sig(root: &Path, files: &[FileEntry]) -> String {
    let mut buf = String::with_capacity(64 + files.len() * 40);
    buf.push_str(&root.to_string_lossy());
    for f in files {
        buf.push_str(&format!(
            "\u{0}{}\u{1}{}\u{1}{}\u{1}{}",
            f.name, f.first_line, f.line_count, f.size
        ));
    }
    format!("{:016x}", fnv64(buf.as_bytes()))
}

/// 行偏移盘缓存文件名（`index/` 下的相对名）：fnv64(相对路径) hex
fn off_key(name: &str) -> String {
    format!("{:016x}", fnv64(name.as_bytes()))
}

/// filter 命中盘缓存键：hex(fnv(ctx_sig + ":" + 定义指纹))——两层指纹拼接，
/// 内容寻址即校验。
fn hits_cache_key(ctx_sig: &str, q: &FilterQuery) -> String {
    format!("{:016x}", fnv64(format!("{}:{}", ctx_sig, filter_def_fp(q)).as_bytes()))
}

/// 文件 mtime（unix ms；盘缓存头部三验成分）
fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 读 `.logGraph/<rel>` 缓存文件（缺失/不可读 → None，调用方走重建路径）
fn load_ws_bytes(root: &Path, rel: &str) -> Option<Vec<u8>> {
    std::fs::read(root.join(".logGraph").join(rel)).ok()
}

/// `.off` 布局：`"LGOFF001"` + size u64 + mtime_ms u64 + line_count u32 + pad u32 + u64×n
const OFF_MAGIC: &[u8; 8] = b"LGOFF001";

/// 编码行偏移盘缓存（现读现建路径调用；头部记录 stat 时刻的文件身份）
fn encode_offsets_cache(path: &Path, offsets: &[u64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + offsets.len() * 8);
    out.extend_from_slice(OFF_MAGIC);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&mtime_ms(path).to_le_bytes());
    out.extend_from_slice(&(offsets.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for &o in offsets {
        out.extend_from_slice(&o.to_le_bytes());
    }
    out
}

/// 读 `.off` 盘缓存：头部 size/mtime/行数与当前 fs 元数据及 ctx 行数三验，
/// 任一不符（文件已改/截断/陈旧）→ None（懒建路径兜底，不报错）。
fn load_offsets_cache(root: &Path, path: &Path, fe: &FileEntry) -> Option<Vec<u64>> {
    let bytes = load_ws_bytes(root, &format!("index/{}.off", off_key(&fe.name)))?;
    if bytes.len() < 32 || &bytes[..8] != OFF_MAGIC {
        return None;
    }
    // 不标 mut：闭包只不可变借用 bytes、不改动捕获状态，且下面的 map 里
    // 通过 &rd 调用即可（Fn 而非 FnMut），可变绑定是多余的。
    let rd = |o: usize| -> u64 { u64::from_le_bytes(bytes[o..o + 8].try_into().unwrap()) };
    let size = rd(8);
    let mt = rd(16);
    let count = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() != size
        || mtime_ms(path) != mt
        || count != fe.line_count as usize
        || bytes.len() != 32 + count * 8
    {
        return None;
    }
    Some((0..count).map(|i| rd(32 + i * 8)).collect())
}

/// `.bin` 布局：`"LGFB001\0"` + count u32 + pad u32 + {line u32, ts i64}×n（LE）
const HITS_MAGIC: &[u8; 8] = b"LGFB001\0";

fn encode_hits_cache(hits: &[HitEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + hits.len() * 12);
    out.extend_from_slice(HITS_MAGIC);
    out.extend_from_slice(&(hits.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for h in hits {
        out.extend_from_slice(&h.line.to_le_bytes());
        out.extend_from_slice(&h.ts.to_le_bytes());
    }
    out
}

/// 读 `.bin` 命中盘缓存（损坏 → None，调用方重扫）
fn load_hits_cache(root: &Path, key: &str) -> Option<Vec<HitEntry>> {
    let bytes = load_ws_bytes(root, &format!("cache/filters/{key}.bin"))?;
    if bytes.len() < 16 || &bytes[..8] != HITS_MAGIC {
        return None;
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if bytes.len() != 16 + count * 12 {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let o = 16 + i * 12;
        out.push(HitEntry {
            line: u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()),
            ts: i64::from_le_bytes(bytes[o + 4..o + 12].try_into().unwrap()),
        });
    }
    Some(out)
}

// ---- 测试 fixture ----

/// 测试 fixture：最小会话（无文件骨架，命中由 set_filter_hits 注入）
#[cfg(test)]
pub(crate) fn test_session() -> Session {
    Session {
        root: PathBuf::from("."),
        files: Vec::new(),
        total_lines: 0,
        skipped: 0,
        file_count: 0,
        range: None,
        fmt: None,
        filters: Mutex::new(FilterCache::default()),
        ctx_sig: String::new(),
        persist: Mutex::new(Vec::new()),
    }
}

/// 测试 fixture：写入 filter 命中（(line, ts) 集合）
#[cfg(test)]
pub(crate) fn set_filter_hits(s: &Session, filter_id: &str, hits: &[(u32, i64)]) {
    let v: Vec<HitEntry> = hits
        .iter()
        .map(|&(line, ts)| HitEntry { line, ts })
        .collect();
    s.filters
        .lock()
        .hits
        .insert(filter_id.to_string(), Arc::new(v));
}

// ---- 单元测试 ----

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "loggraph-session-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 与建库扫描一致的偏移计算（split('\n') 分段语义）
    fn scan_offsets(text: &str) -> Vec<u64> {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut pos = 0usize;
        loop {
            out.push(pos as u64);
            let end = match bytes[pos..].iter().position(|&b| b == b'\n') {
                Some(k) => pos + k,
                None => bytes.len(),
            };
            if end == bytes.len() {
                break;
            }
            pos = end + 1;
        }
        out
    }

    fn fe(name: &str, first_line: u32, text: &str) -> FileEntry {
        FileEntry {
            name: name.into(),
            first_line,
            line_count: scan_offsets(text).len() as u32,
            size: text.len() as u64,
            offsets: Arc::new(scan_offsets(text)),
        }
    }

    #[test]
    fn offsets_match_split_semantics() {
        assert_eq!(scan_offsets("a"), vec![0]);
        assert_eq!(scan_offsets("a\n"), vec![0, 2]); // 尾换行 → 末尾空行段
        assert_eq!(scan_offsets("a\n\n"), vec![0, 2, 3]);
        assert_eq!(scan_offsets(""), vec![0]);
        assert_eq!(scan_offsets("中文\nb"), vec![0, 7]); // 多字节 UTF-8 边界
    }

    #[test]
    fn line_ts_of_whole_line_semantics() {
        // 回归：时间戳不在行首的行（前缀 > 64B）——旧版事件索引对整行提取能命中，
        // v4 曾误用 64B 前缀窗口 → NO_TS → 命中从时间轴/序列匹配中消失
        let fmt = detect_timestamp_format(&["2024-01-01 09:00:00.000 x"]).unwrap();
        // 70B 前缀：ts 起点在 64B 窗口之外
        let line = format!("{}2024-01-01 09:00:05.123 tail", "L".repeat(70));
        let b = line.as_bytes();
        assert_ne!(line_ts_of(b, 0, b.len(), Some(fmt)), NO_TS);
        // ts 在行首（常规日志）不受影响
        let head = "2024-01-01 09:00:05.123 hello";
        assert_ne!(
            line_ts_of(head.as_bytes(), 0, head.len(), Some(fmt)),
            NO_TS
        );
        // 无 ts 行 → NO_TS
        let none = "no timestamp in this line at all";
        assert_eq!(line_ts_of(none.as_bytes(), 0, none.len(), Some(fmt)), NO_TS);
        // CRLF：\r 不影响提取
        let crlf = "2024-01-01 09:00:05.123 x\r\n";
        assert_ne!(
            line_ts_of(crlf.as_bytes(), 0, crlf.len() - 1, Some(fmt)),
            NO_TS
        );
    }

    #[test]
    fn read_line_range_variants() {
        let dir = tmp_dir("range");
        let p = dir.join("t1.log");
        std::fs::write(&p, "l0\r\nl1\nl2\n\nl4").unwrap(); // CRLF + 空行 + 无尾换行
        let off = scan_offsets("l0\r\nl1\nl2\n\nl4");
        assert_eq!(read_line_range(&p, &off, 0, 0).unwrap(), vec!["l0"]);
        assert_eq!(
            read_line_range(&p, &off, 0, 4).unwrap(),
            vec!["l0", "l1", "l2", "", "l4"]
        );
        assert_eq!(read_line_range(&p, &off, 3, 3).unwrap(), vec![""]);
        assert_eq!(read_line_range(&p, &off, 4, 4).unwrap(), vec!["l4"]); // 尾行: end=文件尾
        assert!(read_line_range(&p, &off, 0, 5).is_err()); // 越界
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn merge_segments_groups_neighbors() {
        assert_eq!(merge_line_segments(&[], 64), vec![]);
        assert_eq!(merge_line_segments(&[1, 2, 3], 64), vec![(1, 3)]);
        assert_eq!(merge_line_segments(&[1, 100], 64), vec![(1, 1), (100, 100)]);
        assert_eq!(merge_line_segments(&[1, 64], 64), vec![(1, 64)]); // gap=63 ≤ 64
        assert_eq!(
            merge_line_segments(&[1, 66], 64),
            vec![(1, 1), (66, 66)] // gap=65 > 64
        );
        // 乱序输入按序段内扩展（调用方保证升序，这里只验证单调性假设下的行为）
        assert_eq!(merge_line_segments(&[5, 6, 7], 64), vec![(5, 7)]);
    }

    #[test]
    fn scan_filters_once_batch() {
        let dir = tmp_dir("scan_batch");
        let a_text =
            "2024-01-01 10:00:00.000 alpha hello\nplain line no ts\n2024-01-01 10:00:01.000 world hello\n";
        let b_text = "2024-01-01 10:00:02.000 alpha hello\n";
        std::fs::write(dir.join("a.log"), a_text).unwrap();
        std::fs::write(dir.join("b.log"), b_text).unwrap();
        // a.log split('\n') 4 段（含尾空段）→ 全局行 0..=3；b.log 从行 4 起。
        let files = vec![fe("a.log", 0, a_text), fe("b.log", 4, b_text)];
        let q = |id: &str, pattern: &str, is_regex: bool, cs: bool, scope: &str| FilterQuery {
            filter_id: id.into(),
            pattern: pattern.into(),
            is_regex,
            case_sensitive: cs,
            scope: scope.into(),
        };
        // 多 filter 单遍：raw/message/字面量/正则混合，结果正确分桶
        let lines = |v: &Vec<HitEntry>| -> Vec<u32> { v.iter().map(|h| h.line).collect() };
        let queries = vec![
            q("msg", "hello", false, true, "message"), // msg 域 → 0,2,4
            q("raw", "plain", false, true, "raw"),     // 整行 → 1
            q("re", "wor.d", true, true, "message"),   // 正则 msg → 2
        ];
        let (r, perf) = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(lines(&r[0]), vec![0, 2, 4]);
        assert_eq!(lines(&r[1]), vec![1]); // 无 ts 行命中 → ts = NO_TS
        assert_eq!(r[1][0].ts, NO_TS);
        assert_eq!(lines(&r[2]), vec![2]);
        // 有 ts 命中行：ts 内联解析（fmt=None → 全格式）
        assert_eq!(r[2][0].ts, 1704103201000);
        // 诊断行随结果返回（每文件一行）
        assert_eq!(perf.len(), 2);
        // 大小写不敏感（(?i) 折叠）：message + raw 两种 scope
        let queries = vec![
            q("m", "HELLO", false, false, "message"),
            q("r", "ALPHA", false, false, "raw"),
        ];
        let (r, _) = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(lines(&r[0]), vec![0, 2, 4]);
        assert_eq!(lines(&r[1]), vec![0, 4]);
        // 时间戳部分不属于 message 域
        let (r, _) =
            scan_filters_once(&dir, &files, &[q("t", "10:00:00", false, true, "message")], None)
                .unwrap();
        assert!(r[0].is_empty());
        // 无 ts 行的 message 域视为空 → 不可能命中（即使整行含 pattern）
        let (r, _) =
            scan_filters_once(&dir, &files, &[q("p", "plain", false, true, "message")], None)
                .unwrap();
        assert!(r[0].is_empty());
        // 同 pattern 多 filter 共享 set 位，raw/message 各自分桶
        let queries = vec![
            q("a", "hello", false, true, "raw"),
            q("b", "hello", false, true, "message"),
        ];
        let (r, _) = scan_filters_once(&dir, &files, &queries, None).unwrap();
        assert_eq!(lines(&r[0]), vec![0, 2, 4]);
        assert_eq!(lines(&r[1]), vec![0, 2, 4]);
        // ^/$ 按行边界锚定（multi_line）：「no ts」仅在行 1 行尾
        let (r, _) =
            scan_filters_once(&dir, &files, &[q("a", "no ts$", true, true, "raw")], None).unwrap();
        assert_eq!(lines(&r[0]), vec![1]);
        // 空行（两文件尾空段 = 全局行 3、5）：^$ 只命中空行
        let (r, _) =
            scan_filters_once(&dir, &files, &[q("e", "^$", true, true, "raw")], None).unwrap();
        assert_eq!(lines(&r[0]), vec![3, 5]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn filter_def_fp_stability() {
        let base = FilterQuery {
            filter_id: "f1".into(),
            pattern: "ERROR".into(),
            is_regex: false,
            case_sensitive: false,
            scope: "raw".into(),
        };
        assert_eq!(filter_def_fp(&base), filter_def_fp(&base)); // 稳定
        // 任一定义字段变化 → 指纹变化（缓存失效）；filter_id 不参与
        for mut q in [
            FilterQuery { pattern: "WARN".into(), ..base.clone() },
            FilterQuery { is_regex: true, ..base.clone() },
            FilterQuery { case_sensitive: true, ..base.clone() },
            FilterQuery { scope: "message".into(), ..base.clone() },
        ] {
            q.filter_id = "other".into();
            assert_ne!(filter_def_fp(&base), filter_def_fp(&q));
        }
        let other_id = FilterQuery { filter_id: "f2".into(), ..base.clone() };
        assert_eq!(filter_def_fp(&base), filter_def_fp(&other_id));
    }

    #[test]
    fn hits_with_ts_orders_by_ts_and_drops_no_ts() {
        // 行 10/20/30 有 ts；行 99 无 ts（命中也被丢弃）
        let hits = vec![
            HitEntry { line: 30, ts: 300 },
            HitEntry { line: 99, ts: NO_TS },
            HitEntry { line: 10, ts: 200 },
            HitEntry { line: 20, ts: 100 },
        ];
        let out = hits_with_ts(&hits);
        assert_eq!(
            out.iter().map(|h| (h.line, h.ts)).collect::<Vec<_>>(),
            vec![(20, 100), (10, 200), (30, 300)]
        );
        assert!(hits_with_ts(&[]).is_empty());
    }

    #[test]
    fn build_ctx_excludes_loggraph_and_builds_range() {
        let dir = tmp_dir("open");
        std::fs::create_dir_all(dir.join(".logGraph")).unwrap();
        std::fs::write(
            dir.join("a.log"),
            "2024-01-01 10:00:00.000 alpha\nplain line\n2024-01-01 10:00:01.000 beta\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(".logGraph").join("junk.log"),
            "1791550151000 epoch junk\n",
        )
        .unwrap();

        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        assert_eq!(ctx.files.len(), 1); // .logGraph 被排除
        assert_eq!(ctx.total_lines, 4); // 3 行 + 尾空段
        assert_eq!(ctx.skipped, 1); // 尾空段为空行
        assert_eq!(ctx.file_count, 1);
        assert_eq!(ctx.files[0].name, "a.log");
        assert_eq!(ctx.files[0].first_line, 0);
        assert_eq!(ctx.files[0].line_count, 4);
        assert_eq!(ctx.files[0].size, 70); // 文件实际 70 字节（bytes.len()）
        assert_eq!(ctx.timestamp_format_id.as_deref(), Some("iso-local-ms"));
        assert_eq!(ctx.range_start, Some(1704103200000));
        assert_eq!(ctx.range_end, Some(1704103201000));
        // ctx JSON 往返（客户端持有的正是这个形状）+ from_ctx 重建等价
        let json = serde_json::to_string(&ctx).unwrap();
        let ctx2: WsCtx = serde_json::from_str(&json).unwrap();
        assert_eq!(ctx, ctx2);
        let s = Session::from_ctx(&dir, &ctx2).unwrap();
        assert_eq!(s.total_lines, 4);
        assert_eq!(s.range, Some((1704103200000, 1704103201000)));
        assert_eq!(s.ctx_sig, files_sig(&dir, &s.files));
        // from_ctx 拒收损坏 ctx：空文件表 / 未知格式 id
        assert!(Session::from_ctx(&dir, &WsCtx { files: vec![], ..ctx2.clone() }).is_err());
        let mut bad = ctx2.clone();
        bad.timestamp_format_id = Some("no-such-format".into());
        assert!(Session::from_ctx(&dir, &bad).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn build_ctx_dir_missing_and_files_subset_errors() {
        // 目录不存在 → E_USAGE
        let e =
            Session::build_ctx(Path::new("Z:/loggraph-no-such-dir"), None, |_, _, _| {})
                .unwrap_err();
        assert!(matches!(e, EngineError::Usage { .. }));
        // 空目录（无日志文件）→ E_USAGE
        let dir = tmp_dir("empty");
        let e = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap_err();
        assert!(matches!(e, EngineError::Usage { .. }));
        // 子集不含任何日志文件 → E_USAGE
        let e =
            Session::build_ctx(&dir, Some(&["x.log".to_string()]), |_, _, _| {}).unwrap_err();
        assert!(matches!(e, EngineError::Usage { .. }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn session_filters_batch_caches_by_fingerprint() {
        let dir = tmp_dir("fbatch");
        std::fs::write(
            dir.join("a.log"),
            "2024-01-01 10:00:00.000 alpha\nplain line\n2024-01-01 10:00:01.000 beta alpha\n",
        )
        .unwrap();
        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s = Session::from_ctx(&dir, &ctx).unwrap();
        let q = |id: &str, pattern: &str, scope: &str| FilterQuery {
            filter_id: id.into(),
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: false,
            scope: scope.into(),
        };
        // 首次：miss → 扫描 → 缓存 + 待落盘工件
        let o1 = s.filters_batch(&[q("f1", "alpha", "raw")]).unwrap();
        assert_eq!(o1.out.len(), 1);
        assert_eq!(
            o1.out[0].1.iter().map(|h| (h.line, h.ts)).collect::<Vec<_>>(),
            vec![(0, 1704103200000), (2, 1704103201000)]
        );
        assert!(!o1.scan_perf.is_empty());
        let pend = s.take_persistable();
        assert_eq!(pend.len(), 1, "扫描结果应入待落盘队列");
        // 二次同定义：RAM 指纹命中 → 免扫描（无 scan_perf 行）
        let o2 = s.filters_batch(&[q("f1", "alpha", "raw")]).unwrap();
        assert_eq!(o2.out.len(), 1);
        assert_eq!(o2.out[0].1.len(), 2);
        assert!(o2.scan_perf.is_empty());
        // 定义变化（pattern）→ 缓存失效重扫
        let o3 = s.filters_batch(&[q("f1", "beta", "raw")]).unwrap();
        assert_eq!(o3.out[0].1.iter().map(|h| h.line).collect::<Vec<_>>(), vec![2]);
        // 壳层落盘后：新会话（新 RAM）同定义（filter_id 不同也行——指纹不含 id）
        // → 盘缓存命中，免重扫
        for (path, bytes) in &pend {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        let s2 = Session::from_ctx(&dir, &ctx).unwrap();
        let o4 = s2.filters_batch(&[q("other", "alpha", "raw")]).unwrap();
        assert_eq!(o4.out.len(), 1);
        assert_eq!(o4.out[0].1.len(), 2);
        assert!(o4.scan_perf.is_empty(), "盘缓存命中应免重扫");
        assert!(s2.take_persistable().is_empty(), "盘命中不应再排队落盘");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // ---- 多行 filter 跨行聚合（端口自前端，两端语义必须一致）----

    #[test]
    fn split_sub_conditions_matches_frontend() {
        use crate::session::SubCond;
        let flat = |p: &str| -> Vec<(String, bool)> {
            Session::split_sub_conditions(p)
                .into_iter()
                .map(|s: SubCond| (s.source, s.negate))
                .collect()
        };
        // 单行直通（与旧行为一致）
        assert_eq!(flat("abc"), vec![("abc".to_string(), false)]);
        // 换行 AND
        assert_eq!(
            flat("abc\ndef"),
            vec![("abc".to_string(), false), ("def".to_string(), false)]
        );
        // `!` 前缀 → 排除
        assert_eq!(
            flat("abc\n!def"),
            vec![("abc".to_string(), false), ("def".to_string(), true)]
        );
        // 首尾空白 + 空行跳过（含纯换行的空段）
        assert_eq!(flat("  abc  \n\n  def\n"), vec![
            ("abc".to_string(), false),
            ("def".to_string(), false)
        ]);
        // `!` 后空白也 trim；纯 `!` 行被丢弃
        assert_eq!(flat("abc\n!   def"), vec![
            ("abc".to_string(), false),
            ("def".to_string(), true)
        ]);
        assert_eq!(flat("abc\n!"), vec![("abc".to_string(), false)]);
        // 全空白 → 空（视同空 pattern，无命中）
        assert!(flat("\n  \n").is_empty());
    }

    #[test]
    fn multi_line_filter_aggregates_in_engine() {
        let dir = tmp_dir("multi_line");
        // 行 0: boot   行 1: alpha   行 2: alpha gamma
        std::fs::write(
            dir.join("a.log"),
            "2024-01-01 10:00:00.000 boot\n2024-01-01 10:00:01.000 alpha\n2024-01-01 10:00:02.000 alpha gamma\n",
        )
        .unwrap();
        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s = Session::from_ctx(&dir, &ctx).unwrap();
        let q = |id: &str, pattern: &str| FilterQuery {
            filter_id: id.into(),
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: false,
            scope: "raw".into(),
        };
        let lines_of = |o: &FiltersBatchOutcome, id: &str| -> Vec<u32> {
            o.out
                .iter()
                .find(|(fid, _)| fid == id)
                .map(|(_, v)| v.iter().map(|h| h.line).collect())
                .unwrap_or_default()
        };

        // 换行 AND：alpha(1,2) ∩ gamma(2) = 行 2
        let o = s.filters_batch(&[q("mf", "alpha\ngamma")]).unwrap();
        assert_eq!(lines_of(&o, "mf"), vec![2], "跨行 AND 应取交集");
        // 子条件条目同样落缓存（与前端 ws_filters 路径共享，不重复扫描）
        assert_eq!(lines_of(&o, &format!("mf{}0", SUB_ID_SEP)), vec![1, 2]);
        assert_eq!(lines_of(&o, &format!("mf{}1", SUB_ID_SEP)), vec![2]);

        // 排除：alpha(1,2) − gamma(2) = 行 1
        let o = s.filters_batch(&[q("mn", "alpha\n!gamma")]).unwrap();
        assert_eq!(lines_of(&o, "mn"), vec![1], "! 前缀应排除");

        // 单行的 `!` 前缀**不是**排除语义（不含 \n → 直通，按字面量匹配），
        // 与前端 `!pattern.includes('\n')` 的直通分支一致
        let o = s.filters_batch(&[q("mx", "!alpha")]).unwrap();
        assert!(lines_of(&o, "mx").is_empty(), "单行 ! 按字面量处理 → 无命中");
        // 含 \n 且全为排除（无正向锚，需全量行基集）→ 跳过
        let o = s.filters_batch(&[q("mx2", "!alpha\n!beta")]).unwrap();
        assert!(o.out.is_empty(), "全排除无正向锚 → 无命中");

        // 二次同定义：整条命中（RAM 指纹），不再展开聚合
        let o = s.filters_batch(&[q("mf", "alpha\ngamma")]).unwrap();
        assert_eq!(lines_of(&o, "mf"), vec![2]);
        assert!(o.scan_perf.is_empty(), "整条应在 RAM 命中");

        // 聚合结果供 run_sequences 使用：整条命中进了 fid 键
        {
            let fc = s.filters.lock();
            let hits = fc.hits.get("mf").expect("整条命中必须落在 fid 键下");
            assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![2]);
        }

        // ---- 端到端：跨行 filter 作为 CEP 节点事件源 ----
        // f1(单行 boot, 行0) → f2(跨行 alpha+gamma, 行2)，间隔 2s 内成链。
        // 注意两个 filter 的命中行刻意不重叠：若 A 与 B 命中同一行，CEP 的
        // 「B 须早于 A 的下一个 A」判据会（正确地）拒绝，那是语义而非缺陷。
        let edge = crate::cep::EdgeSpec {
            id: "e".into(),
            from_filter_id: "f1".into(),
            to_filter_id: Some("f2".into()),
            to_filter_ids: None,
            kind: Some("seq".into()),
            max_gap_ms: 5000,
            period_ms: None,
        };
        let spec = GroupSpec {
            group_id: "g".into(),
            filter_ids: vec!["f1".into(), "f2".into()],
            label: None,
            scope: "global".into(),
            edges: vec![edge],
            node_conditions: None,
            node_counts: None,
            max_chains: None,
        };
        s.filters_batch(&[q("f1", "boot")]).unwrap();
        s.filters_batch(&[q("f2", "alpha\ngamma")]).unwrap();
        let r = s.run_sequences(&[spec]);
        assert!(!r.fallback, "跨行 filter 不应再触发 fallback");
        let res = &r.results["g"];
        assert_eq!(res.chains.len(), 1, "跨行 filter 应提供行 2 的事件");
        assert_eq!(res.chains[0].steps[0].event.id, 0);
        assert_eq!(res.chains[0].steps[1].event.id, 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn session_line_and_lines_by_ids() {
        let dir = tmp_dir("lines");
        std::fs::write(dir.join("a.log"), "l0\nl1\nl2\n").unwrap();
        std::fs::write(dir.join("b.log"), "m0\nm1\n").unwrap();
        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s = Session::from_ctx(&dir, &ctx).unwrap();
        // a.log 4 段（含尾空段）→ 全局行 0..=3；b.log 3 段（含尾空段）→ 全局行 4..=6
        // from_ctx 偏移懒建：每文件首次访问现读现建并入队一份 .off，壳层落盘后二次会话走盘缓存
        assert_eq!(s.line(0).unwrap(), "l0"); // a.log 首次访问 → 入队 a.off
        assert_eq!(s.line(4).unwrap(), "m0"); // b.log 首次访问 → 入队 b.off
        let pend = s.take_persistable();
        assert_eq!(pend.len(), 2, "两文件各一份 .off 工件（每文件首次访问入队一次）");
        for (path, bytes) in &pend {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        let s2 = Session::from_ctx(&dir, &ctx).unwrap();
        assert_eq!(s2.line(2).unwrap(), "l2");
        assert_eq!(s2.line(5).unwrap(), "m1"); // b.log 行 5 经盘缓存命中
        assert!(s2.line(7).is_err()); // 全局最大有效行=6，line 7 越界
        assert!(s2.take_persistable().is_empty(), "盘缓存命中不再重建");
        // 任意顺序 ids → 排序去重 + 段读取（gap<=64 合并成整段 seek，段内多余行一并返回）
        let rows = s2.lines_by_ids(&[5, 0, 2]);
        assert_eq!(
            rows,
            vec![
                (0, "l0".to_string()),
                (1, "l1".to_string()),
                (2, "l2".to_string()),
                (5, "m1".to_string())
            ]
        );
        // 空集合 → 空
        assert!(s2.lines_by_ids(&[]).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_offsets_cache_is_rejected() {
        // .off 三验失败（文件已被改写：size/mtime 不符）→ 弃缓存重建
        let dir = tmp_dir("stale");
        std::fs::write(dir.join("a.log"), "l0\nl1\n").unwrap();
        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s = Session::from_ctx(&dir, &ctx).unwrap();
        assert_eq!(s.line(1).unwrap(), "l1");
        for (path, bytes) in &s.take_persistable() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        // 改写文件（内容变长）→ 旧 .off 头部 size/mtime 失配
        std::fs::write(dir.join("a.log"), "l0\nl1\nl2 EXTRA\n").unwrap();
        let ctx2 = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s2 = Session::from_ctx(&dir, &ctx2).unwrap();
        assert_eq!(s2.line(2).unwrap(), "l2 EXTRA");
        assert_eq!(s2.take_persistable().len(), 1, "失配应重建并入队新工件");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn session_corr_ids_and_file_infos() {
        let dir = tmp_dir("corr");
        std::fs::write(dir.join("a.log"), "2024-01-01 10:00:00.000 x\n2024-01-01 10:00:05.000 y\n").unwrap();
        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s = Session::from_ctx(&dir, &ctx).unwrap();
        s.filters_batch(&[FilterQuery {
            filter_id: "f1".into(),
            pattern: "x".into(),
            is_regex: false,
            case_sensitive: true,
            scope: "message".into(),
        }])
        .unwrap();
        // 命中行 0（ts=10:00:00）；窗口含 10:00:00 → [0]，窗口外 → []
        assert_eq!(s.corr_ids(&["f1".into()], 1704103200000, 1704103200000), vec![0]);
        assert!(s.corr_ids(&["f1".into()], 1704103201000, 1704103202000).is_empty());
        assert!(s.corr_ids(&[], 0, i64::MAX).is_empty());
        // 文件清单
        let fis = s.file_infos();
        assert_eq!(fis.len(), 1);
        assert_eq!(fis[0].first_line, 0);
        assert_eq!(fis[0].name, "a.log");
        assert!(fis[0].path.ends_with("a.log"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn session_run_sequences_from_filter_hits() {
        // A: ts 100,200 ; B: ts 150,5000 → A@100→B@150 成链
        let s = test_session();
        set_filter_hits(&s, "A", &[(1, 100), (2, 200)]);
        set_filter_hits(&s, "B", &[(3, 150), (4, 5000)]);
        let groups = vec![GroupSpec {
            group_id: "g1".into(),
            filter_ids: vec!["A".into(), "B".into()],
            label: None,
            scope: "global".into(),
            edges: vec![crate::cep::EdgeSpec {
                id: "e1".into(),
                from_filter_id: "A".into(),
                to_filter_id: Some("B".into()),
                to_filter_ids: None,
                kind: Some("seq".into()),
                max_gap_ms: 1000,
                period_ms: None,
            }],
            node_conditions: None,
            node_counts: None,
            max_chains: None,
        }];
        let r = s.run_sequences(&groups);
        assert!(!r.fallback);
        let res = r.results.get("g1").unwrap();
        assert_eq!(res.chains.len(), 1);
        assert_eq!(res.chains[0].steps[1].event.id, 3);
        // 无 ts 命中被丢弃：C 全是 NO_TS → 空流，不成链
        set_filter_hits(&s, "C", &[(9, NO_TS), (10, NO_TS)]);
        let groups2 = vec![GroupSpec {
            group_id: "g2".into(),
            filter_ids: vec!["A".into(), "C".into()],
            label: None,
            scope: "global".into(),
            edges: vec![crate::cep::EdgeSpec {
                id: "e2".into(),
                from_filter_id: "A".into(),
                to_filter_id: Some("C".into()),
                to_filter_ids: None,
                kind: Some("seq".into()),
                max_gap_ms: 1000,
                period_ms: None,
            }],
            node_conditions: None,
            node_counts: None,
            max_chains: None,
        }];
        let r2 = s.run_sequences(&groups2);
        assert!(r2.results.get("g2").unwrap().chains.is_empty());
    }

    /// 大规模基准(用户实测复现):`cargo test --release bench_ws_filters_scale -- --ignored --nocapture`
    /// 复刻 filters_batch 全链路(建库→scan→join)，分阶段计时。
    #[test]
    #[ignore]
    fn bench_ws_filters_scale() {
        use std::time::Instant;
        let dir = std::env::temp_dir().join("loggraph_bench_scale");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 8 文件 × 80 万行 × ~95B ≈ 600MB / 640 万行;55% 行含 alpha → ~352 万命中
        let t0 = Instant::now();
        let variants: Vec<String> = (0..2000u32)
            .map(|i| {
                let msg = if i % 100 < 55 {
                    format!("processing request payload alpha id={i} seq={} done", i * 7)
                } else {
                    format!("idle tick beta gamma id={i} seq={}", i * 7)
                };
                format!(
                    "2024-06-01 10:{:02}:{:02}.{:03} INFO  [worker-{}] {}\n",
                    (i / 60) % 60,
                    i % 60,
                    i % 1000,
                    i % 8,
                    msg
                )
            })
            .collect();
        for f in 0..8u32 {
            let mut buf = String::with_capacity(80_000_000);
            for _ in 0..400 {
                for v in &variants {
                    buf.push_str(v);
                }
            }
            std::fs::write(dir.join(format!("app{f}.log")), &buf).unwrap();
        }
        println!("[bench] 生成 640 万行/600MB: {:?}", t0.elapsed());

        // ---- 建库（REST: build_ctx → from_ctx） ----
        let t1 = Instant::now();
        let ctx = Session::build_ctx(&dir, None, |_, _, _| {}).unwrap();
        let s = Session::from_ctx(&dir, &ctx).unwrap();
        println!(
            "[bench] 建库(便宜通道: 读+计数 {} 万行): {:?}",
            s.total_lines / 10000,
            t1.elapsed()
        );
        let offsets_b: usize = s.files.iter().map(|f| f.line_count as usize * 8).sum();
        println!("[bench] 骨架(虚拟): offsets {} MB, range {:?}", offsets_b / 1048576, s.range);

        // ---- filters_batch 复刻 ----
        let queries = vec![
            FilterQuery {
                filter_id: "rawA".into(),
                pattern: "alpha".into(),
                is_regex: false,
                case_sensitive: false,
                scope: "raw".into(),
            },
            FilterQuery {
                filter_id: "msgP".into(),
                pattern: "payload".into(),
                is_regex: false,
                case_sensitive: false,
                scope: "message".into(),
            },
        ];
        let t3 = Instant::now();
        let o = s.filters_batch(&queries).unwrap();
        println!(
            "[bench] scan+join(raw alpha + message payload,命中 {}/{}): {:?}",
            o.out[0].1.len(),
            o.out[1].1.len(),
            t3.elapsed()
        );
        assert!(
            o.out[0].1.len() > 3_000_000,
            "raw 命中应 ~352 万,实际 {}",
            o.out[0].1.len()
        );
        assert!(
            o.out[1].1.len() > 3_000_000,
            "msg 命中应 ~352 万,实际 {}",
            o.out[1].1.len()
        );

        // 复查（fp 命中路径）
        let t7 = Instant::now();
        let o2 = s.filters_batch(&queries).unwrap();
        assert!(o2.scan_perf.is_empty(), "指纹命中应免重扫");
        println!("[bench] 复查(fp 命中 {} 行): {:?}", o2.out[0].1.len(), t7.elapsed());

        println!("[bench] 链路总耗时(scan 起): {:?}", t3.elapsed());
        std::fs::remove_dir_all(&dir).ok();
    }
}
