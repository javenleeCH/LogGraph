import { useLogStore } from '../store/logStore';
import { isTauri } from '../lib/tauri';
import { fetchLine } from '../io/dbStore';

/**
 * 取得某一行的原始文本。
 *
 * 单文件模式：rawLines[行号] 即真值。
 * db 模式（目录 / 大文件走 SQLite）：rawLines 为空数组，必须先回源到 SQLite
 * 拉这一行，否则复制出来是空字符串——会被误判成「剪贴板不可用」。
 */
export async function getRawLine(no: number): Promise<string> {
  const st = useLogStore.getState();
  const fromMemory =
    st.rawLines[no] ?? st.events.find((e) => e.id === no)?.raw ?? '';
  if (fromMemory) return fromMemory;

  if (st.dbMode && isTauri()) {
    try {
      const text = await fetchLine(no);
      return typeof text === 'string' ? text : '';
    } catch (err) {
      console.warn('[getRawLine] db 取行失败:', err);
      return '';
    }
  }
  return '';
}
