/**
 * P1 (tm8-ui orchestration, Track P) — boots the real tm8 server FROM SOURCE as a
 * long-running process, never `dist`. Reuses the exact aliasing recipe proven in
 * `packages/tm8-ui/src/data/integration/vitest.config.ts` (the only working
 * TypeScript-from-source execution path found in this repo — a repo-wide grep for
 * tsx/ts-node/--experimental-strip-types across every package.json and scripts/*.mjs
 * returns zero hits), extended to alias @tm8/execution, @tm8/contract and @tm8/prompt
 * to src too — `packages/execution/dist`, `packages/contract/dist` and
 * `packages/prompt/dist` are ALL measured stale relative to their src (mtime check,
 * 2026-07-28), so aliasing only server/main.ts the way the tm8-ui lane does would
 * still run stale spawn/manifest code.
 *
 * Invoke via `run-server.sh` in this directory. Runs under NODE ONLY — vitest's own
 * binary here is `packages/tm8-ui/node_modules/vitest/vitest.mjs`, invoked with an
 * explicit `node` in the run script so there is no ambiguity about the runtime
 * (node-pty's onData does not fire under bun).
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/tm8-ui/scratch-p1-run-src -> tm8-ui -> packages -> repo root */
const REPO_ROOT = resolve(HERE, '../../..');
const SERVER_SRC = resolve(REPO_ROOT, 'packages/server/src');
const EXECUTION_SRC = resolve(REPO_ROOT, 'packages/execution/src');
const CONTRACT_SRC = resolve(REPO_ROOT, 'packages/contract/src');
const PROMPT_SRC = resolve(REPO_ROOT, 'packages/prompt/src');

export default defineConfig({
  root: REPO_ROOT,
  resolve: {
    alias: [
      { find: '@tm8/server-src-main', replacement: resolve(SERVER_SRC, 'main.ts') },
      { find: '@tm8/server-src-config', replacement: resolve(SERVER_SRC, 'http/config.ts') },
      { find: '@tm8/execution', replacement: resolve(EXECUTION_SRC, 'index.ts') },
      { find: '@tm8/contract', replacement: resolve(CONTRACT_SRC, 'index.ts') },
      { find: '@tm8/prompt', replacement: resolve(PROMPT_SRC, 'index.ts') },
    ],
    // One physical copy of each — the server and anything importing these bare
    // specifiers must land on the SAME module instance, or `instanceof` across
    // the boundary (e.g. CollabError) silently goes false.
    dedupe: ['@tm8/contract', '@tm8/execution', '@tm8/prompt'],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['packages/tm8-ui/scratch-p1-run-src/boot.itest.ts'],
    fileParallelism: false,
    // This "test" never completes — it boots a real server and blocks forever so
    // the process stays alive for other lanes to connect to. Both timeouts must
    // exceed any real dev session; vitest's defaults (5s test / 10s hook) would
    // abort it almost immediately.
    testTimeout: 2_147_483_647,
    hookTimeout: 2_147_483_647,
  },
});
