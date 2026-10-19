// @vitest-environment jsdom
/**
 * NodeCanvasView（GroupEditorPage）冒烟（P2-2）：画布数据装配。
 * mock 掉 React Flow（@xyflow/react 在 jsdom 布局脆）+ FilterEngine（顶层拉 wasm），
 * 断言 activeGroup 被正确传给画布；React Flow 自身渲染是第三方库，非本项目被测对象。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const group = {
  id: 'g1',
  label: '登录流程',
  visible: true,
  filterIds: ['f1'],
  edges: [],
  scope: 'global',
};
const state = {
  activeGroupId: 'g1',
  groups: [group],
  setActiveGroup: vi.fn(),
  updateGroup: vi.fn(),
  setSequenceScope: vi.fn(),
  setSequenceKeyPattern: vi.fn(),
  sequenceResults: {},
};
vi.mock('../store/logStore', () => ({
  useLogStore: Object.assign((sel: any) => sel(state), { getState: () => state }),
  CEP_MAX_CHAINS: 100,
}));
vi.mock('../filters/FilterEngine', () => ({
  FilterEngine: class {
    load = vi.fn();
  },
}));
vi.mock('./flow/GroupFlowCanvas', () => ({
  GroupFlowCanvas: ({ group }: { group: { id: string } }) => (
    <div data-testid="canvas">canvas:{group.id}</div>
  ),
}));

import { GroupEditorPage } from './NodeCanvasView';

describe('NodeCanvasView（GroupEditorPage）冒烟', () => {
  it('把 activeGroup 正确传给画布组件', () => {
    render(<GroupEditorPage />);
    expect(screen.getByTestId('canvas')).toHaveTextContent('canvas:g1');
  });
});
