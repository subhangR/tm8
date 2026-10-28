/**
 * db/migrate.mjs's target guard (db/target.mjs, task 01a0e759) — NO database.
 *
 * The 2026-09-28 incident: `TM8_MIGRATION_DATABASE_URL=… node db/migrate.mjs up`
 * with nothing else set fell back to 127.0.0.1:5442/tm8_dev and migrated the
 * dev database on the PROD cluster. These cells pin the replacement:
 *
 *   a1  no explicit target → non-zero exit before psql is even looked for;
 *   a2  port 5442 refused without --i-mean-prod, accepted with it (and on a
 *       GitHub Actions runner, whose 5442 is the job's own container);
 *   a3  only host:port/db is printed — never a user or a password.
 *
 * The spawned runner gets TM8_PSQL = a recording shim that fails every call, so
 * nothing here can connect anywhere: "psql was called" is the marker file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { MigrateTargetRefusal, describeTarget, portOf, resolveMigrateTarget } from '../../../../db/target.mjs';
import type { ResolvedSidecarConfig } from '../../src/sidecar/config.js';
import { MIGRATE_I_MEAN_PROD, runSchemaMigrations } from '../../src/sidecar/migrate.js';
import { REPO_ROOT } from './w1-pg.js';

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tm8-migrate-target-'));
  scratch.push(d);
  return d;
}

const refusal = (env: Record<string, string>, iMeanProd = false): string => {
  try {
    resolveMigrateTarget(env, { iMeanProd });
  } catch (error) {
    expect(error).toBeInstanceOf(MigrateTargetRefusal);
    return (error as Error).message;
  }
  return 'accepted';
};

describe('resolveMigrateTarget — a1: no implicit default', () => {
  it('refuses with nothing set, and with a port but no database, or a database but no port', () => {
    expect(refusal({ USER: 'tm8' })).toMatch(/no explicit target/);
    expect(refusal({ USER: 'tm8', TM8_PG_PORT: '5443' })).toMatch(/no explicit target/);
    expect(refusal({ USER: 'tm8', TM8_DB: 'tm8_x' })).toMatch(/no explicit target/);
  });

  it('names a harness variable that is set but not read, instead of ignoring it (the incident)', () => {
    const message = refusal({ USER: 'tm8', TM8_MIGRATION_DATABASE_URL: 'postgres://tm8@127.0.0.1:5497/l2' });
    expect(message).toMatch(/TM8_MIGRATION_DATABASE_URL is set, but that is a test harness's variable/);
    expect(refusal({ TM8_W1_ADMIN_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/postgres' })).toMatch(/TM8_W1_ADMIN_DATABASE_URL/);
  });

  it('positive: TM8_DATABASE_URL, DATABASE_URL, or TM8_PG_PORT with TM8_DB', () => {
    expect(resolveMigrateTarget({ TM8_DATABASE_URL: 'postgres://a@h:5443/d', DATABASE_URL: 'postgres://b@h:1/x' })).toEqual({
      url: 'postgres://a@h:5443/d', source: 'TM8_DATABASE_URL',
    });
    expect(resolveMigrateTarget({ DATABASE_URL: 'postgres://b@h:5444/d' }).source).toBe('DATABASE_URL');
    expect(resolveMigrateTarget({ TM8_PG_PORT: '5443', TM8_DB: 'tm8_x', USER: 'me' }).url).toBe('postgres://me@127.0.0.1:5443/tm8_x');
    // An explicit target wins over a harness variable — that is how CI jobs set both.
    expect(resolveMigrateTarget({ TM8_DATABASE_URL: 'postgres://a@h:5443/d', TM8_MIGRATION_DATABASE_URL: 'postgres://a@h:5443/postgres' }).url)
      .toBe('postgres://a@h:5443/d');
  });
});

describe('resolveMigrateTarget — a2: 5442 needs --i-mean-prod', () => {
  const prod = { TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1:5442/tm8_dev' };

  it('refuses 5442 from a URL, from TM8_PG_PORT, and from a socket URL\'s ?port=', () => {
    expect(refusal(prod)).toMatch(/127\.0\.0\.1:5442\/tm8_dev \(from TM8_DATABASE_URL\) is on port 5442.*--i-mean-prod/);
    expect(refusal({ TM8_PG_PORT: '5442', TM8_DB: 'tm8_dev', USER: 'tm8' })).toMatch(/port 5442/);
    expect(refusal({ TM8_DATABASE_URL: 'postgresql://tm8@/tm8?host=%2Ftmp%2Fsock&port=5442' })).toMatch(/port 5442/);
    // A URL with no port connects to $PGPORT — which counts.
    expect(refusal({ TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1/tm8_dev', PGPORT: '5442' })).toMatch(/port 5442/);
    expect(resolveMigrateTarget({ TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1/tm8_dev', PGPORT: '5443' }).source).toBe('TM8_DATABASE_URL');
  });

  it('positive: the same targets with --i-mean-prod, and 5442 on a GitHub Actions runner', () => {
    expect(resolveMigrateTarget(prod, { iMeanProd: true }).url).toBe(prod.TM8_DATABASE_URL);
    expect(resolveMigrateTarget({ TM8_PG_PORT: '5442', TM8_DB: 'tm8_dev', USER: 'tm8' }, { iMeanProd: true }).url)
      .toBe('postgres://tm8@127.0.0.1:5442/tm8_dev');
    expect(resolveMigrateTarget({ ...prod, GITHUB_ACTIONS: 'true' }).url).toBe(prod.TM8_DATABASE_URL);
    expect(resolveMigrateTarget({ TM8_DATABASE_URL: 'postgres://tm8@127.0.0.1:5443/x' }).url).toBe('postgres://tm8@127.0.0.1:5443/x');
  });
});

describe('describeTarget — a3: host:port/db only', () => {
  it('drops user and password, and reads a socket URL\'s host and port', () => {
    expect(describeTarget('postgres://tm8:hunter2@127.0.0.1:5443/tm8_x')).toBe('127.0.0.1:5443/tm8_x');
    expect(describeTarget('postgresql://tm8@/tm8?host=%2Ftmp%2Fsock&port=5442')).toBe('/tmp/sock:5442/tm8');
    expect(portOf('postgres://h/d')).toBe('');
  });
});

describe('db/migrate.mjs, spawned — refuses before psql; prints only host:port/db', () => {
  function shim(): { psql: string; marker: string } {
    const dir = tempDir();
    const marker = join(dir, 'psql-was-called');
    const psql = join(dir, 'psql');
    writeFileSync(psql, `#!/bin/sh\ntouch '${marker}'\necho 'shim: no database here' >&2\nexit 2\n`, { mode: 0o755 });
    return { psql, marker };
  }
  const runner = (env: Record<string, string>, ...args: string[]) => {
    const { psql, marker } = shim();
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'db', 'migrate.mjs'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', USER: 'tm8', TM8_PSQL: psql, ...env },
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}`, psqlCalled: existsSync(marker) };
  };

  it('a1: no target (only the harness variable, as in the incident) → exit 1, psql never touched', () => {
    const r = runner({ TM8_MIGRATION_DATABASE_URL: 'postgres://tm8@127.0.0.1:5497/l2_t42q' }, 'up');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/refusing to run: no explicit target.*TM8_MIGRATION_DATABASE_URL is set/);
    expect(r.psqlCalled).toBe(false);
  });

  it('a2: 5442 without the flag → exit 1, psql never touched; with --i-mean-prod it goes on to psql', () => {
    const url = 'postgres://tm8:hunter2@127.0.0.1:5442/tm8_dev';
    const refused = runner({ TM8_DATABASE_URL: url }, 'up');
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/is on port 5442/);
    expect(refused.psqlCalled).toBe(false);

    const allowed = runner({ TM8_DATABASE_URL: url }, 'up', '--i-mean-prod');
    expect(allowed.psqlCalled).toBe(true); // it went on — to the shim, which fails every call
    expect(allowed.out).toContain('target: 127.0.0.1:5442/tm8_dev');
    // a3: the password and the user never reach the output.
    expect(allowed.out).not.toContain('hunter2');
    expect(allowed.out).not.toContain('tm8:');
  });

  it('help needs no target', () => {
    const r = runner({}, 'help');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no default/i);
  });
});

describe('the sidecar passes --i-mean-prod for its own 5442 cluster, and only then', () => {
  async function argsFor(pgPort: number): Promise<string[]> {
    const dir = tempDir();
    const fake = join(dir, 'migrate.mjs');
    writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const cfg = {
      repoRoot: dir, socketDir: join(dir, 'sock'), pgPort, database: 'tm8', superuser: 'tm8', appRole: 'tm8_app',
      binariesDir: join(dir, 'bin'), dataDir: dir, pgMajor: 16,
    } as unknown as ResolvedSidecarConfig;
    const outcome = await runSchemaMigrations(cfg, { runnerPath: fake });
    return JSON.parse(outcome.stdout ?? '[]') as string[];
  }

  it('5442 → up --i-mean-prod; 5443 → up', async () => {
    expect(await argsFor(5442)).toEqual(['up', MIGRATE_I_MEAN_PROD]);
    expect(await argsFor(5443)).toEqual(['up']);
  });
});
