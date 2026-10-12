import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatDateTime, formatDuration, parseDateTime } from '../utils/timeFormat';
import type { SavedRange } from '../types';
import styles from './RangeChips.module.css';

/** 编辑中表单值（时间戳以文本形态编辑，保存时统一解析校验） */
interface EditState {
  id: string;
  name: string;
  start: string;
  end: string;
}

/**
 * 范围书签条（statusbar 常驻）：保存的时间范围平铺为 chips，
 * 单击切换视口（表格流/时间线同步）、当前激活项高亮、✎ 重命名/改时间戳、
 * × 删除、＋ 保存当前视口（保存后立即进入编辑，方便随手命名）。
 * 时间线 Shift 框选后随手「＋」即可收藏；缩放/平移后高亮自动取消。
 */
export function RangeChips() {
  const viewRange = useLogStore((s) => s.viewRange);
  const savedRanges = useLogStore((s) => s.savedRanges);
  const activeSavedRangeId = useLogStore((s) => s.activeSavedRangeId);
  const saveRange = useLogStore((s) => s.saveRange);
  const applySavedRange = useLogStore((s) => s.applySavedRange);
  const removeSavedRange = useLogStore((s) => s.removeSavedRange);
  const updateSavedRange = useLogStore((s) => s.updateSavedRange);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 打开编辑器时聚焦并全选名称
  useEffect(() => {
    if (edit) nameRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id]);

  // 编辑目标被删除（他处同步）时退出编辑态
  useEffect(() => {
    if (edit && !savedRanges.some((r) => r.id === edit.id)) {
      setEdit(null);
      setError(null);
    }
  }, [savedRanges, edit]);

  const startEdit = (r: SavedRange) => {
    setError(null);
    setEdit({ id: r.id, name: r.name, start: formatDateTime(r.start), end: formatDateTime(r.end) });
  };

  const closeEdit = () => {
    setEdit(null);
    setError(null);
  };

  const saveEdit = () => {
    if (!edit) return;
    const start = parseDateTime(edit.start);
    const end = parseDateTime(edit.end, start ?? undefined);
    if (start === null) {
      setError('开始时间无法识别（支持 2024-01-01 09:00:00.123 / 09:00:00 / 毫秒整数）');
      return;
    }
    if (end === null) {
      setError('结束时间无法识别（格式同开始时间）');
      return;
    }
    if (end <= start) {
      setError('开始必须早于结束');
      return;
    }
    if (!updateSavedRange(edit.id, { name: edit.name, start, end })) {
      setError('名称不能为空');
      return;
    }
    closeEdit();
  };

  const onEditKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveEdit();
    else if (e.key === 'Escape') closeEdit();
  };

  // 实时时长预览（合法才显示）
  const parsedStart = edit === null ? null : parseDateTime(edit.start);
  const parsedEnd = edit === null ? null : parseDateTime(edit.end, parsedStart ?? undefined);
  const durationOk = parsedStart !== null && parsedEnd !== null && parsedEnd > parsedStart;

  const save = () => {
    if (!viewRange) return;
    // 自动递增不重名（范围 1、范围 2…），保存后立即进入编辑便于命名/改时间戳
    const names = new Set(savedRanges.map((r) => r.name));
    let n = savedRanges.length + 1;
    while (names.has(`范围 ${n}`)) n++;
    const item = saveRange(`范围 ${n}`);
    if (item) startEdit(item);
  };

  return (
    <div className={styles.root}>
      <div className={styles.wrap}>
        {savedRanges.map((r) => (
          <span
            key={r.id}
            className={`${styles.chip} ${r.id === activeSavedRangeId ? styles.active : ''} ${
              edit?.id === r.id ? styles.editing : ''
            }`}
          >
            <button
              className={styles.apply}
              onClick={() => applySavedRange(r.id)}
              title={`切换到：${formatDateTime(r.start)} → ${formatDateTime(r.end)}（${formatDuration(r.end - r.start)}）`}
            >
              {r.name}
            </button>
            <button
              className={styles.editBtn}
              onClick={() => (edit?.id === r.id ? closeEdit() : startEdit(r))}
              title={`重命名 / 修改时间戳：${r.name}`}
            >
              ✎
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

      {edit && (
        <div className={styles.editor}>
          <div className={styles.field}>
            <label>名称</label>
            <input
              ref={nameRef}
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              onKeyDown={onEditKey}
              placeholder="范围名称"
            />
          </div>
          <div className={styles.field}>
            <label>开始</label>
            <input
              className={styles.ts}
              value={edit.start}
              onChange={(e) => setEdit({ ...edit, start: e.target.value })}
              onKeyDown={onEditKey}
              spellCheck={false}
              placeholder="2024-01-01 09:00:00.000"
            />
          </div>
          <div className={styles.field}>
            <label>结束</label>
            <input
              className={styles.ts}
              value={edit.end}
              onChange={(e) => setEdit({ ...edit, end: e.target.value })}
              onKeyDown={onEditKey}
              spellCheck={false}
              placeholder="2024-01-01 09:00:27.000"
            />
          </div>
          {error ? (
            <div className={styles.err}>{error}</div>
          ) : (
            <div className={styles.hint}>
              {durationOk
                ? `时长 ${formatDuration(parsedEnd - parsedStart)}`
                : '格式：2024-01-01 09:00:00.123，也可只填 09:00:00（沿用日期）或毫秒整数'}
            </div>
          )}
          <div className={styles.actions}>
            <button className={styles.primary} onClick={saveEdit}>
              保存
            </button>
            <button onClick={closeEdit}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
