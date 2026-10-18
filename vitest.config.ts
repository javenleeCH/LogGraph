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
    // 默认的 forks/threads 池在本机（Windows + 该 Node 组合）起不来 worker：
    // 子进程/RPC 建不起来 ⇒ 测试文件在主进程被求值 ⇒ describe 拿到 undefined
    // 的 worker state ⇒ 全部文件报 "Cannot read properties of undefined
    // (reading 'config')"。vmForks/vmThreads 用进程内 VM 上下文，不依赖
    // 那条链路；这些用例全是纯模块，语义等价。排查时可用
    // `npx vitest run --pool=forks` 复现原故障。
    pool: 'vmForks',
    // 这些模块顶层会摸 window / 拉 wasm，与被测逻辑无关
    // （测试文件里各自 vi.mock）
  },
});
