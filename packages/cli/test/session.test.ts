/**
 * `tm8 session liveness|spawn|terminate|attach` — the four caller-facing
 * `execution.*` rows,
 * and the one that must have no command at all.
 *
 * WHY THIS FILE DRIVES THE MODULE RATHER THAN `run()`. `src/commands/registry.ts`
 * and `src/run.ts` are coordinator-owned: this slot exports a `CommandModule[]`
 * and does NOT wire it in. `drive()` below therefore reproduces `run()`'s own
 * funnel — the real `parseInvocation`, the real `splitCommandPath`, the real
 * `resolveContext`, the real `errorLines`/`exitCodeFor`, the real `Output` — and
 * substitutes ONLY the registry lookup, which is the single line the coordinator
 * will write. Nothing about parsing, context, output law, or exit-code funnelling
 * is reimplemented, because reimplementing any of it would mean this file
 * measured itself rather than the CLI.
 *
 * THE HONESTY RULE THIS FILE EXISTS TO KEEP. `execution.prompt` is INTERNAL. It
 * names `messages.post` as its public composite and it has NO command, so no
 * surface here may render invocation syntax for it — a command line printed for
 * an operation no caller may invoke is a promise the system cannot keep. The
 * assertions below prove the absence two ways (no registered path, and a null
 * projection), and each is probe-red'd so that "absent" is a measurement rather
 * than a loop that iterated nothing.
 *
 * The five `execution.*` rows are mounted and registered on the Server but carry
 * ZERO W3 verdict: they are composed, not independently gated. That is a
 * statement about the Server, not about this file — the bindings below are
 * asserted against a local stub so they hold regardless of what any node
 * answers, and `test/integration/session.test.ts` measures the real node.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bindPath } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { createOutput } from '../src/output.js';
import { discoveryFor, isCommandPath } from '../src/discovery/operations.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function sessionCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/session.js')).SESSION_COMMANDS;
}

// ── the stub Server ─────────────────────────────────────────────────────────

interface Seen {
  method: string;
  pathname: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = {
  status: 200,
  body: { data: {}, requestId: 'req_t' },
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method ?? '',
        pathname: url.pathname,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no stub port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: {}, requestId: 'req_t' } };
});

// `TM8_*` is read by the REAL context resolver, so a leaked variable from
// another test would silently retarget these commands.
const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

interface DriveResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[], env: Record<string, string> = {}): Promise<DriveResult> {
  const modules = await sessionCommands();
  const out: string[] = [];
  const err: string[] = [];
  const streams = {
    stdout: (chunk: string | Uint8Array) =>
      void out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')),
    stderr: (chunk: string) => void err.push(chunk),
  };

  let output = createOutput({ format: 'human', streams });
  try {
    const invocation = parseInvocation(argv);
    output = createOutput({
      format: invocation.globals.format,
      color: invocation.globals.color,
      quiet: invocation.globals.quiet,
      streams,
    });
    const registered = new Map(modules.map((m) => [m.path.join(' '), m]));
    const match = splitCommandPath(invocation.positionals, (p) => registered.has(p.join(' ')));
    if (!match) throw new Error(`no group-9 command matched: ${invocation.positionals.join(' ')}`);
    const command = registered.get(match.path.join(' '))!;
    const ctx = resolveContext({
      globals: invocation.globals,
      session: sessionContextFromEnv({ TM8_BASE_URL: baseUrl, ...env }),
      // No `TM8_CONFIG_PATH`: an UNREADABLE implicit config is absent, not an
      // error, which is exactly the isolation these tests need.
      config: loadLocalConfig({}, {
        readFile: () => {
          throw new Error('no config in a group-9 test');
        },
      }),
    });
    const code = await command.run({
      path: match.path,
      args: match.args,
      options: invocation.options,
      passthrough: invocation.passthrough,
      ctx,
      out: output,
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  } catch (error) {
    output.error(errorLines(error));
    return { code: exitCodeFor(error), stdout: out.join(''), stderr: err.join('') };
  }
}

const SPACE = '11111111-1111-7111-8111-111111111111';
const TEAMMATE = '22222222-2222-7222-8222-222222222222';
const SESSION = '33333333-3333-7333-8333-333333333333';
const body = (): Record<string, unknown> => (seen[0]?.body ?? {}) as Record<string, unknown>;

// ── registration and the anti-drift binding ─────────────────────────────────

describe('registration', () => {
  it('registers exactly the eight caller-facing execution rows', async () => {
    const paths = (await sessionCommands()).map((m) => m.path.join(' ')).sort();
    expect(paths).toEqual(['session attach', 'session journal', 'session launch', 'session liveness', 'session resume', 'session spawn', 'session terminate', 'session transcript']);
  });

  it('every registered path is in the frozen projection', async () => {
    for (const m of await sessionCommands()) {
      expect(isCommandPath(m.path), m.path.join(' ')).toBe(true);
    }
    // PROBE-RED: the sweep above passes vacuously if `isCommandPath` says yes
    // to everything, so show it can say no.
    expect(isCommandPath(['session', 'prompt'])).toBe(false);
  });

  it('binds every path through the catalog, never a literal', async () => {
    // The four bindings this module must produce, derived here the same way
    // the module must derive them.
    expect(bindPath('execution.spawn', {})).toBe('/v2/execution/spawn');
    expect(bindPath('execution.terminate', { id: SESSION })).toBe(
      `/v2/entities/${SESSION}/commands/terminate`,
    );
    expect(bindPath('execution.streams.attach', { id: SESSION })).toBe(
      `/v2/entities/${SESSION}/commands/streams-attach`,
    );
    expect(bindPath('execution.liveness', { spaceId: SPACE })).toBe(
      `/v2/spaces/${SPACE}/execution/liveness`,
    );
  });
});

describe('session liveness', () => {
  it('reads the space-scoped live PTY snapshot and renders follow-up ids', async () => {
    reply.body = {
      data: {
        liveEntityIds: [SESSION],
        nodeBootId: 'boot_1',
        checkedAt: '2026-07-29T12:00:00.000Z',
        capacity: { used: 3, total: 8 },
      },
      requestId: 'req_live',
    };

    const result = await drive(['session', 'liveness'], { TM8_SPACE_ID: SPACE });

    expect(result.code).toBe(0);
    expect(seen).toEqual([{ method: 'GET', pathname: bindPath('execution.liveness', { spaceId: SPACE }), body: undefined }]);
    expect(result.stdout).toContain(SESSION);
    expect(result.stdout).toContain('boot_1');
    expect(result.stdout).toContain('capacity: 3/8 in use');
    expect(result.stderr).toBe('');
  });

  it('refuses a mutation id because liveness is a read', async () => {
    const result = await drive(
      ['session', 'liveness', '--mutation-id', '77777777-7777-7777-8777-777777777777'],
      { TM8_SPACE_ID: SPACE },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--mutation-id applies only to mutations');
    expect(seen).toHaveLength(0);
  });
});

describe('execution.prompt has no command and never renders syntax', () => {
  it('registers nothing under `session prompt`', async () => {
    const paths = (await sessionCommands()).map((m) => m.path.join(' '));
    expect(paths).not.toContain('session prompt');
    expect(paths.filter((p) => p.includes('prompt'))).toEqual([]);
    // PROBE-RED: prove the filter can find a token that IS present, so an
    // empty result means absence rather than a broken predicate.
    expect(paths.filter((p) => p.includes('attach'))).toEqual(['session attach']);
  });

  it('projects a null command and a null syntax', () => {
    const row = discoveryFor('execution.prompt');
    expect(row.command).toBeNull();
    expect(row.syntax).toBeNull();
    expect(row.exposure).toBe('internal');
    expect(row.publicComposite).toBe('messages.post');
    expect(row.reason).toBe('use_message_send');
    // PROBE-RED: a sibling row DOES carry syntax, so `null` above is a fact
    // about this row and not about the projection being empty.
    expect(discoveryFor('execution.streams.attach').syntax).toContain('tm8 session attach');
  });
});

// ── session spawn ───────────────────────────────────────────────────────────

describe('session spawn', () => {
  it('binds execution.spawn and carries the frozen body', async () => {
    const r = await drive([
      'session', 'spawn',
      '--space', SPACE,
      '--teammate', TEAMMATE,
      '--task', 'aaaaaaaa-0000-7000-8000-000000000001',
      '--task', 'aaaaaaaa-0000-7000-8000-000000000002',
      '--launch-project', 'bbbbbbbb-0000-7000-8000-000000000001',
      '--workdir', 'project',
      '--mode', 'coordinated-worker',
      '--model', 'gpt-5.6-sol',
      '--agent-tool', 'codex',
      '--title', 'Launch from CLI',
      '--context', 'extra manifest context',
      '--confirm-untrusted',
    ]);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe('/v2/execution/spawn');
    const b = body();
    expect(b.spaceId).toBe(SPACE);
    expect(b.teamMemberId).toBe(TEAMMATE);
    expect(b.taskIds).toEqual([
      'aaaaaaaa-0000-7000-8000-000000000001',
      'aaaaaaaa-0000-7000-8000-000000000002',
    ]);
    expect(b.projectId).toBe('bbbbbbbb-0000-7000-8000-000000000001');
    expect(b.workdir).toEqual({ mode: 'project' });
    expect(b.mode).toBe('coordinated-worker');
    expect(b.model).toBe('gpt-5.6-sol');
    expect(b.agentTool).toBe('codex');
    expect(b.title).toBe('Launch from CLI');
    expect(b.promptExtra).toBe('extra manifest context');
    expect(b.confirmUntrusted).toBe(true);
    expect(String(b.clientMutationId)).toMatch(UUID_PATTERN);
  });

  it('uses the current work session as the spawned session parent', async () => {
    const r = await drive([
      'session', 'spawn',
      '--space', SPACE,
      '--teammate', TEAMMATE,
    ], { TM8_SESSION_ID: SESSION });

    expect(r.code).toBe(0);
    expect(body().parentSessionId).toBe(SESSION);
  });

  it('carries an explicit --access-mode', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--access-mode', 'fullAccess',
    ]);
    expect(r.code).toBe(0);
    expect(body().accessMode).toBe('fullAccess');
  });

  it('refuses an access mode outside the closed set', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--access-mode', 'yolo',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('fullAccess');
    expect(seen).toEqual([]);
  });

  /**
   * The absence is the feature. A spawned agent that sends no `accessMode` gets
   * its PARENT session's posture on the Server; sending a default here would
   * overwrite that inheritance with the one value the caller never chose.
   */
  it('omits every optional field the caller did not give', async () => {
    const r = await drive(['session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE]);
    expect(r.code).toBe(0);
    expect(Object.keys(body()).sort()).toEqual(['clientMutationId', 'spaceId', 'teamMemberId']);
  });

  it('requires --teammate', async () => {
    const r = await drive(['session', 'spawn', '--space', SPACE]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--teammate');
    expect(seen).toEqual([]);
  });

  it('requires a Space in context', async () => {
    const r = await drive(['session', 'spawn', '--teammate', TEAMMATE]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no Space in context');
    expect(seen).toEqual([]);
  });

  it('refuses a workdir outside the closed set, naming it', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--workdir', 'home',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('project|scratch|worktree');
    expect(seen).toEqual([]);
  });

  // The closed set gained `worktree` when the node gained the manager, the
  // provisioning saga and the reconciler — which is the condition the design
  // sets for advertising the mode at all. The discipline it asks for is that a
  // mode is not offered BEFORE it can be serviced; keeping a shipped capability
  // hidden is not the same virtue.
  it('sends worktree, now that the node can service it', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--workdir', 'worktree',
    ]);
    expect(r.code).toBe(0);
    expect(body().workdir).toEqual({ mode: 'worktree' });
  });

  it('carries --base-ref as the worktree variant, never a bare string', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE,
      '--workdir', 'worktree', '--base-ref', 'main',
    ]);
    expect(r.code).toBe(0);
    expect(body().workdir).toEqual({ mode: 'worktree', baseRef: 'main' });
  });

  // `SpawnWorkdir`'s members are `.strict()`, so a baseRef on a project or
  // scratch workdir is a parse failure at the facade. Refusing it here with the
  // reason spelled out beats sending it to earn a 400 the caller has to decode.
  it('refuses --base-ref on a workdir that has no base ref, locally', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE,
      '--workdir', 'scratch', '--base-ref', 'main',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--base-ref applies only to --workdir worktree');
    expect(seen).toEqual([]);
  });

  it('refuses a mode outside the closed set', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--mode', 'boss',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('worker');
    expect(seen).toEqual([]);
  });

  it('carries --as as an authorship SELECTION the Server adjudicates', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--as', TEAMMATE,
    ]);
    expect(r.code).toBe(0);
    expect(body().actorId).toBe(TEAMMATE);
  });

  it('never regenerates a supplied --mutation-id', async () => {
    const r = await drive([
      'session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE, '--mutation-id', 'MY-ID',
    ]);
    expect(r.code).toBe(0);
    expect(body().clientMutationId).toBe('MY-ID');
  });

  it('keeps the new work-session id in HUMAN output', async () => {
    reply = {
      status: 201,
      body: { data: { entity: { id: SESSION, kind: 'work_session' }, patches: [] }, requestId: 'req_t' },
    };
    const r = await drive(['session', 'spawn', '--space', SPACE, '--teammate', TEAMMATE]);
    expect(r.code).toBe(0);
    // The id a follow-up `session attach`/`terminate` needs is never dropped.
    expect(r.stdout).toContain(SESSION);
  });
});

// ── session terminate ───────────────────────────────────────────────────────

describe('session terminate', () => {
  it('binds execution.terminate on the work-session entity', async () => {
    const r = await drive(['session', 'terminate', SESSION, '--yes']);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe(`/v2/entities/${SESSION}/commands/terminate`);
    expect(Object.keys(body()).sort()).toEqual(['clientMutationId']);
  });

  it('requires --yes: terminating a session is destructive', async () => {
    const r = await drive(['session', 'terminate', SESSION]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(seen).toEqual([]);
  });

  it('requires the work-session id', async () => {
    const r = await drive(['session', 'terminate', '--yes']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('work-session-id');
    expect(seen).toEqual([]);
  });

  it('sends force only when asked', async () => {
    const r = await drive(['session', 'terminate', SESSION, '--force', '--yes']);
    expect(r.code).toBe(0);
    expect(body().force).toBe(true);
  });

  it('renders an honest 501 faithfully and exits 8', async () => {
    reply = {
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation execution.terminate is not implemented on this node',
          requestId: 'req_501',
          retryable: false,
        },
      },
    };
    const r = await drive(['session', 'terminate', SESSION, '--yes']);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('operation execution.terminate is not implemented on this node');
    expect(r.stdout).toBe('');
  });
});

// ── session attach ──────────────────────────────────────────────────────────

const GRANT = {
  workSessionId: SESSION,
  url: `/v2/ws?sessionId=${SESSION}&mode=view`,
  protocol: 'ws',
  mode: 'view',
  token: `tm8g_${'a'.repeat(43)}`,
  expiresAt: '2030-01-01T00:00:00.000Z',
};

describe('session attach', () => {
  beforeEach(() => {
    reply = { status: 200, body: { data: GRANT, requestId: 'req_t' } };
  });

  it('binds execution.streams.attach and carries the mode', async () => {
    const r = await drive(['session', 'attach', SESSION, '--mode', 'view', '--grant-only']);
    expect(r.code).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.pathname).toBe(`/v2/entities/${SESSION}/commands/streams-attach`);
    expect(body().mode).toBe('view');
    expect(String(body().clientMutationId)).toMatch(UUID_PATTERN);
  });

  it('requires --mode', async () => {
    const r = await drive(['session', 'attach', SESSION]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--mode');
    expect(seen).toEqual([]);
  });

  it('refuses a mode outside view|drive', async () => {
    const r = await drive(['session', 'attach', SESSION, '--mode', 'watch']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('view|drive');
    expect(seen).toEqual([]);
  });

  it('requires the work-session id', async () => {
    const r = await drive(['session', 'attach', '--mode', 'view']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('work-session-id');
    expect(seen).toEqual([]);
  });

  it('--grant-only emits the grant DTO and never opens a socket', async () => {
    const r = await drive([
      'session', 'attach', SESSION, '--mode', 'view', '--grant-only', '--format', 'json',
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(GRANT);
  });

  it('--format json IMPLIES --grant-only: terminal bytes are not DTO output', async () => {
    // No --grant-only here. Under json the command must still return the grant
    // rather than attempt a byte stream; `Output.bytes` would refuse anyway,
    // and refusing after opening a socket would be a side effect nobody asked
    // for.
    const r = await drive(['session', 'attach', SESSION, '--mode', 'drive', '--format', 'json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(GRANT);
    expect(body().mode).toBe('drive');
  });

  it('keeps the grant url and session id in HUMAN output', async () => {
    const r = await drive(['session', 'attach', SESSION, '--mode', 'view', '--grant-only']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(SESSION);
    expect(r.stdout).toContain('/v2/ws?sessionId=');
    expect(r.stdout).not.toContain(GRANT.token);
  });

  it('renders an honest 501 faithfully and exits 8', async () => {
    reply = {
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation execution.streams.attach is not implemented on this node',
          requestId: 'req_501',
          retryable: false,
        },
      },
    };
    const r = await drive(['session', 'attach', SESSION, '--mode', 'view', '--grant-only']);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('is not implemented on this node');
    expect(r.stdout).toBe('');
  });
});
