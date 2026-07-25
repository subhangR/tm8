/**
 * Driver error → contract taxonomy.
 *
 * The rule, inherited from `http/errors.ts` and not negotiable: a code is
 * decided by SQLSTATE and by nothing else. We never regex an error message,
 * because the RPCs' message text is free to change and a mapping that reads it
 * would break silently rather than loudly.
 *
 * Anything with no SQLSTATE we recognise degrades to `upstream_unavailable`
 * (503) with the raw SQLSTATE preserved in `details.sqlstate` and logged. A
 * wrong-but-honest 503 is recoverable; a plausible-looking 400 sends the
 * client off to fix input that was never the problem.
 *
 * Note on 503-vs-500: the closed taxonomy (contract §4) has no `internal`
 * code. `upstream_unavailable` IS the taxonomy's 5xx, so an unmapped database
 * failure lands there — that is the honest slot, not a downgrade.
 */
import { CollabError, type CommandErrorCode } from '@tm8/contract';
import { SQLSTATE_TO_ERROR_CODE } from '../http/errors.js';

/** The shape `pg` gives us on a server-side error (a subset of DatabaseError). */
interface PgErrorLike {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  hint?: unknown;
  constraint?: unknown;
  routine?: unknown;
}

function asPgError(err: unknown): PgErrorLike | null {
  if (typeof err !== 'object' || err === null) return null;
  return err as PgErrorLike;
}

/** `internal.assert_version` ships `{entityId, currentVersion}` as JSON in DETAIL. */
function parseDetail(detail: unknown): Record<string, unknown> | undefined {
  if (typeof detail !== 'string' || detail.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not every RAISE carries JSON in DETAIL; a plain string is fine and rides
    // through as text rather than being dropped.
  }
  return { detail };
}

export function sqlStateToCode(sqlState: string | undefined): CommandErrorCode | undefined {
  if (!sqlState) return undefined;
  return SQLSTATE_TO_ERROR_CODE[sqlState];
}

/**
 * Translate anything thrown by `pg` into the taxonomy.
 *
 * A `CollabError` passes through untouched — handlers throw those deliberately
 * and re-translating one would flatten a precise code into a generic 503.
 */
export function translateDbError(err: unknown): unknown {
  if (err instanceof CollabError) return err;

  const pgErr = asPgError(err);
  const sqlState = typeof pgErr?.code === 'string' ? pgErr.code : undefined;
  if (!sqlState) return err;

  const message = typeof pgErr?.message === 'string' ? pgErr.message : 'database error';
  const code = sqlStateToCode(sqlState);

  if (!code) {
    // Loud, not silent: an unmapped SQLSTATE is a gap in the table, and the
    // only way that gap gets closed is if it is visible in the log.
    console.error(`[db] unmapped SQLSTATE ${sqlState}: ${message}`);
    return new CollabError('upstream_unavailable', 'internal database error', {
      details: { sqlstate: sqlState },
    });
  }

  const detail = parseDetail(pgErr?.detail);
  return new CollabError(code, message, {
    details: { sqlstate: sqlState, ...(detail ?? {}) },
  });
}
