import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
export default defineConfig({ root, base: './', plugins: [react()], server: { host: '127.0.0.1', port: 4627, strictPort: true }, build: { outDir: 'dist-walking-map', rollupOptions: { input: `${root}/src/story/game/maps/walking-dev.html` } } });
