/**
 * Ambient declarations for this lane ONLY. Nothing outside
 * `src/data/integration/` sees them and nothing here is shipped to a browser.
 *
 * WHY THIS FILE EXISTS — two constraints that meet in exactly one place:
 *
 * 1. `packages/tm8-ui` deliberately has NO `@types/node` (package tsconfig
 *    comment: "app code stays guarded against accidental node imports because
 *    `types` omits @types/node"). Measured 2026-07-28: no `@types/node` exists
 *    anywhere reachable from this package — root `node_modules` has no
 *    `@types` directory at all, and `packages/server/node_modules/@types` is
 *    NOT on this package's resolution path. So the node builtins this
 *    integration harness genuinely needs have to be declared, narrowly, here.
 *
 * 2. The harness boots the REAL server composition **from `packages/server/src`**
 *    (bridge-coordinator correction [bridge->B4 2]: the built `dist` predates
 *    the Delta 1 mapper arm, so a dist-booted node would report `menu.updated`
 *    not flowing — a false red that reads exactly like the MERGED signal being
 *    wrong). A *relative* import into `../../../../server/src` would drag the
 *    whole server source tree into `src/data/tsconfig.test.json`, which cannot
 *    typecheck it (constraint 1 again — server src is written against
 *    `NodeJS.ProcessEnv`). A BARE specifier resolved by an alias sidesteps
 *    that: TypeScript finds no package and falls through to the declarations
 *    below; `./vitest.config.ts` maps the same specifiers to the real files at
 *    runtime.
 *
 * THE HONESTY COST, STATED: these declarations are a hand-written narrowing of
 * types this lane does not own. They are deliberately MINIMAL — only the
 * members the harness actually touches — so drift shows up as a runtime
 * failure in a suite that boots a real node against a real database, not as a
 * quietly-wrong green. `node-fixture.ts` additionally asserts at runtime that
 * each aliased import produced a callable, because a typo in an alias resolves
 * to `undefined` and `undefined is not a function` three frames down is a worse
 * error message than the one raised there.
 *
 * REMOVE THIS FILE the day `@types/node` becomes resolvable from this package
 * and the server exposes a test entry point — the alias and these declarations
 * are both scaffolding around an absence, not a design.
 */

// ---------------------------------------------------------------------------
// The two server modules this lane imports, by their aliased specifiers.
// ---------------------------------------------------------------------------

declare module '@tm8/server-src-config' {
  /**
   * `packages/server/src/http/config.ts`. Structurally what `bootstrap()`
   * reads; `loadConfig` is called with an explicit env record so the ambient
   * process environment can never leak a real `TM8_DATABASE_URL` into a test.
   */
  export interface ServerConfig {
    readonly host: string;
    readonly port: number;
    readonly uiDir: string | undefined;
    readonly maxBodyBytes: number;
    readonly databaseUrl: string | undefined;
    readonly dataDir?: string;
    readonly fileMaxSizeBytes?: number;
  }
  export function loadConfig(env: Record<string, string | undefined>): ServerConfig;
}

declare module '@tm8/server-src-main' {
  import type { ServerConfig } from '@tm8/server-src-config';

  /**
   * The subset of `BootstrappedServer` this harness owns the lifetime of.
   * `db` and `delivery` are `unknown`-shaped on purpose: the harness only ever
   * closes them, and typing them any further would be inventing a contract
   * with a package this lane may not edit.
   */
  export interface BootstrappedServer {
    readonly server: { close(): Promise<void> };
    readonly url: string;
    readonly db: { end(): Promise<void> } | undefined;
    readonly delivery: { close(): Promise<void> } | undefined;
  }
  export function bootstrap(opts?: { config?: ServerConfig }): Promise<BootstrappedServer>;
}

// ---------------------------------------------------------------------------
// Node builtins — only the members used under `src/data/integration/`.
// ---------------------------------------------------------------------------

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      encoding?: 'utf8';
      env?: Record<string, string | undefined>;
      cwd?: string;
      timeout?: number;
    },
  ): SpawnSyncResult;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

/**
 * The one global. Declared as a value with exactly the two members used, rather
 * than pulling in the whole `NodeJS` namespace — which is the thing this
 * package's tsconfig is deliberately keeping out.
 */
declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
};
