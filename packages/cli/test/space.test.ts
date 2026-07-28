/**
 * `tm8 space …` and the Space half of group 2 — nineteen G01 rows plus the
 * three W0 additive menu/default-channel rows (A01–A03).
 *
 * WHY THIS FILE DRIVES THE MODULE RATHER THAN `run()`. `src/commands/registry.ts`
 * and `src/run.ts` are coordinator-owned: this slot exports a `CommandModule[]`
 * and does NOT wire it in. So `drive()` below reproduces `run()`'s own funnel —
 * the real `parseInvocation`, the real `splitCommandPath`, the real
 * `resolveContext`, the real `errorLines`/`exitCodeFor` — and substitutes ONLY
 * the registry lookup. Everything under test is the shipped kernel; the one
 * thing not proved here is the import line the coordinator adds, and
 * `test/discovery-commands.test.ts` already proves that for whatever is wired.
 *
 * THE SECURITY BINDING THIS FILE CARRIES. `spaces.invites.create` returns a live
 * invite CODE, and an invite code is BEARER AUTHENTICATION MATERIAL, not an
 * identifier: whoever holds it can join the Space. There is a measured live
 * defect on the composed surface where a ledger replay can return another
 * principal's stored result — including that column. The CLI's duty is exactly
 * two things and they pull in opposite directions:
 *   FAITHFUL RENDER — print what the Server sent, because a client that hides a
 *     server-side disclosure hides it from the gate that has to see it;
 *   ZERO RETENTION  — never cache, persist, log, or re-display it afterwards.
 * Both are asserted below, and the retention probe proves it can detect a write
 * before it is allowed to report that there was none.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { isCommandPath } from '../src/discovery/operations.js';
import { ledger, resolveAvailability } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function spaceCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/space.js')).SPACE_COMMANDS;
}

// ── the stub Server ─────────────────────────────────────────────────────────

interface Seen {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { data: {}, requestId: 'req_t' } };
let scratchHome: string;

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
        query: url.search,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(scratchHome, { recursive: true, force: true });
});

const SPACE = '11111111-1111-7111-8111-111111111111';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: {}, requestId: 'req_t' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g2-home-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

afterEach(() => {
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
});

// ── the driver: `run()`'s funnel with only the registry substituted ─────────

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function drive(argv: readonly string[]): Promise<Ran> {
  const modules = await spaceCommands();
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: (c: string | Uint8Array) => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
    stderr: (c: string) => {
      stderr += c;
    },
  };
  let out = createOutput({ format: 'human', streams });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
      streams,
    });
    const known = new Set(modules.map((m) => m.path.join(' ')));
    const match = splitCommandPath(inv.positionals, (p) => known.has(p.join(' ')));
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '));
    if (!mod) throw new CliError('no module', EXIT_USAGE);
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    const code = await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
    return { code, stdout, stderr };
  } catch (err) {
    out.error(errorLines(err));
    return { code: exitCodeFor(err), stdout, stderr };
  }
}

const AXIS = '22222222-2222-7222-8222-222222222222';
const INVITE = '33333333-3333-7333-8333-333333333333';
const CHANNEL = '44444444-4444-7444-8444-444444444444';

/**
 * Every row this slot owns, with the path its catalog binding MUST produce.
 * The expected path is computed with `bindPath` rather than written out, which
 * is the whole point: if the command hand-wrote a URL, or bound the wrong
 * operation, the two disagree.
 */
const ROWS: ReadonlyArray<{
  op: Parameters<typeof bindPath>[0];
  argv: string[];
  method: string;
  params?: Record<string, string>;
}> = [
  { op: 'spaces.list', argv: ['space', 'list'], method: 'GET' },
  { op: 'spaces.create', argv: ['space', 'create', 'Ops'], method: 'POST' },
  { op: 'spaces.get', argv: ['space', 'get'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.update', argv: ['space', 'update', '--name', 'x'], method: 'PATCH', params: { spaceId: SPACE } },
  { op: 'spaces.navigation', argv: ['space', 'navigation', 'get'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.home', argv: ['space', 'home', 'get'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.settings', argv: ['space', 'settings', 'get'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.members.list', argv: ['space', 'member', 'list'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.invites.list', argv: ['space', 'invite', 'list'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.invites.create', argv: ['space', 'invite', 'create'], method: 'POST', params: { spaceId: SPACE } },
  {
    op: 'spaces.invites.revoke',
    argv: ['space', 'invite', 'revoke', INVITE, '--yes'],
    method: 'POST',
    params: { spaceId: SPACE, inviteId: INVITE },
  },
  { op: 'spaces.invites.redeem', argv: ['space', 'invite', 'redeem', 'JOIN-ME'], method: 'POST' },
  { op: 'spaces.taskAxes.list', argv: ['space', 'task-axis', 'list'], method: 'GET', params: { spaceId: SPACE } },
  {
    op: 'spaces.taskAxes.create',
    argv: ['space', 'task-axis', 'create', 'Stage', '--value', 'a', '--kind', 'manual', '--position', '1'],
    method: 'POST',
    params: { spaceId: SPACE },
  },
  {
    op: 'spaces.taskAxes.update',
    argv: ['space', 'task-axis', 'update', AXIS, '--name', 'Stage', '--value', 'a', '--kind', 'manual', '--position', '1'],
    method: 'PATCH',
    params: { spaceId: SPACE, axisId: AXIS },
  },
  {
    op: 'spaces.taskAxes.delete',
    argv: ['space', 'task-axis', 'delete', AXIS, '--yes'],
    method: 'DELETE',
    params: { spaceId: SPACE, axisId: AXIS },
  },
  { op: 'spaces.leaderboard', argv: ['space', 'leaderboard', 'get'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.awards', argv: ['space', 'award', 'list'], method: 'GET', params: { spaceId: SPACE } },
  { op: 'spaces.menu.get', argv: ['space', 'menu', 'get'], method: 'GET', params: { spaceId: SPACE } },
  {
    op: 'spaces.menu.update',
    argv: ['space', 'menu', 'update', '--expect-revision', '3', '--data', '{"schemaVersion":1,"groups":[]}'],
    method: 'PUT',
    params: { spaceId: SPACE },
  },
  {
    op: 'spaces.defaultChannel.set',
    argv: ['space', 'default-channel', 'set', CHANNEL, '--expect-revision', '1'],
    method: 'PUT',
    params: { spaceId: SPACE },
  },
];

/** Reads refuse `--mutation-id`; mutations require nothing extra to send one. */
const READS = [
  ['space', 'list'],
  ['space', 'get'],
  ['space', 'navigation', 'get'],
  ['space', 'home', 'get'],
  ['space', 'settings', 'get'],
  ['space', 'member', 'list'],
  ['space', 'invite', 'list'],
  ['space', 'task-axis', 'list'],
  ['space', 'leaderboard', 'get'],
  ['space', 'award', 'list'],
  ['space', 'menu', 'get'],
] as const;

describe('the registered command set', () => {
  it('registers all 21 Space rows and nothing that is not in the projection', async () => {
    const paths = (await spaceCommands()).map((c) => c.path.join(' '));
    expect(paths).toHaveLength(21);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(isCommandPath(p.split(' ')), `${p} is wired but absent from the projection`).toBe(true);
    }
  });

  it('does NOT claim `space interaction-profile set-default` — seam ruling S3', async () => {
    // A20 belongs to the Interaction Profile group, beside its symmetric
    // `teammate interaction-profile set-default`. `registry.ts` throws at IMPORT
    // on a duplicate path, so a second registration here would not fail one
    // test — it would collapse the whole suite for every slot at once.
    const paths = (await spaceCommands()).map((c) => c.path.join(' '));
    expect(paths).not.toContain('space interaction-profile set-default');
  });

  it('covers the rows the projection gives a `space …` command path', async () => {
    const paths = new Set((await spaceCommands()).map((c) => c.path.join(' ')));
    expect(paths.has('space list')).toBe(true);
    expect(paths.has('space default-channel set')).toBe(true);
    expect(paths.has('space menu update')).toBe(true);
  });
});

describe('every row binds its path from the catalog', () => {
  it('sends the exact method and bound path for all 21 rows', async () => {
    let checked = 0;
    for (const row of ROWS) {
      seen = [];
      const r = await drive([...row.argv, '--format', 'json']);
      expect(r.code, `${row.op}: ${r.stderr}`).toBe(0);
      expect(seen, row.op).toHaveLength(1);
      expect(seen[0]?.method, row.op).toBe(row.method);
      expect(seen[0]?.pathname, row.op).toBe(bindPath(row.op, row.params ?? {}));
      checked++;
    }
    // Vacuity guard: a loop that silently iterates zero rows passes everything.
    expect(checked).toBe(21);
    expect(ROWS).toHaveLength(21);
  });
});

describe('mutation identity (§7.4)', () => {
  it('every read REFUSES --mutation-id and never reaches the network', async () => {
    let checked = 0;
    for (const path of READS) {
      seen = [];
      const r = await drive([...path, '--mutation-id', 'abc']);
      expect(r.code, path.join(' ')).toBe(2);
      expect(r.stderr, path.join(' ')).toMatch(/--mutation-id applies only to mutations/);
      expect(seen, path.join(' ')).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(11);
  });

  it('a mutation generates a UUIDv7 when --mutation-id is omitted', async () => {
    await drive(['space', 'create', 'Ops']);
    const body = seen[0]?.body as { clientMutationId?: string } | undefined;
    expect(body?.clientMutationId).toMatch(UUID_PATTERN);
    expect(body?.clientMutationId?.[14]).toBe('7');
  });

  it('a supplied --mutation-id is passed through VERBATIM, never regenerated', async () => {
    await drive(['space', 'create', 'Ops', '--mutation-id', 'NOT-a-uuid-but-MINE']);
    expect((seen[0]?.body as { clientMutationId?: string }).clientMutationId).toBe('NOT-a-uuid-but-MINE');
  });
});

describe('destructive confirmation (§7.5)', () => {
  it('`space invite revoke` without --yes is exit 2 and sends nothing', async () => {
    const r = await drive(['space', 'invite', 'revoke', INVITE]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--yes/);
    expect(seen).toHaveLength(0);
  });

  it('`space task-axis delete` without --yes is exit 2 and sends nothing', async () => {
    const r = await drive(['space', 'task-axis', 'delete', AXIS]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--yes/);
    expect(seen).toHaveLength(0);
  });

  it('--format json does not imply consent', async () => {
    const r = await drive(['space', 'invite', 'revoke', INVITE, '--format', 'json']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe('local validation happens before the network', () => {
  it('`space update` with nothing to change is exit 2', async () => {
    const r = await drive(['space', 'update']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/needs something to change/);
    expect(seen).toHaveLength(0);
  });

  it('`space create` without a name is exit 2', async () => {
    const r = await drive(['space', 'create']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('`space task-axis create` requires --value, --kind and --position', async () => {
    for (const argv of [
      ['space', 'task-axis', 'create', 'Stage', '--kind', 'manual', '--position', '1'],
      ['space', 'task-axis', 'create', 'Stage', '--value', 'a', '--position', '1'],
      ['space', 'task-axis', 'create', 'Stage', '--value', 'a', '--kind', 'manual'],
    ]) {
      seen = [];
      const r = await drive(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(seen, argv.join(' ')).toHaveLength(0);
    }
  });

  it('--kind takes the exact contract spelling, not an invented one', async () => {
    const r = await drive([
      'space', 'task-axis', 'create', 'Stage',
      '--value', 'a', '--kind', 'Manual', '--position', '1',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/default\|manual/);
    expect(seen).toHaveLength(0);
  });

  it('no Space in context is a usage error naming the four resolution steps', async () => {
    delete process.env.TM8_SPACE_ID;
    const r = await drive(['space', 'get']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no Space in context/);
    expect(seen).toHaveLength(0);
  });
});

describe('the `|none` idiom clears rather than sends the literal string', () => {
  it('`--github-repo none` sends null', async () => {
    await drive(['space', 'update', '--github-repo', 'none']);
    expect((seen[0]?.body as { githubRepo?: unknown }).githubRepo).toBeNull();
  });

  it('`--expires-at none` sends null', async () => {
    await drive(['space', 'invite', 'create', '--expires-at', 'none']);
    expect((seen[0]?.body as { expiresAt?: unknown }).expiresAt).toBeNull();
  });

  it('`space default-channel set none` sends channelId null', async () => {
    await drive(['space', 'default-channel', 'set', 'none', '--expect-revision', '1']);
    expect((seen[0]?.body as { channelId?: unknown }).channelId).toBeNull();
  });

  it('a real channel id is sent as itself', async () => {
    await drive(['space', 'default-channel', 'set', CHANNEL, '--expect-revision', '1']);
    expect((seen[0]?.body as { channelId?: unknown }).channelId).toBe(CHANNEL);
  });
});

describe('Space resolution: the optional positional and the global flag', () => {
  const OTHER = '55555555-5555-7555-8555-555555555555';

  it('the positional <space-id> wins over session-injected context', async () => {
    await drive(['space', 'get', OTHER]);
    expect(seen[0]?.pathname).toBe(bindPath('spaces.get', { spaceId: OTHER }));
  });

  it('an EXPLICIT --space that contradicts the positional is a usage error', async () => {
    // Two explicit answers on one command line to "which Space?" is a caller
    // who believes something false about where their write lands.
    const r = await drive(['space', 'update', OTHER, '--space', SPACE, '--name', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/two different Spaces/);
    expect(seen).toHaveLength(0);
  });

  it('an explicit --space that AGREES with the positional is fine', async () => {
    const r = await drive(['space', 'get', OTHER, '--space', OTHER]);
    expect(r.code).toBe(0);
    expect(seen[0]?.pathname).toBe(bindPath('spaces.get', { spaceId: OTHER }));
  });
});

describe('pagination (§7.2)', () => {
  it('--limit and --cursor become query parameters', async () => {
    await drive(['space', 'award', 'list', '--limit', '5', '--cursor', 'Y3Vyc29y']);
    expect(seen[0]?.query).toContain('limit=5');
    expect(seen[0]?.query).toContain('cursor=Y3Vyc29y');
  });

  it('the cursor is opaque — passed through byte-for-byte, never decoded', async () => {
    const cursor = 'eyJrIjpbIjIwMjQiLCJhYiJdfQ==';
    await drive(['space', 'leaderboard', 'get', '--cursor', cursor]);
    const got = new URLSearchParams(seen[0]?.query ?? '').get('cursor');
    expect(got).toBe(cursor);
  });

  it('a non-integer --limit is a local usage error', async () => {
    const r = await drive(['space', 'list', '--limit', 'lots']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe('output law (§7.1)', () => {
  it('--format json emits the exact contract DTO, with no CLI envelope', async () => {
    reply = {
      status: 200,
      body: { data: { id: SPACE, name: 'Ops', memberCount: 3 }, requestId: 'req_1' },
    };
    const r = await drive(['space', 'get', '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({ id: SPACE, name: 'Ops', memberCount: 3 });
    expect(r.stdout).not.toContain('requestId');
  });

  it('human output renders the SAME DTO and never drops an id a follow-up needs', async () => {
    reply = { status: 200, body: { data: { id: SPACE, name: 'Ops', memberCount: 3 }, requestId: 'r' } };
    const r = await drive(['space', 'get']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(SPACE);
    expect(r.stdout).toContain('Ops');
  });

  it('a refusal puts NOTHING on stdout and everything on stderr', async () => {
    reply = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'nope', requestId: 'r1', retryable: false } },
    };
    const r = await drive(['space', 'get']);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/forbidden/);
  });
});

describe('per-node availability is derived, never assumed', () => {
  it('a not_implemented answer is exit 8 and teaches the availability ledger', async () => {
    reply = {
      status: 501,
      body: {
        error: {
          code: 'not_implemented',
          message: 'operation spaces.menu.get is not implemented on this node',
          requestId: 'r2',
          retryable: false,
        },
      },
    };
    const r = await drive(['space', 'menu', 'get']);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('operation spaces.menu.get is not implemented on this node');
    expect(resolveAvailability('spaces.menu.get', 'v1')).toEqual({
      availability: 'unavailable',
      availabilityReason: 'not_implemented_on_node',
      availabilitySource: 'observed',
    });
  });

  it('a working row is recorded as available, so the ledger is not write-only', async () => {
    // The positive control for the probe above: an assertion that can only ever
    // report `unavailable` proves nothing about what it measured.
    await drive(['space', 'list']);
    expect(resolveAvailability('spaces.list', 'v1').availability).toBe('available');
  });

  it('a refusal that is NOT not_implemented still proves a handler exists', async () => {
    reply = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'no', requestId: 'r', retryable: false } },
    };
    await drive(['space', 'settings', 'get']);
    expect(resolveAvailability('spaces.settings', 'v1').availability).toBe('available');
  });
});

describe('INVITE CODES ARE CREDENTIALS — faithful render, zero retention', () => {
  const CODE = 'JOIN-7Q2F-LIVE';

  beforeEach(() => {
    reply = {
      status: 201,
      body: {
        data: { id: INVITE, code: CODE, maxUses: 1, uses: 0, expiresAt: null, revoked: false },
        requestId: 'r3',
      },
    };
  });

  it('renders the code the Server sent, in human and in json alike', async () => {
    const human = await drive(['space', 'invite', 'create']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(CODE);

    const json = await drive(['space', 'invite', 'create', '--format', 'json']);
    expect((JSON.parse(json.stdout) as { code: string }).code).toBe(CODE);
  });

  it('says on STDERR what the code is, without instructing whoever reads it', async () => {
    const r = await drive(['space', 'invite', 'create']);
    expect(r.stderr).toMatch(/bearer/i);
    // In a PTY, stderr and stdout land in the same agent context. A diagnostic
    // that reads as an instruction becomes an instruction.
    expect(r.stderr).not.toMatch(/\b(you should|you must|please|do not share|remember to)\b/i);
  });

  it('the credential note is never silenced by --quiet', async () => {
    const r = await drive(['space', 'invite', 'create', '--quiet']);
    expect(r.stderr).toMatch(/bearer/i);
  });

  it('says nothing about credentials when no code was disclosed', async () => {
    // The note must track the DTO, not the command name — otherwise it is
    // decoration and stops being evidence of anything.
    reply = { status: 200, body: { data: [], requestId: 'r' } };
    const r = await drive(['space', 'invite', 'list']);
    expect(r.stderr).toBe('');
  });

  it('writes NOTHING to disk — and the probe proves it can see a write', async () => {
    const before = readdirSync(scratchHome, { recursive: true }) as string[];
    await drive(['space', 'invite', 'create']);
    await drive(['space', 'invite', 'list']);
    const after = readdirSync(scratchHome, { recursive: true }) as string[];
    expect(after).toEqual(before);

    // POSITIVE CONTROL. A probe that reports "nothing was written" is worthless
    // until it has demonstrated it can detect something being written.
    writeFileSync(join(scratchHome, 'canary.json'), '{}');
    const poisoned = readdirSync(scratchHome, { recursive: true }) as string[];
    expect(poisoned).not.toEqual(before);
    rmSync(join(scratchHome, 'canary.json'));
  });
});

describe('the A02 menu payload', () => {
  it('--data carries the payload and --expect-revision the guard, per its DTO', async () => {
    await drive([
      'space', 'menu', 'update',
      '--expect-revision', '4',
      '--data', '{"schemaVersion":1,"groups":[]}',
    ]);
    const body = seen[0]?.body as { expectedRevision?: unknown; payload?: unknown };
    expect(body.expectedRevision).toBe(4);
    expect(body.payload).toEqual({ schemaVersion: 1, groups: [] });
  });

  it('a --data that is not a JSON object is a local usage error', async () => {
    const r = await drive(['space', 'menu', 'update', '--expect-revision', '4', '--data', '[1,2]']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('menu update requires its revision guard', async () => {
    const r = await drive(['space', 'menu', 'update', '--data', '{"schemaVersion":1,"groups":[]}']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

/**
 * A03's guard flag. RESTORATION, NOT INVENTION: `SetDefaultChannelInput` has
 * always REQUIRED its guard; only the CLI flag name was unspecified, and the
 * flag surface is this wave's own. The name is derived mechanically by
 * kebab-casing the frozen field, dropping nothing.
 *
 * The field name is taken from RUNTIME INTROSPECTION of the frozen schema, not
 * from a name-grep and not from a table:
 *     SetDefaultChannelInputSchema
 *       clientMutationId          ZodString            REQUIRED
 *       expectedSettingsRevision  ZodNumber            REQUIRED
 *       channelId                 ZodNullable | null   REQUIRED
 * so `expectedSettingsRevision` -> `--expect-settings-revision`. That is NOT
 * `--expect-revision`, which belongs to `UpdateMenuInput.expectedRevision` —
 * a different field on a different row. Two guards that differ by one word are
 * exactly the pair a grep collapses and introspection keeps apart.
 */
describe('A03 sends the guard its frozen schema requires', () => {
  it('requires --expect-revision and sends it as expectedSettingsRevision', async () => {
    await drive(['space', 'default-channel', 'set', CHANNEL, '--expect-revision', '7']);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body.expectedSettingsRevision).toBe(7);
    expect(body.channelId).toBe(CHANNEL);
    // Exactly the frozen shape — `.strict()` rejects anything else.
    expect(Object.keys(body).sort()).toEqual([
      'channelId', 'clientMutationId', 'expectedSettingsRevision',
    ]);
  });

  it('is REQUIRED, because the schema marks the field required', async () => {
    const r = await drive(['space', 'default-channel', 'set', CHANNEL]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--expect-revision/);
    expect(seen).toHaveLength(0);
  });

  it('⚠ shares the flag SPELLING with `space menu update` but NOT the field', async () => {
    // THE HAZARD, PINNED. Both rows take `--expect-revision`; their fields
    // differ. Kebab-casing would have given this row `--expect-settings-revision`,
    // but the derivation is only the default and dossier §7 ("CLI freeze") names
    // the shorter flag — authority beats derivation. Crossing the two fields is a
    // mistake that has already been made once at coordinator level, so the wire
    // shape of EACH row is asserted here rather than assumed.
    await drive(['space', 'default-channel', 'set', CHANNEL, '--expect-revision', '7']);
    const channelBody = seen[0]?.body as Record<string, unknown>;
    expect(channelBody.expectedSettingsRevision).toBe(7);
    expect(channelBody).not.toHaveProperty('expectedRevision');

    seen = [];
    await drive(['space', 'menu', 'update', '--expect-revision', '7', '--data', '{"schemaVersion":1,"groups":[]}']);
    const menuBody = seen[0]?.body as Record<string, unknown>;
    expect(menuBody.expectedRevision).toBe(7);
    expect(menuBody).not.toHaveProperty('expectedSettingsRevision');

    // Both schemas are `.strict()`, so a crossed field is a loud 400 on the
    // first real call rather than a silent wrong answer — but "fails loudly" is
    // not a reason to leave it unasserted.
  });

  it('still clears with `none` while carrying the guard', async () => {
    await drive(['space', 'default-channel', 'set', 'none', '--expect-revision', '2']);
    expect((seen[0]?.body as { channelId?: unknown }).channelId).toBeNull();
    expect((seen[0]?.body as { expectedSettingsRevision?: unknown }).expectedSettingsRevision).toBe(2);
  });
});

/**
 * PROBE-RED ON THE MATCHER ITSELF, so the paging assertion in the integration
 * suite cannot pass vacuously.
 *
 * The cursor-truncation class: a `timestamptz` (MICROseconds) round-tripped
 * through a JS `Date` (MILLIseconds) loses its tail. The two directions differ
 * in how visible they are, and the quiet one is the dangerous one:
 *   truncated DOWN -> cursor too SMALL -> re-admits the boundary row -> loops. LOUD.
 *   rounded UP     -> cursor too LARGE -> SKIPS rows -> SILENT DATA LOSS.
 * A "terminates and does not overlap" assertion passes cleanly over the second.
 *
 * A matcher is an instrument, and an instrument is verified before it is
 * trusted: this proves it ACCEPTS full precision, REJECTS a millisecond tail,
 * and REJECTS the specific artifact a `Date` round-trip produces.
 */
export const MICROSECOND_CURSOR = /\.\d{6}Z?$/;

describe('the microsecond cursor matcher discriminates', () => {
  it('accepts a full-precision timestamp', () => {
    expect('2026-07-27T06:34:13.421911Z').toMatch(MICROSECOND_CURSOR);
  });

  it('REJECTS a millisecond tail', () => {
    expect('2026-07-27T06:34:13.421Z').not.toMatch(MICROSECOND_CURSOR);
  });

  it('REJECTS what a JS Date round-trip actually produces', () => {
    // Not a hand-written string — the real artifact, computed here, so the test
    // tracks the runtime rather than someone's memory of it.
    const truncated = new Date('2026-07-27T06:34:13.421911Z').toISOString();
    expect(truncated).toBe('2026-07-27T06:34:13.421Z');
    expect(truncated).not.toMatch(MICROSECOND_CURSOR);
  });
});

describe('--as selects an author and is carried as actorId', () => {
  it('a mutation carries the resolved actor', async () => {
    const actor = '66666666-6666-7666-8666-666666666666';
    await drive(['space', 'invite', 'create', '--as', actor]);
    expect((seen[0]?.body as { actorId?: unknown }).actorId).toBe(actor);
  });

  it('a read carries no body at all', async () => {
    await drive(['space', 'list']);
    expect(seen[0]?.body).toBeUndefined();
  });

  it('the two DTOs with NO author field never receive an actorId', async () => {
    // `UpdateMenuInput` and `SetDefaultChannelInput` do not extend
    // `CommandContext` and are `.strict()`. Sending `actorId` would be the CLI
    // putting a body on the wire that the frozen schema rejects.
    process.env.TM8_ACTOR_ID = '66666666-6666-7666-8666-666666666666';
    await drive(['space', 'default-channel', 'set', 'none', '--expect-revision', '1']);
    expect(seen[0]?.body).not.toHaveProperty('actorId');

    seen = [];
    await drive(['space', 'menu', 'update', '--expect-revision', '1', '--data', '{"schemaVersion":1,"groups":[]}']);
    expect(seen[0]?.body).not.toHaveProperty('actorId');
    expect(Object.keys(seen[0]?.body as object).sort()).toEqual([
      'clientMutationId', 'expectedRevision', 'payload',
    ]);
  });

  it('an EXPLICIT --as on those two rows is refused, not silently dropped', async () => {
    const actor = '66666666-6666-7666-8666-666666666666';
    for (const argv of [
      ['space', 'default-channel', 'set', 'none', '--expect-revision', '1', '--as', actor],
      ['space', 'menu', 'update', '--expect-revision', '1', '--data', '{"schemaVersion":1,"groups":[]}', '--as', actor],
    ]) {
      seen = [];
      const r = await drive(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toMatch(/no author field/);
      expect(seen, argv.join(' ')).toHaveLength(0);
    }
  });

  it('but an INJECTED actor on those rows is dropped rather than refused', async () => {
    // Session-injected context is the ordinary case; refusing it would make the
    // command unusable inside every host-spawned session.
    process.env.TM8_ACTOR_ID = '66666666-6666-7666-8666-666666666666';
    const r = await drive(['space', 'default-channel', 'set', 'none', '--expect-revision', '1']);
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
  });
});
