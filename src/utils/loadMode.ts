/**
 * 加载模式描述（P1④ 加载模式透明化）。
 *
 * 背景：同一目录全选加载 → dbMode（骨架 + rg 直扫原文件 + SQLite 衍生索引）；
 * 拖拽文件 / 子集加载 → 全量内存；Web 版受 File System Access API 限制只能内存。
 * **同一份数据、两种能力边界、两种引擎**，而 UI 此前没有任何地方告诉用户
 * 自己在哪个模式——遇到行为差异（详情面板形态、时间列能否编辑、性能特征）
 * 完全无法归因。本模块把模式判定与能力边界说明收敛为纯函数，供 Toolbar
 * 状态栏 pill 渲染（hover 摘要 + 点击 toast 详解）。
 *
 * 纯函数、无 store 依赖，便于单测；改文案只需动这里。
 */

export type LoadMode = 'db' | 'memory' | 'web';

export interface LoadModeInfo {
  mode: LoadMode;
  /** 状态栏 pill 的短标签 */
  label: string;
  /** hover 摘要（title 属性，单行） */
  summary: string;
  /** 点击后 toast 的标题 */
  detailTitle: string;
  /** 点击后 toast 的详解要点（逐行展示） */
  boundaries: string[];
}

/** dbMode（目录加载）的能力边界说明 */
const DB_BOUNDARIES = [
  '原文件即数据库：过滤与搜索直扫磁盘（rg），百万行秒开、不占内存',
  '详情面板为无限上下文流，按需回源读取原文件',
  '复制行内容自动回源原文件取原文',
  '纵轴时间列不可编辑（dbMode 数据不可变改；仅内存模式可编辑）',
];

/** 桌面端内存模式的能力边界说明 */
const MEMORY_BOUNDARIES = [
  '全部日志载入内存：小文件流畅；超大日志建议改用「打开目录」走数据库模式',
  '详情面板按上下文行数档位查看',
  '纵轴时间列可编辑（仅内存模式支持）',
  'CEP 匹配优先走引擎 wasm，未就绪时回退内置引擎',
];

/** Web 版内存模式的能力边界说明（目录浏览不可用） */
const WEB_BOUNDARIES = [
  '浏览器受 File System Access API 限制（Firefox / Safari 不支持），无法像桌面版那样浏览目录',
  '因此只能把文件整份载入内存；大日志会占用大量内存甚至加载失败',
  '需要数据库模式（直扫磁盘、无限上下文流）请使用桌面版「打开目录」',
];

/**
 * 描述当前加载模式。
 *
 * @param dbMode   是否为数据库模式（目录全选加载）
 * @param desktop  是否运行在 Tauri 桌面容器中（false = 纯浏览器）
 */
export function describeLoadMode(dbMode: boolean, desktop: boolean): LoadModeInfo {
  if (dbMode) {
    return {
      mode: 'db',
      label: '数据库模式',
      summary: '数据库模式：原文件即数据库，搜索/过滤直扫磁盘；详情为无限上下文流；时间列不可编辑',
      detailTitle: '数据库模式（目录加载）',
      boundaries: DB_BOUNDARIES,
    };
  }
  if (desktop) {
    return {
      mode: 'memory',
      label: '内存模式',
      summary: '内存模式：全部日志载入内存；详情按上下文行数档位；时间列可编辑',
      detailTitle: '内存模式（文件 / 子集加载）',
      boundaries: MEMORY_BOUNDARIES,
    };
  }
  return {
    mode: 'web',
    label: '内存模式 · Web',
    summary: 'Web 版只能整文件载入内存（浏览器无目录浏览），大日志会占用大量内存',
    detailTitle: '内存模式（Web 版）',
    boundaries: WEB_BOUNDARIES,
  };
}
