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
        const count = m?.events.length ?? 0;
        return (
          <button
            key={f.id}
            className={`${styles.chip} ${f.enabled ? '' : styles.chipOff}`}
            onClick={() => updateFilter(f.id, { enabled: !f.enabled })}
            title={f.enabled ? `点击隐藏「${f.label}」` : `点击显示「${f.label}」`}
          >
            <span className={styles.dot} style={{ background: f.color }} />
            <span className={styles.label}>{f.label}</span>
            <span className={styles.count}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
