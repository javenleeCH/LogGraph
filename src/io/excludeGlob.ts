/**
 * 目录排除规则（rg `-g '!pat'` 的语义子集）：
 * - 规则不含 `/`：对**文件名**做 glob 匹配（如 `*.gz`、`noise.log`）
 * - 规则含 `/`：对**相对路径**做 glob 匹配（如 `debug/**`、`a/b*.log`）
 *   —— `**` 跨目录层级，`*` / `?` 不跨（与 rg / VSCode 一致）
 *
 * 应用点唯一（前端 listLogFiles）：前端是文件清单的唯一权威，
 * db_open 只接收最终清单（Rust 不实现第二套 glob，杜绝两边语义漂移）。
 */

/** 单条 glob → 锚定整串的正则；`**` 跨目录，`*`/`?` 单段内 */
function globToRegex(pat: string): RegExp {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 编译排除规则集。返回 (relPath, fileName) => boolean；
 * 无有效规则返回 null（调用方跳过过滤，零开销）。
 */
export function compileExcludePatterns(
  patterns: string[],
): ((relPath: string, fileName: string) => boolean) | null {
  const rules = patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== '**')
    .map((p) => ({ re: globToRegex(p), isPath: p.includes('/') }));
  if (rules.length === 0) return null;
  return (relPath: string, fileName: string) =>
    rules.some((r) => (r.isPath ? r.re.test(relPath) : r.re.test(fileName)));
}
