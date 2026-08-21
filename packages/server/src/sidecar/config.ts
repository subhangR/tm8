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
 *   TM8_PG_SOCKET_DIR <dataDir>/run           → unix_socket_directories override
 *   TM8_PG_LISTEN_ADDRESSES 127.0.0.1         → '' for a socket-only profile
 *   TM8_PG_BIN_DIR —                          → explicit Postgres bin/ override
 *   TM8_PG_DATABASE / TM8_PG_SUPERUSER / TM8_PG_APP_ROLE
 */

import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
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
  /**
   * `listen_addresses`. `127.0.0.1` for a server install (tooling wants a TCP
   * endpoint); the empty string for the desktop app, which is socket-only —
   * that is what makes `pgPort` a filename rather than a claim on a port.
   */
  readonly listenAddresses: string;
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

/**
 * `sizeof(struct sockaddr_un.sun_path)` on macOS. Linux is 108; 104 is the
 * smaller of the two, so asserting against it is portable.
 */
export const SUN_PATH_MAX = 104;

/** What Postgres will actually try to `bind()`. */
export function socketFilePath(socketDir: string, pgPort: number): string {
  return join(socketDir, `.s.PGSQL.${pgPort}`);
}

/**
 * Choose a socket directory whose `.s.PGSQL.<port>` fits in `sun_path`.
 *
 * The preferred directory is `<dataDir>/run`, and on a normal machine it fits
 * with room to spare. It does not fit for a long username, a deeply nested
 * `TM8_DATA_DIR`, or an iCloud-synced Desktop — and the failure Postgres gives
 * for that is `bind() failed: Invalid argument`, which names neither the path
 * nor the limit. So measure it here and fall back to a short hashed directory
 * under `$TMPDIR`, keyed by the data dir so two data dirs never share a socket.
 *
 * The fallback is announced, not silent: a socket under `$TMPDIR` is reaped by
 * macOS eventually, and an operator who does not know that is an operator who
 * will one day be very confused.
 */
export function chooseSocketDir(
  dataDir: string,
  pgPort: number,
  override?: string | undefined,
): { readonly socketDir: string; readonly fallbackReason?: string } {
  if (override !== undefined && override.trim() !== '') {
    const dir = resolve(expandHome(override.trim()));
    const path = socketFilePath(dir, pgPort);
    if (Buffer.byteLength(path) >= SUN_PATH_MAX) {
      throw new Error(
        `TM8_PG_SOCKET_DIR=${dir} is too long: the socket Postgres would bind is ` +
          `${Buffer.byteLength(path)} bytes and the kernel limit (sun_path) is ${SUN_PATH_MAX}. ` +
          `Choose a shorter directory.`,
      );
    }
    return { socketDir: dir };
  }

  const preferred = join(dataDir, 'run');
  const preferredBytes = Buffer.byteLength(socketFilePath(preferred, pgPort));
  if (preferredBytes < SUN_PATH_MAX) return { socketDir: preferred };

  const digest = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
  const fallback = join(tmpdir(), `tm8-${digest}`);
  const fallbackBytes = Buffer.byteLength(socketFilePath(fallback, pgPort));
  if (fallbackBytes >= SUN_PATH_MAX) {
    throw new Error(
      `tm8: no usable Postgres socket directory. ${preferred} is ${preferredBytes} bytes and the ` +
        `$TMPDIR fallback ${fallback} is ${fallbackBytes}; the kernel limit (sun_path) is ${SUN_PATH_MAX}. ` +
        `Set TM8_PG_SOCKET_DIR to a short path such as /tmp/tm8.`,
    );
  }
  return {
    socketDir: fallback,
    fallbackReason:
      `${preferred} would make a ${preferredBytes}-byte socket path and the kernel limit is ` +
      `${SUN_PATH_MAX}; using ${fallback} instead. Set TM8_PG_SOCKET_DIR to override.`,
  };
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
  const pgPort = readPort(env['TM8_PG_PORT'], DEFAULT_PG_PORT);
  const socket = chooseSocketDir(dataDir, pgPort, env['TM8_PG_SOCKET_DIR']);
  if (socket.fallbackReason !== undefined) {
    console.warn(`sidecar: socket directory fallback — ${socket.fallbackReason}`);
  }

  return {
    env: mode,
    dataDir,
    pgDataDir: choice.pgDataDir,
    socketDir: socket.socketDir,
    pgPort,
    listenAddresses: env['TM8_PG_LISTEN_ADDRESSES'] ?? '127.0.0.1',
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
