import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig({ root, cacheDir: '.taskland-vite-cache', plugins: [react()],
  server: { host: '127.0.0.1', port: 4637, strictPort: true },
  build: { outDir: 'dist-taskland-harness', rollupOptions: { input: `${root}/e2e/taskland-harness.html` } } });
