/**
 * 文件加载：拖拽 + FileReader。
 * 读取 .log / .txt / 任意文本，返回字符串。
 */

const ACCEPTED = /\.(log|txt|out|csv|tsv)$/i;

export interface LoadedFile {
  name: string;
  size: number;
  text: string;
}

/** 通过 input[type=file] 加载 */
export function loadFile(file: File): Promise<LoadedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: file.name,
        size: file.size,
        text: String(reader.result ?? ''),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** 是否为可接受的日志文件（按扩展名宽松判断） */
export function isLogFileName(name: string): boolean {
  return ACCEPTED.test(name);
}

/** 处理拖拽释放的文件列表，返回第一个文本文件 */
export async function loadFromDataTransfer(dt: DataTransfer): Promise<LoadedFile | null> {
  const file = dt.files?.[0];
  if (!file) return null;
  return loadFile(file);
}
