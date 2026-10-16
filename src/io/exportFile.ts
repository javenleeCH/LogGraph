/**
 * 文件级导入 / 导出通道（规则集、结论文档）。
 *
 * 规则此前只活在 `<日志目录>/.logGraph/filters.json` 里，跟目录绑死：真实
 * 场景的日志常常在服务器上、只读，或是临时拉下来的一批，规则根本带不出
 * 工作区，也就没法交给同事或进 CI。这里补上「拿到用户手里的路径上」这一环。
 *
 * 双通道（与 openLogFlow 同一套路）：
 * - Tauri：plugin-dialog 的 save/open + plugin-fs 直接读写；
 * - 浏览器：a[download] + Blob / input[type=file]。
 *
 * 全部返回 null/false 表示用户取消，不抛错（取消不是错误）。
 */
import { isTauri, loadDialog, loadFs } from '../lib/tauri';

/** 保存文本到用户选择的位置。返回是否真的落盘了 */
export async function saveTextFile(
  defaultName: string,
  text: string,
  opts: { title?: string; extensions?: string[] } = {},
): Promise<string | null> {
  const exts = opts.extensions ?? [];
  if (isTauri()) {
    try {
      const { save } = await loadDialog();
      const path = await save({
        title: opts.title,
        defaultPath: defaultName,
        ...(exts.length ? { filters: [{ name: '文档', extensions: exts }] } : {}),
      });
      if (!path || typeof path !== 'string') return null;
      const fs = await loadFs();
      await fs.writeTextFile(path, text);
      return path;
    } catch (e) {
      console.warn('[saveTextFile] Tauri 保存失败，回退浏览器下载', e);
    }
  }
  // 浏览器：Blob + 临时 a[download]
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return defaultName;
  } catch (e) {
    console.warn('[saveTextFile] 浏览器下载失败', e);
    return null;
  }
}

/** 选择并读取一个文本文件。取消 / 失败返回 null */
export async function pickTextFile(opts: { extensions?: string[] } = {}): Promise<{
  name: string;
  text: string;
} | null> {
  if (isTauri()) {
    try {
      const { open } = await loadDialog();
      const sel = await open({
        multiple: false,
        directory: false,
        ...(opts.extensions?.length
          ? { filters: [{ name: '规则', extensions: opts.extensions }] }
          : {}),
      });
      const path = Array.isArray(sel) ? sel[0] : sel;
      if (!path || typeof path !== 'string') return null;
      const fs = await loadFs();
      const text = await fs.readTextFile(path);
      return { name: basenameOf(path), text };
    } catch (e) {
      console.warn('[pickTextFile] Tauri 读取失败，回退浏览器选择', e);
    }
  }
  return await pickFileViaInput();
}

/** 浏览器路径：动态 input[type=file]（无法在用户手势外用 showPicker） */
function pickFileViaInput(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json,.md,text/markdown';
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      const done = (v: { name: string; text: string } | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      input.onchange = () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return done(null);
        file
          .text()
          .then((text) => done({ name: file.name, text }))
          .catch(() => done(null));
      };
      // 取消文件选择：部分浏览器不触发 change，用窗口重新获得焦点兜底
      input.oncancel = () => {
        input.remove();
        done(null);
      };
      input.click();
    } catch {
      resolve(null);
    }
  });
}

function basenameOf(p: string): string {
  const segs = p.split(/[\\/]+/).filter(Boolean);
  return segs[segs.length - 1] ?? p;
}
