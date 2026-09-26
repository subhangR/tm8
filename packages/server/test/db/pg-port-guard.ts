/**
 * The ONE place packages/server's DB tests resolve their admin Postgres URL
 * (used by ./w1-pg.ts, which every scratch-database suite goes through).
 *
 * DB SAFETY (standing rule, 2026-09-25): a test harness must never default to
 * 5442. On the tm8 host 5442 is the PROD cluster; the test cluster is 5443.
 * The old fallback here was 'postgres://tm8@127.0.0.1:5442/postgres'. The
 * resolution below REFUSES, before any connection is attempted, when the URL it
 * lands on is on 5442 or has no explicit port — and when nothing is set at all:
 *
 *   TM8_W1_ADMIN_DATABASE_URL → TM8_MIGRATION_DATABASE_URL → TM8_DATABASE_URL
 *     → 127.0.0.1:$TM8_PG_PORT
 *
 * CI's postgres service is the runner's own container on 5442, which
 * `onGithubRunner` below admits (GITHUB_ACTIONS=true). The product
 * sidecar default (src/sidecar/config.ts) is untouched: this is for tests only.
 */

export const PROD_PG_PORT = '5442';
export const TEST_PG_PORT = '5443';

export class TestPgPortRefusal extends Error {
  override readonly name = 'TestPgPortRefusal';
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The ONE exception: on a GitHub Actions runner 5442 is the job's own throwaway
 * postgres service container (.github/workflows/ci.yml publishes it there), not
 * the tm8 host's prod cluster. An unset port is refused there too. Moving the
 * CI service to 5443 needs a token with `workflow` scope — a follow-up.
 */
function onGithubRunner(env: Env): boolean {
  return env['GITHUB_ACTIONS'] === 'true';
}

const URL_VARS = ['TM8_W1_ADMIN_DATABASE_URL', 'TM8_MIGRATION_DATABASE_URL', 'TM8_DATABASE_URL'] as const;

function refuse(found: string, fix: string): never {
  throw new TestPgPortRefusal(
    `refusing to run: the test Postgres ${found}. ` +
      `5442 is the PROD cluster on the tm8 host and a test run must name its port explicitly. ` +
      `Set ${fix} — the test cluster is on ${TEST_PG_PORT}.`,
  );
}

/**
 * The configured admin URL, still pointing at whatever database it names
 * (w1-pg.ts swaps in TM8_ADMIN_DB). Throws TestPgPortRefusal; never connects.
 */
export function testAdminUrl(env: Env = process.env): string {
  for (const name of URL_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;
    const fix = `${name}=postgres://tm8@127.0.0.1:${TEST_PG_PORT}/postgres`;
    let port: string;
    try {
      port = new URL(value).port;
    } catch {
      return refuse(`URL in ${name} does not parse`, fix);
    }
    if (port === '') refuse(`URL in ${name} has no explicit port`, fix);
    if (port === PROD_PG_PORT && !onGithubRunner(env)) refuse(`URL in ${name} is on port ${PROD_PG_PORT}`, fix);
    return value;
  }
  const port = env['TM8_PG_PORT']?.trim();
  const fix = `TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:${TEST_PG_PORT}/postgres (or TM8_PG_PORT=${TEST_PG_PORT})`;
  if (!port) refuse(`port is unset (none of ${URL_VARS.join(', ')} or TM8_PG_PORT is set)`, fix);
  if (port === PROD_PG_PORT && !onGithubRunner(env)) refuse(`port is TM8_PG_PORT=${PROD_PG_PORT}`, fix);
  const user = env['TM8_PG_USER']?.trim() || 'tm8';
  return `postgres://${user}@127.0.0.1:${port}/postgres`;
}
