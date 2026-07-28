/**
 * `tm8 placement apply` — group 4's placement module (grammar 4.8).
 *
 * See `edge.test.ts` for why this drives a local mirror of `run()`'s funnel
 * rather than `run()` itself: registry wiring is coordinator-owned.
 *
 * Two things this file exists to hold down:
 *
 *  - THE INTENT IS A CLOSED POSITIONAL. `attach|assign|depend|subtask|embed|
 *    reparent` and nothing else. A typo'd intent must fail here naming the six,
 *    not travel to the Server as a shrug.
 *  - THE EMBED VARIANT IS NEWLY REPAIRED. `placement apply … embed …` was a
 *    confirmed data-loss defect (an undo token rejected at INSERT rolled back
 *    the posted message); X01 fixed it and W3 confirmed at the public boundary.
 *    It is therefore tested deliberately rather than treated as one more member
 *    of the enum, and its real-Server behaviour is asserted in the integration
 *    suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE, type ExitCode } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import type { CommandModule } from '../src/run.js';
import { PLACEMENT_COMMANDS, PLACEMENT_INTENTS } from '../src/commands/placement.js';

interface Recorded {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let requests: Recorded[] = [];
let stdout: string[] = [];
let stderr: string[] = [];
let reply: unknown = { patches: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://stub');
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.search,
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      });
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ data: reply, requestId: 'req_stub' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  requests = [];
  stdout = [];
  stderr = [];
  reply = { patches: [] };
  process.env.TM8_BASE_URL = baseUrl;
  delete process.env.TM8_SPACE_ID;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_CONFIG_PATH;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});

async function invoke(modules: readonly CommandModule[], argv: readonly string[]): Promise<ExitCode> {
  let out = createOutput({ format: 'human' });
  try {
    const inv = parseInvocation(argv);
    out = createOutput({
      format: inv.globals.format,
      color: inv.globals.color,
      quiet: inv.globals.quiet,
    });
    const known = (p: readonly string[]): boolean =>
      modules.some((m) => m.path.join(' ') === p.join(' '));
    const match = splitCommandPath(inv.positionals, known);
    if (!match) throw new CliError(`unknown command: ${inv.positionals.join(' ')}`, EXIT_USAGE);
    const mod = modules.find((m) => m.path.join(' ') === match.path.join(' '))!;
    const ctx = resolveContext({
      globals: inv.globals,
      session: sessionContextFromEnv(),
      config: loadLocalConfig(),
    });
    return await mod.run({
      path: match.path,
      args: match.args,
      options: inv.options,
      passthrough: inv.passthrough,
      ctx,
      out,
    });
  } catch (err) {
    out.error(errorLines(err));
    return exitCodeFor(err);
  }
}

const placement = (argv: readonly string[]): Promise<ExitCode> => invoke(PLACEMENT_COMMANDS, argv);
const out = (): string => stdout.join('');
const err = (): string => stderr.join('');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SRC = '11111111-1111-7111-8111-111111111111';
const DST = '22222222-2222-7222-8222-222222222222';
const EDGE_ID = '33333333-3333-7333-8333-333333333333';

const body = (n = 0): Record<string, unknown> => requests[n]?.body as Record<string, unknown>;

describe('the module exports exactly one path', () => {
  it('registers `placement apply` and nothing else', () => {
    expect(PLACEMENT_COMMANDS.map((c) => c.path.join(' '))).toEqual(['placement apply']);
  });

  it('names the six frozen intents, in the grammar own order', () => {
    expect([...PLACEMENT_INTENTS]).toEqual([
      'attach', 'assign', 'depend', 'subtask', 'embed', 'reparent',
    ]);
  });
});

describe('tm8 placement apply — placements.apply', () => {
  it('binds POST /v2/placements from three positionals', async () => {
    reply = { patches: [], edge: { id: EDGE_ID, type: 'attached_to' } };
    expect(await placement(['placement', 'apply', SRC, 'attach', DST])).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/v2/placements');
    expect(requests[0]?.query).toBe('');
    expect(body()).toMatchObject({ sourceId: SRC, targetId: DST, intent: 'attach' });
    expect(String(body().clientMutationId)).toMatch(UUID_RE);
  });

  for (const intent of ['attach', 'assign', 'depend', 'subtask', 'embed', 'reparent'] as const) {
    it(`accepts the frozen intent \`${intent}\``, async () => {
      expect(await placement(['placement', 'apply', SRC, intent, DST])).toBe(0);
      expect(body().intent).toBe(intent);
    });
  }

  it('refuses an intent outside the closed six, naming them, before the network', async () => {
    expect(await placement(['placement', 'apply', SRC, 'yeet', DST])).toBe(2);
    expect(requests).toEqual([]);
    for (const intent of PLACEMENT_INTENTS) expect(err()).toContain(intent);
  });

  it('a missing positional is a usage error, never a partial placement', async () => {
    expect(await placement(['placement', 'apply', SRC, 'attach'])).toBe(2);
    expect(await placement(['placement', 'apply'])).toBe(2);
    expect(requests).toEqual([]);
  });

  it('passes a supplied --mutation-id through VERBATIM', async () => {
    expect(await placement(['placement', 'apply', SRC, 'attach', DST, '--mutation-id', 'Keep-Me_1'])).toBe(0);
    expect(body().clientMutationId).toBe('Keep-Me_1');
  });

  it('sends exactly the four frozen body keys — PlacementInput is strict', async () => {
    expect(await placement(['placement', 'apply', SRC, 'attach', DST])).toBe(0);
    expect(Object.keys(body()).sort()).toEqual(['clientMutationId', 'intent', 'sourceId', 'targetId']);
  });
});

describe('the embed variant — newly repaired, tested deliberately', () => {
  it('binds intent `embed` and sends NO embedMessage key at all', async () => {
    reply = { patches: [], undo: { token: 'undo_1', label: 'Undo embed' } };
    expect(await placement(['placement', 'apply', SRC, 'embed', DST])).toBe(0);
    expect(body().intent).toBe('embed');
    // PlacementInput carries an optional `embedMessage`, but the frozen grammar
    // 4.8 binds no flag for it and the schema is strict. Sending an empty
    // string would be inventing a payload the caller never asked for.
    expect('embedMessage' in body()).toBe(false);
  });

  it('refuses --embed-message by NAME rather than dropping the text on the floor', async () => {
    // Silently discarding it is the worst available answer for this row
    // specifically: the caller believes a message was posted with the embed.
    expect(await placement(['placement', 'apply', SRC, 'embed', DST, '--embed-message', 'hello'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toContain('--embed-message');
    expect(err()).toMatch(/amendment|not bound/i);
  });

  it('renders the undo token the embed placement returned, so it can actually be redeemed', async () => {
    reply = { patches: [], undo: { token: 'undo_embed_1', label: 'Undo embed' } };
    expect(await placement(['placement', 'apply', SRC, 'embed', DST])).toBe(0);
    expect(out()).toContain('undo_embed_1');
  });
});

describe('output law and LAW O5 on the placement surface', () => {
  it('--format json emits the CommandResult DTO verbatim', async () => {
    reply = { patches: [], edge: { id: EDGE_ID, type: 'attached_to' }, undo: { token: 'u1', label: 'Undo attach' } };
    expect(await placement(['placement', 'apply', SRC, 'attach', DST, '--format', 'json'])).toBe(0);
    expect(JSON.parse(out())).toEqual(reply);
    expect(stderr).toEqual([]);
  });

  it('human output keeps the edge id a follow-up `tm8 edge update` would need', async () => {
    reply = {
      patches: [],
      edge: {
        id: EDGE_ID,
        type: 'attached_to',
        source: { id: SRC, kind: 'file', title: 'a file' },
        target: { id: DST, kind: 'task', title: 'a task' },
        props: {},
        createdBy: { id: 'actor_1', kind: 'member', title: 'owner' },
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
    };
    expect(await placement(['placement', 'apply', SRC, 'attach', DST])).toBe(0);
    expect(out()).toContain(EDGE_ID);
  });

  it('the undo rendering adds no delete/undelete wording of its own', async () => {
    reply = { patches: [], undo: { token: 'u1', label: 'Undo attach' } };
    expect(await placement(['placement', 'apply', SRC, 'attach', DST])).toBe(0);
    expect(out().toLowerCase()).not.toMatch(/delet|resurrect/);
  });

  it('PROBE: a Server label containing the word is still rendered verbatim', async () => {
    reply = { patches: [], undo: { token: 'u1', label: 'Undo the deleted attachment' } };
    expect(await placement(['placement', 'apply', SRC, 'attach', DST])).toBe(0);
    expect(out()).toContain('Undo the deleted attachment');
  });

  it('does not advertise `tm8 undo apply` as universally applicable', async () => {
    reply = { patches: [], edge: { id: EDGE_ID, type: 'attached_to' } };
    expect(await placement(['placement', 'apply', SRC, 'attach', DST])).toBe(0);
    // No undo token came back, so nothing may claim one is redeemable.
    expect(out()).not.toContain('undo');
  });
});
