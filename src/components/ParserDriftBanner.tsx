import { useEffect, useState } from 'react';

interface DriftDetail {
  diffs: string[];
  rust: number;
  js: number;
}

/**
 * 解析引擎漂移告警横幅。
 *
 * 监听 parseBridge 派发的 `loggraph:parser-drift` 事件（仅 dev 构建或
 * `?dualengine=1` 自检发现 Rust/JS 解析不一致时派发），在顶部给出非阻塞提示。
 * 这是 P0 项 1.3「解析器漂移」的可观测化：把原本只打 console.error 的自检
 * 变成用户可见的告警（web-desktop-consistency-review.md §1.3）。
 */
export function ParserDriftBanner() {
  const [info, setInfo] = useState<DriftDetail | null>(null);

  useEffect(() => {
    const onDrift = (e: Event) => {
      const detail = (e as CustomEvent<DriftDetail>).detail;
      if (detail && Array.isArray(detail.diffs)) setInfo(detail);
    };
    window.addEventListener('loggraph:parser-drift', onDrift as EventListener);
    return () =>
      window.removeEventListener('loggraph:parser-drift', onDrift as EventListener);
  }, []);

  if (!info) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: 'var(--danger, #e5484d)',
        color: '#fff',
        fontSize: 12,
        lineHeight: 1.4,
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>⚠ 解析引擎不一致</span>
      <span style={{ flex: 1 }}>
        Rust 与 JS 解析结果存在差异（已按 Rust 继续）：{info.diffs.join('；')}
        （Rust 事件 {info.rust} / JS 事件 {info.js}）。请检查两端解析器对齐情况。
      </span>
      <button
        onClick={() => setInfo(null)}
        style={{
          background: 'rgba(255,255,255,0.2)',
          border: 'none',
          color: '#fff',
          borderRadius: 6,
          padding: '3px 10px',
          cursor: 'pointer',
          fontSize: 12,
          whiteSpace: 'nowrap',
        }}
      >
        知道了
      </button>
    </div>
  );
}
