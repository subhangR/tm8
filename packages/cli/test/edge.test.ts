/**
 * `tm8 edge …` and `tm8 entity connections` — group 4's edge module.
 *
 * WHY THIS FILE DRIVES A LOCAL DISPATCH INSTEAD OF `run()`.
 * `src/commands/registry.ts` is coordinator-owned: this slot exports a
 * `CommandModule[]` and the coordinator adds the import and the spread. Until
 * that lands, `run(['edge','list'])` correctly answers exit 8 ("documented, not
 * built here"), so driving `run()` here would assert the router's pre-wiring
 * behaviour rather than this module's. `invoke()` below is a deliberate mirror
 * of `dispatch()` + `run()`'s funnel — same parser, same context resolution,
 * same `Output`, same `errorLines`/`exitCodeFor` catch — with only the command
 * lookup pointed at this module. Once the coordinator wires it,
 * `discovery-commands.test.ts` covers the router half for these paths too.
 *
 * The stub Server records METHOD, PATH, QUERY and BODY, because the thing most
 * worth proving about a catalog-bound command is not that it returned something
 * but that it bound the RIGHT route with the RIGHT payload — `--target` binding
 * the wire's `destination`, `--peer` binding repeated `peerId`, and a mutation
 * id reaching the body verbatim are each a defect class if they drift.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { parseInvocation, splitCommandPath } from '../src/args.js';
import { loadLocalConfig, resolveContext, sessionContextFromEnv } from '../src/context.js';
import { errorLines, exitCodeFor } from '../src/errors.js';
import { CliError, EXIT_USAGE, type ExitCode } from '../src/exit.js';
import { createOutput } from '../src/output.js';
import type { CommandModule } from '../src/run.js';
import { commandDiscovery } from '../src/discovery/operations.js';
import { EDGE_COMMANDS, renderCommandResult, renderEdgePage } from '../src/commands/edge.js';

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
/** What the stub answers inside `{data, requestId}` for the next call. */
let reply: unknown = { items: [], nextCursor: null };

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
  reply = { items: [], nextCursor: null };
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

/** A faithful mirror of `run()`'s funnel over one module's command list. */
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

const edge = (argv: readonly string[]): Promise<ExitCode> => invoke(EDGE_COMMANDS, argv);
const out = (): string => stdout.join('');
const err = (): string => stderr.join('');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SRC = '11111111-1111-7111-8111-111111111111';
const DST = '22222222-2222-7222-8222-222222222222';
const EDGE_ID = '33333333-3333-7333-8333-333333333333';

function edgeView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EDGE_ID,
    type: 'depends_on',
    source: { id: SRC, kind: 'task', title: 'the source task' },
    target: { id: DST, kind: 'task', title: 'the target task' },
    props: {},
    createdBy: { id: 'actor_1', kind: 'member', title: 'owner' },
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

const body = (n = 0): Record<string, unknown> => requests[n]?.body as Record<string, unknown>;

describe('the module exports exactly the paths this slot owns', () => {
  it('registers its six edge paths plus the entity-centred connections read (seam ruling S1)', () => {
    expect(EDGE_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'edge create',
      'edge delete',
      'edge list',
      'edge type list',
      'edge update',
      'entity connections',
    ]);
  });

  it('claims no path twice — a duplicate would throw at registry IMPORT, not in one test', () => {
    const keys = EDGE_COMMANDS.map((c) => c.path.join(' '));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('tm8 edge list — edges.list', () => {
  it('binds GET /v2/edges with no invented query', async () => {
    expect(await edge(['edge', 'list'])).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/v2/edges');
    expect(requests[0]?.query).toBe('');
  });

  it('binds --target to the wire name `destination`, which is NOT the flag name', async () => {
    expect(await edge([
      'edge', 'list',
      '--source', SRC, '--target', DST, '--type', 'depends_on',
      '--direction', 'incoming', '--limit', '5', '--cursor', 'cur_1',
    ])).toBe(0);
    const q = new URLSearchParams(requests[0]?.query ?? '');
    expect(q.get('source')).toBe(SRC);
    expect(q.get('destination')).toBe(DST);
    expect(q.get('target')).toBeNull();
    expect(q.get('type')).toBe('depends_on');
    expect(q.get('direction')).toBe('incoming');
    expect(q.get('limit')).toBe('5');
    expect(q.get('cursor')).toBe('cur_1');
  });

  it('refuses a --direction outside this row own closed pair, before the network', async () => {
    expect(await edge(['edge', 'list', '--direction', 'both'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toMatch(/incoming\|outgoing/);
  });

  it('is a READ, so it refuses --mutation-id rather than sending a meaningless one', async () => {
    expect(await edge(['edge', 'list', '--mutation-id', 'abc'])).toBe(2);
    expect(requests).toEqual([]);
  });

  it('refuses a non-positive --limit locally and names the dimension <count>', async () => {
    expect(await edge(['edge', 'list', '--limit', '0'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toContain('--limit <count>');
  });
});

describe('tm8 edge create — edges.create', () => {
  it('binds POST /v2/edges from three positionals and generates a UUIDv7 mutation id', async () => {
    reply = { patches: [], edge: edgeView() };
    expect(await edge(['edge', 'create', SRC, 'depends_on', DST])).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/v2/edges');
    expect(body()).toMatchObject({ srcId: SRC, dstId: DST, type: 'depends_on' });
    expect(String(body().clientMutationId)).toMatch(UUID_RE);
    // v7: the version nibble is the 15th hex digit of the id.
    expect(String(body().clientMutationId)[14]).toBe('7');
  });

  it('passes a supplied --mutation-id through VERBATIM — a changed id is a different mutation', async () => {
    reply = { patches: [], edge: edgeView() };
    expect(await edge(['edge', 'create', SRC, 'depends_on', DST, '--mutation-id', 'MiXeD-Case_id'])).toBe(0);
    expect(body().clientMutationId).toBe('MiXeD-Case_id');
  });

  it('sends --props as an object, and omits the key entirely when unset (strict schema)', async () => {
    reply = { patches: [], edge: edgeView() };
    expect(await edge(['edge', 'create', SRC, 'depends_on', DST, '--props', '{"hard":false}'])).toBe(0);
    expect(body().props).toEqual({ hard: false });

    requests = [];
    expect(await edge(['edge', 'create', SRC, 'depends_on', DST])).toBe(0);
    expect('props' in body()).toBe(false);
  });

  it('refuses --props that is not a JSON object before putting it on the wire', async () => {
    expect(await edge(['edge', 'create', SRC, 'depends_on', DST, '--props', '["a"]'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toMatch(/object/);
  });

  it('does NOT pre-empt the Server ruling on props.origin — it sends it and lets the Server refuse', async () => {
    // `props.origin` is Server-OWNED, and the Server answers `forbidden`. A
    // local exit 2 here would be this CLI inventing an authorization decision
    // the Server owns, and would report a different exit code than the node
    // actually returns. The real-Server exit 4 is asserted in the integration
    // suite; here we only prove the CLI does not swallow it.
    reply = { patches: [], edge: edgeView() };
    expect(await edge(['edge', 'create', SRC, 'depends_on', DST, '--props', '{"origin":"x"}'])).toBe(0);
    expect(body().props).toEqual({ origin: 'x' });
  });

  it('a missing positional names WHICH one is missing and the whole three-argument shape', async () => {
    expect(await edge(['edge', 'create', SRC, 'depends_on'])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toContain('<source-entity-id> <edge-type> <target-entity-id>');
    expect(err()).toContain('missing <target-entity-id>');

    stderr = [];
    expect(await edge(['edge', 'create'])).toBe(2);
    expect(err()).toContain('missing <source-entity-id>');
  });
});

describe('tm8 edge update — edges.patch', () => {
  it('binds PATCH /v2/edges/:edgeId with the required props', async () => {
    reply = { patches: [], edge: edgeView({ props: { hard: false } }) };
    expect(await edge(['edge', 'update', EDGE_ID, '--props', '{"hard":false}'])).toBe(0);
    expect(requests[0]?.method).toBe('PATCH');
    expect(requests[0]?.path).toBe(`/v2/edges/${EDGE_ID}`);
    expect(body().props).toEqual({ hard: false });
  });

  it('requires --props: the frozen grammar has no other thing to change', async () => {
    expect(await edge(['edge', 'update', EDGE_ID])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toContain('--props');
  });

  it('requires the edge id', async () => {
    expect(await edge(['edge', 'update', '--props', '{}'])).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('tm8 edge delete — edges.delete', () => {
  it('refuses without --yes and sends NOTHING (grammar 7.5)', async () => {
    expect(await edge(['edge', 'delete', EDGE_ID])).toBe(2);
    expect(requests).toEqual([]);
    expect(err()).toContain('--yes');
  });

  it('binds DELETE /v2/edges/:edgeId with --yes', async () => {
    reply = { patches: [] };
    expect(await edge(['edge', 'delete', EDGE_ID, '--yes'])).toBe(0);
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.path).toBe(`/v2/edges/${EDGE_ID}`);
    expect(String(body().clientMutationId)).toMatch(UUID_RE);
  });
});

describe('tm8 edge type list — edgeTypes.list', () => {
  it('binds GET /v2/edge-types and takes no arguments', async () => {
    reply = [{ type: 'depends_on', sourceKinds: ['task'], destinationKinds: ['task'], direction: 'directed', description: 'blocks', propsSchema: {}, acyclic: true }];
    expect(await edge(['edge', 'type', 'list'])).toBe(0);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe('/v2/edge-types');
    expect(requests[0]?.query).toBe('');
  });

  it('renders the type name and its endpoint rule, which is the whole point of the row', async () => {
    reply = [{ type: 'depends_on', sourceKinds: ['task'], destinationKinds: ['task'], direction: 'directed', description: 'blocks', propsSchema: {}, acyclic: true }];
    expect(await edge(['edge', 'type', 'list'])).toBe(0);
    expect(out()).toContain('depends_on');
    expect(out()).toContain('task');
  });

  it('is a READ and refuses --mutation-id', async () => {
    expect(await edge(['edge', 'type', 'list', '--mutation-id', 'x'])).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('tm8 entity connections — entities.connections, registered from THIS module (S1)', () => {
  it('binds GET /v2/entities/:id/connections', async () => {
    expect(await edge(['entity', 'connections', SRC])).toBe(0);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.path).toBe(`/v2/entities/${SRC}/connections`);
  });

  it('repeats --type and --peer as repeated query keys, never comma-joined', async () => {
    expect(await edge([
      'entity', 'connections', SRC,
      '--type', 'depends_on', '--type', 'attached_to',
      '--peer', DST, '--peer', EDGE_ID,
      '--direction', 'both', '--limit', '3', '--cursor', 'cur_2',
    ])).toBe(0);
    const q = new URLSearchParams(requests[0]?.query ?? '');
    expect(q.getAll('type')).toEqual(['depends_on', 'attached_to']);
    expect(q.getAll('peerId')).toEqual([DST, EDGE_ID]);
    expect(q.get('types')).toBeNull();
    expect(q.get('peer')).toBeNull();
    expect(q.get('direction')).toBe('both');
    expect(q.get('limit')).toBe('3');
    expect(q.get('cursor')).toBe('cur_2');
  });

  it('accepts `both`, which edges.list does not — the two rows have DIFFERENT closed sets', async () => {
    expect(await edge(['entity', 'connections', SRC, '--direction', 'both'])).toBe(0);
    expect(await edge(['entity', 'connections', SRC, '--direction', 'sideways'])).toBe(2);
    expect(requests).toHaveLength(1);
  });

  // The grammar redesign §4.4 lists these under a PROPOSED amendment banner and
  // the frozen discovery projection binds none of them. Dropping them silently
  // would answer an ORDER the caller did not get and a FILTER that never
  // applied, which reads exactly like a correct answer.
  for (const [flag, value] of [
    ['--sort', 'updatedAt'],
    ['--order', 'asc'],
    ['--peer-kind', 'task'],
    ['--created-by', SRC],
    ['--created-after', '2026-01-01T00:00:00Z'],
    ['--created-before', '2026-01-01T00:00:00Z'],
  ] as const) {
    it(`refuses ${flag} by NAME rather than dropping it silently`, async () => {
      expect(await edge(['entity', 'connections', SRC, flag, value])).toBe(2);
      expect(requests).toEqual([]);
      expect(err()).toContain(flag);
      expect(err()).toMatch(/amendment/i);
    });
  }

  it('requires the entity id and refuses --mutation-id', async () => {
    expect(await edge(['entity', 'connections'])).toBe(2);
    expect(await edge(['entity', 'connections', SRC, '--mutation-id', 'x'])).toBe(2);
    expect(requests).toEqual([]);
  });
});

describe('output law — human renders the SAME DTO json emits, and keeps every follow-up id', () => {
  it('--format json emits the contract DTO verbatim, with no CLI envelope', async () => {
    reply = { items: [edgeView()], nextCursor: 'cur_next' };
    expect(await edge(['edge', 'list', '--format', 'json'])).toBe(0);
    expect(JSON.parse(out())).toEqual(reply);
    expect(stderr).toEqual([]);
  });

  it('human output keeps the edge id, both endpoint ids, and the nextCursor', async () => {
    reply = { items: [edgeView()], nextCursor: 'cur_next' };
    expect(await edge(['edge', 'list'])).toBe(0);
    expect(out()).toContain(EDGE_ID);
    expect(out()).toContain(SRC);
    expect(out()).toContain(DST);
    expect(out()).toContain('cur_next');
  });

  it('an empty page says so rather than printing nothing', () => {
    expect(renderEdgePage({ items: [], nextCursor: null })).toMatch(/no edges/i);
  });

  it('stdout is data only — a successful read writes nothing to stderr', async () => {
    reply = { items: [edgeView()], nextCursor: null };
    expect(await edge(['edge', 'list'])).toBe(0);
    expect(stderr).toEqual([]);
  });
});

describe('LAW O5 — an undo token rendered by an edge surface never says "delete"', () => {
  it('renders the token and the Server own label without adding delete/undelete wording', () => {
    const rendered = renderCommandResult({
      patches: [],
      undo: { token: 'undo_abc', label: 'Restore message body' },
    });
    expect(rendered).toContain('undo_abc');
    expect(rendered).toContain('Restore message body');
    // Undo of a messages.delete token is a REDACTION and thread history
    // SURVIVES. CLI-authored wording that says "delete" tells an operator
    // history is gone when it is not, inviting a destructive recovery.
    expect(rendered.toLowerCase()).not.toMatch(/delet|un-?delete|resurrect/);
  });

  it('PROBE: the same renderer would SURFACE the word if the Server sent it — faithful, not sanitised', () => {
    const rendered = renderCommandResult({
      patches: [],
      undo: { token: 'undo_abc', label: 'Undo the deleted edge' },
    });
    expect(rendered).toContain('Undo the deleted edge');
  });

  it('never describes a mutation id as secret, private, or a credential', () => {
    const rendered = renderCommandResult({ patches: [], edge: edgeView() });
    expect(rendered.toLowerCase()).not.toMatch(/secret|private|credential|authenticat/);
  });
});

/**
 * THE "FLAG WITH NO WIRE DESTINATION" DETECTOR.
 *
 * A sibling slot's projection advertised `--limit`/`--cursor` on an operation
 * the contract never gave a limit or a cursor to. An agent that sees `--limit`
 * reasonably concludes the operation pages; a flag the CLI cannot deliver is a
 * promise it cannot keep. The failure is silent in both directions — an
 * advertised-but-unbound flag is accepted and dropped, and a bound-but-
 * unadvertised flag is invisible to help, completion, and search.
 *
 * So this asserts the projection and this module agree EXACTLY, by counting the
 * flags the frozen projection advertises and requiring the same number of
 * distinct destinations on the wire. It is derived from the projection at
 * runtime rather than from a hand-copied list, so it moves when §4 moves.
 */
describe('every flag the frozen projection advertises actually reaches the wire', () => {
  /** `--flag` tokens in a syntax line, minus the globals every command shares. */
  const advertisedFlags = (path: readonly string[]): string[] => {
    const syntax = commandDiscovery(path)?.syntax ?? '';
    return [...new Set([...syntax.matchAll(/--([a-z-]+)/g)].map((m) => m[1] as string))]
      .filter((f) => f !== 'mutation-id');
  };

  it('PROBE: the extractor finds real flags, so an empty match cannot pass vacuously', () => {
    expect(advertisedFlags(['edge', 'list']).sort())
      .toEqual(['cursor', 'direction', 'limit', 'source', 'target', 'type']);
    expect(advertisedFlags(['edge', 'type', 'list'])).toEqual([]);
  });

  it('edge list — all six advertised flags land as six distinct query parameters', async () => {
    const flags = advertisedFlags(['edge', 'list']);
    expect(await edge([
      'edge', 'list', '--source', SRC, '--target', DST, '--type', 'relates_to',
      '--direction', 'outgoing', '--limit', '2', '--cursor', 'cur_x',
    ])).toBe(0);
    const keys = [...new URLSearchParams(requests[0]?.query ?? '').keys()];
    expect(keys).toHaveLength(flags.length);
    // `--target` is deliberately renamed to the wire's `destination`; every
    // other flag keeps its name, and NONE is silently dropped.
    expect(keys.sort()).toEqual(['cursor', 'destination', 'direction', 'limit', 'source', 'type']);
  });

  it('entity connections — every advertised flag lands, and none beyond them is bound', async () => {
    const flags = advertisedFlags(['entity', 'connections']);
    expect(flags.sort()).toEqual(['cursor', 'direction', 'limit', 'peer', 'type']);
    expect(await edge([
      'entity', 'connections', SRC, '--type', 'relates_to', '--peer', DST,
      '--direction', 'both', '--limit', '2', '--cursor', 'cur_y',
    ])).toBe(0);
    const keys = [...new Set([...new URLSearchParams(requests[0]?.query ?? '').keys()])];
    expect(keys).toHaveLength(flags.length);
    expect(keys.sort()).toEqual(['cursor', 'direction', 'limit', 'peerId', 'type']);
  });

  it('edge type list advertises no flags and sends no query — nothing invented', async () => {
    reply = [];
    expect(await edge(['edge', 'type', 'list'])).toBe(0);
    expect(requests[0]?.query).toBe('');
  });
});

/**
 * CURSOR OPACITY, ASSERTED RATHER THAN ASSUMED.
 *
 * The cursor is an opaque base64url blob whose keyset the SERVER owns. This CLI
 * must carry it back BYTE-FOR-BYTE — never parse it, never normalise it, never
 * re-encode it, and above all never "repair" it. Client-side compensation for a
 * server cursor defect is the worst available outcome: it hides the defect from
 * the gate that has to see it, and it does so while making the symptom go away.
 *
 * The realistic corruptions are all silent, so each is named: base64url `-`/`_`
 * mangled back to `+`/`/`, `=` padding re-added or stripped, whitespace
 * trimmed, or the whole thing round-tripped through a decoder.
 */
describe('the cursor is carried opaquely — never parsed, normalised, or repaired', () => {
  const HOSTILE = 'eyJ2IjoyLCJrIjpbImFiYy1kZWZfZ2hpIiwiMjAyNi0wNy0yN1QwNjozNDoxMy40MjE5MTFaIl19';

  for (const [name, cursor] of [
    ['base64url with - and _', 'abc-def_ghi'],
    ['trailing = padding', 'YWJjZA=='],
    ['a realistic encoded keyset', HOSTILE],
    ['leading and trailing spaces', ' spaced '],
  ] as const) {
    it(`edge list carries a ${name} cursor through byte-for-byte`, async () => {
      expect(await edge(['edge', 'list', '--cursor', cursor])).toBe(0);
      expect(new URLSearchParams(requests[0]?.query ?? '').get('cursor')).toBe(cursor);
    });

    it(`entity connections carries a ${name} cursor through byte-for-byte`, async () => {
      expect(await edge(['entity', 'connections', SRC, '--cursor', cursor])).toBe(0);
      expect(new URLSearchParams(requests[0]?.query ?? '').get('cursor')).toBe(cursor);
    });
  }

  it('PROBE: the assertion would CATCH a normalising client', () => {
    // Proves the check discriminates rather than comparing a value to itself:
    // these are exactly the transforms a "helpful" client would apply.
    expect('abc-def_ghi'.replace(/-/g, '+').replace(/_/g, '/')).not.toBe('abc-def_ghi');
    expect(' spaced '.trim()).not.toBe(' spaced ');
    expect('YWJjZA=='.replace(/=+$/, '')).not.toBe('YWJjZA==');
  });
});
