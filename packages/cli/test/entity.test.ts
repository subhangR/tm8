/**
 * `tm8 entity …` — the universal entity surface (W4 group 3).
 *
 * SIXTEEN command paths, projecting sixteen catalog rows: the twelve
 * `entities.*` rows this slot owns, the two W0 additive rows (`entities.feed`,
 * `entities.context`), `entities.commands.pull`, and `collections.query` —
 * which is a `collections` row wearing an `entity` command path, exactly as the
 * frozen projection says.
 *
 * WHY THIS FILE DRIVES THE MODULE RATHER THAN `run()`. `src/run.ts` and
 * `src/commands/registry.ts` are coordinator-owned: this slot exports a
 * `CommandModule[]` and does NOT wire it in. `drive()` therefore reproduces
 * `run()`'s own funnel — the real `parseInvocation`, the real
 * `splitCommandPath`, the real `resolveContext`, the real
 * `errorLines`/`exitCodeFor` — and substitutes ONLY the registry lookup. What
 * is under test is the shipped kernel plus this module.
 *
 * SEAM RULING S1 IS ASSERTED HERE. `entity connections` is group 4's row: the
 * DTO is `Page<EdgeView>` and edge-shaped. `registry.ts` throws at IMPORT on a
 * duplicate path, so a double registration would not fail one test — it would
 * collapse every suite in this package at once. The absence is therefore
 * asserted, not assumed.
 *
 * THE PATH IS NEVER WRITTEN OUT. Every expectation is computed with
 * `bindPath`, which is the whole point of the closed catalog: if a command
 * hand-wrote a URL, or bound the wrong operation name, the command and the
 * catalog disagree and the row fails.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPath, type OperationName } from '@tm8/contract';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import { UUID_PATTERN } from '../src/mutation.js';
import { commandDiscovery, isCommandPath } from '../src/discovery/operations.js';
import { ledger } from '../src/discovery/availability.js';
import type { CommandModule } from '../src/run.js';

/** Imported lazily so a missing module fails each TEST, not only the FILE. */
async function entityCommands(): Promise<CommandModule[]> {
  return (await import('../src/commands/entity.js')).ENTITY_COMMANDS;
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
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

const SPACE = '11111111-1111-7111-8111-111111111111';
const ENT = '55555555-5555-7555-8555-555555555555';
const OTHER = '66666666-6666-7666-8666-666666666666';
const ACTOR = '77777777-7777-7777-8777-777777777777';

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { data: {}, requestId: 'req_t' } };
  ledger.clear();
  scratchHome ??= mkdtempSync(join(tmpdir(), 'tm8-w4-g3-home-'));
  process.env.TM8_BASE_URL = baseUrl;
  process.env.TM8_SPACE_ID = SPACE;
  process.env.XDG_CONFIG_HOME = scratchHome;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
});

afterEach(() => {
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_BASE_URL;
});

// ── the driver: `run()`'s funnel with only the registry substituted ─────────

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function driveWith(modules: CommandModule[], argv: readonly string[]): Promise<Ran> {
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
    /* c8 ignore next */
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

async function drive(argv: readonly string[]): Promise<Ran> {
  return driveWith(await entityCommands(), argv);
}

// ── every row, bound through the catalog ────────────────────────────────────

interface RowCase {
  op: OperationName;
  argv: string[];
  method: string;
  params?: Record<string, string>;
}

const ROWS: readonly RowCase[] = [
  { op: 'entities.get', argv: ['entity', 'get', ENT], method: 'GET', params: { id: ENT } },
  { op: 'entities.create', argv: ['entity', 'create', 'task', 'Ship it'], method: 'POST' },
  {
    op: 'entities.patch',
    argv: ['entity', 'update', ENT, '--expect-version', '3', '--title', 'x'],
    method: 'PATCH',
    params: { id: ENT },
  },
  {
    op: 'entities.move',
    argv: ['entity', 'move', ENT, '--parent', 'none', '--position', '2', '--expect-version', '3'],
    method: 'POST',
    params: { id: ENT },
  },
  { op: 'entities.delete', argv: ['entity', 'delete', ENT, '--yes'], method: 'DELETE', params: { id: ENT } },
  { op: 'entities.restore', argv: ['entity', 'restore', ENT], method: 'POST', params: { id: ENT } },
  { op: 'entities.children', argv: ['entity', 'children', ENT], method: 'GET', params: { id: ENT } },
  { op: 'entities.hierarchy', argv: ['entity', 'hierarchy', ENT], method: 'GET', params: { id: ENT } },
  { op: 'entities.versions', argv: ['entity', 'versions', ENT], method: 'GET', params: { id: ENT } },
  { op: 'entities.activity', argv: ['entity', 'activity', ENT], method: 'GET', params: { id: ENT } },
  { op: 'entities.react', argv: ['entity', 'react', ENT, 'like'], method: 'PUT', params: { id: ENT } },
  {
    op: 'entities.points.add',
    argv: ['entity', 'point', 'grant', ENT, '5', '--reason', 'grant'],
    method: 'POST',
    params: { id: ENT },
  },
  { op: 'entities.feed', argv: ['entity', 'feed', ENT], method: 'GET', params: { id: ENT } },
  { op: 'entities.context', argv: ['entity', 'context', ENT], method: 'GET', params: { id: ENT } },
  {
    op: 'entities.commands.pull',
    argv: ['entity', 'pull', ENT, '--pinned-version', '4'],
    method: 'POST',
    params: { id: ENT },
  },
  { op: 'collections.query', argv: ['entity', 'query'], method: 'POST' },
];

describe('the sixteen rows this slot owns', () => {
  it('registers exactly the sixteen command paths, and no others', async () => {
    const paths = (await entityCommands()).map((m) => m.path.join(' ')).sort();
    expect(paths).toEqual(
      [
        'entity activity',
        'entity children',
        'entity context',
        'entity create',
        'entity delete',
        'entity feed',
        'entity get',
        'entity hierarchy',
        'entity move',
        'entity point grant',
        'entity pull',
        'entity query',
        'entity react',
        'entity restore',
        'entity update',
        'entity versions',
      ].sort(),
    );
  });

  /**
   * SEAM RULING S1. `entities.connections` is group 4's, and `registry.ts`
   * throws at IMPORT on a duplicate path — so registering it here would not
   * fail one test, it would take down every suite in this package.
   */
  it('does NOT register `entity connections` — that row belongs to group 4', async () => {
    const paths = (await entityCommands()).map((m) => m.path.join(' '));
    expect(paths).not.toContain('entity connections');
  });

  it('every registered path is in the frozen grammar projection', async () => {
    const modules = await entityCommands();
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) expect(isCommandPath(m.path)).toBe(true);
  });

  for (const row of ROWS) {
    it(`${row.argv.slice(0, 3).join(' ')} binds ${row.op} through bindPath`, async () => {
      const r = await drive(row.argv);
      expect({ op: row.op, code: r.code, stderr: r.stderr }).toEqual({
        op: row.op,
        code: 0,
        stderr: '',
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe(row.method);
      expect(seen[0]?.pathname).toBe(bindPath(row.op, row.params ?? {}));
    });
  }
});

// ── mutation identity (§7.4) ────────────────────────────────────────────────

describe('mutation identity', () => {
  const MUTATIONS: ReadonlyArray<{ argv: string[]; label: string }> = [
    { label: 'entity create', argv: ['entity', 'create', 'task', 'Ship it'] },
    { label: 'entity update', argv: ['entity', 'update', ENT, '--expect-version', '3', '--title', 'x'] },
    {
      label: 'entity move',
      argv: ['entity', 'move', ENT, '--parent', 'none', '--position', '2', '--expect-version', '3'],
    },
    { label: 'entity delete', argv: ['entity', 'delete', ENT, '--yes'] },
    { label: 'entity restore', argv: ['entity', 'restore', ENT] },
    { label: 'entity react', argv: ['entity', 'react', ENT, 'like'] },
    { label: 'entity point grant', argv: ['entity', 'point', 'grant', ENT, '5', '--reason', 'grant'] },
    { label: 'entity pull', argv: ['entity', 'pull', ENT, '--pinned-version', '4'] },
  ];

  for (const m of MUTATIONS) {
    it(`${m.label} generates a UUIDv7 clientMutationId when none is given`, async () => {
      const r = await drive(m.argv);
      expect(r.code).toBe(0);
      const body = seen[0]?.body as { clientMutationId?: string };
      expect(body?.clientMutationId).toMatch(UUID_PATTERN);
      // v7: the version nibble is literally `7`.
      expect(body?.clientMutationId?.[14]).toBe('7');
    });

    it(`${m.label} passes a supplied --mutation-id through VERBATIM`, async () => {
      const supplied = 'NOT-a-uuid-but-MINE';
      const r = await drive([...m.argv, '--mutation-id', supplied]);
      expect(r.code).toBe(0);
      expect((seen[0]?.body as { clientMutationId?: string })?.clientMutationId).toBe(supplied);
    });
  }

  const READS: ReadonlyArray<{ argv: string[]; label: string }> = [
    { label: 'entity get', argv: ['entity', 'get', ENT] },
    { label: 'entity children', argv: ['entity', 'children', ENT] },
    { label: 'entity hierarchy', argv: ['entity', 'hierarchy', ENT] },
    { label: 'entity versions', argv: ['entity', 'versions', ENT] },
    { label: 'entity activity', argv: ['entity', 'activity', ENT] },
    { label: 'entity feed', argv: ['entity', 'feed', ENT] },
    { label: 'entity context', argv: ['entity', 'context', ENT] },
    { label: 'entity query', argv: ['entity', 'query'] },
  ];

  for (const rd of READS) {
    it(`${rd.label} REFUSES --mutation-id — a read is not a mutation`, async () => {
      const r = await drive([...rd.argv, '--mutation-id', '018f0000-0000-7000-8000-000000000000']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--mutation-id applies only to mutations');
      expect(seen).toHaveLength(0);
    });
  }
});

// ── destructive confirmation (§7.5) ─────────────────────────────────────────

describe('destructive confirmation', () => {
  it('entity delete without --yes never reaches the network', async () => {
    const r = await drive(['entity', 'delete', ENT]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(seen).toHaveLength(0);
  });

  it('entity restore is NOT destructive and needs no --yes', async () => {
    const r = await drive(['entity', 'restore', ENT]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
  });
});

// ── request payloads, field by field ────────────────────────────────────────

describe('entity create', () => {
  it('sends kind, title and the resolved Space, and answers 201 as a SUCCESS', async () => {
    reply = { status: 201, body: { data: { id: OTHER }, requestId: 'req_t' } };
    const r = await drive(['entity', 'create', 'doc', 'Design notes']);
    expect(r.code).toBe(0);
    expect(seen[0]?.body).toMatchObject({ kind: 'doc', title: 'Design notes', spaceId: SPACE });
  });

  it('folds --attach-to, --relate-to and --connect into one deduped connections array', async () => {
    const r = await drive([
      'entity', 'create', 'task', 'T',
      '--attach-to', ENT,
      '--relate-to', OTHER,
      '--connect', `depends_on=${OTHER}`,
      '--connect', `attached_to=${ENT}`,
    ]);
    expect(r.code).toBe(0);
    expect((seen[0]?.body as { connections?: unknown }).connections).toEqual([
      { type: 'attached_to', targetId: ENT },
      { type: 'relates_to', targetId: OTHER },
      { type: 'depends_on', targetId: OTHER },
    ]);
  });

  it('rejects a --connect without `=` locally rather than sending it', async () => {
    const r = await drive(['entity', 'create', 'task', 'T', '--connect', 'depends_on']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--connect');
    expect(seen).toHaveLength(0);
  });

  it('--parent none clears the parent; a value sets it', async () => {
    await drive(['entity', 'create', 'task', 'T', '--parent', 'none']);
    expect((seen[0]?.body as { parentId?: unknown }).parentId).toBeNull();
    seen = [];
    await drive(['entity', 'create', 'task', 'T', '--parent', ENT]);
    expect((seen[0]?.body as { parentId?: unknown }).parentId).toBe(ENT);
  });

  it('--content must be a JSON OBJECT, and says so locally', async () => {
    const r = await drive(['entity', 'create', 'task', 'T', '--content', '[1,2]']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('carries --as into the body as actorId', async () => {
    await drive(['entity', 'create', 'task', 'T', '--as', ACTOR]);
    expect((seen[0]?.body as { actorId?: string }).actorId).toBe(ACTOR);
  });

  it('requires <kind> and <title>', async () => {
    expect((await drive(['entity', 'create'])).code).toBe(2);
    expect((await drive(['entity', 'create', 'task'])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe('entity update', () => {
  it('requires --expect-version', async () => {
    const r = await drive(['entity', 'update', ENT, '--title', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect-version');
    expect(seen).toHaveLength(0);
  });

  it('refuses an update with nothing to change', async () => {
    const r = await drive(['entity', 'update', ENT, '--expect-version', '3']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('sends expectedVersion as a NUMBER, not a string', async () => {
    await drive(['entity', 'update', ENT, '--expect-version', '3', '--title', 'x']);
    expect((seen[0]?.body as { expectedVersion?: unknown }).expectedVersion).toBe(3);
  });
});

describe('entity move', () => {
  it('requires --parent, --position and --expect-version', async () => {
    expect((await drive(['entity', 'move', ENT, '--position', '1', '--expect-version', '2'])).code).toBe(2);
    expect((await drive(['entity', 'move', ENT, '--parent', 'none', '--expect-version', '2'])).code).toBe(2);
    expect((await drive(['entity', 'move', ENT, '--parent', 'none', '--position', '1'])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('sends parentId null for `none` and numbers for position/expectedVersion', async () => {
    await drive(['entity', 'move', ENT, '--parent', 'none', '--position', '2', '--expect-version', '3']);
    expect(seen[0]?.body).toMatchObject({ parentId: null, position: 2, expectedVersion: 3 });
  });
});

describe('entity react', () => {
  it('sends enabled true by default and false under --off', async () => {
    await drive(['entity', 'react', ENT, 'star']);
    expect(seen[0]?.body).toMatchObject({ reaction: 'star', enabled: true });
    seen = [];
    await drive(['entity', 'react', ENT, 'star', '--off']);
    expect(seen[0]?.body).toMatchObject({ reaction: 'star', enabled: false });
  });

  it('refuses a reaction outside like|dislike|star locally', async () => {
    const r = await drive(['entity', 'react', ENT, 'heart']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('like');
    expect(seen).toHaveLength(0);
  });
});

describe('entity point grant', () => {
  it('sends a numeric amount and the reason', async () => {
    await drive(['entity', 'point', 'grant', ENT, '5', '--reason', 'award', '--reference', OTHER]);
    expect(seen[0]?.body).toMatchObject({ amount: 5, reason: 'award', referenceId: OTHER });
  });

  it('refuses a non-numeric amount and an unknown reason locally', async () => {
    expect((await drive(['entity', 'point', 'grant', ENT, 'five', '--reason', 'grant'])).code).toBe(2);
    expect((await drive(['entity', 'point', 'grant', ENT, '5', '--reason', 'bribe'])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe('entity pull', () => {
  it('sends pinnedVersion, and localId null for the literal `none`', async () => {
    await drive(['entity', 'pull', ENT, '--pinned-version', '4', '--local-id', 'none']);
    expect(seen[0]?.body).toMatchObject({ pinnedVersion: 4, localId: null });
  });
});

// ── paging: query params, not a body (`input: none` rows) ───────────────────

describe('paged reads carry --limit/--cursor as QUERY parameters', () => {
  const PAGED: ReadonlyArray<{ argv: string[]; label: string }> = [
    { label: 'entity children', argv: ['entity', 'children', ENT] },
    { label: 'entity versions', argv: ['entity', 'versions', ENT] },
    { label: 'entity activity', argv: ['entity', 'activity', ENT] },
    { label: 'entity feed', argv: ['entity', 'feed', ENT] },
  ];
  for (const p of PAGED) {
    it(`${p.label} sends no body at all`, async () => {
      await drive([...p.argv, '--limit', '5', '--cursor', 'abc']);
      expect(seen[0]?.body).toBeUndefined();
      expect(seen[0]?.query).toContain('limit=5');
      expect(seen[0]?.query).toContain('cursor=abc');
    });
  }

  it('--limit must be an integer', async () => {
    const r = await drive(['entity', 'children', ENT, '--limit', 'lots']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('entity feed carries scope, order and around', async () => {
    await drive(['entity', 'feed', ENT, '--scope', 'session_chat_v1', '--order', 'oldest', '--around', `message:${OTHER}`]);
    expect(seen[0]?.query).toContain('scope=session_chat_v1');
    expect(seen[0]?.query).toContain('order=oldest');
    expect(seen[0]?.query).toContain(`around=message%3A${OTHER}`);
  });
});

// ── entity query (collections.query) ────────────────────────────────────────

describe('entity query', () => {
  it('always carries the resolved spaceId', async () => {
    await drive(['entity', 'query']);
    expect(seen[0]?.body).toEqual({ spaceId: SPACE });
  });

  it('folds repeatable filters into the frozen CollectionQuery shape', async () => {
    await drive([
      'entity', 'query',
      '--kind', 'task', '--kind', 'doc',
      '--subtree', ENT,
      '--work-status', 'working', '--work-status', 'in_review',
      '--assignee', ACTOR,
      '--ready',
      '--limit', '10',
      '--cursor', 'c1',
    ]);
    expect(seen[0]?.body).toEqual({
      spaceId: SPACE,
      kinds: ['task', 'doc'],
      subtreeOf: ENT,
      filters: {
        workStatus: ['working', 'in_review'],
        assigneeIds: [ACTOR],
        readyToPull: true,
      },
      limit: 10,
      cursor: 'c1',
    });
  });

  it('omits `filters` entirely when no filter flag is given', async () => {
    await drive(['entity', 'query', '--kind', 'task']);
    expect(seen[0]?.body).toEqual({ spaceId: SPACE, kinds: ['task'] });
  });

  it('fails locally with no Space in context', async () => {
    delete process.env.TM8_SPACE_ID;
    const r = await drive(['entity', 'query']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no Space in context');
    expect(seen).toHaveLength(0);
  });
});

// ── entity context: the disclosed contract conflict ─────────────────────────

/**
 * `EntityContextQuerySchema` is `.strict()` over exactly `sections`,
 * `totalBytes` and `sectionBytes`. The frozen CLI syntax for this row names
 * `--depth`, `--messages`, `--children` and `--edge-type` — four flags the
 * frozen contract query schema physically cannot accept. Binding them would
 * send a request guaranteed to answer `400 invalid_input`; inventing
 * `--sections` instead would be inventing a flag outside the authorities. So
 * the command ships its contract-legal surface and REFUSES the four locally,
 * naming the amendment. The conflict is reported, not normalised.
 */
describe('entity context', () => {
  it('sends no query parameters — the contract-legal surface is empty', async () => {
    const r = await drive(['entity', 'context', ENT]);
    expect(r.code).toBe(0);
    expect(seen[0]?.query).toBe('');
  });

  /**
   * The refusal must NAME the conflict, not merely reject the flag. A mutation
   * test showed that "exit 2 and nothing sent" is satisfied by the generic
   * unknown-option guard too — so the assertion could not tell a caller who
   * learns WHY from one who is told only "no such flag". The frozen syntax
   * DOES name these four, so "unknown option" would be an actively misleading
   * answer here.
   */
  for (const flag of ['--depth', '--messages', '--children', '--edge-type']) {
    it(`refuses ${flag} locally, naming the contract conflict rather than calling it unknown`, async () => {
      const r = await drive(['entity', 'context', ENT, flag, '1']);
      expect(r.code).toBe(2);
      expect(seen).toHaveLength(0);
      expect(r.stderr).toContain('EntityContextQuery');
      expect(r.stderr).toContain('amendment');
    });
  }
});

/**
 * The SAME defect class as `entity context`, and treated the same way. The
 * frozen syntax names `entity hierarchy --depth`; the contract defines no
 * hierarchy query type at all, so nothing on the wire can receive it. Sending
 * it is the worst of the options — silently ignored end to end, so the caller
 * believes the read is depth-bounded and nothing ever goes red.
 */
describe('entity hierarchy --depth has no wire destination', () => {
  it('sends no query parameters', async () => {
    const r = await drive(['entity', 'hierarchy', ENT]);
    expect(r.code).toBe(0);
    expect(seen[0]?.query).toBe('');
  });

  it('refuses --depth locally, naming the conflict rather than calling it unknown', async () => {
    const r = await drive(['entity', 'hierarchy', ENT, '--depth', '2']);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
    expect(r.stderr).toContain('hierarchy query type');
    expect(r.stderr).toContain('amendment');
  });
});

// ── option discipline: a flag outside the projection never silently drops ───

describe('an option outside a command\'s frozen syntax is a usage error', () => {
  it('names the command and quotes the projected syntax', async () => {
    const r = await drive(['entity', 'query', '--sort', 'position']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--sort');
    // The hint is the projection's OWN syntax string, so it can never drift.
    expect(r.stderr).toContain(commandDiscovery(['entity', 'query'])?.syntax ?? '<<no syntax>>');
    expect(seen).toHaveLength(0);
  });

  it('catches a typo instead of dropping it', async () => {
    const r = await drive(['entity', 'query', '--assigne', ACTOR]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

// ── output law (§7.1) ───────────────────────────────────────────────────────

describe('output law', () => {
  it('--format json emits the contract DTO verbatim, with nothing added', async () => {
    reply = { status: 200, body: { data: { id: ENT, kind: 'task', title: 'T' }, requestId: 'req_t' } };
    const r = await drive(['entity', 'get', ENT, '--format', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({ id: ENT, kind: 'task', title: 'T' });
    expect(r.stderr).toBe('');
  });

  it('human output keeps the id a follow-up command needs', async () => {
    reply = { status: 200, body: { data: { id: ENT, kind: 'task', title: 'T', version: 4 }, requestId: 'req_t' } };
    const r = await drive(['entity', 'get', ENT]);
    expect(r.stdout).toContain(ENT);
    expect(r.stdout).toContain('T');
  });

  it('every diagnostic lands on stderr and stdout stays empty on failure', async () => {
    reply = {
      status: 404,
      body: { error: { code: 'not_found', message: 'no such entity', requestId: 'req_t', retryable: false } },
    };
    const r = await drive(['entity', 'get', ENT]);
    expect(r.code).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not_found');
  });
});

// ── the taxonomy, projected onto the frozen exit table ──────────────────────

describe('server refusals map onto the frozen §7.6 table', () => {
  const CASES: ReadonlyArray<{ status: number; code: string; exit: number }> = [
    { status: 400, code: 'invalid_input', exit: 2 },
    { status: 401, code: 'unauthenticated', exit: 3 },
    { status: 403, code: 'forbidden', exit: 4 },
    { status: 404, code: 'not_found', exit: 5 },
    { status: 409, code: 'version_conflict', exit: 6 },
    { status: 409, code: 'invariant_violation', exit: 6 },
    { status: 429, code: 'rate_limited', exit: 7 },
    { status: 501, code: 'not_implemented', exit: 8 },
    { status: 413, code: 'payload_too_large', exit: 9 },
  ];
  for (const c of CASES) {
    it(`${c.code} → exit ${c.exit}`, async () => {
      reply = {
        status: c.status,
        body: { error: { code: c.code, message: 'no', requestId: 'req_t', retryable: c.exit === 7 } },
      };
      const r = await drive(['entity', 'get', ENT]);
      expect(r.code).toBe(c.exit);
    });
  }

  /**
   * An honest 501 is a normal closed envelope, not a crash — and it must read
   * as "not built here", because that is the difference between a capability
   * that does not exist and one that has not landed yet.
   */
  it('a 501 is rendered as an honest not-implemented, never as a transport failure', async () => {
    reply = {
      status: 501,
      body: { error: { code: 'not_implemented', message: 'not implemented', requestId: 'req_t', retryable: false } },
    };
    const r = await drive(['entity', 'feed', ENT]);
    expect(r.code).toBe(8);
    expect(r.stderr).toContain('not implemented on this node');
    expect(r.stdout).toBe('');
  });
});
