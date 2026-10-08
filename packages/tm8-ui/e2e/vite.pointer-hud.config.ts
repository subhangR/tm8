import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const sourceHead = git(['rev-parse', 'HEAD']);
git(['diff', '--quiet', 'HEAD', '--', 'packages/tm8-ui/src']);
const provenance = { head: sourceHead, sourceDiffExitCode: 0, statusPorcelain: git(['status', '--porcelain']) };
export default defineConfig({
  plugins: [react()],
  define: { __POINTER_HUD_BUILD_SHA__: JSON.stringify(sourceHead), __POINTER_HUD_BUILD_PROVENANCE__: JSON.stringify(provenance) },
  build: {
    outDir: process.env.POINTER_HUD_BUILD_DIR ?? `/tmp/pointer-hud-build-${sourceHead}`,
    emptyOutDir: true,
    rollupOptions: { input: resolve('e2e/pointer-hud.html') },
  },
  server: { host: '127.0.0.1', port: 18543, strictPort: true },
  preview: { host: '127.0.0.1', port: 18543, strictPort: true },
});
