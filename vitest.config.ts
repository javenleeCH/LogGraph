/**
 * Vitest 配置（独立于 vite.config.ts）
 *
 * 纯算法 / 纯文本拼装模块用 node 环境跑，避免被 Tauri / wasm / 构建配置污染；
 * 组件冒烟（P2-2）用 `// @vitest-environment jsdom` 逐文件切 jsdom。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // 组件冒烟（P2-2）：setup 提供 jest-dom matchers + ResizeObserver 桩
    setupFiles: ['src/test/setup.ts'],
    // 默认的 forks/threads 池在本机（Windows + 该 Node 组合）起不来 worker：
    // 子进程/RPC 建不起来 ⇒ 测试文件在主进程被求值 ⇒ describe 拿到 undefined
    // 的 worker state ⇒ 全部文件报 "Cannot read properties of undefined
    // (reading 'config')"。vmForks/vmThreads 用进程内 VM 上下文，不依赖
    // 那条链路；这些用例全是纯模块，语义等价。排查时可用
    // `npx vitest run --pool=forks` 复现原故障。
    pool: 'vmForks',
    // 这些模块顶层会摸 window / 拉 wasm，与被测逻辑无关
    // （测试文件里各自 vi.mock）
    // ---- 覆盖率门禁（P2-1）----
    // 聚焦四个「单一实现」语义核心目录；UI/组件层（src/components 等）另行
    // 冒烟覆盖，不纳入本门禁，避免被大块未测 UI 拉低整体、丧失守护意义。
    // 阈值取 2026-10-19 实测基线之下（基线 Stmts 36.5 / Branch 37.6 /
    // Funcs 32.5 / Lines 37.1），先绿后守：新增改动导致覆盖率跌破阈值 → CI 红。
    coverage: {
      provider: 'v8',
      include: [
        'src/sequence/**',
        'src/filters/**',
        'src/parser/**',
        'src/io/**',
      ],
      exclude: ['**/pkg/**', '**/*.d.ts', '**/*.test.ts'],
      thresholds: {
        lines: 35,
        statements: 34,
        functions: 30,
        branches: 35,
      },
    },
  },
});
