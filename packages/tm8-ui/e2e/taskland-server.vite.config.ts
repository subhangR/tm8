import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const target = process.env.TM8_SERVER_ORIGIN ?? 'http://127.0.0.1:18441';

// The production plugins and proxy, with all Vite writes inside this checkout.
export default mergeConfig(base, defineConfig({
  define: { __TASKLAND_VALIDATION_HEAD__: JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) },
  cacheDir: '.taskland-cache/vite',
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: '.taskland-cache/server-harness', emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'taskland-server-harness.html') } },
  preview: { host: '127.0.0.1', strictPort: true, proxy: {
    '/v2': { target, changeOrigin: false, ws: true }, '/health': { target, changeOrigin: false },
  } },
}));
