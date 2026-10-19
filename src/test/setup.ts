/**
 * 测试 setup（P2-2 UI 组件冒烟）：
 * - jest-dom matchers（toHaveTextContent / toBeInTheDocument 等）
 * - ResizeObserver / IntersectionObserver 桩：LogStreamView 等组件挂载时依赖，
 *   jsdom 未实现，缺则 render 崩溃
 * - 每个用例后 cleanup（@testing-library/react）
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

// jsdom 无 ResizeObserver / IntersectionObserver：观测回调直接触发一次，
// 其余静默接受——冒烟级够用，不追布局重算行为。
if (!globalThis.ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!globalThis.IntersectionObserver) {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}
