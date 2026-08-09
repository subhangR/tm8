/**
 * `tm8 doctor` — the preflight.
 *
 * Every check is driven through the injected `DoctorIo`, so each FAILURE branch
 * is exercised for real rather than inferred: a doctor whose failure paths are
 * untested is a doctor that reports PASS on the day it matters.
 *
 * Two properties are load-bearing and are asserted directly:
 *
 *  1. EVERY FAILURE CARRIES A REMEDY. A check that can only say "FAIL" has told
 *     the caller nothing they did not already know, so the shape is pinned for
 *     all of them at once rather than case by case.
 *  2. DOCTOR IS READ-ONLY. It is given an io whose every write-shaped call
 *     throws, and the `psql` invocations are asserted to carry
 *     `default_transaction_read_only=on` — read-only enforced by Postgres, not
 *     by this file's good intentions.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKS,
  checkAgentClis,
  checkDataDir,
  checkGit,
  checkMigrations,
  checkNode,
  checkPostgres,
  databaseUrl,
  dataDir,
  doctor,
  redactUrl,
  renderReport,
  runChecks,
  spawnableAgentTools,
  type CheckResult,
  type DoctorIo,
} from '../src/commands/doctor.js';
import { COMMANDS, isRegisteredPath } from '../src/commands/registry.js';
import { isCommandPath, COMMAND_PATHS } from '../src/discovery/operations.js';
import { createOutput, type Output } from '../src/output.js';
import { run } from '../src/run.js';
import type { CliContext } from '../src/context.js';

// ── harness ────────────────────────────────────────────────────────────────

const HEALTHY_BODY = JSON.stringify({
  ok: true,
  server: 'tm8-server',
  contractVersion: '0.1.0',
  operations: 125,
  implemented: 123,
  db: 'ok',
});

interface ExecCall {
  bin: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

let execCalls: ExecCall[] = [];

/**
 * The migration fixture. Bodies are hashed with the SAME sha256-over-bytes the
 * runner records, so the "current" case is current for the real reason rather
 * than because both sides are empty strings.
 */
const MIGRATION_BODIES: Record<string, string> = {
  '001_core_graph.sql': 'create table a();',
  '002_identity.sql': 'create table b();',
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ledgerRows = (bodies: Record<string, string>): string =>
  Object.entries(bodies)
    .map(([f, body]) => `${f}\u001f${sha(body)}`)
    .join('\n') + '\n';

/** An environment in which every check passes. Individual tests break one thing. */
function healthyIo(overrides: Partial<DoctorIo> = {}): DoctorIo {
  const base: DoctorIo = {
    which: async (bin) =>
      ({ claude: '/usr/local/bin/claude', codex: '/usr/local/bin/codex', psql: '/usr/bin/psql', git: '/usr/bin/git' })[
        bin
      ] ?? null,
    exec: async (bin, args, opts) => {
      execCalls.push({ bin, args, env: opts?.env });
      const sql = args[args.indexOf('-c') + 1] ?? '';
      if (bin.endsWith('psql')) {
        if (sql.includes('applied_migrations')) {
          return { code: 0, stdout: ledgerRows(MIGRATION_BODIES), stderr: '' };
        }
        return {
          code: 0,
          stdout: ['tm8_dev', 'subhang', '127.0.0.1', '5442', '18.1'].join('\u001f'),
          stderr: '',
        };
      }
      if (bin.endsWith('git')) {
        if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0', stderr: '' };
        if (args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true', stderr: '' };
        if (args.includes('--short')) return { code: 0, stdout: 'abc1234', stderr: '' };
        if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'main', stderr: '' };
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    http: async () => ({ status: 200, body: HEALTHY_BODY }),
    readFile: (p) => {
      if (p.endsWith('.claude.json')) return JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } });
      if (p.endsWith('auth.json')) return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-SECRET' });
      const body = MIGRATION_BODIES[p.split('/').pop() as string];
      if (body !== undefined) return body;
      throw new Error(`unexpected readFile ${p}`);
    },
    readDir: () => ['001_core_graph.sql', '002_identity.sql', 'README.md'],
    writable: () => true,
    exists: () => true,
    env: { HOME: '/home/t', USER: 'subhang', TM8_DATA_DIR: '/home/t/.tm8-dev' },
    repoRoot: '/repo',
    cwd: '/repo',
  };
  return { ...base, ...overrides };
}

const ctx = (baseUrl = 'http://127.0.0.1:4610'): CliContext =>
  ({
    space: undefined,
    actor: undefined,
    baseUrl: { value: baseUrl, source: 'implicit-local' },
    sessionId: undefined,
    token: undefined,
    format: 'human',
    timeoutMs: undefined,
    fresh: false,
  }) as CliContext;

const only = (r: readonly CheckResult[], name: string): CheckResult => {
  const found = r.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in ${r.map((c) => c.name).join(', ')}`);
  return found;
};

beforeEach(() => {
  execCalls = [];
});

// ── registration: the whole point of the investigation ─────────────────────

describe('doctor registers as a LOCAL command, never as a catalog operation', () => {
  it('is dispatchable', () => {
    expect(isRegisteredPath(['doctor'])).toBe(true);
    expect(COMMANDS.some((c) => c.path.join(' ') === 'doctor')).toBe(true);
  });

  /**
   * THE LOAD-BEARING NEGATIVE. If `doctor` ever appears in the operation
   * catalog this goes red, and it must: one catalog row costs a frozen count
   * pin, a pinned digest, a generated manifest and a grammar-completeness
   * guard, none of which a local diagnostic should ever pay.
   */
  it('is ABSENT from the operation catalog, and the catalog count is unmoved', () => {
    expect(isCommandPath(['doctor'])).toBe(false);
    // 123 -> 125: `worktree list|status`, both ALIASES over existing
    // operations. The command-path count moves and the CATALOG does not, which
    // is the very distinction this assertion is here to watch.
    expect(COMMAND_PATHS).toHaveLength(127);
  });

  it('is reachable through run() and never reports "unknown command"', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await run(['doctor', '--help']);
    expect(stderr.join('')).not.toMatch(/unknown command/);
    vi.restoreAllMocks();
  });

  it('refuses arguments rather than silently ignoring them', async () => {
    const out = createOutput({ format: 'json', streams: { stdout: () => {}, stderr: () => {} } });
    await expect(doctor({ args: ['--prod'], ctx: ctx(), out, io: healthyIo() })).rejects.toThrow(
      /takes no arguments/,
    );
  });
});

// ── the healthy path, and the exit contract ────────────────────────────────

describe('a healthy environment', () => {
  it('passes every check and exits 0', async () => {
    const report = await runChecks({ io: healthyIo(), ctx: ctx() });
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
  });

  it('covers all six subjects the preflight claims to check', async () => {
    const report = await runChecks({ io: healthyIo(), ctx: ctx() });
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'agent-cli:claude-code',
        'agent-cli:codex',
        'postgres',
        'migrations',
        'git',
        'git-repo',
        'data-dir',
        'node',
      ]),
    );
    expect(CHECKS).toHaveLength(6);
  });

  it('exits 0 and prints a passing summary line', async () => {
    const chunks: string[] = [];
    const out = createOutput({ format: 'human', streams: { stdout: (c) => chunks.push(String(c)), stderr: () => {} } });
    const code = await doctor({ args: [], ctx: ctx(), out, io: healthyIo() });
    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/^OK — \d+ of \d+ checks passed$/m);
  });

  it('exits NON-ZERO when any check fails, and says so on the summary line', async () => {
    const chunks: string[] = [];
    const out = createOutput({ format: 'human', streams: { stdout: (c) => chunks.push(String(c)), stderr: () => {} } });
    const io = healthyIo({ which: async (b) => (b === 'codex' ? null : '/usr/bin/' + b) });
    const code = await doctor({ args: [], ctx: ctx(), out, io });
    expect(code).not.toBe(0);
    expect(chunks.join('')).toMatch(/^FAIL — \d+ of \d+ checks failed$/m);
  });

  it('--format json emits the same DTO the human view renders', async () => {
    const chunks: string[] = [];
    const out = createOutput({ format: 'json', streams: { stdout: (c) => chunks.push(String(c)), stderr: () => {} } });
    await doctor({ args: [], ctx: ctx(), out, io: healthyIo() });
    const dto = JSON.parse(chunks.join('')) as { schemaVersion: string; checks: unknown[]; ok: boolean };
    expect(dto.schemaVersion).toBe('tm8.doctor.v1');
    expect(dto.ok).toBe(true);
    expect(dto.checks.length).toBeGreaterThan(0);
  });
});

// ── property 1: every failure is actionable ────────────────────────────────

describe('every failing check carries a remedy, not just a verdict', () => {
  it('holds across a comprehensively broken environment', async () => {
    const io = healthyIo({
      which: async () => null,
      http: async () => {
        throw new Error('ECONNREFUSED');
      },
      readDir: () => {
        throw new Error('ENOENT');
      },
      writable: () => false,
      exists: () => false,
      env: { HOME: '/home/t', TM8_DATA_DIR: '/nope/tm8' },
    });
    const report = await runChecks({ io, ctx: ctx() });
    expect(report.failed).toBeGreaterThanOrEqual(5);
    for (const c of report.checks) {
      if (c.status !== 'fail') continue;
      expect(c.remedy, `${c.name} failed with no remedy`).toBeTruthy();
      expect((c.remedy as string).length, c.name).toBeGreaterThan(20);
      // A remedy is a NEXT MOVE, so it names a command, a variable or a path.
      expect(c.remedy as string, c.name).toMatch(/`|TM8_|\//);
    }
  });

  it('renders the remedy under the failing line', () => {
    const text = renderReport({
      schemaVersion: 'tm8.doctor.v1',
      cliVersion: '0.1.0',
      checks: [{ name: 'x', title: 'a thing', status: 'fail', detail: 'it broke', remedy: 'fix it with `y`' }],
      failed: 1,
      ok: false,
    });
    expect(text).toMatch(/FAIL {2}a thing {2}it broke/);
    expect(text).toMatch(/→ fix it with `y`/);
  });
});

// ── property 2: read-only ──────────────────────────────────────────────────

describe('doctor never mutates anything', () => {
  it('pins the database session read-only at the SERVER, not by convention', async () => {
    await runChecks({ io: healthyIo(), ctx: ctx() });
    const psqlCalls = execCalls.filter((c) => c.bin.endsWith('psql'));
    expect(psqlCalls.length).toBeGreaterThan(0);
    for (const call of psqlCalls) {
      expect(call.env?.PGOPTIONS).toContain('default_transaction_read_only=on');
      // ON_ERROR_STOP so a refused write is a loud failure, never a partial run.
      expect(call.args).toContain('ON_ERROR_STOP=1');
    }
  });

  it('issues only SELECTs', async () => {
    await runChecks({ io: healthyIo(), ctx: ctx() });
    for (const call of execCalls.filter((c) => c.bin.endsWith('psql'))) {
      const sql = call.args[call.args.indexOf('-c') + 1] ?? '';
      expect(sql.trim().toLowerCase().startsWith('select'), sql).toBe(true);
    }
  });

  it('does NOT create the data dir when it is absent — it reports that first run will', async () => {
    const io = healthyIo({ exists: () => false, writable: (p) => p === '/home/t' });
    const r = only(await checkDataDir({ io, ctx: ctx() }), 'data-dir');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/absent.*first run will create it/);
  });

  it('never invokes an agent CLI to ask whether it is logged in', async () => {
    await checkAgentClis({ io: healthyIo(), ctx: ctx() });
    expect(execCalls.filter((c) => /claude|codex/.test(c.bin))).toEqual([]);
  });

  it('never prints a secret out of a credential file', async () => {
    const r = await checkAgentClis({ io: healthyIo(), ctx: ctx() });
    expect(JSON.stringify(r)).not.toContain('sk-SECRET');
    expect(JSON.stringify(r)).not.toContain('OPENAI_API_KEY');
  });
});

// ── 1. agent CLIs ──────────────────────────────────────────────────────────

describe('agent CLIs — the exit-127 outage', () => {
  it('derives the tool set from the contract catalog, not a hardcoded list', () => {
    expect(spawnableAgentTools()).toEqual(['claude-code', 'codex']);
  });

  it('names exit 127 AND the boot-settlement message the user actually saw', async () => {
    const io = healthyIo({ which: async (b) => (b === 'claude' ? null : '/usr/bin/' + b) });
    const r = only(await checkAgentClis({ io, ctx: ctx() }), 'agent-cli:claude-code');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/127/);
    expect(r.detail).toMatch(/boot settlement/);
    expect(r.remedy).toMatch(/install/);
  });

  it('reports auth state when it is cheaply readable', async () => {
    const r = await checkAgentClis({ io: healthyIo(), ctx: ctx() });
    expect(only(r, 'agent-cli:claude-code').detail).toContain('authenticated');
    expect(only(r, 'agent-cli:codex').detail).toContain('auth_mode=chatgpt');
  });

  it('says UNKNOWN rather than guessing when the credential is in the Keychain', async () => {
    const io = healthyIo({
      readFile: (p) => (p.endsWith('.claude.json') ? '{}' : JSON.stringify({ auth_mode: 'x' })),
    });
    const r = only(await checkAgentClis({ io, ctx: ctx() }), 'agent-cli:claude-code');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/auth unknown/);
    expect(r.detail).toMatch(/Keychain/);
  });

  it('reports codex as NOT authenticated when auth.json is absent', async () => {
    const io = healthyIo({ exists: (p) => !p.endsWith('auth.json') });
    const r = only(await checkAgentClis({ io, ctx: ctx() }), 'agent-cli:codex');
    expect(r.detail).toMatch(/NOT authenticated/);
  });

  it('checks TM8_AGENT_CMD instead of the per-tool binaries when the operator forced one', async () => {
    const io = healthyIo({
      env: { HOME: '/home/t', TM8_AGENT_CMD: 'my-wrapper --flag' },
      which: async (b) => (b === 'my-wrapper' ? '/opt/my-wrapper' : null),
    });
    const r = await checkAgentClis({ io, ctx: ctx() });
    expect(r).toHaveLength(1);
    expect(only(r, 'agent-cli').status).toBe('pass');
  });

  it('fails when TM8_AGENT_CMD names a binary that is not there', async () => {
    const io = healthyIo({ env: { HOME: '/home/t', TM8_AGENT_CMD: 'ghost' }, which: async () => null });
    const r = only(await checkAgentClis({ io, ctx: ctx() }), 'agent-cli');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/127/);
  });
});

// ── 2. postgres ────────────────────────────────────────────────────────────

describe('postgres — connect, do not ask pg_isready', () => {
  it('resolves the URL exactly as db/migrate.mjs does', () => {
    expect(databaseUrl({})).toBe('postgres://postgres@127.0.0.1:5442/tm8_dev');
    expect(databaseUrl({ USER: 'me' })).toBe('postgres://me@127.0.0.1:5442/tm8_dev');
    expect(databaseUrl({ TM8_PG_PORT: '5443', TM8_DB: 'tm8_x', USER: 'me' })).toBe(
      'postgres://me@127.0.0.1:5443/tm8_x',
    );
    expect(databaseUrl({ TM8_DATABASE_URL: 'postgres://a@h:1/d', USER: 'me' })).toBe('postgres://a@h:1/d');
    expect(databaseUrl({ DATABASE_URL: 'postgres://b@h:2/d' })).toBe('postgres://b@h:2/d');
  });

  /**
   * The multi-cluster trap: a bare `psql` can hit the wrong one of several
   * local clusters. So the resolved identity is read back from the SERVER's own
   * answer, not echoed from the string we sent.
   */
  it('reports the host/port/database the server itself reports', async () => {
    const r = only(await checkPostgres({ io: healthyIo(), ctx: ctx() }), 'postgres');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('tm8_dev');
    expect(r.detail).toContain('127.0.0.1:5442');
    expect(r.detail).toContain('PostgreSQL 18.1');
  });

  it('actually runs a query rather than probing liveness', async () => {
    await checkPostgres({ io: healthyIo(), ctx: ctx() });
    const sql = execCalls.map((c) => c.args[c.args.indexOf('-c') + 1] ?? '').join(' ');
    expect(sql).toContain('current_database()');
    expect(execCalls.some((c) => c.bin.includes('pg_isready'))).toBe(false);
  });

  it('an AUTH failure fails the check and says pg_isready would have lied', async () => {
    const io = healthyIo({
      exec: async () => ({ code: 2, stdout: '', stderr: 'psql: error: FATAL:  password authentication failed' }),
    });
    const r = only(await checkPostgres({ io, ctx: ctx() }), 'postgres');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/authentication failed/);
    expect(r.remedy).toMatch(/pg_isready/);
  });

  it('an unreachable cluster points at the multi-cluster trap', async () => {
    const io = healthyIo({
      exec: async () => ({ code: 2, stdout: '', stderr: 'psql: error: connection refused' }),
    });
    const r = only(await checkPostgres({ io, ctx: ctx() }), 'postgres');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/TM8_PG_PORT|more than one/);
  });

  it('a missing psql names TM8_PSQL rather than failing opaquely', async () => {
    const io = healthyIo({ which: async () => null, exists: () => false });
    const r = only(await checkPostgres({ io, ctx: ctx() }), 'postgres');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/TM8_PSQL/);
  });

  it('redacts a password out of a connection string before it reaches stdout', () => {
    expect(redactUrl('postgres://u:hunter2@h:5442/db')).toBe('postgres://u:***@h:5442/db');
    expect(redactUrl('postgres://u@h:5442/db')).toBe('postgres://u@h:5442/db');
  });
});

// ── 3. migrations ──────────────────────────────────────────────────────────

describe('migrations — drift named in BOTH directions', () => {
  it('passes when disk and ledger agree', async () => {
    const r = only(await checkMigrations({ io: healthyIo(), ctx: ctx() }), 'migrations');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/2 migration\(s\) on disk, all applied/);
  });

  it('names PENDING files (disk ahead of database) and how to apply them', async () => {
    const io = healthyIo({ readDir: () => ['001_core_graph.sql', '002_identity.sql', '003_read_model.sql'] });
    const r = only(await checkMigrations({ io, ctx: ctx() }), 'migrations');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/1 PENDING/);
    expect(r.detail).toContain('003_read_model.sql');
    expect(r.remedy).toMatch(/db\/migrate\.mjs up/);
  });

  /**
   * The other direction is not noise: a row with no file means the DATABASE is
   * ahead of the tree, which is what a branch switch produces, and applying
   * nothing would "fix" it into silent breakage.
   */
  it('names APPLIED-BUT-ABSENT rows (database ahead of tree) as its own diagnosis', async () => {
    const io = healthyIo({ readDir: () => ['001_core_graph.sql'] });
    const r = only(await checkMigrations({ io, ctx: ctx() }), 'migrations');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/APPLIED BUT ABSENT/);
    expect(r.detail).toContain('002_identity.sql');
    expect(r.remedy).toMatch(/AHEAD of the tree/);
  });

  /**
   * THE FALSE-PASS CASE. Same filename on both sides, different bytes. A
   * name-only comparison reports "all applied" while the database does not have
   * the schema the tree describes — so this is asserted against a fixture whose
   * NAMES agree perfectly.
   */
  it('catches a migration EDITED AFTER it was applied, which names alone call current', async () => {
    const io = healthyIo({
      readFile: (p) =>
        p.endsWith('002_identity.sql') ? 'create table b(); -- edited after apply' : healthyIo().readFile(p),
    });
    const r = only(await checkMigrations({ io, ctx: ctx() }), 'migrations');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/1 EDITED AFTER APPLY/);
    expect(r.detail).toContain('002_identity.sql');
    expect(r.detail).not.toMatch(/PENDING|ABSENT/);
    expect(r.remedy).toMatch(/never edit an applied one/);
  });

  it('uses the same sha256-over-bytes the migration runner records', async () => {
    // Non-vacuity: the healthy fixture is "current" because the hashes MATCH,
    // not because both sides are empty.
    expect(sha(MIGRATION_BODIES['001_core_graph.sql'] as string)).toHaveLength(64);
    const r = only(await checkMigrations({ io: healthyIo(), ctx: ctx() }), 'migrations');
    expect(r.status).toBe('pass');
  });

  it('ignores non-migration files in the directory', async () => {
    const io = healthyIo({ readDir: () => ['001_core_graph.sql', '002_identity.sql', 'README.md', '.DS_Store'] });
    expect(only(await checkMigrations({ io, ctx: ctx() }), 'migrations').status).toBe('pass');
  });

  it('a never-migrated database is diagnosed as such, not as generic drift', async () => {
    const io = healthyIo({
      exec: async (bin, args, opts) => {
        execCalls.push({ bin, args, env: opts?.env });
        return { code: 3, stdout: '', stderr: 'ERROR:  relation "public.applied_migrations" does not exist' };
      },
    });
    const r = only(await checkMigrations({ io, ctx: ctx() }), 'migrations');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/never been migrated/);
  });

  it('a missing migrations directory is a clear failure, not a silent pass', async () => {
    const io = healthyIo({
      readDir: () => {
        throw new Error('ENOENT');
      },
    });
    const r = only(await checkMigrations({ io, ctx: ctx() }), 'migrations');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/TM8_MIGRATIONS_DIR/);
  });
});

// ── 4. git ─────────────────────────────────────────────────────────────────

describe('git', () => {
  it('passes with the version, the HEAD and the branch a spawn would branch from', async () => {
    const r = await checkGit({ io: healthyIo(), ctx: ctx() });
    expect(only(r, 'git').detail).toMatch(/git version 2\.45\.0/);
    expect(only(r, 'git-repo').detail).toMatch(/abc1234 on main \(clean\)/);
  });

  it('reports uncommitted changes rather than only clean/absent', async () => {
    const io = healthyIo({
      exec: async (bin, args, opts) => {
        execCalls.push({ bin, args, env: opts?.env });
        if (args[0] === 'status') return { code: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '' };
        return healthyIo().exec(bin, args, opts);
      },
    });
    expect(only(await checkGit({ io, ctx: ctx() }), 'git-repo').detail).toMatch(/2 uncommitted change/);
  });

  it('calls out a DETACHED HEAD, which a branch-scoped spawn cannot use', async () => {
    const io = healthyIo({
      exec: async (bin, args, opts) => {
        execCalls.push({ bin, args, env: opts?.env });
        if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'HEAD', stderr: '' };
        return healthyIo().exec(bin, args, opts);
      },
    });
    expect(only(await checkGit({ io, ctx: ctx() }), 'git-repo').detail).toMatch(/DETACHED HEAD/);
  });

  it('a missing git is one failure and does not cascade into a bogus repo verdict', async () => {
    const io = healthyIo({ which: async () => null });
    const r = await checkGit({ io, ctx: ctx() });
    expect(r).toHaveLength(1);
    expect(only(r, 'git').status).toBe('fail');
  });

  it('a non-repository directory fails the work-tree check', async () => {
    const io = healthyIo({
      exec: async (bin, args, opts) => {
        execCalls.push({ bin, args, env: opts?.env });
        if (args[1] === '--is-inside-work-tree') return { code: 128, stdout: '', stderr: 'not a git repository' };
        if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(only(await checkGit({ io, ctx: ctx() }), 'git-repo').status).toBe('fail');
  });

  it('an unborn HEAD is diagnosed, because a worktree cannot be allocated from one', async () => {
    const io = healthyIo({
      exec: async (bin, args, opts) => {
        execCalls.push({ bin, args, env: opts?.env });
        if (args[0] === '--version') return { code: 0, stdout: 'git version 2.45.0', stderr: '' };
        if (args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true', stderr: '' };
        if (args.includes('--short')) return { code: 128, stdout: '', stderr: 'unknown revision' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const r = only(await checkGit({ io, ctx: ctx() }), 'git-repo');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/unborn HEAD/);
  });
});

// ── 5. data dir ────────────────────────────────────────────────────────────

describe('data dir', () => {
  it('defaults to the dev dir the sidecar uses', () => {
    expect(dataDir({ HOME: '/home/t' })).toBe('/home/t/.tm8-dev');
    expect(dataDir({ HOME: '/home/t', TM8_DATA_DIR: '/other' })).toBe('/other');
  });

  it('fails an existing-but-unwritable dir with a permissions remedy', async () => {
    const io = healthyIo({ writable: () => false });
    const r = only(await checkDataDir({ io, ctx: ctx() }), 'data-dir');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/chmod|TM8_DATA_DIR/);
  });

  it('fails an absent dir whose parent is also unwritable', async () => {
    const io = healthyIo({ exists: () => false, writable: () => false });
    const r = only(await checkDataDir({ io, ctx: ctx() }), 'data-dir');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/parent .* is not writable/);
  });

  it('refuses a relative TM8_DATA_DIR, which the sidecar itself refuses', async () => {
    const io = healthyIo({ env: { HOME: '/home/t', TM8_DATA_DIR: './data' } });
    const r = only(await checkDataDir({ io, ctx: ctx() }), 'data-dir');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/not absolute/);
  });
});

// ── 6. the node ────────────────────────────────────────────────────────────

describe('the configured node — a 200 is not proof', () => {
  it('reports the RESOLVED base url and where it came from', async () => {
    const r = only(await checkNode({ io: healthyIo(), ctx: ctx('http://127.0.0.1:7777') }), 'node');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('http://127.0.0.1:7777');
    expect(r.detail).toContain('implicit-local');
  });

  it('reports the build identity, so two nodes are told apart', async () => {
    const r = only(await checkNode({ io: healthyIo(), ctx: ctx() }), 'node');
    expect(r.detail).toMatch(/server=tm8-server/);
    expect(r.detail).toMatch(/contract=0\.1\.0/);
    expect(r.detail).toMatch(/operations=125/);
    expect(r.detail).toMatch(/implemented=123/);
    expect(r.detail).toMatch(/db=ok/);
  });

  /**
   * THE ZOMBIE. A failed boot can leave a process holding the port that still
   * answers /health. A check that stopped at the status code would certify it.
   */
  it('FAILS a 200 whose body does not identify a tm8 server, and says to find the process', async () => {
    const io = healthyIo({ http: async () => ({ status: 200, body: '<html>nginx</html>' }) });
    const r = only(await checkNode({ io, ctx: ctx('http://127.0.0.1:4610') }), 'node');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/does not identify a tm8 server/);
    expect(r.remedy).toMatch(/zombie/);
    expect(r.remedy).toMatch(/lsof/);
    expect(r.remedy).toContain('4610');
  });

  it('FAILS a 503 that self-reports an unhealthy database, and points at the pool', async () => {
    const io = healthyIo({
      http: async () => ({
        status: 503,
        body: JSON.stringify({ ok: false, server: 'tm8-server', contractVersion: '0.1.0', db: 'unavailable' }),
      }),
    });
    const r = only(await checkNode({ io, ctx: ctx() }), 'node');
    expect(r.status).toBe('fail');
    expect(r.remedy).toMatch(/idle in transaction/);
  });

  it('FAILS a node wired without a database, which can only serve 501s', async () => {
    const io = healthyIo({
      http: async () => ({ status: 200, body: JSON.stringify({ ok: true, server: 'tm8-server', operations: 125 }) }),
    });
    const r = only(await checkNode({ io, ctx: ctx() }), 'node');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/NO database probe/);
  });

  it('an unreachable node names TM8_BASE_URL and the config file', async () => {
    const io = healthyIo({
      http: async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      },
    });
    const r = only(await checkNode({ io, ctx: ctx() }), 'node');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/ECONNREFUSED/);
    expect(r.remedy).toMatch(/TM8_BASE_URL/);
    expect(r.remedy).toMatch(/config\.json/);
  });

  it('warns on contract drift between this CLI and the node', async () => {
    const io = healthyIo({
      http: async () => ({
        status: 200,
        body: JSON.stringify({ ok: true, server: 'tm8-server', contractVersion: '9.9.9', db: 'ok' }),
      }),
    });
    const r = only(await checkNode({ io, ctx: ctx() }), 'node');
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/WARNING: this CLI is built against contract 0\.1\.0/);
  });

  it('probes /health exactly once and nothing else', async () => {
    const urls: string[] = [];
    const io = healthyIo({
      http: async (u) => {
        urls.push(u);
        return { status: 200, body: HEALTHY_BODY };
      },
    });
    await runChecks({ io, ctx: ctx('http://127.0.0.1:4610/') });
    expect(urls).toEqual(['http://127.0.0.1:4610/health']);
  });
});
