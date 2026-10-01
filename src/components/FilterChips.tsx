import { useLogStore } from '../store/logStore';
import styles from './FilterChips.module.css';

export function FilterChips() {
  const filters = useLogStore((s) => s.filters);
  const matches = useLogStore((s) => s.matches);
  const updateFilter = useLogStore((s) => s.updateFilter);

  if (filters.length === 0) return null;

  return (
    <div className={styles.chipBar}>
      {filters.map((f) => {
        const m = matches.find((x) => x.filterId === f.id);
        // 关闭的过滤器不参与匹配，count 会是 0——显示成 0 会被误读成「这条没命中」，
        // 所以关态显示「—」（意为未统计），开态才显示真实命中数
        const count = f.enabled ? (m?.events.length ?? 0) : null;
        return (
          <button
            key={f.id}
            className={`${styles.chip} ${f.enabled ? '' : styles.chipOff}`}
            onClick={() => updateFilter(f.id, { enabled: !f.enabled })}
            aria-pressed={f.enabled}
            title={
              f.enabled
                ? `点击隐藏「${f.label}」（当前命中 ${count ?? 0} 条）`
                : `点击显示「${f.label}」`
            }
          >
            <span className={styles.dot} style={{ background: f.color }} />
            <span className={styles.label}>{f.label}</span>
            <span className={styles.count}>{count ?? '—'}</span>
          </button>
        );
      })}
    </div>
  );
}
