import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Tauri 相关：固定端口 + strictPort 供桌面窗口连接；clearScreen=false 避免清屏。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    // 绑定 IPv4 127.0.0.1：本机 localhost 在部分环境解析到 IPv6 ::1，
    // 而 WebView2 用 IPv4 连接时会白屏（connection refused）。固定 IPv4 最稳。
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    // target/（cargo 构建产物）与 .logGraph/（SQLite cache.db）在项目根内：
    // Windows 上链接器/SQLite 写这些文件时持锁，watcher 报 EBUSY 会直接崩掉
    // 整个 dev server → Tauri 窗口白屏。必须排除。
    watch: {
      ignored: ['**/target/**', '**/.logGraph/**', 'perf-data/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2021',
    // Vite 8（Rolldown 管线）默认 minifier 为 oxc；显式声明避免回退 esbuild（需另装依赖）
    minify: 'oxc',
    sourcemap: false,
  },
});
