/**
 * expr.ts 解析/求值单测（CEP 节点条件表达式，EPL 子集）。
 * 覆盖：优先级 / 括号 / 比较 / 字段别名 / 方法调用 / 字符串转义 / 非法表达式。
 */
import { describe, it, expect } from 'vitest';
import { compileExpr, validateExpr, parseExpr } from './expr';
import type { ExprEvent } from './expr';

const ev = (partial: Partial<ExprEvent> = {}): ExprEvent => ({
  raw: '2026-01-01 10:00:00.000 ERROR boom',
  message: 'boom',
  thread: 'pool-4',
  level: 'ERROR',
  ts: 1_704_067_201_469,
  sourceFile: 'app.log',
  ...partial,
});

const testEval = (expr: string, e: ExprEvent) => {
  const fn = compileExpr(expr);
  expect(fn).not.toBeNull();
  return fn!(e);
};

describe('compileExpr · 空 / 非法表达式', () => {
  it('空串返回 null（不过滤）', () => {
    expect(compileExpr('')).toBeNull();
    expect(compileExpr('   ')).toBeNull();
  });

  it('语法非法 → null，validateExpr 给出错误信息', () => {
    expect(compileExpr('level ==')).toBeNull();
    expect(compileExpr('(')).toBeNull();
    expect(compileExpr("msg.includes('x")).toBeNull(); // 未闭合字符串
    expect(validateExpr('level ==')).not.toBeNull();
    expect(validateExpr('a b c')).not.toBeNull(); // 多余 token
  });

  it('未知字段在求值期报错 → 保守返回 false', () => {
    expect(testEval('unknownField == 1', ev())).toBe(false);
  });
});

describe('比较运算', () => {
  it('== / != 字符串与字段', () => {
    expect(testEval("level == 'ERROR'", ev())).toBe(true);
    expect(testEval("level == 'INFO'", ev())).toBe(false);
    expect(testEval("level != 'INFO'", ev())).toBe(true);
  });

  it('数字比较 > < >= <=', () => {
    expect(testEval('ts > 1000', ev())).toBe(true);
    expect(testEval('ts < 1000', ev())).toBe(false);
    expect(testEval('ts >= 1704067201469', ev())).toBe(true);
    expect(testEval('ts <= 1704067201469', ev())).toBe(true);
  });

  it('ts 为数值字段，参与数值比较', () => {
    expect(testEval('ts == 1704067201469', ev())).toBe(true);
  });
});

describe('字段别名', () => {
  it('msg / message 同指 message', () => {
    expect(testEval("msg == 'boom'", ev())).toBe(true);
    expect(testEval("message == 'boom'", ev())).toBe(true);
  });
  it('thread 缺省为空串', () => {
    expect(testEval("thread == 'pool-4'", ev({ thread: undefined }))).toBe(false);
  });
  it('sourceFile / file 同指 sourceFile', () => {
    expect(testEval("sourceFile == 'app.log'", ev())).toBe(true);
    expect(testEval("file == 'app.log'", ev())).toBe(true);
  });
  it('level 缺省为空串', () => {
    expect(testEval("level == 'ERROR'", ev({ level: undefined }))).toBe(false);
  });
});

describe('逻辑组合与优先级', () => {
  it('&& 优先级高于 ||（默认）', () => {
    // a || b && c  →  a || (b && c)
    expect(testEval("level == 'WARN' || level == 'ERROR' && ts > 0", ev())).toBe(true);
    expect(testEval("level == 'WARN' || level == 'ERROR' && ts < 0", ev())).toBe(false); // false || (true&&false)
  });

  it('括号提升优先级', () => {
    // (a || b) && c
    expect(testEval("(level == 'WARN' || level == 'ERROR') && ts > 0", ev())).toBe(true);
    expect(testEval("(level == 'WARN' || level == 'ERROR') && ts < 0", ev())).toBe(false);
  });

  it('多级 && / || 组合', () => {
    const e = ev({ level: 'INFO', thread: 'main' });
    expect(testEval("level == 'INFO' && thread == 'main' && ts > 0", e)).toBe(true);
    expect(testEval("level == 'INFO' && thread == 'main' && ts < 0", e)).toBe(false);
    expect(testEval("level == 'DEBUG' || level == 'INFO' || level == 'TRACE'", e)).toBe(true);
  });
});

describe('方法调用', () => {
  it('includes / contains', () => {
    expect(testEval("msg.includes('oo')", ev())).toBe(true);
    expect(testEval("msg.contains('xz')", ev())).toBe(false);
    expect(testEval("thread.includes('pool')", ev())).toBe(true);
  });
  it('startsWith / endsWith', () => {
    expect(testEval("msg.startsWith('bo')", ev())).toBe(true);
    expect(testEval("msg.startsWith('oo')", ev())).toBe(false);
    expect(testEval("msg.endsWith('om')", ev())).toBe(true);
    expect(testEval("msg.endsWith('bo')", ev())).toBe(false);
  });
  it('方法可与其他运算组合', () => {
    expect(testEval("level == 'ERROR' && msg.includes('boom')", ev())).toBe(true);
  });
  it('方法需字符串参数（非字符串 → 求值期 false）', () => {
    expect(compileExpr('msg.includes(123)')).toBeNull(); // 数字参数非法
  });
});

describe('字符串字面量与转义', () => {
  it('单引号 / 双引号均可', () => {
    expect(testEval("level == 'ERROR'", ev())).toBe(true);
    expect(testEval('level == "ERROR"', ev())).toBe(true);
  });
  it('反斜杠转义（字符串内含引号）', () => {
    expect(testEval("msg == 'bo\\'om'", ev({ message: "bo'om" }))).toBe(true);
  });
});

describe('parseExpr 结构', () => {
  it('生成正确的 AST 树', () => {
    const ast = parseExpr("level == 'ERROR' && ts > 1");
    expect(ast).toMatchObject({ t: 'and' });
  });
});
