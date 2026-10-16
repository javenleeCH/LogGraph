/**
 * Vitest 配置（独立于 vite.config.ts）
 *
 * 被测目标全是纯算法 / 纯文本拼装模块，不需要 DOM 与 React 插件；用 node
 * 环境跑，避免被 Tauri / wasm / 构建配置污染。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 这些模块顶层会摸 window / 拉 wasm，与被测逻辑无关
    // （测试文件里各自 vi.mock）
  },
});
