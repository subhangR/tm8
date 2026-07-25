/**
 * Resolved sidecar configuration — SIDECAR-PACKAGING.md §9.1.
 *
 * Produced once at boot; every path is absolute and no further env reads happen
 * afterwards. That single-read discipline is what makes `doctor` honest: what it
 * prints is exactly what the lifecycle will use.
 *
 * Environment (docs/ops/CONFIG.md §2):
 *   TM8_ENV        dev | prod                 → data-dir default
 *   TM8_DATA_DIR   ~/.tm8-dev | ~/.tm8        → root of all sidecar state
 *   TM8_PG_PORT    5442                       → loopback TCP (tooling endpoint)
 *   TM8_PG_BIN_DIR —                          → explicit Postgres bin/ override
 *   TM8_PG_DATABASE / TM8_PG_SUPERUSER / TM8_PG_APP_ROLE
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBinaryMajor, resolveBinariesDir } from './binaries.js';
import { chooseClusterDir } from './layout.js';

/**
 * The one place the pinned major lives (§3). CI asserts the bundled binary's
 * major equals this; `assertBinaryMajor` asserts it again at runtime.
 */
export const PINNED_PG_MAJOR = 18;

/** Loopback TCP default; the app connects over the socket in the data dir (§7). */
export const DEFAULT_PG_PORT = 5442;

export interface ResolvedSidecarConfig {
  /** `dev` or `prod` — selects the data-dir default only. */
  readonly env: 'dev' | 'prod';
  /** ~/.tm8 (prod) or ~/.tm8-dev (dev). The root of all sidecar state. */
  readonly dataDir: string;
  /** <dataDir>/pg/<major>/ — the live cluster for the pinned major. */
  readonly pgDataDir: string;
  /** Unpacked postgres bin/ dir for THIS platform. */
  readonly binariesDir: string;
  /** <dataDir>/run — unix_socket_directories; primary connection path (§7). */
  readonly socketDir: string;
  /** Loopback TCP port from TM8_PG_PORT. Secondary/tooling endpoint. */
  readonly pgPort: number;
  /** Pinned major, e.g. 18. */
  readonly pgMajor: number;
  /** <dataDir>/backups — scheduled/, pre-migration/, on-demand/ (§5). */
  readonly backupsDir: string;
  /** Low-privilege app role name (never superuser/table-owner — R2). */
  readonly appRole: string;
  /** Database name tm8 uses. */
  readonly database: string;

  // --- additive beyond §9.1, all derived; documented in docs/ops/CONFIG.md ---
  /** Bootstrap superuser created by `initdb -U`; owns the cluster and runs migrations. */
  readonly superuser: string;
  /** <dataDir>/log — postmaster log destination. */
  readonly logDir: string;
  /** <dataDir>/sidecar.lock — tm8 advisory single-instance lock (§7). */
  readonly lockPath: string;
  /** Repo root, used to locate `db/migrate.mjs` and `vendor/pg/`. */
  readonly repoRoot: string;
}

/** Expand a leading `~`, mirroring scripts/lib/env.mjs. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Repo root from this module's location. `packages/server/{src,dist}/sidecar/`
 * is four levels down in both the source and the built tree.
 */
export function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..');
}

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`TM8_PG_PORT must be an integer port, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export interface ResolveConfigOptions {
  /** Override the pinned major. Tests only — production always uses the pin. */
  readonly pgMajor?: number;
  readonly repoRoot?: string;
}

/**
 * Resolve everything except `binariesDir`, which needs async work (checksum
 * verification / archive unpack). Useful for `doctor`, tests, and any caller
 * that must not touch the filesystem.
 */
export function resolveSidecarPaths(
  env: NodeJS.ProcessEnv,
  opts: ResolveConfigOptions = {},
): Omit<ResolvedSidecarConfig, 'binariesDir'> {
  const mode = env['TM8_ENV'] === 'prod' ? 'prod' : 'dev';
  const rawDataDir = env['TM8_DATA_DIR'] ?? join(homedir(), mode === 'prod' ? '.tm8' : '.tm8-dev');
  const dataDir = resolve(expandHome(rawDataDir));
  if (!isAbsolute(dataDir)) throw new Error(`TM8_DATA_DIR must resolve to an absolute path: ${dataDir}`);
  const pgMajor = opts.pgMajor ?? PINNED_PG_MAJOR;
  // Major-scoped so a future major upgrade creates a sibling, never overwrites (§4);
  // an existing unversioned cluster of the pinned major is adopted in place.
  const choice = chooseClusterDir(dataDir, pgMajor);

  return {
    env: mode,
    dataDir,
    pgDataDir: choice.pgDataDir,
    socketDir: join(dataDir, 'run'),
    pgPort: readPort(env['TM8_PG_PORT'], DEFAULT_PG_PORT),
    pgMajor,
    backupsDir: join(dataDir, 'backups'),
    appRole: env['TM8_PG_APP_ROLE'] ?? 'tm8_app',
    database: env['TM8_PG_DATABASE'] ?? 'tm8',
    superuser: env['TM8_PG_SUPERUSER'] ?? 'tm8',
    logDir: join(dataDir, 'log'),
    lockPath: join(dataDir, 'sidecar.lock'),
    repoRoot: opts.repoRoot ?? env['TM8_REPO_ROOT'] ?? defaultRepoRoot(),
  };
}

/**
 * Fully-resolved config, including binary resolution and the major-pin check.
 *
 * @throws SidecarError `BinaryMissing` / `BinaryChecksumFail` (§2), or a plain
 *         `Error` for malformed env values.
 */
export async function resolveSidecarConfig(
  env: NodeJS.ProcessEnv,
  opts: ResolveConfigOptions = {},
): Promise<ResolvedSidecarConfig> {
  const paths = resolveSidecarPaths(env, opts);
  const binariesDir = await resolveBinariesDir({
    major: paths.pgMajor,
    dataDir: paths.dataDir,
    repoRoot: paths.repoRoot,
    override: env['TM8_PG_BIN_DIR'],
  });
  await assertBinaryMajor(binariesDir, paths.pgMajor);
  return { ...paths, binariesDir };
}
