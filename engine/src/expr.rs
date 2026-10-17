//! 节点条件表达式（EPL 事件内部条件子集）求值器。
//!
//! 语法（优先级低→高）：
//! ```text
//! or_expr  := and_expr ('||' and_expr)*
//! and_expr := cmp_expr ('&&' cmp_expr)*
//! cmp_expr := operand (('=='|'!='|'>'|'<'|'>='|'<=') operand)?
//! operand  := 字符串 | 数字 | 字段 | 字段.方法('参数') | '(' or_expr ')'
//! ```
//! 字段：raw / msg(message) / thread / level / ts / sourceFile(file)
//! 方法：includes / contains / startsWith / endsWith
//!
//! 零依赖递归下降；求值异常按 false（保守：条件错=不匹配）。
//! 端口对齐前端 `src/sequence/expr.ts`。

use crate::cep::SeqEvent;

/// 词法单元：字符串内部以 NUL 标记前缀，便于与字段/数字区分。
const STR: &str = "\u{0}";

#[derive(Debug, Clone)]
enum Node {
    Or(Box<Node>, Box<Node>),
    And(Box<Node>, Box<Node>),
    Cmp { op: &'static str, l: Box<Node>, r: Box<Node> },
    Str(String),
    Num(f64),
    Field(String),
    MCall { method: String, field: String, arg: String },
}

fn tokenize(src: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            let mut j = i + 1;
            let mut s = String::new();
            while j < chars.len() && chars[j] != c {
                if chars[j] == '\\' && j + 1 < chars.len() {
                    s.push(chars[j + 1]);
                    j += 2;
                } else {
                    s.push(chars[j]);
                    j += 1;
                }
            }
            if j >= chars.len() {
                return Err("未闭合的字符串".into());
            }
            out.push(format!("{STR}{s}"));
            i = j + 1;
            continue;
        }
        if c.is_ascii_digit() {
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == '.') {
                j += 1;
            }
            out.push(chars[i..j].iter().collect());
            i = j;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            out.push(chars[i..j].iter().collect());
            i = j;
            continue;
        }
        let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
        if ["==", "!=", ">=", "<=", "&&", "||"].contains(&two.as_str()) {
            out.push(two);
            i += 2;
            continue;
        }
        if [">", "<", "(", ")", "."].contains(&c.to_string().as_str()) {
            out.push(c.to_string());
            i += 1;
            continue;
        }
        return Err(format!("非法字符 '{c}'"));
    }
    Ok(out)
}

const METHODS: &[&str] = &["includes", "contains", "startsWith", "endsWith"];

/// 合法字段名（见模块文档）。
const FIELDS: &[&str] = &["raw", "msg", "message", "thread", "level", "ts", "sourceFile", "file"];

/// 校验 AST 中所有字段引用是否合法；未知字段视为非法表达式（编译期 None）。
fn check_fields(n: &Node) -> bool {
    match n {
        Node::Or(l, r) | Node::And(l, r) => check_fields(l) && check_fields(r),
        Node::Cmp { l, r, .. } => check_fields(l) && check_fields(r),
        Node::Str(_) | Node::Num(_) => true,
        Node::Field(name) => FIELDS.contains(&name.as_str()),
        Node::MCall { field, .. } => FIELDS.contains(&field.as_str()),
    }
}

fn p_peek(toks: &[String], p: &usize) -> Option<String> {
    toks.get(*p).cloned()
}

fn p_eat(toks: &[String], p: &mut usize, t: Option<&str>) -> Result<String, String> {
    let cur = toks.get(*p).cloned();
    if let Some(t) = t {
        if cur.as_deref() != Some(t) {
            return Err(format!("期望 '{t}' 实得 '{}'", cur.unwrap_or_else(|| "EOF".into())));
        }
    }
    *p += 1;
    Ok(cur.unwrap_or_default())
}

fn parse_expr(src: &str) -> Result<Node, String> {
    let toks = tokenize(src)?;
    let mut p = 0usize;
    let ast = parse_or(&toks, &mut p)?;
    if p < toks.len() {
        return Err(format!("多余 token '{}'", toks[p]));
    }
    Ok(ast)
}

fn parse_or(toks: &[String], p: &mut usize) -> Result<Node, String> {
    let mut l = parse_and(toks, p)?;
    while p_peek(toks, p) == Some("||".to_string()) {
        p_eat(toks, p, Some("||"))?;
        let r = parse_and(toks, p)?;
        l = Node::Or(Box::new(l), Box::new(r));
    }
    Ok(l)
}

fn parse_and(toks: &[String], p: &mut usize) -> Result<Node, String> {
    let mut l = parse_cmp(toks, p)?;
    while p_peek(toks, p) == Some("&&".to_string()) {
        p_eat(toks, p, Some("&&"))?;
        let r = parse_cmp(toks, p)?;
        l = Node::And(Box::new(l), Box::new(r));
    }
    Ok(l)
}

fn parse_cmp(toks: &[String], p: &mut usize) -> Result<Node, String> {
    let l = parse_operand(toks, p)?;
    let op = p_peek(toks, p);
    if let Some(op) = op.as_deref() {
        if ["==", "!=", ">", "<", ">=", "<="].contains(&op) {
            p_eat(toks, p, Some(op))?;
            let r = parse_operand(toks, p)?;
            let sop: &'static str = match op {
                "==" => "==",
                "!=" => "!=",
                ">" => ">",
                "<" => "<",
                ">=" => ">=",
                "<=" => "<=",
                _ => unreachable!(),
            };
            return Ok(Node::Cmp { op: sop, l: Box::new(l), r: Box::new(r) });
        }
    }
    Ok(l)
}

fn parse_operand(toks: &[String], p: &mut usize) -> Result<Node, String> {
    let tk = p_peek(toks, p).ok_or_else(|| "表达式意外结束".to_string())?;
    // 方法调用：field.method('arg')
    if tk.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
        && toks.get(*p + 1).map(|s| s == ".").unwrap_or(false)
        && toks.get(*p + 2).map(|s| METHODS.contains(&s.as_str())).unwrap_or(false)
    {
        let field = tk;
        let method = toks[*p + 2].clone();
        *p += 3;
        p_eat(toks, p, Some("("))?;
        let arg = p_peek(toks, p).ok_or_else(|| "方法需字符串参数".to_string())?;
        if !arg.starts_with(STR) {
            return Err("方法需字符串参数".into());
        }
        p_eat(toks, p, None)?;
        p_eat(toks, p, Some(")"))?;
        return Ok(Node::MCall {
            method,
            field,
            arg: arg.strip_prefix(STR).unwrap().to_string(),
        });
    }
    if tk.starts_with(STR) {
        p_eat(toks, p, None)?;
        return Ok(Node::Str(tk.strip_prefix(STR).unwrap().to_string()));
    }
    if tk.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        p_eat(toks, p, None)?;
        return Ok(Node::Num(tk.parse::<f64>().unwrap_or(f64::NAN)));
    }
    if tk.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false) {
        p_eat(toks, p, None)?;
        return Ok(Node::Field(tk));
    }
    if tk == "(" {
        p_eat(toks, p, Some("("))?;
        let n = parse_or(toks, p)?;
        p_eat(toks, p, Some(")"))?;
        return Ok(n);
    }
    Err(format!("意外的 token '{tk}'"))
}

#[derive(Debug, Clone)]
enum Value {
    Str(String),
    Num(f64),
    Bool(bool),
}

fn field_value(ev: &SeqEvent, name: &str) -> Result<Value, ()> {
    match name {
        "raw" => Ok(Value::Str(ev.raw.clone())),
        "msg" | "message" => Ok(Value::Str(ev.message.clone())),
        "thread" => Ok(Value::Str(ev.thread.clone().unwrap_or_default())),
        "level" => Ok(Value::Str(ev.level.clone().unwrap_or_default())),
        "ts" => Ok(Value::Num(ev.ts as f64)),
        "sourceFile" | "file" => Ok(Value::Str(ev.source_file.clone().unwrap_or_default())),
        _ => Err(()),
    }
}

fn to_num(v: &Value) -> f64 {
    match v {
        Value::Num(n) => *n,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Str(s) => s.parse::<f64>().unwrap_or(f64::NAN),
    }
}

fn to_bool(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Num(n) => *n != 0.0,
        Value::Str(s) => !s.is_empty(),
    }
}

fn eval_node(n: &Node, ev: &SeqEvent) -> Result<Value, ()> {
    match n {
        Node::Or(l, r) => Ok(Value::Bool(to_bool(&eval_node(l, ev)?) || to_bool(&eval_node(r, ev)?))),
        Node::And(l, r) => Ok(Value::Bool(to_bool(&eval_node(l, ev)?) && to_bool(&eval_node(r, ev)?))),
        Node::Cmp { op, l, r } => {
            let a = eval_node(l, ev)?;
            let b = eval_node(r, ev)?;
            let res = match *op {
                "==" => match (&a, &b) {
                    (Value::Num(x), Value::Num(y)) => x == y,
                    (Value::Str(x), Value::Str(y)) => x == y,
                    (Value::Bool(x), Value::Bool(y)) => x == y,
                    _ => false,
                },
                "!=" => match (&a, &b) {
                    (Value::Num(x), Value::Num(y)) => x != y,
                    (Value::Str(x), Value::Str(y)) => x != y,
                    (Value::Bool(x), Value::Bool(y)) => x != y,
                    _ => true,
                },
                ">" => to_num(&a) > to_num(&b),
                "<" => to_num(&a) < to_num(&b),
                ">=" => to_num(&a) >= to_num(&b),
                "<=" => to_num(&a) <= to_num(&b),
                _ => false,
            };
            Ok(Value::Bool(res))
        }
        Node::Str(s) => Ok(Value::Str(s.clone())),
        Node::Num(n) => Ok(Value::Num(*n)),
        Node::Field(name) => field_value(ev, name),
        Node::MCall { method, field, arg } => {
            let target = match field_value(ev, field) {
                Ok(Value::Str(s)) => s,
                _ => return Err(()),
            };
            let res = match method.as_str() {
                "includes" | "contains" => target.contains(arg),
                "startsWith" => target.starts_with(arg),
                "endsWith" => target.ends_with(arg),
                _ => return Err(()),
            };
            Ok(Value::Bool(res))
        }
    }
}

/// 编译表达式：返回 `(ev) -> bool`。空串/非法表达式返回 `None`（调用方按「不过滤」处理）。
pub fn compile_expr(src: &str) -> Option<Box<dyn Fn(&SeqEvent) -> bool>> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return None;
    }
    let ast = parse_expr(trimmed).ok()?;
    if !check_fields(&ast) {
        return None;
    }
    Some(Box::new(move |ev: &SeqEvent| {
        eval_node(&ast, ev).map(|v| to_bool(&v)).unwrap_or(false)
    }))
}

/// 语法校验：合法返回 None，否则返回错误信息。
pub fn validate_expr(src: &str) -> Option<String> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return None;
    }
    parse_expr(trimmed).err()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cep::SeqEvent;

    fn ev(raw: &str, msg: &str, thread: Option<&str>, level: Option<&str>) -> SeqEvent {
        SeqEvent {
            id: 0,
            ts: 1000,
            raw: raw.into(),
            message: msg.into(),
            thread: thread.map(|s| s.into()),
            level: level.map(|s| s.into()),
            source_file: None,
        }
    }

    #[test]
    fn level_eq() {
        let e = ev("x", "boom", None, Some("E"));
        let p = compile_expr("level == 'E'").unwrap();
        assert!(p(&e));
        let p2 = compile_expr("level == 'W'").unwrap();
        assert!(!p2(&e));
    }

    #[test]
    fn msg_includes() {
        let e = ev("x", "IPC timeout happened", None, None);
        let p = compile_expr("msg.includes('IPC')").unwrap();
        assert!(p(&e));
        let p2 = compile_expr("message.contains('timeout')").unwrap();
        assert!(p2(&e));
    }

    #[test]
    fn thread_and_or() {
        let e = ev("x", "m", Some("pool-4"), None);
        let p = compile_expr("thread == 'pool-4' || level == 'E'").unwrap();
        assert!(p(&e));
        let p2 = compile_expr("thread != 'pool-4'").unwrap();
        assert!(!p2(&e));
    }

    #[test]
    fn ts_numeric() {
        let e = ev("x", "m", None, None);
        let p = compile_expr("ts >= 500").unwrap();
        assert!(p(&e));
        let p2 = compile_expr("ts < 500").unwrap();
        assert!(!p2(&e));
    }

    #[test]
    fn invalid_is_none() {
        assert!(compile_expr("").is_none());
        assert!(compile_expr("level == ").is_none());
        assert!(compile_expr("unknownField == 'x'").is_none());
    }

    #[test]
    fn precedence_and_or() {
        // a && b || c 应解析为 (a && b) || c
        let e = ev("x", "m", Some("t1"), Some("W"));
        let p = compile_expr("thread == 't1' && level == 'W' || level == 'E'").unwrap();
        assert!(p(&e));
    }
}
