# 大规模日志性能优化方案

## 场景
141 文件 × 5.1MB ≈ 720MB，约 500~700 万行事件。现象：加载慢；新增过滤器后主线程长时间阻塞；切到时间线视图直接卡死。

## 瓶颈定位

| # | 位置 | 问题 |
|---|------|------|
| L1 | dirLoader.loadMultiple | 141 次逐文件 IPC；events+rawLines JSON 过桥，JSON.parse 峰值内存 2~3 倍 |
| L2 | dirLoader.mergeParsedInputs | 全量事件再拷贝一遍 + 500 万事件全局 sort，主线程同步 |
| L3 | 数据模型 | 每行文本存 3 份独立字符串：rawLines[i] / event.raw / event.message |
| L4 | FilterEngine.run | 改 1 个 filter 全量重跑全部 filter；ci 匹配每行 toLowerCase 再生成一份 |
| L5 | TimelineCanvas RAF | 每帧全量重绘：drawMinimap 每帧遍历全部匹配事件 fillRect；drawLaneEventsAt 线性扫全量；chainDataOf 每帧重建 Map/Set |
| L6 | layout.buildVisibleRows | `merged.push(...fm.events)` spread 百万元素 → 栈溢出 |

## 优化方案（按优先级分四阶段，每阶段独立可交付）

### P0 渲染卡死（纯前端，改动小收益大）
1. **脏标记渲染**：去掉每帧 RAF 循环；zustand 订阅相关状态 → `needsRenderRef` 标脏 → 单帧 `requestAnimationFrame` 重绘一次。静止时 0 CPU。
2. **视口二分裁剪**：每 filter 的匹配事件已按 ts 升序 → 对 viewRange 用 `bisectLeft/bisectRight`（复用 `timeline/correlation.ts`）取可见子数组，只画可见的。O(全量)→O(可见)。
3. **minimap 离屏预渲染**：直方图只依赖 matches/fullRange → 重算时预渲染到 OffscreenCanvas；每帧仅 `drawImage` + 视口框。
4. **chainDataOf memo 化**：依赖 sequenceResults/groups/filters，用 `useMemo` 产出 `Map<filterId, ChainData>`，不进 render 回调。
5. **drawSequenceLinks / drawSequenceDecorations** 同样按视口裁剪链事件。
6. **buildVisibleRows spread 修复**：`push(...events)` 改 for 循环。

### P1 过滤慢（纯前端）
7. **单 filter 增量重算**：store 记 `filterId → FilterMatch`；改一个 filter 只重跑该 filter，其余引用复用。`recomputeSequences` 只重算受影响 group。
8. **chunk 化调度**：FilterEngine 按块（5 万/块）异步执行（`setTimeout(0)` 步进），Toolbar 显示进度，主线程保持响应。
9. **lowercase 缓存**：解析完成后对 raw 预生成小写串缓存表（WeakMap 或列存数组），匹配时直接 indexOf，不再每次 toLowerCase。

### P2 加载慢 + 内存（Rust 侧 + 数据流）
10. **Rust 批量命令 `parse_dir`**：Rust 进程内枚举 + 解析 + 合并 + 全局排序，**单次 IPC** 返回最终结果；进度经 Tauri event 推送（替换 141 次往返 + JS 合并 + JS sort）。
11. **sourceFile 驻留**：合并阶段 141 个文件名字符串 intern（500 万事件共享引用，不再每事件一份）。
12. **message 字段去除存储**：message = raw 去掉时间戳前缀，改为按需切片（`raw.slice(prefixLen)`）或仅保存起始偏移；内存立省 1/3。
13. **rawLines 引用共享**：合并时 rawLines[i] 直接复用 event.raw 的字符串引用（同一字符串对象不重复占内存）；JSON 传输路径下无法共享的，改由 P3 二进制通道解决。

### P3 架构级（升级路线，暂不实施）

> **决策（2026-09）**：SQLite（rusqlite + FTS5 trigram + regex UDF）定为后续升级路线。
> 触发条件（满足任一再启动）：① P0-P2 完成后实测"过滤 1~3 秒带进度"仍打断分析心流；
> ② 日志规模走向 2GB+；③ 同一目录高频重开成为日常。
> P0/P1 的"id 集合 + 视口取数"设计与 SQLite 化同构，届时前端无需重写。
14. **二进制 IPC**：Rust 返回 `tauri::ipc::Response` 原始字节（ts: i64 列、行号: u32 列、字符串大池 + 偏移表），前端 `DataView` 解码，绕过 JSON.parse。
15. **Web Worker 匹配引擎**：列存 + Transferable 零拷贝转移，主线程永不阻塞。
16. **事件列存储（SoA）**：`ts: Float64Array` / `offsets: Uint32Array` + 单一 raw 大字符串，渲染只读 ts 列。

## 预期效果
- P0：时间线从「每帧全量」→「静止 0 CPU、交互单帧 O(可见)」，卡死消除
- P1：新增/编辑过滤器从全量 O(N×M) 同步阻塞 → 单 filter O(N) 分块异步 + 进度
- P2：加载从 141×(IPC+JSON.parse) → 1 次 IPC + Rust 合并排序；内存峰值降约 1/3~1/2
