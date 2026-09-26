/**
 * The ONE place the CLI integration suites resolve their admin Postgres URL.
 *
 * DB SAFETY (standing rule, 2026-09-25): a test harness must never default to
 * 5442. On the tm8 host 5442 is the PROD cluster; the test cluster is 5443.
 * The old fallback here was `TM8_PG_PORT ?? '5442'`, copied into seven files,
 * and a run without TM8_PG_PORT created and dropped scratch `tm8_w4_*`
 * databases on prod. So the resolution below REFUSES, before any connection is
 * attempted, when the port it lands on is 5442 or is not set at all:
 *
 *   TM8_W4_ADMIN_DATABASE_URL → TM8_MIGRATION_DATABASE_URL → 127.0.0.1:$TM8_PG_PORT
 *
 * An explicit URL must carry an explicit port that is not 5442. With no URL,
 * TM8_PG_PORT must be set and must not be 5442. CI's postgres service is the
 * runner's own container on 5442, which `onGithubRunner` below admits.
 *
 * The product default in packages/cli/src/commands/doctor.ts stays 5442 — that
 * is the sidecar a real install runs, and this guard is for tests only.
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

function refuse(found: string, fix: string): never {
  throw new TestPgPortRefusal(
    `refusing to run: the test Postgres ${found}. ` +
      `5442 is the PROD cluster on the tm8 host and a test run must name its port explicitly. ` +
      `Set ${fix} — the test cluster is on ${TEST_PG_PORT}.`,
  );
}

/** Admin URL for scratch-database create/drop. Throws TestPgPortRefusal; never connects. */
export function testAdminUrl(env: Env = process.env): string {
  for (const name of ['TM8_W4_ADMIN_DATABASE_URL', 'TM8_MIGRATION_DATABASE_URL'] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    const fix = `${name}=postgres://tm8@127.0.0.1:${TEST_PG_PORT}/postgres (or unset it and set TM8_PG_PORT=${TEST_PG_PORT})`;
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
  const fix = `TM8_PG_PORT=${TEST_PG_PORT}`;
  if (!port) refuse('port is unset (TM8_PG_PORT, TM8_W4_ADMIN_DATABASE_URL and TM8_MIGRATION_DATABASE_URL are all empty)', fix);
  if (port === PROD_PG_PORT && !onGithubRunner(env)) refuse(`port is TM8_PG_PORT=${PROD_PG_PORT}`, fix);
  const user = env['TM8_PG_USER']?.trim() || 'tm8';
  return `postgres://${user}@127.0.0.1:${port}/postgres`;
}
