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
    port: 5180,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2021',
    // Vite 8（Rolldown 管线）默认 minifier 为 oxc；显式声明避免回退 esbuild（需另装依赖）
    minify: 'oxc',
    sourcemap: false,
  },
});
