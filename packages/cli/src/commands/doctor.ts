/**
 * `tm8 doctor` — the preflight.
 *
 * WHY THIS IS NOT A CATALOG OPERATION. Every check here is answered LOCALLY:
 * by looking at PATH, at the filesystem, at `db/migrations`, or by making one
 * diagnostic probe at a database and a node. None of it is a Server capability,
 * so none of it belongs in `src/discovery/operations.ts`. It registers exactly
 * the way `help` and `completion` do — a `CommandModule` in
 * `./registry.ts`'s DISCOVERY set, dispatched by `run.ts` without ever
 * consulting the catalog. See the header of `registry.ts` for the two-registry
 * split that makes this legal.
 *
 * EVERY CHECK HERE IS A REAL OUTAGE THIS PROJECT ALREADY HAD:
 *
 *  - AGENT CLIs. A production box had no agent CLI installed at all. Spawns
 *    died with exit 127 and the user was shown a "boot settlement window"
 *    message, so the visible symptom was a slow start, not a missing binary.
 *  - POSTGRES. `pg_isready` answers OK while authentication is failing, so an
 *    isready probe is worthless — this one CONNECTS and runs a query. And a dev
 *    machine has more than one cluster, so a bare `psql` can silently hit the
 *    wrong one: the resolved host/port/database is reported, from the server's
 *    own answer rather than from the string we sent.
 *  - MIGRATIONS. `db/migrations` on disk vs `public.applied_migrations` in the
 *    target database, named in BOTH directions — pending files are a stale
 *    database, and applied-but-absent rows are a database ahead of the tree
 *    (the shape a branch switch produces). Checksums are compared too, because
 *    a file edited after it was applied has the same NAME on both sides and is
 *    the one drift a name-only comparison reports as PASS.
 *  - THE NODE. A failed boot can leave a zombie holding the port that still
 *    answers `/health`, so a 200 is not proof. The build identity in the body
 *    is reported, and a body that does not identify itself as tm8-server fails.
 *
 * READ-ONLY, STRUCTURALLY. No check creates a directory, writes a file, or
 * mutates a row. The database probe additionally runs under
 * `default_transaction_read_only=on` so that "read-only" is enforced by
 * Postgres rather than by this file's good intentions, and the data-dir check
 * asks `access(W_OK)` rather than proving writability by writing.
 *
 * NO PLUGIN FRAMEWORK. `CHECKS` is a flat array of functions. Adding a check is
 * adding a function and one array entry.
 */
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import { CLI_VERSION } from '../discovery/help.js';
import { EXIT_OK, EXIT_USAGE, CliError, type ExitCode } from '../exit.js';
import type { Output } from '../output.js';
import type { CliContext } from '../context.js';

// ── the result shape ───────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail';

export interface CheckResult {
  /** Stable machine name — scripts branch on this, not on the human title. */
  readonly name: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** What was actually observed. Present on pass AND fail. */
  readonly detail: string;
  /**
   * The next command to run. REQUIRED on a failure: a check that can only say
   * "FAIL" has told the caller nothing they did not already know.
   */
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 'tm8.doctor.v1';
  readonly cliVersion: string;
  readonly checks: readonly CheckResult[];
  readonly failed: number;
  readonly ok: boolean;
}

const pass = (name: string, title: string, detail: string): CheckResult => ({
  name,
  title,
  status: 'pass',
  detail,
});

const fail = (name: string, title: string, detail: string, remedy: string): CheckResult => ({
  name,
  title,
  status: 'fail',
  detail,
  remedy,
});

// ── the IO seam ────────────────────────────────────────────────────────────

/**
 * Everything that leaves this process, in one narrow interface so the tests can
 * drive every branch without a Postgres, a node, or a particular PATH. This is
 * NOT a plugin surface — it is the four syscalls the checks make.
 */
export interface DoctorIo {
  /** Resolve a binary on PATH. `null` when absent. */
  which(bin: string): Promise<string | null>;
  /** Run argv (never a shell string). Resolves with the exit code, never rejects. */
  exec(
    bin: string,
    args: readonly string[],
    opts?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** GET a URL with a hard timeout. Rejects only on transport failure. */
  http(url: string, timeoutMs: number): Promise<{ status: number; body: string }>;
  readFile(path: string): string;
  readDir(path: string): string[];
  /** True when the path exists and the caller may write into it. */
  writable(path: string): boolean;
  exists(path: string): boolean;
  env: NodeJS.ProcessEnv;
  /** Where `db/migrations` and the git repo are looked for. */
  repoRoot: string;
  cwd: string;
}

/**
 * `packages/cli/{src,dist}/commands/doctor.{ts,js}` is four levels below the
 * repo root either way, which is the same trick `echoAgentPath` uses to survive
 * the src/dist split.
 */
export function defaultRepoRoot(): string {
  return dirname(fileURLToPath(new URL('../../../../package.json', import.meta.url)));
}

function run(
  bin: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args as string[],
      {
        cwd: opts.cwd,
        // No `shell`. execFile's default (false) is the point: no token in
        // `args` is ever seen by a shell.
        timeout: opts.timeoutMs ?? 10_000,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: opts.env ?? process.env,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? 127
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function defaultIo(): DoctorIo {
  return {
    which: async (bin) => {
      const r = await run('/usr/bin/env', ['sh', '-c', `command -v ${JSON.stringify(bin)}`], {
        timeoutMs: 5_000,
      });
      const first = r.stdout.split('\n')[0]?.trim();
      return r.code === 0 && first ? first : null;
    },
    exec: run,
    http: async (url, timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    readDir: (p) => readdirSync(p),
    writable: (p) => {
      try {
        if (!statSync(p).isDirectory()) return false;
        accessSync(p, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    exists: (p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    env: process.env,
    repoRoot: defaultRepoRoot(),
    cwd: process.cwd(),
  };
}

export interface CheckInput {
  readonly io: DoctorIo;
  readonly ctx: CliContext;
}

export type Check = (input: CheckInput) => Promise<CheckResult[]>;

// ── 1. agent CLIs ──────────────────────────────────────────────────────────

/**
 * tool → binary. Mirrors `AGENT_TOOL_BINARIES` in
 * `packages/execution/src/spawn/manifest.ts`, which is the authority: the CLI
 * does not depend on `@tm8/execution` (that would drag node-pty into every
 * `tm8 help`), so the pair is restated here and pinned by a test. The TOOL SET
 * itself is not restated — it is derived from `@tm8/contract`'s launch model
 * catalog below, so a model added upstream joins this check automatically.
 */
const AGENT_TOOL_BINARIES: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
};

/** Every agent tool this node can actually be asked to spawn. */
export function spawnableAgentTools(): string[] {
  return [...new Set(LAUNCH_MODEL_CATALOG.map((m) => m.agentTool))].sort();
}

const INSTALL_HINT: Readonly<Record<string, string>> = {
  'claude-code':
    'install it (`npm i -g @anthropic-ai/claude-code`) and authenticate with `claude` once, ' +
    'or force a different binary for this node with TM8_AGENT_CMD',
  codex:
    'install it (`npm i -g @openai/codex`) and authenticate with `codex login` once, ' +
    'or force a different binary for this node with TM8_AGENT_CMD',
};

/**
 * Auth state, only where it is CHEAPLY readable — no binary is invoked to ask,
 * because an agent CLI's "am I logged in" path can open a browser. On macOS
 * Claude Code keeps its token in the login Keychain, which doctor deliberately
 * does NOT probe: an unknown is reported as unknown rather than guessed.
 * No secret is ever read out of these files, only the presence of a key and,
 * for codex, its non-secret `auth_mode` label.
 */
function agentAuthState(tool: string, io: DoctorIo): string {
  const home = io.env.HOME?.trim() || homedir();
  try {
    if (tool === 'claude-code') {
      const config = join(home, '.claude.json');
      if (!io.exists(config)) return 'auth unknown (no ~/.claude.json)';
      const parsed = JSON.parse(io.readFile(config)) as Record<string, unknown>;
      return parsed['oauthAccount'] ? 'authenticated' : 'auth unknown (no oauthAccount; may be in the Keychain)';
    }
    if (tool === 'codex') {
      const authPath = join(io.env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json');
      if (!io.exists(authPath)) return 'NOT authenticated (no auth.json)';
      const parsed = JSON.parse(io.readFile(authPath)) as Record<string, unknown>;
      const mode = typeof parsed['auth_mode'] === 'string' ? parsed['auth_mode'] : undefined;
      return mode ? `authenticated (auth_mode=${mode})` : 'authenticated';
    }
  } catch {
    return 'auth unknown (credential file unreadable)';
  }
  return 'auth unknown';
}

export const checkAgentClis: Check = async ({ io }) => {
  const override = io.env.TM8_AGENT_CMD?.trim();
  if (override) {
    // The operator override wins over every per-session `agentTool`, so when it
    // is set the per-tool binaries are not what the PTY runs and checking them
    // would be theatre.
    const bin = override.split(/\s+/)[0] ?? override;
    const found = isAbsolute(bin) ? (io.exists(bin) ? bin : null) : await io.which(bin);
    return [
      found
        ? pass('agent-cli', 'agent CLI (TM8_AGENT_CMD)', `${override} → ${found}`)
        : fail(
            'agent-cli',
            'agent CLI (TM8_AGENT_CMD)',
            `TM8_AGENT_CMD=${override} but ${bin} is not on PATH — every spawn will die with exit 127`,
            `install ${bin}, or unset TM8_AGENT_CMD to fall back to the per-tool binaries`,
          ),
    ];
  }

  const results: CheckResult[] = [];
  for (const tool of spawnableAgentTools()) {
    const bin = AGENT_TOOL_BINARIES[tool];
    const name = `agent-cli:${tool}`;
    const title = `agent CLI: ${tool}`;
    if (!bin) {
      results.push(
        fail(
          name,
          title,
          `no binary is mapped for agent tool ${tool}`,
          'add it to AGENT_TOOL_BINARIES in packages/execution/src/spawn/manifest.ts (and its mirror in this file)',
        ),
      );
      continue;
    }
    const found = await io.which(bin);
    if (!found) {
      results.push(
        fail(
          name,
          title,
          `\`${bin}\` is not on PATH — a session with agentTool=${tool} will die with exit 127, ` +
            'which the UI presents as a boot settlement window rather than a missing binary',
          INSTALL_HINT[tool] ?? `install the ${tool} CLI so \`${bin}\` is on PATH`,
        ),
      );
      continue;
    }
    results.push(pass(name, title, `${bin} → ${found} (${agentAuthState(tool, io)})`));
  }
  return results;
};

// ── 2. postgres ────────────────────────────────────────────────────────────

/**
 * The connection string, resolved EXACTLY as `db/migrate.mjs` resolves it. Two
 * resolvers that disagree is how doctor certifies a database the migration
 * runner never touches.
 */
export function databaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.TM8_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const user = env.TM8_PG_USER?.trim() || env.USER?.trim() || 'postgres';
  const port = env.TM8_PG_PORT?.trim() || '5442';
  const host = env.TM8_PG_HOST?.trim() || '127.0.0.1';
  const db = env.TM8_DB?.trim() || 'tm8_dev';
  return `postgres://${user}@${host}:${port}/${db}`;
}

/** Same discovery order as `db/migrate.mjs` — the sidecar's psql is a keg, not on PATH. */
const PSQL_CANDIDATES = [
  '/opt/homebrew/opt/postgresql@18/bin/psql',
  '/usr/local/opt/postgresql@18/bin/psql',
  '/usr/lib/postgresql/18/bin/psql',
];

export async function findPsql(io: DoctorIo): Promise<string | null> {
  const explicit = io.env.TM8_PSQL?.trim();
  if (explicit) return explicit;
  const onPath = await io.which('psql');
  if (onPath) return onPath;
  for (const candidate of PSQL_CANDIDATES) if (io.exists(candidate)) return candidate;
  return null;
}

/** Redact any password before a connection string reaches stdout. */
export function redactUrl(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:/@]+):[^@]*@/i, '$1:***@');
}

/**
 * One `psql` invocation, unaligned + tuples-only so the answer is parseable,
 * and pinned read-only by the server itself.
 */
async function psql(io: DoctorIo, url: string, sql: string) {
  const psqlBin = await findPsql(io);
  if (!psqlBin) return { psqlBin: null, code: 127, stdout: '', stderr: '' };
  const result = await io.exec(
    psqlBin,
    ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-Atq', '-F', '\u001f', url, '-c', sql],
    {
      timeoutMs: 10_000,
      env: {
        ...io.env,
        // Structural read-only: Postgres refuses a write in this session even
        // if a future edit to this file asks for one.
        PGOPTIONS: `${io.env.PGOPTIONS ?? ''} -c default_transaction_read_only=on`.trim(),
        // Never let a missing password turn a diagnostic into a hung prompt.
        PGCONNECT_TIMEOUT: io.env.PGCONNECT_TIMEOUT ?? '5',
      },
    },
  );
  return { psqlBin, ...result };
}

const PG_NAME = 'postgres';
const PG_TITLE = 'postgres reachable AND authenticating';

export const checkPostgres: Check = async ({ io }) => {
  const url = databaseUrl(io.env);
  const shown = redactUrl(url);
  const psqlBin = await findPsql(io);
  if (!psqlBin) {
    return [
      fail(
        PG_NAME,
        PG_TITLE,
        'no psql client found on PATH or in the known Homebrew/apt locations',
        'install the Postgres 18 client, or set TM8_PSQL to its path ' +
          '(`brew --prefix postgresql@18` → <prefix>/bin/psql)',
      ),
    ];
  }

  // NOT `pg_isready`. isready answers OK while authentication is failing — the
  // exact way this project lost an afternoon. Connect, authenticate, and make
  // the server describe ITSELF, so a connection that landed on the wrong one of
  // several local clusters is visible rather than assumed.
  const probe = await psql(
    io,
    url,
    "select current_database(), current_user, coalesce(host(inet_server_addr()),'local'), " +
      'inet_server_port(), current_setting(\'server_version\')',
  );
  if (probe.code !== 0) {
    const why = (probe.stderr || probe.stdout).trim().split('\n')[0] ?? `psql exited ${probe.code}`;
    return [
      fail(
        PG_NAME,
        PG_TITLE,
        `could not connect to ${shown}: ${why}`,
        /password|authentication|role .* does not exist/i.test(why)
          ? 'authentication failed — note that `pg_isready` would still say OK here. Check TM8_PG_USER/PGPASSWORD, ' +
            'or start the dev sidecar with `bun run dev` which owns the cluster on TM8_PG_PORT (default 5442)'
          : `start the database (\`bun run dev\`), or point TM8_DATABASE_URL / TM8_PG_HOST / TM8_PG_PORT / TM8_DB at the right cluster — ` +
            'a dev machine has more than one, and a bare `psql` hits whichever is on the default port',
      ),
    ];
  }
  const [db, user, host, port, version] = (probe.stdout.trim().split('\n')[0] ?? '').split('\u001f');
  return [
    pass(
      PG_NAME,
      PG_TITLE,
      `connected as ${user} to ${db} on ${host}:${port} (PostgreSQL ${version}) via ${shown}`,
    ),
  ];
};

// ── 3. migrations ──────────────────────────────────────────────────────────

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIG_NAME = 'migrations';
const MIG_TITLE = 'migrations current';

export const checkMigrations: Check = async ({ io }) => {
  const dir = io.env.TM8_MIGRATIONS_DIR?.trim() || join(io.repoRoot, 'db', 'migrations');
  let onDisk: string[];
  try {
    onDisk = io.readDir(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
  } catch {
    return [
      fail(
        MIG_NAME,
        MIG_TITLE,
        `no migrations directory at ${dir}`,
        'run doctor from a tm8 checkout, or set TM8_MIGRATIONS_DIR to the db/migrations you want compared',
      ),
    ];
  }

  const url = databaseUrl(io.env);
  const probe = await psql(
    io,
    url,
    'select filename, checksum from public.applied_migrations order by filename',
  );
  if (probe.code !== 0) {
    const why = (probe.stderr || probe.stdout).trim().split('\n')[0] ?? `psql exited ${probe.code}`;
    return [
      fail(
        MIG_NAME,
        MIG_TITLE,
        `${onDisk.length} migration file(s) on disk; the database could not be read: ${why}`,
        /applied_migrations/.test(why)
          ? 'the ledger table does not exist — this database has never been migrated: `node db/migrate.mjs up`'
          : 'fix the postgres check above first; migration drift cannot be judged without reading the ledger',
      ),
    ];
  }

  const applied = new Map<string, string>();
  for (const line of probe.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [filename, checksum] = line.split('\u001f');
    if (filename) applied.set(filename.trim(), (checksum ?? '').trim());
  }

  const pending = onDisk.filter((f) => !applied.has(f));
  // BOTH DIRECTIONS. A row with no file is not noise: it is what a branch
  // switch looks like, and it means the database is AHEAD of this tree.
  const orphaned = [...applied.keys()].filter((f) => !onDisk.includes(f)).sort();
  // The THIRD case, and the only one that could produce a false PASS: a file
  // EDITED AFTER it was applied. Same name on both sides, different bytes — so
  // a name-only comparison calls it current while the database does not have
  // the schema the tree describes. Same sha256-over-file-bytes the runner
  // records, so the two agree by construction.
  const drifted = onDisk
    .filter((f) => applied.has(f))
    .filter((f) => {
      const recorded = applied.get(f);
      if (!recorded) return false;
      try {
        return createHash('sha256').update(io.readFile(join(dir, f))).digest('hex') !== recorded;
      } catch {
        return false;
      }
    });

  if (pending.length === 0 && orphaned.length === 0 && drifted.length === 0) {
    return [
      pass(MIG_NAME, MIG_TITLE, `${onDisk.length} migration(s) on disk, all applied to ${redactUrl(url)}`),
    ];
  }
  const parts: string[] = [];
  if (pending.length) parts.push(`${pending.length} PENDING (on disk, not applied): ${pending.join(', ')}`);
  if (orphaned.length)
    parts.push(`${orphaned.length} APPLIED BUT ABSENT from this tree: ${orphaned.join(', ')}`);
  if (drifted.length)
    parts.push(`${drifted.length} EDITED AFTER APPLY (checksum differs): ${drifted.join(', ')}`);
  return [
    fail(
      MIG_NAME,
      MIG_TITLE,
      parts.join('; '),
      pending.length
        ? 'apply them: `node db/migrate.mjs up` (`node db/migrate.mjs status` first to see the plan)'
        : drifted.length && !orphaned.length
          ? 'a migration was edited after it was applied, so this database does NOT have the schema the tree ' +
            'describes. Revert the edit, or add a NEW migration — never edit an applied one'
          : 'this database is AHEAD of the tree — it was migrated from another branch. Check out the branch that ' +
            'owns those files, or reset the dev database with `node db/migrate.mjs reset --force`',
    ),
  ];
};

// ── 4. git ─────────────────────────────────────────────────────────────────

export const checkGit: Check = async ({ io }) => {
  const results: CheckResult[] = [];
  const gitBin = await io.which('git');
  if (!gitBin) {
    return [
      fail(
        'git',
        'git available',
        'git is not on PATH — worktree allocation and every branch-scoped spawn will fail',
        'install git (`xcode-select --install` on macOS, `apt install git` on Debian/Ubuntu)',
      ),
    ];
  }
  const version = await io.exec(gitBin, ['--version'], { timeoutMs: 5_000 });
  results.push(pass('git', 'git available', `${version.stdout.trim() || 'git'} → ${gitBin}`));

  // The repo state a spawn needs: a real work tree with a resolvable HEAD.
  // A worktree whose HEAD is unborn or detached is exactly the shape that makes
  // a branch-scoped spawn fail at allocation rather than at launch.
  const inTree = await io.exec(gitBin, ['rev-parse', '--is-inside-work-tree'], {
    cwd: io.repoRoot,
    timeoutMs: 5_000,
  });
  if (inTree.code !== 0 || inTree.stdout.trim() !== 'true') {
    results.push(
      fail(
        'git-repo',
        'git work tree',
        `${io.repoRoot} is not inside a git work tree`,
        'run doctor from a tm8 checkout — worktree allocation needs a real repository to branch from',
      ),
    );
    return results;
  }
  const head = await io.exec(gitBin, ['rev-parse', '--short', 'HEAD'], {
    cwd: io.repoRoot,
    timeoutMs: 5_000,
  });
  if (head.code !== 0) {
    results.push(
      fail(
        'git-repo',
        'git work tree',
        `${io.repoRoot} has no resolvable HEAD (unborn branch?)`,
        'make at least one commit — a worktree cannot be allocated from an unborn HEAD',
      ),
    );
    return results;
  }
  const branch = await io.exec(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: io.repoRoot,
    timeoutMs: 5_000,
  });
  const status = await io.exec(gitBin, ['status', '--porcelain'], {
    cwd: io.repoRoot,
    timeoutMs: 10_000,
  });
  const dirty = status.stdout.split('\n').filter((l) => l.trim()).length;
  const branchName = branch.stdout.trim() || 'HEAD';
  results.push(
    pass(
      'git-repo',
      'git work tree',
      `${io.repoRoot} @ ${head.stdout.trim()} on ${branchName}` +
        (dirty ? ` (${dirty} uncommitted change(s))` : ' (clean)') +
        (branchName === 'HEAD' ? ' — DETACHED HEAD' : ''),
    ),
  );
  return results;
};

// ── 5. data dir ────────────────────────────────────────────────────────────

/** `TM8_DATA_DIR`, else the dev default the sidecar uses. */
export function dataDir(env: NodeJS.ProcessEnv): string {
  const configured = env.TM8_DATA_DIR?.trim();
  if (configured) return configured;
  return join(env.HOME?.trim() || homedir(), '.tm8-dev');
}

export const checkDataDir: Check = async ({ io }) => {
  const dir = dataDir(io.env);
  const name = 'data-dir';
  const title = 'data dir writable';
  if (!isAbsolute(dir)) {
    return [
      fail(
        name,
        title,
        `TM8_DATA_DIR=${dir} is not absolute; the sidecar refuses a relative data dir`,
        'set TM8_DATA_DIR to an absolute path (~/.tm8-dev for dev, ~/.tm8 for prod)',
      ),
    ];
  }
  if (io.exists(dir)) {
    return io.writable(dir)
      ? [pass(name, title, `${dir} (exists, writable)`)]
      : [
          fail(
            name,
            title,
            `${dir} exists but is not a writable directory`,
            `fix its ownership/permissions (\`chmod u+rwx ${dir}\`), or point TM8_DATA_DIR somewhere you own`,
          ),
        ];
  }
  // Doctor NEVER creates it — read-only means read-only. The honest question is
  // whether the parent would let the server create it on first run.
  const parent = dirname(dir);
  return io.writable(parent)
    ? [pass(name, title, `${dir} (absent; parent ${parent} is writable, so first run will create it)`)]
    : [
        fail(
          name,
          title,
          `${dir} does not exist and its parent ${parent} is not writable — first run cannot create it`,
          `create it yourself (\`mkdir -p ${dir}\`) or set TM8_DATA_DIR to a path you own`,
        ),
      ];
};

// ── 6. the configured node ─────────────────────────────────────────────────

const NODE_NAME = 'node';
const NODE_TITLE = 'tm8 node reachable';

export const checkNode: Check = async ({ io, ctx }) => {
  const base = ctx.baseUrl.value.replace(/\/+$/, '');
  const where = `${base} (from ${ctx.baseUrl.source})`;
  const url = `${base}/health`;
  let status: number;
  let body: string;
  try {
    const res = await io.http(url, 5_000);
    status = res.status;
    body = res.body;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return [
      fail(
        NODE_NAME,
        NODE_TITLE,
        `${where} did not answer GET /health: ${why}`,
        'start it (`bun run dev`), or point TM8_BASE_URL / `baseUrl` in ~/.config/tm8/config.json at the node you meant',
      ),
    ];
  }

  let parsed: Record<string, unknown> | undefined;
  try {
    const j: unknown = JSON.parse(body);
    if (j && typeof j === 'object') parsed = j as Record<string, unknown>;
  } catch {
    /* handled below */
  }

  // A 200 IS NOT PROOF. A failed boot can leave a zombie holding the port that
  // still answers /health, so the body must IDENTIFY ITSELF before this passes.
  if (!parsed || parsed['server'] !== 'tm8-server') {
    return [
      fail(
        NODE_NAME,
        NODE_TITLE,
        `${where} answered ${status} but the body does not identify a tm8 server ` +
          `(${body.slice(0, 120).replace(/\s+/g, ' ').trim() || 'empty body'})`,
        'something else is holding that port — a zombie from a failed boot, or another service. ' +
          `Find it with \`lsof -nP -iTCP -sTCP:LISTEN | grep ${base.split(':').pop()}\` and stop it, then restart tm8`,
      ),
    ];
  }

  const identity =
    `server=${String(parsed['server'])} contract=${String(parsed['contractVersion'])} ` +
    `operations=${String(parsed['operations'])} implemented=${String(parsed['implemented'])} ` +
    `db=${String(parsed['db'] ?? 'not probed')}`;

  if (status !== 200 || parsed['ok'] !== true) {
    return [
      fail(
        NODE_NAME,
        NODE_TITLE,
        `${where} answered ${status} and reports itself UNHEALTHY: ${identity}`,
        parsed['db'] === 'unavailable'
          ? 'the node is up but its database probe fails — fix the postgres check above, and check for connections ' +
            'stuck `idle in transaction` exhausting the pool'
          : 'read the node log and restart it (`bun run dev`)',
      ),
    ];
  }
  if (parsed['db'] === undefined) {
    return [
      fail(
        NODE_NAME,
        NODE_TITLE,
        `${where} answered 200 but reports NO database probe: ${identity}`,
        'this node was wired without a pool, so it can only serve 501s — start it with a database ' +
          '(`bun run dev`) rather than API-only',
      ),
    ];
  }
  const drift =
    parsed['contractVersion'] !== CONTRACT_VERSION
      ? ` — WARNING: this CLI is built against contract ${CONTRACT_VERSION}`
      : '';
  return [pass(NODE_NAME, NODE_TITLE, `${where} healthy: ${identity}${drift}`)];
};

// ── the flat list ──────────────────────────────────────────────────────────

export const CHECKS: readonly Check[] = [
  checkAgentClis,
  checkPostgres,
  checkMigrations,
  checkGit,
  checkDataDir,
  checkNode,
];

export async function runChecks(input: CheckInput): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  for (const check of CHECKS) checks.push(...(await check(input)));
  const failed = checks.filter((c) => c.status === 'fail').length;
  return {
    schemaVersion: 'tm8.doctor.v1',
    cliVersion: CLI_VERSION,
    checks,
    failed,
    ok: failed === 0,
  };
}

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.title.length), 0);
  const lines = [`tm8 doctor — ${report.checks.length} checks (cli ${report.cliVersion})`, ''];
  for (const c of report.checks) {
    lines.push(`  ${c.status === 'pass' ? 'PASS' : 'FAIL'}  ${c.title.padEnd(width)}  ${c.detail}`);
    if (c.remedy) lines.push(`        ${' '.repeat(width)}  → ${c.remedy}`);
  }
  lines.push('');
  lines.push(
    report.ok
      ? `OK — ${report.checks.length} of ${report.checks.length} checks passed`
      : `FAIL — ${report.failed} of ${report.checks.length} checks failed`,
  );
  return lines.join('\n');
}

/**
 * The command.
 *
 * EXIT CODE. A failing doctor is EXIT_USAGE (2): the frozen table's code for a
 * failure the CLI decided LOCALLY, without performing an operation on the
 * caller's behalf. Doctor does touch the network, but only as the SUBJECT of a
 * diagnosis — nothing was attempted and nothing was refused, so none of the
 * server-verdict codes (3/4/5/6/8) would be true. Callers who only need
 * "is my environment ready" branch on zero vs non-zero.
 */
export async function doctor(cmd: {
  args: readonly string[];
  ctx: CliContext;
  out: Output;
  io?: DoctorIo;
}): Promise<ExitCode> {
  if (cmd.args.length > 0) {
    throw new CliError(
      `tm8 doctor takes no arguments, got ${cmd.args.length}: ${cmd.args.join(' ')}`,
      EXIT_USAGE,
      { hint: 'run `tm8 doctor` on its own; use --format json for the machine-readable report' },
    );
  }
  const report = await runChecks({ io: cmd.io ?? defaultIo(), ctx: cmd.ctx });
  cmd.out.data(report, renderReport);
  return report.ok ? EXIT_OK : EXIT_USAGE;
}
