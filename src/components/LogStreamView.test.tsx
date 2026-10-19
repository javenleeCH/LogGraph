// @vitest-environment jsdom
/**
 * LogStreamView 空态冒烟（P2-2）：无 viewRange/fullRange 时渲染 WelcomeState 不崩。
 * 空态提前 return，避开重表格/时间线路径；隔离 store 副作用 + 子面板。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const state = {
  viewRange: null,
  fullRange: null,
  matches: [],
  filters: [],
  groups: [],
  filtersComputing: false,
  sequenceResults: {},
  correlatedEventIds: [],
  selectedEventId: null,
  hoveredEventId: null,
  dbMode: false,
  selectEvent: vi.fn(),
  setHovered: vi.fn(),
  resetView: vi.fn(),
  focusEvent: vi.fn(),
  updateEventTs: vi.fn(),
  setViewRange: vi.fn(),
};
vi.mock('../store/logStore', () => ({
  hitTsByLine: vi.fn(),
  useLogStore: Object.assign((sel: any) => sel(state), { getState: () => state }),
}));
vi.mock('../io/dbStore', () => ({
  fetchLinesByIds: vi.fn(async () => []),
}));
vi.mock('./CepTimelinePanel', () => ({ CepTimelinePanel: () => null }));
vi.mock('./LaneHeader', () => ({ LaneHeader: () => null }));
// WelcomeState 挂载时列最近项目/收藏（内部用 indexedDB，jsdom 无实现）
vi.mock('../io/recentProjects', () => ({
  listRecentProjects: vi.fn(async () => []),
  listFavoriteProjects: vi.fn(async () => []),
}));
vi.mock('../io/openLogFlow', () => ({
  openSingleLogFile: vi.fn(),
  openLogDirectory: vi.fn(),
}));

import { LogStreamView } from './LogStreamView';

describe('LogStreamView 空态冒烟', () => {
  it('无 viewRange/fullRange 时渲染 WelcomeState，不崩溃', () => {
    render(<LogStreamView />);
    expect(
      screen.getByText('把日志拖进来，或者选个入口开始'),
    ).toBeInTheDocument();
  });
});
