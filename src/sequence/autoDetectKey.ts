/**
 * 自动发现关联键 —— 纯前端嗅探（零 engine 改动）。
 *
 * 关联键 = 一整个请求/事务内保持不变的字段（traceId/requestId/spanId…），
 * 从日志原文 raw（或正文）以 `field=value` / `"field":"value"` 等形态出现。
 *
 * 设计取向：**宁可不关联，也不乱关联**。本模块在用户未配置任何 scope='key'
 * 规则时兜底启用（`detectCorrelationKey`），扫描候选字段，按
 * 「覆盖率 × 值形态 × 键基数」打分，只把高置信候选判为可用——
 * - 覆盖率过低（字段只在零散几行出现）⇒ 不可信；
 * - 键基数 = 1（所有事件同一个值）⇒ 是常量不是关联键；
 * - 键基数 ≈ 全命中数（每个事件一个键）⇒ 粒度太细，分桶即全漏；
 * - 值形态不成立（太短/无数字/像普通词）⇒ 疑似误配。
 */

import type { LogEvent } from '../types';

export interface AutoKeyCandidate {
  /** 字段名，如 traceId */
  fieldName: string;
  /** 可用的 keyPattern（含 1 捕获组，供 scope='key' 使用），如 traceId=([^\s,"']+) */
  keyPattern: string;
  /** 命中的事件占比（0~1） */
  coverage: number;
  /** 不同键值数（键基数） */
  distinctKeys: number;
  /** 0~1 置信度；>= CONFIDENT_THRESHOLD 视为可应用 */
  confidence: number;
}

/** 字段白名单：只认这些已知关联键字段名，避免把任意字段当键 */
const KNOWN_FIELDS = [
  'traceId',
  'trace_id',
  'requestId',
  'request_id',
  'request-id',
  'X-Request-Id',
  'X-B3-TraceId',
  'x-b3-traceid',
  'spanId',
  'span_id',
  'correlationId',
  'correlation_id',
] as const;

/** 置信度下限：超过才算「可用」 */
export const CONFIDENT_THRESHOLD = 0.5;
/** 覆盖率下限：字段命中事件占比低于它则不可信 */
export const MIN_COVERAGE = 0.2;
/** 键基数下限：>=2 才有分桶价值（=1 是常量） */
export const MIN_DISTINCT = 2;
/** 「distinct≈命中数=过细」要成立的最小样本：小样本下每行一个键是正常的 */
const MIN_GRANULAR_SAMPLE = 8;
/** 一次嗅探最多扫的事件数（超大量语料抽样，避免 load 时 O(N×字段) 过慢） */
export const MAX_SNIFF_SAMPLE = 20_000;

/** 抽样：超大量时按跨距均匀取，覆盖全语料但限总扫描量 */
function sampleEvents(events: LogEvent[]): LogEvent[] {
  if (events.length <= MAX_SNIFF_SAMPLE) return events;
  const stride = Math.ceil(events.length / MAX_SNIFF_SAMPLE);
  const out: LogEvent[] = [];
  for (let i = 0; i < events.length; i += stride) out.push(events[i]);
  return out;
}

/**
 * 值形态校验：关联键值应像一个 ID，而不是普通词/短标记。
 * 命中任一形态即通过（大写 hex 或数字或足够长的混合串）。
 */
function isPlausibleKeyValue(v: string): boolean {
  if (v.length === 0 || v.length > 128) return false;
  // UUID 形态：8-4-4-4-12 hex
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  // 纯 hex，>=8 位（如 f00dcafe / 32 位 md5）
  if (/^[0-9a-f]{8,}$/i.test(v)) return true;
  // 纯数字，>=8 位（雪花/毫秒时间戳）
  if (/^\d{8,}$/.test(v)) return true;
  // 混合字母数字（可含 - _），>=12 位且至少含 1 个数字 ⇒ 像 token/id
  if (/^[0-9a-zA-Z_-]{12,}$/.test(v) && /\d/.test(v)) return true;
  return false;
}

/** 转义字段名以安全嵌入正则字面量 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 某字段在 raw 上的提取正则：field=value 或 "field":"value"，捕获组取 value */
function fieldRe(field: string): RegExp {
  return new RegExp(
    `(?:^|[\\s"'\\[,])${esc(field)}(?:=|:)\\s*"([^"]*)"|(?:^|[\\s"'\\[,])${esc(field)}(?:=|:)\\s*([^\\s,"'\\]]+)`,
    'gi',
  );
}

/**
 * 从全部事件里嗅探关联键候选，按置信度降序返回。
 * @param events 已加载的日志事件（用 raw 原文；无 raw 则退而用 message）
 * @returns 排序后的候选；无任何可用候选时返回空数组
 */
export function detectCorrelationKey(events: LogEvent[]): AutoKeyCandidate[] {
  if (!events || events.length === 0) return [];
  const sample = sampleEvents(events);
  const total = sample.length;
  const candidates: AutoKeyCandidate[] = [];

  for (const field of KNOWN_FIELDS) {
    const re = fieldRe(field);
    const values = new Set<string>();
    let hits = 0;

    for (const ev of sample) {
      const src = ev.raw ?? ev.message ?? '';
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const v = (m[1] ?? m[2] ?? '').trim();
        if (v && isPlausibleKeyValue(v)) {
          hits++;
          values.add(v);
          // 同一行只计一次命中（一个事件一个关联键值）
          break;
        }
      }
    }

    if (hits === 0) continue;

    const coverage = hits / total;
    const distinct = values.size;
    // 键基数因子：基数越大越可信；但「distinct≈全命中」且样本够大 ⇒ 每事件一键=过度分桶
    let distinctFactor: number;
    if (distinct < MIN_DISTINCT) distinctFactor = 0; // 常量，无分桶价值
    else {
      const granular = distinct >= hits && hits >= MIN_GRANULAR_SAMPLE;
      if (granular) distinctFactor = 0.15; // 样本够大仍每事件一键 ⇒ 粒度太细
      else if (distinct <= 5) distinctFactor = 0.5 + 0.1 * (distinct - MIN_DISTINCT);
      else distinctFactor = 0.8 + Math.min(0.2, 0.02 * distinct); // 基数 5 后缓升，封顶 1.0
    }

    // 形状因子：值形态通过=1.0（isPlausibleKeyValue 已在提取时把关），
    // 这里对「UUID / 纯 hex」再给一点额外可信加成
    const shapeBonus = Array.from(values).every((v) => /^[0-9a-f-]{8,}$/i.test(v)) ? 1.1 : 1.0;

    const confidence = Math.min(1, coverage * distinctFactor * shapeBonus);
    if (coverage < MIN_COVERAGE) continue; // 覆盖率硬门槛

    candidates.push({
      fieldName: field,
      keyPattern: `${field}=([^\\s,"']+)`,
      coverage,
      distinctKeys: distinct,
      confidence,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || b.coverage - a.coverage);
  return candidates;
}

/**
 * 取当前事件集的高置信关联键候选（不做任何 group/手配检查）。
 * 供 store 在 load 时一次性嗅探并缓存；null = 无可用候选。
 */
export function sniffAutoKey(events: LogEvent[]): AutoKeyCandidate | null {
  const top = detectCorrelationKey(events)[0];
  return top && top.confidence >= CONFIDENT_THRESHOLD ? top : null;
}

/**
 * 顶层的「当前应自动应用的关联键」：若用户已配任何 scope='key' 规则则返回 null
 * （不干预手配规则）；否则取置信候选第一（>= 门槛者）。
 * @returns 可自动应用的候选，或 null
 */
export function pickAutoKey(
  groups: { sequence?: { scope?: string; keyPattern?: string } }[],
  events: LogEvent[],
): AutoKeyCandidate | null {
  const hasManualKey = groups.some(
    (g) => g.sequence?.scope === 'key' && g.sequence.keyPattern,
  );
  if (hasManualKey) return null; // 已有手配规则，不兜底介入
  const top = detectCorrelationKey(events)[0];
  return top && top.confidence >= CONFIDENT_THRESHOLD ? top : null;
}
