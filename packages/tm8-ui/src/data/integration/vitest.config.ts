/**
 * The integration lane's own vitest config. It exists so this lane can reach
 * `packages/server/src` WITHOUT editing a single file outside
 * `src/data/integration/` (bridge-coordinator hard constraint (a)).
 *
 * Run it explicitly, from the package root, with the NODE-shebanged binary:
 *
 *   cd packages/tm8-ui
 *   TM8_UI_INTEGRATION=1 ./node_modules/.bin/vitest run \
 *     --config src/data/integration/vitest.config.ts
 *
 * NOT `bunx vitest` (charter: server code never runs under bun) and NOT a bare
 * `vitest` (measured on this machine: a bare `vitest` resolves to
 * `…/maestro/agent-maestro/node_modules/.bin/vitest` — a real runner answering
 * about the wrong tree).
 *
 * THREE THINGS HERE ARE LOAD-BEARING:
 *
 * 1. `root` is pinned to the package. Passing `--config <path>` makes vite
 *    default `root` to the CONFIG FILE's directory, which would silently
 *    re-base every relative path in the run.
 * 2. The two aliases map bare specifiers onto server SOURCE. Source, not
 *    `dist`: the built artifact predates the Delta 1 mapper passthrough arm, so
 *    a dist-booted node reports `menu.updated` as not flowing — indistinguishable
 *    from the Delta 1 MERGED signal being wrong (server-owner, relayed
 *    [bridge->B4 2]). Booting from src is the only way this suite's Delta 1
 *    result means what it says.
 * 3. `@tm8/contract` is deduped to ONE physical copy. The seam under test and
 *    the server both import it; two copies would give two `CollabError`
 *    constructors, and every `instanceof` assertion in this lane would be
 *    false for a reason that has nothing to do with the server.
 */
// `vitest/config`, NOT `vite` — vite's own `defineConfig` has no `test` key in
// its type, so importing it here is a TS2769 overload failure in every lane
// that typechecks `src/**` (the package tsconfig does; measured by FE, relayed
// [bridge->B4 6]). `vitest/config` re-exports a `defineConfig` whose
// UserConfig carries `test`. The correct import source, not a cast over the
// wrong one.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** integration → data → src → tm8-ui */
const PACKAGE_ROOT = resolve(HERE, '../../..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const SERVER_SRC = resolve(REPO_ROOT, 'packages/server/src');

export default defineConfig({
  root: PACKAGE_ROOT,
  resolve: {
    alias: [
      { find: '@tm8/server-src-main', replacement: resolve(SERVER_SRC, 'main.ts') },
      { find: '@tm8/server-src-config', replacement: resolve(SERVER_SRC, 'http/config.ts') },
    ],
    // See note 3. The server resolves `@tm8/contract` through its own
    // node_modules symlink and this package through its own; both symlinks land
    // on `packages/contract`, so one copy is the EXPECTED outcome — `dedupe`
    // makes it an enforced one. `node-fixture.ts` still asserts it at runtime,
    // because "they happened to agree" and "they cannot disagree" look the same
    // from a green suite.
    dedupe: ['@tm8/contract'],
  },
  test: {
    environment: 'node',
    globals: true,
    // `.itest.ts`, NOT `.test.ts`, and this is STRUCTURAL — not a naming taste.
    //
    // The package's own `vite.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}`,
    // and the package-root runner never loads THIS config. A `.test.ts` file in
    // here would therefore be COLLECTED by every FE worker's `vitest run` and
    // fail at import — the bare specifiers below only resolve under the aliases
    // in this file. Worse, a collection failure runs zero tests, so the
    // "Tests passed" line stays green and blind while the exit code is 1.
    // (Measured by FE, relayed [bridge->B4 5].) The suffix is the only thing
    // keeping this lane out of everyone else's baseline; renaming a suite back
    // to `.test.ts` re-breaks the whole package.
    include: ['src/data/integration/**/*.itest.ts'],
    // Real nodes, real databases, real sockets: one suite at a time. Parallel
    // files would race on the sidecar and on the ephemeral-port pick, and the
    // resulting flake would read as a transport defect in the code under test.
    fileParallelism: false,
    // The defaults (5s test / 10s hook) do not fit "create a database, apply 43
    // migrations, boot a composition root, drop the database" — and the
    // instruments memory records that the hook overrun presents as an UNNAMED
    // file-level abort with every test reported passing. Per-file
    // `vi.setConfig` restates these; this is the floor.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // The lane's own opt-in (see ./enabled.ts). Set HERE so the config built
    // for these suites always runs them, while the package's default
    // `vitest run` — which the FE workers use constantly — keeps skipping them
    // instead of booting nodes against the shared Postgres sidecar.
    env: { NODE_ENV: 'test', TM8_UI_INTEGRATION: '1' },
  },
});
