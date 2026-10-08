/**
 * 空状态引导。
 *
 * 原来这里只有一行「打开日志文件并添加过滤器以开始」，
 * 新用户拿到的是一张白板：不知道能拖什么、也不知道下一步该点哪儿。
 * 这里把「入口」直接摆出来——三个主操作 + 格式说明 + 快捷键线索。
 */
import { useLogStore, selectEventCount } from '../store/logStore';
import { openSingleLogFile, openLogDirectory } from '../io/openLogFlow';
import { FileText, Folder, Plus, Search } from './Icon';
import styles from './EmptyState.module.css';

/** 未载入任何日志：主引导页 */
export function WelcomeState() {
  const addFilter = useLogStore((s) => s.addFilter);
  const setEditingFilterId = useLogStore((s) => s.setEditingFilterId);
  const persistSupported = useLogStore((s) => s.persistSupported);

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.mark} aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 13h4l2-6 3 10 2-8 1.5 4H21"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1 className={styles.title}>把日志拖进来，或者选个入口开始</h1>
        <p className={styles.sub}>
          支持多过滤器并行：每条过滤器一条独立轨道，共享同一根时间轴，
          跨轨道的垂直对齐就是时间上的关联。
        </p>

        <div className={styles.actions}>
          <button className="primary" onClick={() => void openSingleLogFile()}>
            <FileText size={14} />
            打开日志文件
          </button>
          {persistSupported && (
            <button className="ghost" onClick={() => void openLogDirectory()}>
              <Folder size={14} />
              打开日志目录
            </button>
          )}
        </div>

        <div className={styles.divider}>
          <span>也支持直接拖放</span>
        </div>
        <p className={styles.dropHint}>
          把 <code>.log</code> / <code>.txt</code> / <code>.out</code> / <code>.csv</code> /{' '}
          <code>.tsv</code> 文件或整个文件夹拖到窗口任意位置即可加载
        </p>

        <div className={styles.tips}>
          <span className={styles.tip}>
            随时按 <kbd className={styles.kbd}>Ctrl</kbd>
            <span className={styles.plus}>+</span>
            <kbd className={styles.kbd}>K</kbd> 唤出命令面板
          </span>
          <span className={styles.tipSep} />
          <button
            className={styles.linkBtn}
            onClick={() => {
              const id = addFilter();
              setEditingFilterId(id);
            }}
          >
            <Plus size={12} />
            先建一个过滤器
          </button>
        </div>
      </div>
    </div>
  );
}

/** 已载入日志但没有任何可见过滤器：次级引导 */
export function NoFilterState() {
  const addFilter = useLogStore((s) => s.addFilter);
  const setEditingFilterId = useLogStore((s) => s.setEditingFilterId);
  const total = useLogStore(selectEventCount);

  const quick = (label: string, pattern: string, color: string) => {
    const id = addFilter({ label, pattern, isRegex: true, color });
    setEditingFilterId(id);
  };

  return (
    <div className={styles.compact}>
      <div className={styles.compactIcon} aria-hidden="true">
        <Search size={22} />
      </div>
      <div className={styles.compactTitle}>还没有过滤器</div>
      <div className={styles.compactSub}>
        已载入 {total.toLocaleString()} 条事件。每条过滤器对应一条轨道，
        匹配结果按时间对齐显示——这是看到多条日志之间关联的前提。
      </div>
      <div className={styles.compactActions}>
        <button className="primary" onClick={() => void quick('ERROR', '\\b(ERROR|FATAL)\\b', '#d55e00')}>
          <Plus size={13} />
          过滤 ERROR
        </button>
        <button className="ghost" onClick={() => void quick('WARN', '\\b(WARN|WARNING)\\b', '#e69f00')}>
          <Plus size={13} />
          过滤 WARN
        </button>
        <button
          className="ghost"
          onClick={() => {
            const id = addFilter();
            setEditingFilterId(id);
          }}
        >
          <Plus size={13} />
          空白过滤器
        </button>
      </div>
      <div className={styles.compactHint}>
        也可以按 <kbd className={styles.kbd}>Ctrl</kbd>
        <span className={styles.plus}>+</span>
        <kbd className={styles.kbd}>K</kbd> 在命令面板里操作
      </div>
    </div>
  );
}
