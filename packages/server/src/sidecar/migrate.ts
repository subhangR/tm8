/**
 * Schema-migration seam.
 *
 * The sidecar *runs* the migration sequence; it does not own it. `db/migrate.mjs`
 * and `db/migrations/NNN_*.sql` belong to the db workstream (Cygnus, W1b), and
 * there is exactly ONE migration sequence for laptop and hub (T-L11) — so this
 * module only ever spawns the runner under node and interprets its exit code.
 * Reimplementing a runner here would be the fastest way to fork that sequence.
 *
 * Until `db/migrate.mjs` lands, `runSchemaMigrations()` skips **loudly** and
 * reports `{ ran: false, reason }` — a skipped migration is never silently
 * reported as applied.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedSidecarConfig } from './config.js';
import { SidecarError } from './errors.js';
import { describeFailure, run } from './exec.js';
import type { SidecarLogger } from './log.js';

/** Where the runner is expected to live, relative to the repo root. */
export const MIGRATE_RUNNER_RELPATH = join('db', 'migrate.mjs');

/**
 * The subcommand that actually applies pending migrations.
 *
 * The runner's default subcommand is `status`, which reports and applies
 * nothing — invoking it bare would log a clean run while leaving the database
 * empty. `up` is the verb; it is named here so the coupling is explicit and
 * greppable rather than an implicit default.
 */
export const MIGRATE_APPLY_ARGS = ['up'] as const;

export interface MigrationOutcome {
  readonly ran: boolean;
  /** Present when `ran` is false — why nothing was applied. */
  readonly reason?: string;
  readonly stdout?: string;
}

/**
 * A libpq connection URL over the data-dir Unix socket.
 *
 * The socket dir goes in the `host` query parameter (percent-encoded) rather
 * than the authority, which is how libpq accepts an absolute socket path.
 */
export function socketConnectionUrl(
  cfg: Pick<ResolvedSidecarConfig, 'socketDir' | 'pgPort' | 'database'>,
  user: string,
): string {
  return `postgresql://${encodeURIComponent(user)}@/${encodeURIComponent(cfg.database)}?host=${encodeURIComponent(
    cfg.socketDir,
  )}&port=${cfg.pgPort}`;
}

export interface RunMigrationsOptions {
  readonly logger?: SidecarLogger;
  readonly timeoutMs?: number;
  /** Override the runner path (tests). */
  readonly runnerPath?: string;
  /** Override the subcommand. Defaults to `up` (see MIGRATE_APPLY_ARGS). */
  readonly args?: readonly string[];
  /** Node executable to spawn the runner with. Never bun (ground rule). */
  readonly nodePath?: string;
}

/**
 * Apply `db/migrations` by spawning the db workstream's runner under node.
 *
 * @throws SidecarError `SchemaMigrationFailed` when the runner exits non-zero.
 */
export async function runSchemaMigrations(
  cfg: ResolvedSidecarConfig,
  opts: RunMigrationsOptions = {},
): Promise<MigrationOutcome> {
  const runner = opts.runnerPath ?? join(cfg.repoRoot, MIGRATE_RUNNER_RELPATH);
  if (!existsSync(runner)) {
    const reason = `${runner} not present — schema migrations SKIPPED (db workstream has not landed the runner yet)`;
    opts.logger?.warn(`migrations: ${reason}`);
    return { ran: false, reason };
  }

  const url = socketConnectionUrl(cfg, cfg.superuser);
  const args = [runner, ...(opts.args ?? MIGRATE_APPLY_ARGS)];
  opts.logger?.info(`migrations: applying db/migrations via ${runner} ${args.slice(1).join(' ')}`);

  const r = await run(opts.nodePath ?? process.execPath, args, {
    cwd: cfg.repoRoot,
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    env: {
      ...process.env,
      LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      // Both names are supplied: the runner may read either (docs/ops/CONFIG.md §2).
      DATABASE_URL: url,
      TM8_DATABASE_URL: url,
      TM8_MIGRATION_DATABASE_URL: url,
      TM8_PG_BIN_DIR: cfg.binariesDir,
      TM8_DATA_DIR: cfg.dataDir,
      TM8_PG_PORT: String(cfg.pgPort),
      TM8_PG_DATABASE: cfg.database,
      TM8_PG_SUPERUSER: cfg.superuser,
      TM8_PG_APP_ROLE: cfg.appRole,
    },
  });

  if (!r.ok) {
    throw new SidecarError('SchemaMigrationFailed', `tm8: db/migrations failed to apply`, {
      detail: describeFailure(r),
    });
  }
  opts.logger?.info('migrations: applied cleanly');
  return { ran: true, stdout: r.stdout };
}
