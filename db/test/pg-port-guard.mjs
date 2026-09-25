// =============================================================================
// The ONE place the db/ suites (helpers.mjs, run.mjs) resolve their database URL.
//
// DB SAFETY (standing rule, 2026-09-25): a test harness must never default to
// 5442. On the tm8 host 5442 is the PROD cluster; the test cluster is 5443. The
// old fallback here was `TM8_PG_PORT || '5442'`, and run.mjs RESETS the database
// it resolves (`migrate.mjs reset --force`). So this REFUSES, before any psql
// call, when the resolved port is 5442 or is not set at all:
//
//   $TM8_DATABASE_URL (must carry an explicit port that is not 5442)
//     → postgres://$TM8_PG_USER@$TM8_PG_HOST:$TM8_PG_PORT/<database>
//
// db/migrate.mjs keeps its own 5442 default: that is the product sidecar, and
// run.mjs always hands it an explicit TM8_DATABASE_URL.
// =============================================================================

export const PROD_PG_PORT = '5442';
export const TEST_PG_PORT = '5443';

export class TestPgPortRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestPgPortRefusal';
  }
}

function refuse(found, fix) {
  throw new TestPgPortRefusal(
    `refusing to run: the test Postgres ${found}. ` +
      `5442 is the PROD cluster on the tm8 host and a test run must name its port explicitly. ` +
      `Set ${fix} — the test cluster is on ${TEST_PG_PORT}.`,
  );
}

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} database  database name used when TM8_DATABASE_URL is unset
 * @returns {string} the URL; throws TestPgPortRefusal, never connects
 */
export function testDatabaseUrl(env, database) {
  const explicit = env.TM8_DATABASE_URL?.trim();
  if (explicit) {
    const fix = `TM8_DATABASE_URL=postgres://tm8@127.0.0.1:${TEST_PG_PORT}/<db> (or unset it and set TM8_PG_PORT=${TEST_PG_PORT})`;
    let port;
    try {
      port = new URL(explicit).port;
    } catch {
      refuse('URL in TM8_DATABASE_URL does not parse', fix);
    }
    if (port === '') refuse('URL in TM8_DATABASE_URL has no explicit port', fix);
    if (port === PROD_PG_PORT) refuse(`URL in TM8_DATABASE_URL is on port ${PROD_PG_PORT}`, fix);
    return explicit;
  }
  const port = env.TM8_PG_PORT?.trim();
  const fix = `TM8_PG_PORT=${TEST_PG_PORT}`;
  if (!port) refuse('port is unset (neither TM8_DATABASE_URL nor TM8_PG_PORT is set)', fix);
  if (port === PROD_PG_PORT) refuse(`port is TM8_PG_PORT=${PROD_PG_PORT}`, fix);
  const user = env.TM8_PG_USER || env.USER || 'postgres';
  const host = env.TM8_PG_HOST || '127.0.0.1';
  return `postgres://${user}@${host}:${port}/${database}`;
}
