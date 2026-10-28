// =============================================================================
// Where db/migrate.mjs points — resolved here, refused here, never connected.
//
// WHY (2026-09-28, task 01a0e759). A lane ran `node db/migrate.mjs up` with
// TM8_MIGRATION_DATABASE_URL set — the test harness's variable, which the
// runner never read. With nothing else set the runner fell back to its default,
// postgres://$USER@127.0.0.1:5442/tm8_dev, and applied 80 migrations to the dev
// database on the PROD cluster. So:
//
//   * there is NO default target. The runner needs $TM8_DATABASE_URL, or
//     $DATABASE_URL, or BOTH $TM8_PG_PORT and $TM8_DB;
//   * a harness variable (TM8_MIGRATION_DATABASE_URL, TM8_W1_ADMIN_DATABASE_URL)
//     is not a target — when it is the only thing set, it is named in the
//     refusal instead of being silently ignored;
//   * port 5442 — the PROD cluster on the tm8 host — is refused unless the
//     caller passes --i-mean-prod. A GitHub Actions runner is the one exception:
//     its 5442 is the job's own throwaway postgres container (the same rule as
//     the test guards, db/test/pg-port-guard.mjs and
//     packages/server/test/db/pg-port-guard.ts, which import from here);
//   * what is printed is host:port/db only — never a user or a password.
//
// Zero dependencies, like migrate.mjs.
// =============================================================================

export const PROD_PG_PORT = '5442';
export const I_MEAN_PROD = '--i-mean-prod';

/** The variables test harnesses read. migrate.mjs does not; see above. */
export const HARNESS_URL_VARS = ['TM8_MIGRATION_DATABASE_URL', 'TM8_W1_ADMIN_DATABASE_URL'];

export class MigrateTargetRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrateTargetRefusal';
  }
}

/** On a GitHub Actions runner 5442 is the job's own postgres container, not prod. */
export function onGithubRunner(env) {
  return env.GITHUB_ACTIONS === 'true';
}

/**
 * The parts of a libpq URL. Not `new URL()`: it rejects the socket form the
 * sidecar uses, `postgresql://user@/db?host=%2Fsock&port=5442` (empty host).
 * Throws on anything that is not scheme://…
 */
function libpqParts(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/i.exec(url.trim());
  if (!m) throw new TypeError('not a postgres URL');
  const params = new URLSearchParams(m[4] ?? '');
  const authority = m[2] ?? '';
  const bracket = /^\[([^\]]*)\](?::(\d*))?$/.exec(authority);
  const [host, port] = bracket ? [bracket[1], bracket[2] ?? ''] : [authority.replace(/:\d*$/, ''), /:(\d*)$/.exec(authority)?.[1] ?? ''];
  return {
    host: decodeURIComponent(host) || params.get('host') || '',
    port: port || params.get('port') || '',
    database: decodeURIComponent((m[3] ?? '').replace(/^\//, '')),
  };
}

/**
 * The port a libpq URL connects to: the authority's, else a `?port=` parameter
 * (the sidecar's socket URLs carry it there), else '' (libpq's default).
 */
export function portOf(url) {
  return libpqParts(url).port;
}

/** host:port/db for a log line: no user, no password, no query. */
export function describeTarget(url) {
  let parts;
  try {
    parts = libpqParts(url);
  } catch {
    return '(unparseable url)';
  }
  return `${parts.host || '(default host)'}:${parts.port || '(default port)'}/${parts.database || '(no database)'}`;
}

/**
 * The URL migrate.mjs will use, or a MigrateTargetRefusal. Never connects.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ iMeanProd?: boolean }} [opts]
 * @returns {{ url: string, source: string }}
 */
export function resolveMigrateTarget(env, { iMeanProd = false } = {}) {
  let url;
  let source;
  for (const name of ['TM8_DATABASE_URL', 'DATABASE_URL']) {
    const value = env[name]?.trim();
    if (value) {
      url = value;
      source = name;
      break;
    }
  }
  if (!url) {
    const port = env.TM8_PG_PORT?.trim();
    const db = env.TM8_DB?.trim();
    if (port && db) {
      const user = env.TM8_PG_USER?.trim() || env.USER?.trim() || 'postgres';
      const host = env.TM8_PG_HOST?.trim() || '127.0.0.1';
      url = `postgres://${user}@${host}:${port}/${db}`;
      source = 'TM8_PG_PORT+TM8_DB';
    }
  }
  if (!url) {
    const ignored = HARNESS_URL_VARS.filter((name) => env[name]?.trim());
    throw new MigrateTargetRefusal(
      'no explicit target: set TM8_DATABASE_URL (or DATABASE_URL, or both TM8_PG_PORT and TM8_DB). ' +
        'There is no default database.' +
        (ignored.length
          ? ` ${ignored.join(' and ')} ${ignored.length > 1 ? 'are' : 'is'} set, but that is a test harness's ` +
            'variable and migrate.mjs does not read it — refusing rather than ignoring it.'
          : ''),
    );
  }
  let port;
  try {
    // No port in the URL → libpq falls back to $PGPORT, so that is the port.
    port = portOf(url) || env.PGPORT?.trim() || '';
  } catch {
    throw new MigrateTargetRefusal(`the URL in ${source} does not parse`);
  }
  if (port === PROD_PG_PORT && !iMeanProd && !onGithubRunner(env)) {
    throw new MigrateTargetRefusal(
      `the target ${describeTarget(url)} (from ${source}) is on port ${PROD_PG_PORT}, the PROD cluster on the tm8 host. ` +
        `Pass ${I_MEAN_PROD} if that is really the database you mean.`,
    );
  }
  return { url, source };
}
