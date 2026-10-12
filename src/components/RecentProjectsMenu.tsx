/**
 * 工具栏「最近项目」下拉：已载入日志时也能切换 / 收藏 / 管理最近项目。
 * 弹层 createPortal 到 body + fixed（避开 Toolbar backdrop-filter 的层叠上下文，
 * 与 RangeChips 编辑器同策略）；打开时刷新列表，外点 / Esc 关闭，打开成功即收起。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listFavoriteProjects, listRecentProjects, type ProjectEntry } from '../io/recentProjects';
import { Clock, ChevronDown } from './Icon';
import { ProjectRow } from './ProjectRow';
import styles from './RecentProjectsMenu.module.css';

const POPOVER_W = 380;

export function RecentProjectsMenu() {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<ProjectEntry[] | null>(null);
  const [favs, setFavs] = useState<ProjectEntry[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    void listRecentProjects().then(setRecents);
    void listFavoriteProjects().then(setFavs);
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    const place = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({
        left: Math.min(Math.max(8, rect.left), window.innerWidth - POPOVER_W - 8),
        top: rect.bottom + 8,
      });
    };
    place();
    const onDocDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null;
      if (t && (btnRef.current?.contains(t) || popRef.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const closeOnOpened = useCallback((ok: boolean) => {
    if (ok) setOpen(false);
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        className="ghost"
        onClick={() => setOpen((v) => !v)}
        title="最近项目 / 收藏夹：切换、收藏、管理"
      >
        <Clock size={14} />
        最近
        <ChevronDown size={11} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div ref={popRef} className={styles.popover} style={{ left: pos.left, top: pos.top }}>
            {favs.length > 0 && (
              <section className={styles.section}>
                <div className={styles.sectionTitle}>项目收藏夹</div>
                {favs.map((e) => (
                  <ProjectRow
                    key={e.id}
                    entry={e}
                    fav
                    section="fav"
                    onChange={refresh}
                    onOpened={closeOnOpened}
                  />
                ))}
              </section>
            )}
            <section className={styles.section}>
              <div className={styles.sectionTitle}>最近打开</div>
              {(recents?.length ?? 0) > 0 ? (
                recents!.map((e) => (
                  <ProjectRow
                    key={e.id}
                    entry={e}
                    fav={favs.some((f) => f.id === e.id)}
                    section="recent"
                    onChange={refresh}
                    onOpened={closeOnOpened}
                  />
                ))
              ) : (
                <div className={styles.empty}>
                  还没有最近打开的项目——用「打开日志」或拖入文件 / 文件夹开始
                </div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
