/**
 * 实时 tail 轮询器（C 阶段一：单文件实时跟随）。
 *
 * 一个全局定时器（默认 1s）轮询当前跟随文件的字节大小：
 * - 大小未增长 → 跳过；
 * - 增长 → 调 parse_log_incremental 仅取完整新行，写回 store 追加。
 * 仅当 store.tail.enabled 为真时真正干活；其余时间空转（web 模式 / 多文件 / 关闭状态
 * 均不触发任何 IO）。
 *
 * 字节边界由 Rust 端 find_complete_segment 保证（残行留给下个轮询），本模块不解析半行。
 */

import { loadFs } from '../lib/tauri';
import { parseLogIncremental } from '../parser/parseBridge';
import { useLogStore } from '../store/logStore';

const POLL_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;

async function pollTail(): Promise<void> {
  const st = useLogStore.getState();
  const tail = st.tail;
  if (!tail || !tail.enabled) return;
  // 跟随中再次确认仍是单文件 standalone（多文件追加会把 tail 置空）
  if (st.dbMode || st.sessionFiles.length !== 1 || st.sessionFiles[0]?.path !== tail.path) {
    return;
  }
  const { path, offset } = tail;
  try {
    const fs = await loadFs();
    const stat = await fs.stat(path);
    if (typeof stat.size !== 'number' || stat.size <= offset) return;
    const res = await parseLogIncremental(path, offset);
    if (!res || res.events.length === 0) return; // 暂无完整新行（写入中）
    useLogStore.getState().appendTailEvents(
      res.events as never,
      res.rawLines,
      res.newOffset,
      res.skipped,
      stat.size,
    );
  } catch (err) {
    // 文件被移动/删除/权限变化：静默停止跟随，避免每轮抛错刷屏
    console.warn('[tailWatcher] 轮询失败，停止跟随:', err);
    useLogStore.getState().setTailEnabled(false);
  }
}

/** 启动全局轮询（幂等；App 挂载时调用一次即可） */
export function startTailWatcher(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void pollTail();
  }, POLL_MS);
}

/** 停止全局轮询（App 卸载时调用） */
export function stopTailWatcher(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
