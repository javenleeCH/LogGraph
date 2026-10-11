import { useLogStore } from '../store/logStore';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import styles from './RangeChips.module.css';

/**
 * 范围书签条（statusbar 常驻）：保存的时间范围平铺为 chips，
 * 单击切换视口（表格流/时间线同步）、当前激活项高亮、× 删除、＋ 保存当前视口。
 * 时间线 Shift 框选后随手「＋」即可收藏；缩放/平移后高亮自动取消。
 */
export function RangeChips() {
  const viewRange = useLogStore((s) => s.viewRange);
  const savedRanges = useLogStore((s) => s.savedRanges);
  const activeSavedRangeId = useLogStore((s) => s.activeSavedRangeId);
  const saveRange = useLogStore((s) => s.saveRange);
  const applySavedRange = useLogStore((s) => s.applySavedRange);
  const removeSavedRange = useLogStore((s) => s.removeSavedRange);

  const save = () => {
    if (!viewRange) return;
    // 自动递增不重名（范围 1、范围 2…）
    const names = new Set(savedRanges.map((r) => r.name));
    let n = savedRanges.length + 1;
    while (names.has(`范围 ${n}`)) n++;
    saveRange(`范围 ${n}`);
  };

  return (
    <div className={styles.wrap}>
      {savedRanges.map((r) => (
        <span
          key={r.id}
          className={`${styles.chip} ${r.id === activeSavedRangeId ? styles.active : ''}`}
        >
          <button
            className={styles.apply}
            onClick={() => applySavedRange(r.id)}
            title={`切换到：${formatDateTime(r.start)} → ${formatDateTime(r.end)}（${formatDuration(r.end - r.start)}）`}
          >
            {r.name}
          </button>
          <button
            className={styles.del}
            onClick={() => removeSavedRange(r.id)}
            title={`删除「${r.name}」`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className={styles.add}
        onClick={save}
        disabled={!viewRange}
        title={
          viewRange
            ? `保存当前视口为范围（${formatDateTime(viewRange.start)} → ${formatDateTime(viewRange.end)}）`
            : '无数据'
        }
      >
        ＋
      </button>
    </div>
  );
}
