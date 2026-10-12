/**
 * 最近/收藏项目条目行（欢迎页 / 工具栏「最近」菜单共用）。
 * 整行点击重新打开；☆ 收藏切换；× 按所在区删除（最近区已收藏行的 × 只删最近条目）。
 */
import { openRecentProject } from '../io/openLogFlow';
import {
  removeFavoriteProject,
  removeRecentProject,
  toggleFavoriteProject,
  type ProjectEntry,
} from '../io/recentProjects';
import { formatRelativeTime } from '../utils/timeFormat';
import { FileText, Folder } from './Icon';
import styles from './ProjectRow.module.css';

export function ProjectRow({
  entry,
  fav,
  section,
  onChange,
  onOpened,
}: {
  entry: ProjectEntry;
  /** 是否已被收藏（决定 ☆/★ 显示与 toggle 语义） */
  fav: boolean;
  /** 行所在的列表：× 按区块删除，而非按收藏状态 */
  section: 'fav' | 'recent';
  /** 任何列表变更（收藏/删除）后回调，调用方刷新列表 */
  onChange: () => void;
  /** 整行打开完成后回调（ok = 是否走到了载入），菜单据此收起 */
  onOpened?: (ok: boolean) => void;
}) {
  const open = async () => {
    const ok = await openRecentProject(entry);
    onChange();
    onOpened?.(ok);
  };
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await toggleFavoriteProject(entry.id);
    onChange();
  };
  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (section === 'fav') await removeFavoriteProject(entry.id);
    else await removeRecentProject(entry.id);
    onChange();
  };
  return (
    <div
      className={styles.row}
      onClick={() => void open()}
      title={entry.path ?? `${entry.kind === 'dir' ? '目录' : '文件'}（浏览器句柄）`}
    >
      {entry.kind === 'dir' ? <Folder size={13} /> : <FileText size={13} />}
      <span className={styles.name}>{entry.name}</span>
      <span className={styles.meta}>
        {entry.path ?? (entry.kind === 'dir' ? '目录' : '文件')} · {formatRelativeTime(entry.openedAt)}
      </span>
      <button
        className={styles.star}
        onClick={(e) => void toggle(e)}
        title={fav ? '取消收藏' : '收藏到收藏夹'}
      >
        {fav ? '★' : '☆'}
      </button>
      <button
        className={styles.del}
        onClick={(e) => void remove(e)}
        title={section === 'fav' ? '从收藏夹移除' : '从最近打开移除'}
      >
        ×
      </button>
    </div>
  );
}
