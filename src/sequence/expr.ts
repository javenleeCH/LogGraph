/**
 * 节点条件表达式（EPL 事件内部条件子集）：
 *   level == 'E' && msg.includes('IPC timeout') || thread != 'pool-4'
 *
 * 语法（优先级低→高）：
 *   or_expr  := and_expr ('||' and_expr)*
 *   and_expr := cmp_expr ('&&' cmp_expr)*
 *   cmp_expr := operand (('=='|'!='|'>'|'<'|'>='|'<=') operand)?
 *   operand  := 字符串 'x' | 数字 | 字段 | 方法调用 field.m('arg') | '(' or_expr ')'
 * 字段：raw / msg(message) / thread / level / ts / sourceFile(file)
 * 方法：includes / contains / startsWith / endsWith（挂在字段上）
 *
 * 零依赖递归下降；求值异常按 false（保守：条件错=不匹配）。
 */

export type ExprEvent = {
  raw: string;
  message: string;
  thread?: string;
  level?: string;
  ts: number;
  sourceFile?: string;
};

type Node =
  | { t: 'or'; l: Node; r: Node }
  | { t: 'and'; l: Node; r: Node }
  | { t: 'cmp'; op: string; l: Node; r: Node }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'field'; name: string }
  | { t: 'mcall'; method: string; field: string; arg: string };

const STR = '\u0000';

function tokenize(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error('未闭合的字符串');
      out.push(STR + s);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      out.push(two);
      i += 2;
      continue;
    }
    if ('><().'.includes(c)) {
      out.push(c);
      i++;
      continue;
    }
    throw new Error(`非法字符 '${c}' @${i}`);
  }
  return out;
}

const METHODS = new Set(['includes', 'contains', 'startsWith', 'endsWith']);

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t?: string) => {
    if (t !== undefined && toks[p] !== t) throw new Error(`期望 '${t}' 实得 '${toks[p] ?? 'EOF'}'`);
    return toks[p++];
  };

  function parseOr(): Node {
    let l = parseAnd();
    while (peek() === '||') {
      eat();
      l = { t: 'or', l, r: parseAnd() };
    }
    return l;
  }
  function parseAnd(): Node {
    let l = parseCmp();
    while (peek() === '&&') {
      eat();
      l = { t: 'and', l, r: parseCmp() };
    }
    return l;
  }
  function parseCmp(): Node {
    const l = parseOperand();
    const op = peek();
    if (op && ['==', '!=', '>', '<', '>=', '<='].includes(op)) {
      eat();
      return { t: 'cmp', op, l, r: parseOperand() };
    }
    return l;
  }
  function parseOperand(): Node {
    const tk = peek();
    if (tk === undefined) throw new Error('表达式意外结束');
    // 方法调用：field.method('arg')
    if (/^[A-Za-z_]/.test(tk) && toks[p + 1] === '.' && toks[p + 2] && METHODS.has(toks[p + 2])) {
      const field = tk;
      const method = toks[p + 2];
      p += 3; // field . method
      eat('(');
      const arg = peek();
      if (arg === undefined || !arg.startsWith(STR)) throw new Error(`方法 ${method} 需字符串参数`);
      eat();
      eat(')');
      return { t: 'mcall', method, field, arg: arg.slice(1) };
    }
    if (tk.startsWith(STR)) {
      eat();
      return { t: 'str', v: tk.slice(1) };
    }
    if (/^[0-9]/.test(tk)) {
      eat();
      return { t: 'num', v: parseFloat(tk) };
    }
    if (/^[A-Za-z_]/.test(tk)) {
      eat();
      return { t: 'field', name: tk };
    }
    if (tk === '(') {
      eat('(');
      const n = parseOr();
      eat(')');
      return n;
    }
    throw new Error(`意外的 token '${tk}'`);
  }

  const ast = parseOr();
  if (p < toks.length) throw new Error(`多余 token '${toks[p]}'`);
  return ast;
}

function fieldValue(ev: ExprEvent, name: string): string | number {
  switch (name) {
    case 'raw':
      return ev.raw;
    case 'msg':
    case 'message':
      return ev.message;
    case 'thread':
      return ev.thread ?? '';
    case 'level':
      return ev.level ?? '';
    case 'ts':
      return ev.ts;
    case 'sourceFile':
    case 'file':
      return ev.sourceFile ?? '';
    default:
      throw new Error(`未知字段 '${name}'`);
  }
}

function evalNode(n: Node, ev: ExprEvent): string | number | boolean {
  switch (n.t) {
    case 'or':
      return !!evalNode(n.l, ev) || !!evalNode(n.r, ev);
    case 'and':
      return !!evalNode(n.l, ev) && !!evalNode(n.r, ev);
    case 'cmp': {
      const a = evalNode(n.l, ev);
      const b = evalNode(n.r, ev);
      switch (n.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '>':
          return Number(a) > Number(b);
        case '<':
          return Number(a) < Number(b);
        case '>=':
          return Number(a) >= Number(b);
        case '<=':
          return Number(a) <= Number(b);
        default:
          return false;
      }
    }
    case 'str':
      return n.v;
    case 'num':
      return n.v;
    case 'field':
      return fieldValue(ev, n.name);
    case 'mcall': {
      const target = String(fieldValue(ev, n.field));
      switch (n.method) {
        case 'includes':
        case 'contains':
          return target.includes(n.arg);
        case 'startsWith':
          return target.startsWith(n.arg);
        case 'endsWith':
          return target.endsWith(n.arg);
        default:
          return false;
      }
    }
  }
}

/**
 * 编译表达式：返回 (ev) => boolean。
 * 空串/非法表达式返回 null（调用方按「不过滤」处理并提示错误）。
 */
export function compileExpr(src: string): ((ev: ExprEvent) => boolean) | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  try {
    const ast = parseExpr(trimmed);
    return (ev) => {
      try {
        return !!evalNode(ast, ev);
      } catch {
        return false;
      }
    };
  } catch {
    return null;
  }
}

/** 语法校验（编辑器实时反馈）：合法返回 null，否则返回错误信息 */
export function validateExpr(src: string): string | null {
  if (!src.trim()) return null;
  try {
    parseExpr(src.trim());
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
