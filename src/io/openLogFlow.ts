/**
 * 打开日志的统一入口（工具栏 / 命令面板 / 欢迎页共用）。
 *
 * 把「选文件 → 解析 → 写入 store → 反馈」这条链路收敛到一处，
 * 保证各处触发（点按钮、⌘K、拖拽）的行为与提示完全一致。
 */
import { loadFile, openLogFileDialog, type LoadedFile } from './fileLoader';
import { parseLoadedFile } from '../parser/parseBridge';
import { isTauri } from '../lib/tauri';
import { useLogStore } from '../store/logStore';
import { beginBusy, toast } from '../store/uiStore';

/** 解析单个已载入文件 → 写入 store（带忙碌指示 + 结果反馈） */
export async function ingestLoadedFile(loaded: LoadedFile): Promise<void> {
  const endBusy = beginBusy(`解析 ${loaded.name}`);
  try {
    const result = await parseLoadedFile(loaded);
    useLogStore.getState().setLog(result.events, result.rawLines, {
      fileName: loaded.name,
      fileSize: loaded.size,
      totalLines: result.totalLines,
      skipped: result.skipped,
      timestampFormatId: result.timestampFormatId,
    });
    if (result.events.length === 0) {
      toast.warn(
        `${loaded.name} 中没有解析出带时间戳的事件`,
        '请确认文件内含可被识别的时间戳，或换一个文件试试',
      );
      return;
    }
    toast.success(
      `已载入 ${loaded.name}`,
      [
        `${result.events.length.toLocaleString()} 条事件`,
        result.skipped > 0 ? `跳过 ${result.skipped} 行` : '',
        result.timestampFormatId ? `时间戳 ${result.timestampFormatId}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
  } catch (err) {
    console.error('解析日志失败', err);
    toast.error('解析日志失败', (err as Error).message);
  } finally {
    endBusy();
  }
}

/**
 * 弹出文件选择器并载入一个日志文件。
 * Tauri 走系统对话框；浏览器构造一次性 <input type=file>（用户手势内触发才有效）。
 */
export async function openSingleLogFile(): Promise<void> {
  if (isTauri()) {
    const loaded = await openLogFileDialog();
    if (loaded) await ingestLoadedFile(loaded);
    return;
  }
  await new Promise<void>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.log,.txt,.out,.csv,.tsv';
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve();
    };
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) {
          void loadFile(f)
            .then((loaded) => ingestLoadedFile(loaded))
            .then(cleanup);
        } else cleanup();
      });
    // 某些浏览器（含取消场景）不派发 change → 靠窗口重新聚焦兜底清理
    input.addEventListener('cancel', cleanup);
    window.addEventListener('focus', cleanup, { once: true });
    input.click();
  });
}

/** 打开整个日志目录（即绑定工作区），复用 store 内的 .logGraph 绑定逻辑 */
export async function openLogDirectory(): Promise<void> {
  try {
    await useLogStore.getState().chooseLogsDir();
  } catch (err) {
    console.error('打开目录失败', err);
    toast.error('打开目录失败', (err as Error).message);
  }
}
