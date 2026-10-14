/**
 * 打开日志的统一入口（工具栏 / 命令面板 / 欢迎页共用）。
 *
 * 把「选文件 → 解析 → 写入 store → 反馈」这条链路收敛到一处，
 * 保证各处触发（点按钮、⌘K、拖拽）的行为与提示完全一致。
 */
import { loadFile, loadTauriPaths, openLogFileDialog, type LoadedFile } from './fileLoader';
import { ensureReadPermission, isFSASupported, tauriPathAsDirectory } from './dirLoader';
import {
  recordOpenProject,
  resolveProjectHandle,
  type ProjectEntry,
} from './recentProjects';
import { parseLoadedFile } from '../parser/parseBridge';
import { isTauri } from '../lib/tauri';
import { useLogStore } from '../store/logStore';
import { beginBusy, toast } from '../store/uiStore';

/** 解析单个已载入文件 → 写入 store（带忙碌指示 + 结果反馈） */
export async function ingestLoadedFile(loaded: LoadedFile): Promise<void> {
  const endBusy = beginBusy(`解析 ${loaded.name}`);
  try {
    const result = await parseLoadedFile(loaded);
    // 与当前独立会话同目录（Tauri 路径可比对）→ 追加合并；否则新开独立会话
    const mode = await useLogStore.getState().ingestSingleFile(loaded, result);
    if (mode === 'duplicate') {
      toast.warn(`${loaded.name} 已在当前文件列表中`, '同目录同名文件不会重复加载');
      return;
    }
    // Tauri 路径直读的文件计入最近项目（浏览器 File 无路径，不记录）
    if (loaded.path) {
      await recordOpenProject({ name: loaded.name, kind: 'file', path: loaded.path });
    }
    if (result.events.length === 0) {
      toast.warn(
        `${loaded.name} 中没有解析出带时间戳的事件`,
        '请确认文件内含可被识别的时间戳，或换一个文件试试',
      );
      return;
    }
    toast.success(
      mode === 'appended' ? `已追加 ${loaded.name}` : `已载入 ${loaded.name}`,
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

/** Chromium 独有 API，项目 TS lib 未收录：窄化声明 + 运行时存在性检查 */
interface FilePickerWindow {
  showOpenFilePicker?: (opts: {
    multiple?: boolean;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle[]>;
}

/**
 * 弹出文件选择器并载入一个日志文件。
 * Tauri 走系统对话框；Chromium 走 showOpenFilePicker（句柄可入最近项目）；
 * 其余浏览器构造一次性 <input type=file>（用户手势内触发才有效，无句柄不记录）。
 */
export async function openSingleLogFile(): Promise<void> {
  if (isTauri()) {
    const loaded = await openLogFileDialog();
    if (loaded) await ingestLoadedFile(loaded);
    return;
  }
  const picker = (window as FilePickerWindow).showOpenFilePicker;
  if (isFSASupported() && typeof picker === 'function') {
    // Chromium：showOpenFilePicker 返回可持久化句柄（进入最近项目）
    let handle: FileSystemFileHandle | undefined;
    try {
      [handle] = await picker.call(window, {
        multiple: false,
        types: [
          {
            description: '日志文件',
            accept: { 'text/plain': ['.log', '.txt', '.out', '.csv', '.tsv'] },
          },
        ],
      });
    } catch {
      return; // 用户取消
    }
    if (!handle) return;
    const file = await handle.getFile();
    await ingestLoadedFile(await loadFile(file));
    await recordOpenProject({ name: file.name, kind: 'file', handle });
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

/**
 * 打开一个最近 / 收藏项目。
 * Tauri 按绝对路径直读（目录即工作区）；浏览器按 id 取回 FSA 句柄并重新授权。
 * 返回是否走到了载入（失败路径以 toast 反馈，调用方据此决定是否收起入口）。
 */
export async function openRecentProject(entry: ProjectEntry): Promise<boolean> {
  try {
    if (isTauri()) {
      if (!entry.path) return false;
      if (entry.kind === 'dir') {
        const handle = await tauriPathAsDirectory(entry.path);
        if (!handle) {
          toast.error('目录不存在或无法访问', entry.path);
          return false;
        }
        useLogStore.getState().setLogsDir(handle, entry.name);
        await useLogStore.getState().openWorkspace(handle);
        await recordOpenProject({ name: entry.name, kind: 'dir', path: entry.path });
        toast.success(`已打开工作区 ${entry.name}`, '左侧文件树可浏览目录内日志');
        return true;
      }
      const loaded = await loadTauriPaths([entry.path]);
      if (!loaded) {
        toast.error('文件不存在', entry.path);
        return false;
      }
      await ingestLoadedFile(loaded); // 路径记录由 ingestLoadedFile 内完成
      return true;
    }

    const handle = await resolveProjectHandle(entry.id);
    if (!handle) {
      toast.warn('项目句柄已失效', '请通过「打开日志文件 / 目录」重新选择');
      return false;
    }
    if (!(await ensureReadPermission(handle))) {
      toast.warn('未获得读取权限', '浏览器需要重新授权才能再次读取该位置');
      return false;
    }
    if (entry.kind === 'dir') {
      useLogStore.getState().setLogsDir(handle, entry.name);
      await useLogStore.getState().openWorkspace(handle);
      await recordOpenProject({ name: entry.name, kind: 'dir', handle });
      return true;
    }
    if (!('getFile' in handle)) {
      toast.warn('项目句柄类型不匹配', '该条目记录的不是文件句柄');
      return false;
    }
    const file = await handle.getFile();
    await ingestLoadedFile(await loadFile(file));
    await recordOpenProject({ name: file.name, kind: 'file', handle });
    return true;
  } catch (err) {
    console.error('打开最近项目失败', err);
    toast.error('打开项目失败', (err as Error).message);
    return false;
  }
}
