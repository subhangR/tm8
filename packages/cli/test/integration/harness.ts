/**
 * REAL-SERVER INTEGRATION HARNESS — coordinator-owned.
 *
 * WHY THIS FILE IS OWNED BY THE COORDINATOR AND NOT BY ANY GROUP SLOT.
 * Eight domain slots need a real Server to test against. If each wrote its own
 * harness there would be eight subtly different ways to start a Server and
 * eight opinions about ports, and if they shared a file that one file would be
 * a seam handed to eight concurrent workers. Neither is acceptable, so the
 * harness is written once, here, and every slot consumes it read-only.
 *
 * WHY IT SPAWNS THE BUILT BINARY RATHER THAN IMPORTING `bootstrap()`.
 * The CLI is a separate process that talks HTTP. Importing the server into the
 * CLI's test process would prove that the CLI can call a function; it would not
 * prove that the CLI can talk to a Server. It would also let a test accidentally
 * depend on server internals, which is exactly the coupling the catalog exists
 * to prevent. So this starts `packages/server/dist/index.js` as a child process
 * and speaks to it over the wire, the way an agent does.
 *
 * WHY A PRE-ALLOCATED PORT RATHER THAN `TM8_PORT=0`. A fixed port would make
 * two concurrent slots collide — the same collision class the file-ownership
 * rules prevent, one layer down. But `loadConfig` REJECTS port 0 outright
 * ("TM8_PORT must be a valid port number"), and the documented workaround is to
 * override config after validation, which requires importing the server. That
 * would forfeit the child-process property above. So this asks the OS for a free
 * port, closes the probe socket, and hands the number to the child. There is a
 * narrow race between close and bind; it is accepted deliberately, because the
 * alternative is either a fixed port (guaranteed collision) or importing the
 * server (loses the real-process guarantee).
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   * It does not import ANYTHING from `packages/server/test/**`. That tree
 *     belongs to W2 and W3 and is out of bounds for W4; this is a
 *     reimplementation, not a copy.
 *   * It does not register a handler, stub an operation, or seed the registry.
 *     If an operation is not composed into the production `bootstrap()`, this
 *     harness will observe its honest 501 — which is the point. A harness that
 *     helped an operation answer would be measuring itself.
 *   * It does not assert how much of the surface is implemented. Ask `/health`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createProbeServer } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Absolute repository root, derived from this file rather than from cwd. */
export const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Admin connection used only to CREATE and DROP the scratch database.
 *
 * Defaults to the DEV SIDECAR on 5442 as role `tm8`, matching `db/migrate.mjs`'s
 * own default (`TM8_PG_PORT` 5442) and the instance the other waves use.
 *
 * NOT 5432. A Homebrew Postgres also answers on 5432 on this host and it
 * requires a password for the login role — which is worse than being down,
 * because `psql` then BLOCKS ON STDIN waiting for one. That is what it does
 * inside a test runner: nothing, silently, until the hook times out. See
 * `PSQL` below for the guard.
 */
function adminUrl(): string {
  const explicit = process.env.TM8_W4_ADMIN_DATABASE_URL ?? process.env.TM8_MIGRATION_DATABASE_URL;
  if (explicit) return explicit;
  const port = process.env.TM8_PG_PORT ?? '5442';
  const user = process.env.TM8_PG_USER ?? 'tm8';
  return `postgres://${user}@127.0.0.1:${port}/postgres`;
}

/**
 * `-w` is load-bearing, not tidiness: it makes `psql` FAIL rather than prompt
 * when no password is available. Without it a misconfigured connection hangs on
 * stdin forever and surfaces as an unexplained hook timeout minutes later, with
 * nothing in the output to say why. This cost one debugging cycle before any
 * worker saw the harness; `-w` converts it into an immediate, legible error.
 */
const PSQL = ['-w', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'] as const;

/** Connection attempts also get a hard ceiling, for the same reason. */
const PG_ENV = { ...process.env, PGCONNECT_TIMEOUT: '10' };

/** Ask the OS for a currently-free TCP port on loopback. See the header note. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createProbeServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close(() => reject(new Error('could not resolve a free port')));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

function scratchName(label: string): string {
  const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `tm8_w4_${safe}_${process.pid}_${suffix}`;
  // A generated identifier is interpolated into DDL below, so it is validated
  // rather than trusted: anything outside this alphabet is a bug in `label`.
  if (!/^tm8_w4_[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);
  return name;
}

/**
 * The migration-chain identity this Server's database was built from.
 *
 * CANONICAL RECIPE, and the `cd` is the whole point:
 *   (cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16)
 * An earlier recipe hashed `shasum`'s OUTPUT LINES, which contain the path
 * exactly as typed, so it silently varied with the caller's working directory —
 * four different digests for one byte-identical directory. `cd`-ing in first
 * makes the paths bare basenames regardless of where the caller starts, while
 * still rotating when a file is renamed or renumbered (which matters, because
 * the runner applies in LEXICAL order).
 */
export async function chainIdentity(): Promise<{ files: number; digest: string }> {
  const dir = join(REPO_ROOT, 'db/migrations');
  const { stdout } = await run('bash', ['-c',
    `cd ${JSON.stringify(dir)} && ls *.sql | wc -l && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16`]);
  const [count, digest] = stdout.trim().split('\n');
  return { files: Number((count ?? '0').trim()), digest: (digest ?? '').trim() };
}

export interface RealServer {
  /** Origin the CLI should target, e.g. `http://127.0.0.1:53211`. */
  readonly baseUrl: string;
  /** Env a CLI invocation needs to reach this Server and nothing else. */
  readonly env: Record<string, string>;
  /** `{ok, server, contractVersion, operations, implemented}` — NOT enveloped. */
  health(): Promise<HealthBody>;
  /** Chain identity captured when this Server's database was migrated. */
  readonly bindStart: { files: number; digest: string };
  /**
   * Re-read the chain and THROW if it moved since `bindStart`.
   *
   * Call this at the END of a suite, before reporting any number. Migrations are
   * landed by another wave while these tests run, and a scratch database is
   * rebuilt from whatever is on disk at the moment it is created — so a suite
   * can straddle a landing and produce a result bound to TWO different trees.
   * Such a number is not merely stale, it is meaningless, and it reads exactly
   * like a good one. Three other waves have discarded sweeps to this; one caught
   * an 87/87 green straddling a landing and threw it away rather than report it.
   */
  assertBindCoherent(): Promise<void>;
  /**
   * Observe this node's availability for one operation, THREE-STATE.
   *
   * A boolean here would be a lie — see `observe` for why an empty-body probe
   * physically cannot distinguish a live handler from a registered 501 stub.
   */
  observe(operation: string): Promise<ObservedAvailability>;
  stop(): Promise<void>;
}

/**
 * What a probe can honestly conclude, and no more.
 *
 *   'unavailable' — the node answered 501 not_implemented. DEFINITIVE: the
 *                   router found no handler, so this operation does no work here.
 *   'unknown'     — the node answered 400 invalid_input. The router DID find a
 *                   handler, so the operation is registered, but validation
 *                   rejected the probe body BEFORE the handler ran, so whether
 *                   that handler does work is UNOBSERVED.
 *   'available'   — the node returned something else, so the handler ran.
 *
 * WHY 'unknown' IS NOT COLLAPSIBLE INTO EITHER NEIGHBOUR — measured on this
 * host, and this is the trap that makes the three states necessary:
 *
 *   messages.post      registered, UNCONDITIONAL 501 STUB  ->  400 invalid_input
 *   spaces.create      registered, live and working        ->  400 invalid_input
 *   entityKinds.create not registered at all               ->  501 not_implemented
 *
 * The stub and the live operation are INDISTINGUISHABLE from an invalid body,
 * because handler lookup precedes schema validation: the router does not 501,
 * then validation rejects, and the handler's own `throw not_implemented` is
 * never reached. Reporting either of those two as 'available' would have counted
 * an unconditional stub as implemented — the exact measurement-validity defect
 * an independent gate found in its own classifier on this program. Resolving
 * 'unknown' requires a SCHEMA-VALID body, which is domain work and belongs to
 * the group that owns the operation, not to this harness.
 */
export type ObservedAvailability = 'available' | 'unavailable' | 'unknown';

export interface HealthBody {
  ok: boolean;
  server: string;
  contractVersion: string;
  /** Mounted HTTP routes. Always 100 for the frozen catalog. */
  operations: number;
  /**
   * `registry.size` — REGISTERED handlers. NOT the same as behaviourally
   * implemented: a registered handler may be an unconditional 501 stub. Never
   * quote this as "implemented" without saying "registered".
   */
  implemented: number;
}

/**
 * Start a real production Server on an isolated, freshly migrated database.
 *
 * The caller must have run `bun run build:server` first; this deliberately does
 * NOT build, because a harness that silently rebuilds can mask a broken build
 * and because eight concurrent slots must not race one `tsc -b`.
 */
export async function startRealServer(label: string): Promise<RealServer> {
  const database = scratchName(label);
  const admin = adminUrl();
  const dbUrl = new URL(admin);
  dbUrl.pathname = `/${database}`;

  await run('psql', [...PSQL, admin, '-c', `create database ${database}`], { env: PG_ENV });

  let dataDir = '';
  let child: ChildProcess | undefined;

  const teardown = async (): Promise<void> => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, 5_000);
        child?.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    // Guarded: only ever removes a directory this harness created.
    if (dataDir && dataDir.includes('tm8-w4-')) await rm(dataDir, { recursive: true, force: true });
    await run('psql', [...PSQL, admin, '-c', `drop database if exists ${database}`], { env: PG_ENV })
      .catch(() => undefined);
  };

  try {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-w4-'));
    const bindStart = await chainIdentity();

    // The OFFICIAL runner, not a hand-rolled apply loop: it enforces lexical
    // order, one transaction per file, and the content-checksum ledger. Using
    // anything else here would test a migration path nobody ships.
    await run('node', [join(REPO_ROOT, 'db/migrate.mjs'), 'up'], {
      env: { ...PG_ENV, TM8_DATABASE_URL: dbUrl.href },
      cwd: REPO_ROOT,
    });

/**
 * Derive this run's delivery connection string from the ambient one.
 *
 * Returns `{}` when `TM8_DELIVERY_DATABASE_URL` is unset, so the default remains
 * "delivery not wired" and no test silently depends on a credential the gate did
 * not supply. When it IS set, only the USER (and any password) is carried across;
 * host, port and database come from the scratch URL this run just created.
 */
function deliveryEnv(dbUrl: URL): Record<string, string> {
  const ambient = process.env['TM8_DELIVERY_DATABASE_URL'];
  if (!ambient) return {};
  const from = new URL(ambient);
  const derived = new URL(dbUrl.href);
  derived.username = from.username;
  derived.password = from.password;
  return { TM8_DELIVERY_DATABASE_URL: derived.href };
}

    const port = await freePort();
    const serverEntry = join(REPO_ROOT, 'packages/server/dist/index.js');
    child = spawn('node', ['--enable-source-maps', serverEntry], {
      env: {
        ...process.env,
        TM8_DATABASE_URL: dbUrl.href,
        TM8_DATA_DIR: dataDir,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: String(port),
        // The artifact-preview second listener defaults to a FIXED 4613; a
        // child process cannot use the in-process port-0 substitution, so
        // every harness boot raced the long-lived local node for 4613 and
        // died EADDRINUSE (ten files at once, 2026-07-31). Explicit 0 is the
        // config's documented ephemeral opt-in for exactly this shape.
        TM8_PREVIEW_PORT: '0',
        TM8_ENV: 'dev',
        // DELIVERY WIRING — derived, never inherited verbatim.
        //
        // `createW2ExecutionDelivery` opens its OWN pool at this URL, independent
        // of TM8_DATABASE_URL. So an inherited `TM8_DELIVERY_DATABASE_URL` from
        // the ambient environment would point at the DEV database while this
        // Server runs on a per-run SCRATCH database — the delivery worker would
        // reserve against a database that does not contain the message. That
        // measures nothing, and it would look exactly like "the wiring does not
        // work" rather than like a harness mistake.
        //
        // So the role is taken from the ambient variable (it is a credential and
        // a deployment fact the harness must not invent) while the DATABASE is
        // taken from THIS run's scratch URL. Opt-in: unset ambient variable means
        // unset here, and the node behaves exactly as it does by default.
        ...deliveryEnv(dbUrl),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server did not report a listening URL in 60s\n${stderr}\n${stdout}`)),
        60_000,
      );
      let stdout = '';
      let stderr = '';
      child!.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString();
        // `main.ts` prints `tm8-server listening on <url>` once bound.
        const m = stdout.match(/listening on (http:\/\/\S+)/);
        if (m?.[1]) { clearTimeout(timer); resolve(m[1].trim()); }
      });
      child!.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited with ${code} before listening\n${stderr}\n${stdout}`));
      });
    });

    const health = async (): Promise<HealthBody> => {
      // `/health` is OUTSIDE the {data, requestId} envelope on purpose. Do not
      // run it through an envelope extractor — another wave lost a cycle to it.
      const res = await fetch(new URL('/health', baseUrl));
      if (!res.ok) throw new Error(`/health answered ${res.status}`);
      return (await res.json()) as HealthBody;
    };

    return {
      baseUrl,
      env: { TM8_BASE_URL: baseUrl },
      health,
      bindStart,
      async assertBindCoherent(): Promise<void> {
        const end = await chainIdentity();
        if (end.digest !== bindStart.digest || end.files !== bindStart.files) {
          throw new Error(
            `BIND INCOHERENT — the migration chain moved under this suite. ` +
              `start ${bindStart.files}/${bindStart.digest}, end ${end.files}/${end.digest}. ` +
              'Any count from this run is bound to two different trees and must be DISCARDED, ' +
              'not reported. Re-run against a quiet directory.',
          );
        }
      },
      async observe(operation: string): Promise<ObservedAvailability> {
        // Observed, not predicted. Never derived from /health, which counts
        // REGISTERED handlers and names no operation.
        const { getOperation, bindPath } = await import('@tm8/contract');
        const op = getOperation(operation as never);
        // The single WS row is unreachable over HTTP by construction; that is a
        // transport fact, not an availability observation.
        if (op.method === 'WS') return 'unknown';
        const params = Object.fromEntries(
          [...op.path.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1]!, '00000000-0000-7000-8000-000000000000']),
        );
        const res = await fetch(new URL(bindPath(operation as never, params), baseUrl), {
          method: op.method,
          headers: { 'content-type': 'application/json' },
          ...(op.method === 'GET' ? {} : { body: '{}' }),
        });
        const body = (await res.json().catch(() => undefined)) as
          | { error?: { code?: string } }
          | undefined;
        const code = body?.error?.code;
        if (res.status === 501 && code === 'not_implemented') return 'unavailable';
        // Reached validation => registered, but the handler never ran. Whether it
        // is a stub is UNOBSERVED. Do not upgrade this to 'available'.
        if (res.status === 400 && code === 'invalid_input') return 'unknown';
        return 'available';
      },
      stop: teardown,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

/**
 * THE SAME LEAK AS TM8_JOURNAL_PATH, ONE DOOR ALONG — and this one does not
 * merely pollute a journal, it turns the whole suite red.
 *
 * These tests boot a REAL Server on a per-run scratch database and then invoke
 * `dist/index.js` against it. When the suite runs inside a spawned agent's
 * session, that agent's own credentials are in `process.env`, and the CLI reads
 * them as its identity: `TM8_AGENT_TOKEN` and `TM8_ACTOR_ID` at
 * `src/context.ts:88-90`, `TM8_SESSION_ID`/`TM8_TEAM_MEMBER_ID` as the
 * agent-context marker at `src/credentials.ts:99`. The token is minted by a
 * DIFFERENT server for a DIFFERENT database, so the scratch Server rejects it —
 * and the suite reports that as a product failure.
 *
 * MEASURED, on clean `origin/main`, same commit, same box, only the environment
 * differing:
 *
 *     $ (cd packages/cli && npx vitest run test/integration/space.test.ts)
 *       → 6 failed:  "tm8: unauthenticated: invalid token"
 *     $ env -u TM8_AGENT_TOKEN -u TM8_ACTOR_ID  … same command
 *       → 23 passed
 *
 * Unsetting only the token is not enough: `TM8_ACTOR_ID` survives and the
 * refusal changes to "forbidden: not permitted to act as this actor". Both
 * halves of the identity have to go, so the whole seam is listed.
 *
 * Across the package that ambient identity accounted for 13 of the 73 test
 * files on a clean checkout — every one of them a red that says nothing about
 * the code, on every agent session on this node, forever. CI never saw it
 * because a GitHub runner has none of these variables set; this list simply
 * gives a developer's shell the same environment the gate already has.
 *
 * A test that WANTS one of these passes it through `extraEnv`, which is applied
 * after this scrub and therefore still wins.
 */
const AMBIENT_AGENT_IDENTITY = [
  'TM8_AGENT_TOKEN',
  'TM8_ACTOR_ID',
  'TM8_SESSION_ID',
  'TM8_TEAM_MEMBER_ID',
  'TM8_SPACE_ID',
  'TM8_TASK_IDS',
  'TM8_MANIFEST_PATH',
  'TM8_AGENT_TOOL',
  'TM8_MODE',
  'TM8_MODEL',
] as const;

/** Run the built CLI as a child process — the way an agent actually invokes it. */
export async function cli(
  argv: readonly string[],
  server: RealServer,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const entry = join(REPO_ROOT, 'packages/cli/dist/index.js');
  // THE 91% LEAK, closed at the source (F8): when this suite runs inside a
  // spawned agent's session, the child inherits that agent's TM8_JOURNAL_PATH
  // and every fixture invocation lands in the agent's journal as if the agent
  // typed it — 2,737 of 3,018 measured records, the pollution that inverted
  // the headline failure rate. The suite journals NOTHING by default, and
  // anything a test explicitly journals via extraEnv is tagged harness.
  // TM8_NO_CACHE keeps fixtures deterministic: a suite invocation must never
  // serve a cached payload another suite invocation happened to store.
  const base = { ...process.env, TM8_JOURNAL_CLASS: 'harness', TM8_NO_CACHE: '1', ...server.env };
  delete base.TM8_JOURNAL_PATH; // inherited only — an explicit extraEnv path survives below
  for (const name of AMBIENT_AGENT_IDENTITY) delete base[name];
  return await new Promise((resolve) => {
    const child = spawn('node', [entry, ...argv], {
      env: { ...base, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

/** Guard: refuse to run integration tests against a `dist` that does not exist. */
export async function assertBuilt(): Promise<void> {
  const missing: string[] = [];
  for (const [pkg, file] of [['server', 'index.js'], ['cli', 'index.js']] as const) {
    const dir = join(REPO_ROOT, `packages/${pkg}/dist`);
    const found = await readdir(dir).catch(() => [] as string[]);
    if (!found.includes(file)) missing.push(`packages/${pkg}/dist/${file}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `integration tests need a built tree; missing ${missing.join(', ')}. ` +
        'Run `bun run build:server` and `bun run build:cli` first. This harness does not build, ' +
        'because a harness that silently rebuilds can mask a broken build.',
    );
  }
}
