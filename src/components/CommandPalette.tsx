/**
 * ⌘K 命令面板（Command Palette）
 *
 * 把散落在工具栏 / 侧栏 / 各个面板里的操作收敛到一个可搜索入口，
 * 键盘用户无需移动鼠标即可完成绝大多数高频任务。
 *
 * - Ctrl/Cmd+K 开关面板
 * - ↑↓ 选择，Enter 执行，Esc 关闭
 * - 支持中文子串模糊匹配 + 英文关键词匹配
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useLogStore } from '../store/logStore';
import { clearFiltersWithUndo } from '../store/undoable';
import { beginBusy, toast } from '../store/uiStore';
import { toggleTheme } from '../hooks/useTheme';
import { openSingleLogFile, openLogDirectory } from '../io/openLogFlow';
import {
  FileText,
  Folder,
  FolderOpen,
  Table,
  BarChart,
  Plus,
  Maximize,
  Save,
  Keyboard,
  Search,
  Type,
  Copy,
  ChevronUp,
} from './Icon';
import {
  copySelectedChainMarkdown,
  copySelectedEventMarkdown,
  exportMatchesMarkdown,
  exportRulesFile,
  importRulesFile,
} from '../io/exportActions';
import { RULE_TEMPLATES, createGroupFromTemplate } from '../sequence/templates';
import { checkForUpdate } from '../io/updater';
import { OPEN_TS_FORMAT_EVENT } from './TimestampFormatEditor';
import styles from './CommandPalette.module.css';

/* ============================ 开合状态 ============================ */

interface PaletteState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
  toggle: () => set({ open: !get().open }),
}));

/** 供任意组件调用：打开命令面板 */
export function openCommandPalette() {
  usePaletteStore.getState().setOpen(true);
}

/** 供 Toolbar 按钮使用的 setter hook */
export function useCommandPalette() {
  return usePaletteStore((s) => s.setOpen);
}

/**
 * 复制当前选中行的原始文本。
 * 全局快捷键与命令面板共用这一份实现，避免两处逻辑漂移。
 */
async function copySelectedRawLine() {
  const st = useLogStore.getState();
  const id = st.selectedEventId;
  if (id === null) {
    toast.warn('尚未选中任何日志行');
    return;
  }
  const raw = await getRawLine(id);
  await copyWithFallback(raw, {
    successTitle: '已复制原始行',
    successDetail: `第 ${id + 1} 行 · ${raw.length} 字符`,
    fallbackTitle: '手动复制该行',
  });
}

/* ============================ 快捷键帮助 ============================ */

const SHORTCUT_GROUPS: { name: string; items: [string, string][] }[] = [
  {
    name: '全局',
    items: [
      ['Ctrl / ⌘ + K', '打开命令面板'],
      ['?', '显示本快捷键速查表'],
      ['Esc', '关闭弹层 / 取消选中'],
    ],
  },
  {
    name: '视图导航',
    items: [
      ['W / S', '向上 / 向下滚动（Shift 加速）'],
      ['A / D', '向左 / 向右滚动（Shift 加速）'],
      ['Shift + 拖拽', '时间线框选范围：视口跳到框选区（表格流随之过滤）'],
      ['← / →', '在选中轨道内前后跳转事件'],
    ],
  },
  {
    name: '选中与详情',
    items: [
      ['Ctrl / ⌘ + C', '复制当前选中行的原始文本（无可编辑焦点、无文本选区时）'],
      ['Ctrl / ⌘ + Shift + C', '同上（桌面端别名；浏览器里可能被 DevTools 抢占）'],
      ['Ctrl / ⌘ + ↑ / ↓', '跳到上 / 下一个同级别事件'],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.helpCard}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="快捷键速查"
      >
        <div className={styles.helpHead}>
          <span>键盘快捷键</span>
          <button className={styles.iconBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className={styles.helpBody}>
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.name} className={styles.helpGroup}>
              <div className={styles.helpGroupName}>{g.name}</div>
              {g.items.map(([k, d]) => (
                <div key={k} className={styles.helpRow}>
                  <kbd className={styles.kbd}>{k}</kbd>
                  <span className={styles.helpDesc}>{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================ 命令定义 ============================ */

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  /** 额外搜索关键词（英文 / 缩写） */
  keywords?: string;
  icon?: React.ReactNode;
  run: (query: string) => void | Promise<void>;
}

import { copyWithFallback } from '../utils/copyFlow';
import { getRawLine } from '../utils/rawLine';

/** 在当前数据流里按级别向前 / 向后跳转 */
function jumpLevel(dir: -1 | 1, level: string) {
  const st = useLogStore.getState();
  const events = st.events;
  if (events.length === 0) return;
  const target = level.toUpperCase();
  const cur = st.selectedEventId;
  let idx = cur === null ? -1 : events.findIndex((e) => e.id === cur);
  const n = events.length;
  for (let step = 1; step <= n; step++) {
    const i = dir === 1 ? idx + step : idx - step;
    if (i < 0 || i >= n) break;
    if ((events[i].level ?? '').toUpperCase() === target) {
      st.selectEvent(events[i].id);
      toast.info(`跳转到 ${level} 事件`, `第 ${events[i].id + 1} 行`);
      return;
    }
  }
  toast.info(`没有更多 ${level} 事件`, '当前文件中找不到其他匹配级别的日志行');
}

function buildCommands(ctx: { closeAll: () => void }): Command[] {
  const commands: Command[] = [];

  /* —— 文件 —— */
  commands.push({
    id: 'file.open',
    group: '文件',
    label: '打开日志文件…',
    hint: '选择单个 .log / .txt / .out / .csv / .tsv 文件',
    keywords: 'open file 打开 文件',
    icon: <FileText size={14} />,
    run: () => {
      ctx.closeAll();
      void openSingleLogFile();
    },
  });
  commands.push({
    id: 'file.opendir',
    group: '文件',
    label: '打开日志目录（工作区）…',
    hint: '绑定目录，浏览全部日志并把状态存入 .logGraph',
    keywords: 'open folder directory workspace 目录 文件夹 工作区',
    icon: <Folder size={14} />,
    run: () => {
      ctx.closeAll();
      void openLogDirectory();
    },
  });

  commands.push({
    id: 'format.timestamp',
    group: '文件',
    label: '自定义时间格式…',
    hint: '时间戳识别不了或识别错时，用 %Y %m %d %H %M %S 自定义并重新解析',
    keywords: 'timestamp format 时间 格式 解析 自定义 reparse',
    icon: <Type size={14} />,
    run: () => {
      ctx.closeAll();
      window.dispatchEvent(new CustomEvent(OPEN_TS_FORMAT_EVENT));
    },
  });
  commands.push({
    id: 'file.save',
    group: '文件',
    label: '保存工作区状态',
    hint: '把过滤器 / 分组写入当前目录的 .logGraph',
    keywords: 'save workspace persist 保存 持久化',
    icon: <Save size={14} />,
    run: () => {
      ctx.closeAll();
      const end = beginBusy('保存工作区…');
      void useLogStore
        .getState()
        .saveFiltersNow()
        .then(() => toast.success('工作区已保存', '过滤器与分组已写入 .logGraph'))
        .catch((e: Error) => toast.error('保存失败', e.message))
        .finally(end);
    },
  });

  /* —— 导出：结论带走 / 规则带走 —— */
  commands.push({
    id: 'export.chain',
    group: '导出',
    label: '复制选中链为 Markdown',
    hint: '选中链上任一步即可，整链含文件 / 行号 / 时间，可直接贴进工单',
    keywords: 'copy export markdown chain 复制 导出 链 工单 复盘',
    icon: <Copy size={14} />,
    run: () => {
      ctx.closeAll();
      void copySelectedChainMarkdown();
    },
  });
  commands.push({
    id: 'export.event',
    group: '导出',
    label: '复制选中事件为 Markdown',
    hint: '含 文件:行号、时间、级别、线程',
    keywords: 'copy export markdown event 复制 导出 事件',
    icon: <Copy size={14} />,
    run: () => {
      ctx.closeAll();
      void copySelectedEventMarkdown();
    },
  });
  commands.push({
    id: 'export.matches',
    group: '导出',
    label: '导出当前命中为 Markdown 文件…',
    hint: '每个过滤器最多 500 条，再多人也看不过来',
    keywords: 'export markdown file 导出 命中 文件',
    icon: <FileText size={14} />,
    run: () => {
      ctx.closeAll();
      void exportMatchesMarkdown();
    },
  });
  commands.push({
    id: 'rules.export.cep',
    group: '导出',
    label: '导出规则为 .cep.json（CLI / CI 用）…',
    hint: '引擎 v1 跑不了的特性会逐条提示，绝不静默降级',
    keywords: 'export cep rules cli ci 导出 规则 流水线',
    icon: <Save size={14} />,
    run: () => {
      ctx.closeAll();
      void exportRulesFile('cep');
    },
  });
  commands.push({
    id: 'rules.export.loggraph',
    group: '导出',
    label: '导出规则为 .loggraph.json（完整，给同事）…',
    hint: '含颜色 / 折叠 / 画布坐标，GUI 之间可直接互导',
    keywords: 'export rules share backup 导出 规则 分享 备份',
    icon: <Save size={14} />,
    run: () => {
      ctx.closeAll();
      void exportRulesFile('loggraph');
    },
  });
  commands.push({
    id: 'rules.import',
    group: '导出',
    label: '导入规则文件…',
    hint: '.loggraph.json / .cep.json 自动识别（替换当前规则）',
    keywords: 'import rules 导入 规则',
    icon: <FolderOpen size={14} />,
    run: () => {
      ctx.closeAll();
      void importRulesFile();
    },
  });

  /* —— 规则模板（P1⑥：引导式创建，削平 CEP 门槛） —— */
  RULE_TEMPLATES.forEach((tpl) => {
    commands.push({
      id: `template.${tpl.id}`,
      group: '规则模板',
      label: `从模板创建：${tpl.name}`,
      hint: tpl.description,
      keywords: `template ${tpl.name} 模板 规则 创建 cep`,
      icon: <Plus size={14} />,
      run: () => {
        ctx.closeAll();
        createGroupFromTemplate(tpl);
      },
    });
  });

  /* —— 更新（自签通道，桌面端） —— */
  commands.push({
    id: 'app.checkUpdate',
    group: '更新',
    label: '检查更新…',
    hint: '从 GitHub Releases 拉取签名更新清单（minisign 自签，非代码签名证书）',
    keywords: 'update upgrade 更新 升级 版本',
    icon: <ChevronUp size={14} />,
    run: () => {
      ctx.closeAll();
      void checkForUpdate(true);
    },
  });

  /* —— 视图 —— */
  const setOrientation = (o: 'vertical' | 'horizontal') => () => {
    useLogStore.getState().setSplitOrientation(o);
    ctx.closeAll();
  };
  commands.push({
    id: 'view.table',
    group: '视图',
    label: '切换到表格流视图',
    keywords: 'table logstream 表格 列表',
    icon: <Table size={14} />,
    run: setOrientation('vertical'),
  });
  commands.push({
    id: 'view.timeline',
    group: '视图',
    label: '切换到时间线画布',
    keywords: 'timeline canvas 时间线 画布',
    icon: <BarChart size={14} />,
    run: setOrientation('horizontal'),
  });
  commands.push({
    id: 'view.reset',
    group: '视图',
    label: '重置视图为全量',
    hint: '时间窗恢复到整份日志的时间跨度',
    keywords: 'reset zoom fit 重置 全量',
    icon: <Maximize size={14} />,
    run: () => {
      useLogStore.getState().resetView();
      ctx.closeAll();
    },
  });

  /* —— 过滤器 —— */
  const addQuickFilter = (label: string, pattern: string, isRegex: boolean, color: string) => () => {
    const st = useLogStore.getState();
    const id = st.addFilter({ label, pattern, isRegex, color });
    st.setEditingFilterId(id);
    ctx.closeAll();
  };
  commands.push({
    id: 'filter.new',
    group: '过滤器',
    label: '新建过滤器…',
    hint: '把当前输入内容作为匹配模式',
    keywords: 'add create filter 新增 新建 过滤',
    icon: <Plus size={14} />,
    run: (q) => {
      const st = useLogStore.getState();
      const id = st.addFilter({ label: q ? q.slice(0, 24) : undefined, pattern: q ?? '' });
      st.setEditingFilterId(id);
      ctx.closeAll();
    },
  });
  commands.push({
    id: 'filter.search',
    group: '过滤器',
    label: '按关键词过滤当前输入内容',
    hint: '以输入文本新建文本过滤器并立即匹配',
    keywords: 'search keyword 搜索 查找',
    icon: <Search size={14} />,
    run: (q) => {
      const pattern = q.trim();
      if (!pattern) {
        toast.warn('请输入要搜索的关键词');
        return;
      }
      const st = useLogStore.getState();
      const id = st.addFilter({ label: pattern.slice(0, 24), pattern });
      st.setEditingFilterId(id);
      ctx.closeAll();
      toast.success(`已新建过滤器「${pattern.slice(0, 24)}」`);
    },
  });
  commands.push({
    id: 'filter.error',
    group: '过滤器',
    label: '快速过滤 ERROR 级别',
    keywords: 'error exception 错误 异常',
    run: addQuickFilter('ERROR', '\\b(ERROR|FATAL|CRITICAL)\\b', true, '#d55e00'),
  });
  commands.push({
    id: 'filter.warn',
    group: '过滤器',
    label: '快速过滤 WARN 级别',
    keywords: 'warn warning 警告',
    run: addQuickFilter('WARN', '\\b(WARN|WARNING)\\b', true, '#e69f00'),
  });
  commands.push({
    id: 'filter.clear',
    group: '过滤器',
    label: '删除全部过滤器',
    hint: '清空所有已配置的过滤器轨道',
    keywords: 'remove clear all 删除 清空',
    run: () => {
      ctx.closeAll();
      clearFiltersWithUndo();
    },
  });

  /* —— 导航 —— */
  commands.push({
    id: 'nav.prevError',
    group: '导航',
    label: '跳到上一个 ERROR 事件',
    keywords: 'previous error prev 上一个 错误',
    run: () => {
      ctx.closeAll();
      jumpLevel(-1, 'ERROR');
    },
  });
  commands.push({
    id: 'nav.nextError',
    group: '导航',
    label: '跳到下一个 ERROR 事件',
    keywords: 'next error 下一个 错误',
    run: () => {
      ctx.closeAll();
      jumpLevel(1, 'ERROR');
    },
  });
  commands.push({
    id: 'nav.prevWarn',
    group: '导航',
    label: '跳到上一个 WARN 事件',
    keywords: 'previous warn 上一个 警告',
    run: () => {
      ctx.closeAll();
      jumpLevel(-1, 'WARN');
    },
  });
  commands.push({
    id: 'nav.nextWarn',
    group: '导航',
    label: '跳到下一个 WARN 事件',
    keywords: 'next warn 下一个 警告',
    run: () => {
      ctx.closeAll();
      jumpLevel(1, 'WARN');
    },
  });

  /* —— 选中 —— */
  commands.push({
    id: 'sel.copy',
    group: '选中行',
    label: '复制选中行的原始文本',
    hint: 'Ctrl / ⌘ + C',
    keywords: 'copy raw line 复制 原始行',
    run: () => {
      ctx.closeAll();
      void copySelectedRawLine();
    },
  });
  commands.push({
    id: 'sel.clear',
    group: '选中行',
    label: '取消选中',
    keywords: 'clear deselect 取消 清除',
    run: () => {
      useLogStore.getState().selectEvent(null);
      ctx.closeAll();
    },
  });

  /* —— 其它 —— */
  commands.push({
    id: 'misc.theme',
    group: '外观',
    label: '切换浅色 / 暗黑主题',
    keywords: 'theme dark light 主题 暗黑 浅色',
    run: () => {
      const next = toggleTheme();
      ctx.closeAll();
      toast.info(next === 'dark' ? '已切换到暗黑主题' : '已切换到浅色主题');
    },
  });
  commands.push({
    id: 'misc.shortcuts',
    group: '外观',
    label: '显示快捷键速查表',
    hint: '?',
    keywords: 'shortcut help keyboard 快捷键 帮助',
    icon: <Keyboard size={14} />,
    run: () => {
      ctx.closeAll();
      window.dispatchEvent(new CustomEvent('loggraph-show-shortcuts'));
    },
  });

  return commands;
}

/* ============================ 模糊匹配 ============================ */

/** 子序列匹配打分：连续命中与词首命中加权，返回 0 表示不匹配 */
function scoreMatch(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 5 + (direct === 0 ? 200 : 0);
  // 子序列
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    s += 10 + streak * 6 - Math.min(found - ti, 8);
    ti = found + 1;
  }
  return Math.max(s, 1);
}

/* ============================ 面板本体 ============================ */

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(
    () => buildCommands({ closeAll: () => setOpen(false) }),
    [setOpen],
  );

  const results = useMemo(() => {
    const q = query.trim();
    return commands
      .map((c) => {
        const hay = `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''} ${c.group}`;
        return { c, score: scoreMatch(hay, q) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((r) => r.c);
  }, [commands, query]);

  // 结果集变化时把光标拉回首位
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // 打开时聚焦并复位输入框
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 全局快捷键：⌘K / Ctrl+K 开关；? 打开速查表
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement | null)?.isContentEditable === true;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        usePaletteStore.getState().toggle();
        return;
      }
      /**
       * Ctrl/⌘+C（带不带 Shift 都收）：复制当前选中行原文。
       *
       * 用裸 Ctrl+C 而不是只有 Ctrl+Shift+C，是因为浏览器里 Ctrl+Shift+C 是
       * Chrome/Edge 的「检查元素」快捷键，属于浏览器级加速器——页面既收不到
       * keydown、也 preventDefault 不掉。Shift 版保留给桌面端（WebView2 无此抢占）。
       * 判定用 e.code（物理键位），不受键盘布局影响。
       */
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyC') {
        if (inField) return; // 输入框里让位给原生复制
        if (window.getSelection()?.toString()) return; // 用户自己选了文字 → 原生复制
        if (useLogStore.getState().selectedEventId === null) return;
        e.preventDefault();
        void copySelectedRawLine();
        return;
      }
      if (e.key === '?' && !inField) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 命令面板内部的 shortcuts 命令通过事件请求打开速查表
  useEffect(() => {
    const h = () => setHelpOpen(true);
    window.addEventListener('loggraph-show-shortcuts', h);
    return () => window.removeEventListener('loggraph-show-shortcuts', h);
  }, []);

  // 光标跟随滚动
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results.length]);

  if (!open) {
    return helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null;
  }

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    void cmd.run(query.trim());
  };

  return (
    <div className={styles.overlay} onMouseDown={() => setOpen(false)}>
      <div
        className={styles.panel}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="命令面板"
      >
        <div className={styles.inputRow}>
          <span className={styles.inputIcon} aria-hidden="true">
            <Search size={15} />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="搜索命令、切换视图、快速过滤…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(cursor);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>

        <div className={styles.list} ref={listRef}>
          {results.length === 0 && (
            <div className={styles.empty}>没有匹配的命令，试试「打开」「主题」「ERROR」</div>
          )}
          {results.map((c, i) => {
            const showGroup = i === 0 || results[i - 1].group !== c.group;
            return (
              <div key={c.id}>
                {showGroup && <div className={styles.groupLabel}>{c.group}</div>}
                <div
                  data-idx={i}
                  className={`${styles.row} ${i === cursor ? styles.rowActive : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => runAt(i)}
                >
                  <span className={styles.rowIcon}>{c.icon ?? <span className={styles.dot} />}</span>
                  <span className={styles.rowLabel}>{c.label}</span>
                  {c.hint && <span className={styles.rowHint}>{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.footer}>
          <span>
            <kbd className={styles.kbd}>↑</kbd>
            <kbd className={styles.kbd}>↓</kbd> 选择
          </span>
          <span>
            <kbd className={styles.kbd}>Enter</kbd> 执行
          </span>
          <span className={styles.spacer} />
          <span>{results.length} 条命令</span>
        </div>
      </div>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
