/**
 * Typed sidecar failure taxonomy — SIDECAR-PACKAGING.md §9.4.
 *
 * Every unrecoverable lifecycle failure surfaces as a `SidecarError` with a code
 * from this closed set. A stack trace is never the user-facing artifact: the
 * point of the taxonomy is that `doctor`, the health page and the operator all
 * get an actionable name plus (for the migration cases) the recovery artifact.
 */

export type SidecarErrorCode =
  /** §2 no vendored archive / unpacked bin for this platform (STARTING) */
  | 'BinaryMissing'
  /** §2 SHA-256 mismatch on the vendored archive (STARTING) */
  | 'BinaryChecksumFail'
  /** §4 initdb of a new cluster failed (STARTING/MIGRATING) */
  | 'InitdbFailed'
  /** §4 bundled major < cluster major; refuse, data untouched (STARTING) */
  | 'MajorDowngrade'
  /** §4 pre-migration pg_dump failed; no partial cluster exists (MIGRATING) */
  | 'MigrationBackupFailed'
  /** §4 restore/verify into the new cluster failed; carries backupPath (MIGRATING) */
  | 'MigrationRestoreFailed'
  /** §6 health probes never passed within budget (HEALTHCHECK) */
  | 'StartTimeout'
  /** §7 loopback TCP port already bound by something that is not ours (STARTING) */
  | 'PortInUse'
  /** §7 a live, foreign sidecar holds the data dir (STARTING) */
  | 'LockHeld'
  /** §5 scheduled/on-demand pg_dump failed (RUNNING) */
  | 'BackupFailed'
  /** the db/migrations runner failed applying NNN_*.sql (STARTING/MIGRATING) */
  | 'SchemaMigrationFailed';

export interface SidecarErrorOptions {
  /** Set for every Migration* error once a dump exists — the recovery artifact. */
  readonly backupPath?: string;
  /** postmaster log tail / pg_isready output / child stderr. */
  readonly detail?: string;
  readonly cause?: unknown;
}

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  readonly backupPath?: string;
  readonly detail?: string;

  constructor(code: SidecarErrorCode, message: string, opts: SidecarErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SidecarError';
    this.code = code;
    if (opts.backupPath !== undefined) this.backupPath = opts.backupPath;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}

export function isSidecarError(e: unknown): e is SidecarError {
  return e instanceof SidecarError;
}

/** Wrap an unknown throwable in a typed error without losing the original. */
export function asSidecarError(
  code: SidecarErrorCode,
  message: string,
  cause: unknown,
  opts: Omit<SidecarErrorOptions, 'cause'> = {},
): SidecarError {
  if (isSidecarError(cause)) return cause;
  const detail = opts.detail ?? (cause instanceof Error ? cause.message : String(cause));
  return new SidecarError(code, message, { ...opts, detail, cause });
}
