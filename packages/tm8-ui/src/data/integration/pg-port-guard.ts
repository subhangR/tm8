/**
 * The ONE place this lane's real-node fixture (./node-fixture.ts) resolves its
 * Postgres port.
 *
 * DB SAFETY (standing rule, 2026-09-25): a test harness must never default to
 * 5442. On the tm8 host 5442 is the PROD cluster; the test cluster is 5443.
 * The old fallback here was `TM8_PG_PORT ?? '5442'`. This REFUSES, before any
 * psql call, when TM8_PG_PORT is 5442 or is not set at all.
 *
 * Pure (no `process` reference) so the unit test and the package's own
 * `vitest run` can import it without the integration aliases.
 */

export const PROD_PG_PORT = '5442';
export const TEST_PG_PORT = '5443';

export class TestPgPortRefusal extends Error {
  override readonly name = 'TestPgPortRefusal';
}

type Env = Readonly<Record<string, string | undefined>>;

/** TM8_PG_PORT, refused when unset or 5442. Never connects. */
export function testPgPort(env: Env): string {
  const port = env['TM8_PG_PORT']?.trim();
  // The one exception: a GitHub Actions runner's own postgres container on 5442.
  if (port && (port !== PROD_PG_PORT || env['GITHUB_ACTIONS'] === 'true')) return port;
  throw new TestPgPortRefusal(
    `refusing to run: the test Postgres port is ${port ? `TM8_PG_PORT=${port}` : 'unset (TM8_PG_PORT)'}. ` +
      `5442 is the PROD cluster on the tm8 host and a test run must name its port explicitly. ` +
      `Set TM8_PG_PORT=${TEST_PG_PORT} — the test cluster is on ${TEST_PG_PORT}.`,
  );
}
