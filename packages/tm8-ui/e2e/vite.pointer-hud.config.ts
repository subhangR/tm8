import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export default defineConfig({
  plugins: [react()],
  define: { __POINTER_HUD_BUILD_SHA__: JSON.stringify(sourceHead) },
  build: {
    outDir: process.env.POINTER_HUD_BUILD_DIR ?? `/tmp/pointer-hud-build-${sourceHead}`,
    emptyOutDir: true,
    rollupOptions: { input: resolve('e2e/pointer-hud.html') },
  },
  server: { host: '127.0.0.1', port: 18543, strictPort: true },
  preview: { host: '127.0.0.1', port: 18543, strictPort: true },
});
