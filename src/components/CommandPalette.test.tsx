// @vitest-environment jsdom
/**
 * CommandPalette 冒烟（P2-2）：命令面板「开关」。
 * 隔离 IO / 存储副作用：冒烟只关心 open 状态驱动渲染，不触发真实文件打开 / 更新检查。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../io/openLogFlow', () => ({
  openSingleLogFile: vi.fn(),
  openLogDirectory: vi.fn(),
}));
vi.mock('../io/exportActions', () => ({
  copySelectedChainMarkdown: vi.fn(),
  copySelectedEventMarkdown: vi.fn(),
  exportMatchesMarkdown: vi.fn(),
  exportRulesFile: vi.fn(),
  exportSequenceResultsMarkdown: vi.fn(),
  importRulesFile: vi.fn(),
}));
vi.mock('../io/updater', () => ({ checkForUpdate: vi.fn() }));
vi.mock('../store/undoable', () => ({ clearFiltersWithUndo: vi.fn() }));
vi.mock('../store/uiStore', () => ({ beginBusy: vi.fn(), toast: vi.fn() }));
vi.mock('../hooks/useTheme', () => ({ toggleTheme: vi.fn() }));
vi.mock('../sequence/templates', () => ({
  RULE_TEMPLATES: [],
  createGroupFromTemplate: vi.fn(),
}));
vi.mock('../utils/copyFlow', () => ({ copyWithFallback: vi.fn() }));
vi.mock('../utils/rawLine', () => ({ getRawLine: vi.fn() }));
vi.mock('../store/logStore', () => ({
  useLogStore: Object.assign(() => undefined, {
    getState: () => ({ events: [], filters: [], groups: [], selectedEventId: null }),
  }),
}));

import { CommandPalette, openCommandPalette } from './CommandPalette';

describe('CommandPalette 冒烟', () => {
  it('初始关闭不渲染面板；openCommandPalette() 后打开并显示输入框', async () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    openCommandPalette();
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
  });
});
