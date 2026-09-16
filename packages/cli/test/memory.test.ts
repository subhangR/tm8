/**
 * `tm8 memory …` — the memory noun: record, list, show, supersede, search.
 *
 * UNIT tests against a STUB HTTP server, driving the REAL kernel through
 * `run()` — parse → context → registry → dispatch → output → exit. Every
 * assertion is about what THIS CLI puts on the wire and what it does with an
 * answer, never about what the Server would decide.
 *
 * WHAT THE WIRE ASSERTIONS PROTECT. All five commands are SUGAR over
 * operations that already exist, so the only thing that can be wrong about
 * them is the request they compose. Three of those compositions are
 * load-bearing for the whole memory layer:
 *
 *  - `record` must put the four fields in `content` under the names
 *    `create_memory` reads (`statement`, `mechanism`, `subjectScope`,
 *    `doesNotEstablish`) — a misspelt key is a memory refused at the door.
 *  - `record` must forward THIS process's work session as
 *    `content.workSessionId`. That single field is what makes the server write
 *    `authored_from` and `remembers(session → memory)` (090 D10), which is what
 *    the spawn injector reads to carry a fact into the teammate's next session.
 *    Drop it and every memory an agent records dies with the session that
 *    recorded it — the exact gap this noun exists to close.
 *  - `supersede` must create FIRST and mark SECOND with `props.reason`, from
 *    the new memory to the old one, or the chain reads backwards.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPath } from '@tm8/contract';

import { run } from '../src/run.js';
import { MEMORY_COMMANDS } from '../src/commands/memory.js';
import { isRegisteredPath } from '../src/commands/registry.js';
import { nounHelp } from '../src/discovery/help.js';
import { commandDiscovery, isCommandPath, isNoun, NOUNS, PUBLIC_NOUNS } from '../src/discovery/operations.js';
import { deriveMutationId } from '../src/mutation.js';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

type Reply = { status: number; json: unknown };

let server: Server;
let seen: Seen[] = [];
let reply: (seen: Seen) => Reply = () => envelope({});
let stdout: string[] = [];
let stderr: string[] = [];
let savedEnv: NodeJS.ProcessEnv;

function envelope(data: unknown): Reply {
  return { status: 200, json: { data, requestId: 'req_stub' } };
}

function refusal(status: number, code: string, message: string): Reply {
  return { status, json: { error: { code, message, requestId: 'req_stub', retryable: false } } };
}

const SPACE = '018f0000-0000-7000-8000-0000000000f1';
const MEMORY = '018f0000-0000-7000-8000-00000000ae01';
const SUCCESSOR = '018f0000-0000-7000-8000-00000000ae02';
const HEAD = '018f0000-0000-7000-8000-00000000ae03';
const TASK = '018f0000-0000-7000-8000-000000000701';
const DOC = '018f0000-0000-7000-8000-000000000d01';
const TEAMMATE = '018f0000-0000-7000-8000-000000000a01';
const SESSION = '018f0000-0000-7000-8000-0000000005e5';
const EDGE = '018f0000-0000-7000-8000-00000000ed01';

const FOUR = [
  '--statement', 'the deploy needs a reload, not a restart',
  '--mechanism', 'restarted twice and watched the port stay closed; reloaded once and it opened',
  '--scope', 'the production node only',
  '--does-not-establish', 'anything about staging, which runs a different init',
];

const CREATE = bindPath('entities.create', {});
const EDGES = bindPath('edges.create', {});
const QUERY = bindPath('collections.query', {});
const SEARCH = bindPath('memories.search', {});
const GET_MEMORY = bindPath('entities.get', { id: MEMORY });

/** A memory as `entities.get` answers it: statement in content, scope in state. */
function memoryDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEMORY,
    kind: 'memory',
    title: 'the port is 5442',
    version: 2,
    createdAt: '2026-09-15T10:00:00.000Z',
    createdBy: { displayName: 'Draco' },
    content: {
      kind: 'memory',
      statement: 'the port is 5442',
      mechanism: 'read from the running cluster',
      subjectScope: 'this host',
      doesNotEstablish: 'the port on any other host',
      measuredAt: null,
    },
    state: { kind: 'memory', mechanism: 'read from the running cluster', subjectScope: 'this host', doesNotEstablish: 'the port on any other host', measuredAt: null },
    badges: {},
    ...overrides,
  };
}

/** A memory as a collection page carries it: title + excerpt + state, no content. */
function memorySummary(id: string, statement: string, scope: Partial<Record<'mechanism' | 'subjectScope' | 'doesNotEstablish', string>> = {}, badges: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'memory',
    title: statement.slice(0, 120),
    excerpt: statement.slice(0, 200),
    version: 1,
    state: { kind: 'memory', mechanism: 'm', subjectScope: 's', doesNotEstablish: 'd', measuredAt: null, ...scope },
    badges,
  };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const record: Seen = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      };
      seen.push(record);
      const answer = reply(record);
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        'x-tm8-request-id': 'req_stub',
      });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  savedEnv = { ...process.env };
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  // An empty XDG dir so a config file on the developer's own machine cannot
  // decide what these tests resolve.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'tm8-memory-cfg-'));
  process.env.TM8_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TM8_SPACE_ID = SPACE;
  delete process.env.TM8_CONFIG_PATH;
  delete process.env.TM8_ACTOR_ID;
  delete process.env.TM8_SESSION_ID;
  delete process.env.TM8_AGENT_TOKEN;
  // This suite runs inside whatever agent session invoked it; without this the
  // kernel journals every fixture invocation into THAT session's journal (and
  // may serve reads from its cache). No journal path means no journal and no
  // cache — the gate both modules share.
  delete process.env.TM8_JOURNAL_PATH;
  seen = [];
  stdout = [];
  stderr = [];
  reply = () => envelope({ entity: { id: MEMORY, kind: 'memory', title: 't', version: 1 }, patches: [] });
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = savedEnv;
});

const out = (): string => stdout.join('');
const err = (): string => stderr.join('');
const body = (n = 0): Record<string, unknown> => (seen[n]?.body ?? {}) as Record<string, unknown>;
const content = (n = 0): Record<string, unknown> => (body(n).content ?? {}) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Registration, projection, and the noun that used to have no help.
// ---------------------------------------------------------------------------

describe('the module registers exactly its own paths, and the projection agrees', () => {
  it('owns the five memory paths and nothing else', () => {
    expect(MEMORY_COMMANDS.map((c) => c.path.join(' ')).sort()).toEqual([
      'memory list',
      'memory record',
      'memory search',
      'memory show',
      'memory supersede',
    ]);
  });

  it('every path is BOTH documented in the projection and wired into the registry', () => {
    for (const c of MEMORY_COMMANDS) {
      expect(isCommandPath(c.path), `${c.path.join(' ')} is missing from the projection`).toBe(true);
      expect(isRegisteredPath(c.path), `${c.path.join(' ')} is missing from the registry`).toBe(true);
    }
  });

  /**
   * The distinction the whole lane rests on: every one of the five is an
   * ALIAS over operations that already exist — zero new catalog rows. Asserted
   * as exact operation lists, because an alias silently re-pointed at a
   * neighbouring row would still be a command, still be available, and
   * answer a different question.
   */
  it('every verb names every door it uses — four over doors that already existed, and search over its own', () => {
    expect(commandDiscovery(['memory', 'record'])?.operations).toEqual(['entities.create', 'edges.create']);
    expect(commandDiscovery(['memory', 'list'])?.operations).toEqual(['collections.query']);
    expect(commandDiscovery(['memory', 'show'])?.operations).toEqual(['entities.get']);
    expect(commandDiscovery(['memory', 'supersede'])?.operations).toEqual(['entities.create', 'edges.create', 'entities.get']);
    // `search` is the one verb whose door did not already exist. It named
    // `collections.query` while it ranked matches in this process; it names the
    // real operation now, so this command's availability moves with the search
    // itself rather than with a stand-in that could stay green while the
    // search was down.
    expect(commandDiscovery(['memory', 'search'])?.operations).toEqual(['memories.search']);
    for (const c of MEMORY_COMMANDS) expect(commandDiscovery(c.path)?.noun).toBe('memory');
  });

  it('`memory` is a noun on every discovery surface — the gap this noun closes', () => {
    // Before this noun, `tm8 help memory` answered "no help for memory": the
    // noun index was derived from catalog rows alone, and an alias-only noun
    // has none. Root help, the noun shard, and completion all read NOUNS.
    expect(isNoun('memory')).toBe(true);
    expect(NOUNS).toContain('memory');
    expect(PUBLIC_NOUNS).toContain('memory');
    const shard = nounHelp('memory');
    expect(shard?.commands.map((c) => c.command)).toEqual([
      'memory record', 'memory list', 'memory show', 'memory supersede', 'memory search',
    ]);
  });

  it('`tm8 help memory` is exit 0 with the five verbs on stdout, and touches no network', async () => {
    expect(await run(['help', 'memory'])).toBe(0);
    for (const verb of ['record', 'list', 'show', 'supersede', 'search']) {
      expect(out()).toContain(`memory ${verb}`);
    }
    expect(err()).toBe('');
    expect(seen).toEqual([]);
  });

  it('`tm8 memory record --help` answers from the projection', async () => {
    expect(await run(['memory', 'record', '--help'])).toBe(0);
    expect(out()).toContain('--does-not-establish <text>');
    expect(seen).toEqual([]);
  });

  it('help copy names no id, byte count, edge type or migration — a reader who is not a developer can follow it', () => {
    // The product rule for this noun: what an agent or a person reads in
    // `tm8 help` must make sense at first sight. Mechanism belongs in code
    // comments. Checked against the words most likely to leak.
    for (const c of MEMORY_COMMANDS) {
      const d = commandDiscovery(c.path);
      const prose = [d?.summary ?? '', ...(d?.notes ?? [])].join('\n');
      expect(prose, c.path.join(' ')).not.toMatch(/\b(bytes?|jsonb|uuid|remembers|authored_from|created_by|supersedes edge|entities\.|collections\.|edges\.|migration|\b0\d\d\b|D10|D9)\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// memory record
// ---------------------------------------------------------------------------

describe('memory record', () => {
  it('POSTs one entities.create of kind memory with the four parts in content under the names the door reads', async () => {
    expect(await run(['memory', 'record', ...FOUR, '--format', 'json'])).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(CREATE);
    expect(body()).toMatchObject({ spaceId: SPACE, kind: 'memory' });
    expect(content()).toEqual({
      statement: 'the deploy needs a reload, not a restart',
      mechanism: 'restarted twice and watched the port stay closed; reloaded once and it opened',
      subjectScope: 'the production node only',
      doesNotEstablish: 'anything about staging, which runs a different init',
    });
    expect(typeof body().clientMutationId).toBe('string');
    // No session, no actor: neither key is sent as an empty value.
    expect(content()).not.toHaveProperty('workSessionId');
    expect(body()).not.toHaveProperty('actorId');
    expect(body()).not.toHaveProperty('connections');
  });

  it('sends a title derived the way the Server derives it, because the create schema requires one', async () => {
    const long = 'a '.repeat(100).trim(); // 199 chars, whitespace-heavy
    await run(['memory', 'record', '--statement', `  ${long}  `, '--mechanism', 'm', '--scope', 's', '--does-not-establish', 'd']);
    expect(String(body().title)).toHaveLength(120);
    expect(content().statement).toBe(long);
  });

  it('forwards THIS process\'s work session as content.workSessionId — the field that makes the memory carry across sessions', async () => {
    process.env.TM8_SESSION_ID = SESSION;
    expect(await run(['memory', 'record', ...FOUR])).toBe(0);
    expect(content().workSessionId).toBe(SESSION);
    expect(err()).toBe('');
  });

  it('skips a session id that cannot name a session, says so, and still saves the memory', async () => {
    process.env.TM8_SESSION_ID = 'ws_not_a_real_session';
    expect(await run(['memory', 'record', ...FOUR])).toBe(0);
    expect(content()).not.toHaveProperty('workSessionId');
    expect(err()).toMatch(/without a record of which session learned it/);
    expect(out()).toContain(MEMORY);
  });

  it('explains a session the Server refuses, in the caller\'s terms', async () => {
    process.env.TM8_SESSION_ID = SESSION;
    reply = () => refusal(403, 'forbidden', 'authored_from provenance does not match the acting session');
    expect(await run(['memory', 'record', ...FOUR])).toBe(4);
    expect(err()).toContain('forbidden');
    expect(err()).toMatch(/not part of/);
    expect(err()).toMatch(/inside the session that is doing the work/);
  });

  it('carries the acting actor and a caller-supplied mutation id verbatim', async () => {
    process.env.TM8_ACTOR_ID = TEAMMATE;
    await run(['memory', 'record', ...FOUR, '--mutation-id', 'retry-me-please']);
    expect(body()).toMatchObject({ actorId: TEAMMATE, clientMutationId: 'retry-me-please' });
  });

  it('refuses a memory missing any part, naming EVERY missing part in plain words, and sends nothing', async () => {
    expect(await run(['memory', 'record', '--statement', 'x'])).toBe(2);
    expect(err()).toContain('--mechanism (how you found out)');
    expect(err()).toContain('--scope (where it applies)');
    expect(err()).toContain('--does-not-establish (what it does not prove)');
    expect(err()).not.toContain('--statement (');
    expect(seen).toHaveLength(0);
  });

  it('treats a blank part as missing — a single space would satisfy nothing', async () => {
    expect(await run(['memory', 'record', ...FOUR.slice(0, 6), '--does-not-establish', '   '])).toBe(2);
    expect(err()).toContain('--does-not-establish (what it does not prove)');
    expect(seen).toHaveLength(0);
  });

  it('refuses a part longer than the door accepts, before the wire', async () => {
    expect(await run(['memory', 'record', '--statement', 'x'.repeat(4001), ...FOUR.slice(2)])).toBe(2);
    expect(err()).toMatch(/--statement can be at most 4000 characters/);
    expect(seen).toHaveLength(0);
  });

  it('refuses an unknown flag rather than dropping it silently', async () => {
    expect(await run(['memory', 'record', ...FOUR, '--title', 'nope'])).toBe(2);
    expect(err()).toContain('--title');
    expect(seen).toHaveLength(0);
  });

  it('prints the new memory\'s id first, so the next command has its argument', async () => {
    reply = () => envelope({ entity: { id: MEMORY, kind: 'memory', title: 'the deploy needs a reload, not a restart', version: 1 }, patches: [] });
    expect(await run(['memory', 'record', ...FOUR])).toBe(0);
    expect(out().startsWith(MEMORY)).toBe(true);
    expect(out()).toContain('the deploy needs a reload');
  });

  describe('--about', () => {
    it('draws one about link per distinct target AFTER the create, from the memory, with no props', async () => {
      reply = (s) => (s.path === EDGES
        ? envelope({ edge: { id: EDGE, type: 'about' }, patches: [] })
        : envelope({ entity: { id: MEMORY, kind: 'memory', title: 't', version: 1 }, patches: [] }));
      expect(await run(['memory', 'record', ...FOUR, '--about', TASK, '--about', DOC, '--about', TASK])).toBe(0);
      expect(seen.map((s) => s.path)).toEqual([CREATE, EDGES, EDGES]);
      expect(body(0)).not.toHaveProperty('connections');
      expect(body(1)).toMatchObject({ srcId: MEMORY, dstId: TASK, type: 'about' });
      expect(body(2)).toMatchObject({ srcId: MEMORY, dstId: DOC, type: 'about' });
      expect(body(1)).not.toHaveProperty('props');
      expect(out()).toContain(`about ${TASK}  (linked)`);
      expect(out()).toContain(`about ${DOC}  (linked)`);
    });

    it('derives each link\'s mutation id from the create\'s, so a retry with the same id replays rather than duplicates', async () => {
      reply = (s) => (s.path === EDGES
        ? envelope({ edge: { id: EDGE }, patches: [] })
        : envelope({ entity: { id: MEMORY }, patches: [] }));
      await run(['memory', 'record', ...FOUR, '--about', TASK, '--mutation-id', 'root-1']);
      expect(body(1).clientMutationId).toBe(deriveMutationId('root-1', `about:${TASK}`));
      expect(body(1).clientMutationId).not.toBe('root-1');
    });

    it('when a link cannot be drawn: the memory is reported on stdout, the fix on stderr, the exit code is the failure\'s, and the other links are still tried', async () => {
      reply = (s) => {
        if (s.path !== EDGES) return envelope({ entity: { id: MEMORY, kind: 'memory', title: 't', version: 1 }, patches: [] });
        return (s.body as { dstId?: string }).dstId === TASK
          ? refusal(404, 'not_found', `entity ${TASK} not found`)
          : envelope({ edge: { id: EDGE }, patches: [] });
      };
      expect(await run(['memory', 'record', ...FOUR, '--about', TASK, '--about', DOC])).toBe(5);
      expect(seen.map((s) => s.path)).toEqual([CREATE, EDGES, EDGES]);
      expect(out()).toContain(MEMORY);
      expect(out()).toContain(`about ${TASK}  (NOT linked`);
      expect(out()).toContain(`about ${DOC}  (linked)`);
      expect(err()).toContain(`the memory was saved as ${MEMORY}`);
      expect(err()).toContain(`tm8 edge create ${MEMORY} about ${TASK}`);
      expect(err()).not.toContain(`about ${DOC}`);
    });
  });
});

// ---------------------------------------------------------------------------
// memory list
// ---------------------------------------------------------------------------

describe('memory list', () => {
  it('is collections.query narrowed to kinds:[memory], newest first — the narrowing IS the command', async () => {
    reply = () => envelope({ page: { items: [], nextCursor: null } });
    expect(await run(['memory', 'list', '--format', 'json'])).toBe(0);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe(QUERY);
    expect(body()).toEqual({ spaceId: SPACE, kinds: ['memory'], sort: 'createdAt_desc' });
  });

  it('--holder narrows to what that holder remembers, as an edge filter on the SAME query', async () => {
    reply = () => envelope({ page: { items: [] } });
    await run(['memory', 'list', '--holder', TEAMMATE]);
    expect(body().filters).toEqual({ edge: { type: 'remembers', direction: 'incoming', entityId: TEAMMATE } });
    expect(body().kinds).toEqual(['memory']);
  });

  it('carries --limit and --cursor, and refuses --mutation-id on a read', async () => {
    reply = () => envelope({ page: { items: [] } });
    await run(['memory', 'list', '--limit', '5', '--cursor', 'c1']);
    expect(body()).toMatchObject({ limit: 5, cursor: 'c1' });

    seen = [];
    expect(await run(['memory', 'list', '--mutation-id', 'x'])).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('renders id, claim, version and the marks against each memory in plain words', async () => {
    reply = () => envelope({
      page: {
        items: [
          memorySummary(MEMORY, 'the port is 5432', {}, {
            staleness: { reasons: ['superseded'], superseded: { byId: SUCCESSOR, headId: HEAD, depthTruncated: false } },
          }),
          memorySummary(SUCCESSOR, 'the port is 5442', {}, {
            staleness: { reasons: ['disputed', 'basisMoved'], disputed: { openCount: 2, latestAt: 'x' }, basisMoved: { count: 1 } },
          }),
          memorySummary(HEAD, 'the port is 5442 on this node'),
        ],
        nextCursor: 'page-2',
      },
    });
    expect(await run(['memory', 'list'])).toBe(0);
    const lines = out().trim().split('\n');
    expect(lines[0]).toBe(`${MEMORY}  the port is 5432  v1  [replaced by ${HEAD}]`);
    expect(lines[1]).toBe(`${SUCCESSOR}  the port is 5442  v1  [disputed (2 open), rests on something since changed]`);
    expect(lines[2]).toBe(`${HEAD}  the port is 5442 on this node  v1`);
    expect(lines[3]).toBe('next-cursor: page-2');
  });

  it('says "no memories" for an empty page', async () => {
    reply = () => envelope({ page: { items: [] } });
    await run(['memory', 'list']);
    expect(out().trim()).toBe('no memories');
  });
});

// ---------------------------------------------------------------------------
// memory show
// ---------------------------------------------------------------------------

describe('memory show', () => {
  it('GETs the entity and renders the four parts under plain labels', async () => {
    reply = () => envelope(memoryDetail());
    expect(await run(['memory', 'show', MEMORY])).toBe(0);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.path).toBe(GET_MEMORY);
    expect(out()).toContain(`memory ${MEMORY}  v2`);
    expect(out()).toMatch(/What is true:\s+the port is 5442/);
    expect(out()).toMatch(/How it was found out:\s+read from the running cluster/);
    expect(out()).toMatch(/Where it applies:\s+this host/);
    expect(out()).toMatch(/What it does not prove:\s+the port on any other host/);
    expect(out()).toMatch(/Recorded:\s+2026-09-15T10:00:00.000Z by Draco/);
    expect(out()).toMatch(/Status:\s+nothing is marked against this memory/);
  });

  it('names the replacement of a replaced memory, and never invents "verified" from silence', async () => {
    reply = () => envelope(memoryDetail({
      badges: { staleness: { reasons: ['superseded'], superseded: { byId: SUCCESSOR, headId: null, depthTruncated: false } } },
    }));
    await run(['memory', 'show', MEMORY]);
    expect(out()).toMatch(new RegExp(`Status:\\s+replaced by ${SUCCESSOR}`));
    expect(out()).not.toContain('verified');
  });

  it('refuses an id that is not a memory\'s, by name', async () => {
    reply = () => envelope({ ...memoryDetail(), kind: 'task' });
    expect(await run(['memory', 'show', MEMORY])).toBe(2);
    expect(err()).toContain(`${MEMORY} is a task, not a memory`);
    expect(out()).toBe('');
  });

  it('renders the Server\'s not_found faithfully as exit 5, and refuses --mutation-id', async () => {
    reply = () => refusal(404, 'not_found', `entity ${MEMORY} not found`);
    expect(await run(['memory', 'show', MEMORY])).toBe(5);

    seen = [];
    expect(await run(['memory', 'show', MEMORY, '--mutation-id', 'x'])).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('requires the id', async () => {
    expect(await run(['memory', 'show'])).toBe(2);
    expect(err()).toContain('<memory-id>');
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// memory supersede
// ---------------------------------------------------------------------------

describe('memory supersede', () => {
  const CORRECTED = [
    '--reason', 'checked the cluster',
    '--statement', 'the port is 5442',
    '--mechanism', 'read from the running cluster',
    '--scope', 'this host',
    '--does-not-establish', 'the port on any other host',
  ];

  function chain(): (s: Seen) => Reply {
    return (s) => {
      if (s.path === GET_MEMORY) return envelope(memoryDetail({ title: 'the port is 5432' }));
      if (s.path === CREATE) return envelope({ entity: { id: SUCCESSOR, kind: 'memory', title: 'the port is 5442', version: 1 }, patches: [] });
      if (s.path === EDGES) return envelope({ edge: { id: EDGE, type: 'supersedes' }, patches: [] });
      return refusal(500, 'internal', `unexpected ${s.path}`);
    };
  }

  it('reads the old memory, creates the corrected one, then marks old as replaced — in that order, with the reason on the mark', async () => {
    reply = chain();
    expect(await run(['memory', 'supersede', MEMORY, ...CORRECTED])).toBe(0);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      `GET ${GET_MEMORY}`,
      `POST ${CREATE}`,
      `POST ${EDGES}`,
    ]);
    expect(body(1)).toMatchObject({ kind: 'memory' });
    expect(content(1)).toEqual({
      statement: 'the port is 5442',
      mechanism: 'read from the running cluster',
      subjectScope: 'this host',
      doesNotEstablish: 'the port on any other host',
    });
    // FROM the successor TO the predecessor: the successor asserts a better claim.
    expect(body(2)).toMatchObject({ srcId: SUCCESSOR, dstId: MEMORY, type: 'supersedes', props: { reason: 'checked the cluster' } });
    expect(out()).toContain(SUCCESSOR);
    expect(out()).toContain(`replaces ${MEMORY}`);
  });

  it('forwards the work session on the corrected memory too, and derives the mark\'s mutation id from the create\'s', async () => {
    process.env.TM8_SESSION_ID = SESSION;
    reply = chain();
    await run(['memory', 'supersede', MEMORY, ...CORRECTED, '--mutation-id', 'root-2']);
    expect(content(1).workSessionId).toBe(SESSION);
    expect(body(1).clientMutationId).toBe('root-2');
    expect(body(2).clientMutationId).toBe(deriveMutationId('root-2', 'supersedes'));
  });

  it('refuses before ANY write when the old id is not a memory', async () => {
    reply = (s) => (s.path === GET_MEMORY ? envelope({ ...memoryDetail(), kind: 'doc' }) : chain()(s));
    expect(await run(['memory', 'supersede', MEMORY, ...CORRECTED])).toBe(2);
    expect(seen.map((s) => s.method)).toEqual(['GET']);
    expect(err()).toContain('is a doc, not a memory');
  });

  // 190 made "a memory keeps one correction" an invariant the database
  // enforces, and this pre-flight now has to agree with it. Same exit code,
  // same sentence, and the other correction quoted in THEIR words rather than
  // named by id — otherwise the answer a script reads would depend on whether
  // the rival correction landed a millisecond ago (the database refuses, 15)
  // or last week (this pre-flight refuses, used to be 6).
  it('refuses before ANY write when the old memory was already corrected, in the same words and with the same exit code as the database', async () => {
    const GET_HEAD = bindPath('entities.get', { id: HEAD });
    reply = (s) => {
      if (s.path === GET_MEMORY) {
        return envelope(memoryDetail({ badges: { staleness: { reasons: ['superseded'], superseded: { byId: SUCCESSOR, headId: HEAD, depthTruncated: false } } } }));
      }
      if (s.path === GET_HEAD) {
        return envelope(memoryDetail({ id: HEAD, content: { kind: 'memory', statement: 'the port is 5432 on the upgraded node', measuredAt: null } }));
      }
      return chain()(s);
    };
    expect(await run(['memory', 'supersede', MEMORY, ...CORRECTED])).toBe(15);
    // Two reads and NOT ONE WRITE: the second read only fetches the words to
    // quote. A refused correction leaves nothing behind to clean up.
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET ${GET_MEMORY}`, `GET ${GET_HEAD}`]);
    expect(err()).toContain('Someone else corrected this memory first');
    expect(err()).toContain('a memory keeps only one correction');
    expect(err()).toContain('Their correction says: "the port is 5432 on the upgraded node"');
    expect(err()).toContain('correct their version instead of this one');
    expect(err()).toContain(`tm8 memory show ${HEAD}`);
    // No id is used to EXPLAIN the refusal; the only id on screen is inside a
    // command the reader can run.
    expect(err()).not.toContain(`${MEMORY} has already been replaced`);
  });

  it('still refuses when the other correction cannot be read, without inventing a quote', async () => {
    const GET_HEAD = bindPath('entities.get', { id: HEAD });
    reply = (s) => {
      if (s.path === GET_MEMORY) {
        return envelope(memoryDetail({ badges: { staleness: { reasons: ['superseded'], superseded: { byId: SUCCESSOR, headId: HEAD, depthTruncated: false } } } }));
      }
      if (s.path === GET_HEAD) return refusal(404, 'not_found', 'no such entity');
      return chain()(s);
    };
    expect(await run(['memory', 'supersede', MEMORY, ...CORRECTED])).toBe(15);
    expect(seen.map((s) => s.method)).toEqual(['GET', 'GET']);
    expect(err()).toContain('Someone else corrected this memory first');
    expect(err()).not.toContain('Their correction says');
  });

  it('needs --reason and all four parts, before the wire', async () => {
    expect(await run(['memory', 'supersede', MEMORY, ...CORRECTED.slice(2)])).toBe(2);
    expect(err()).toContain('--reason');
    expect(seen).toHaveLength(0);

    expect(await run(['memory', 'supersede', MEMORY, '--reason', 'r', '--statement', 's'])).toBe(2);
    expect(err()).toContain('--mechanism (how you found out)');
    expect(seen).toHaveLength(0);
  });

  it('when the mark cannot be written: the corrected memory is reported, the fix names the exact edge command, and the exit code is the failure\'s', async () => {
    reply = (s) => (s.path === EDGES
      ? refusal(409, 'invariant_violation', 'supersedes would form a cycle')
      : chain()(s));
    expect(await run(['memory', 'supersede', MEMORY, ...CORRECTED])).toBe(6);
    expect(out()).toContain(SUCCESSOR);
    expect(out()).toContain(`does NOT yet replace ${MEMORY}`);
    expect(err()).toContain('the corrected memory was saved, but the old one is not marked as replaced yet');
    expect(err()).toContain(`tm8 edge create ${SUCCESSOR} supersedes ${MEMORY} --props '{"reason":"checked the cluster"}'`);
  });
});

// ---------------------------------------------------------------------------
// memory search — one request, and whatever the Server answers
// ---------------------------------------------------------------------------

/**
 * WHAT MOVED, AND WHAT THESE TESTS ARE NOW ABOUT. This command used to fetch a
 * page of the hundred most recently updated memories and rank them in this
 * process, so its unit tests were about the RANKING: which of three stub rows
 * came back first, which field a word matched in, when the caveat about
 * unsearched memories appeared. None of that is this command's job any more —
 * matching, ranking and chain-head resolution happen in the database, and are
 * proved where they live (`packages/server/test/db/memory-search.pg.test.ts`)
 * and end to end against a real Server (`test/integration/memory.test.ts`).
 *
 * What is left here is the only thing this file can honestly assert: the
 * request this CLI composes, and what it does with an answer. A unit test that
 * re-asserted relevance against a stub would be asserting the stub.
 */
describe('memory search', () => {
  /** Two matches as `memories.search` answers them: statement and marks, no page wrapper. */
  const HITS = [
    { id: MEMORY, statement: 'the deploy needs a reload', subjectScope: 's', doesNotEstablish: 'd', rank: 0.9, marks: [] },
    { id: SUCCESSOR, statement: 'staging runs a different init', subjectScope: 's', doesNotEstablish: 'd', rank: 0.4, marks: ['disputed'] },
  ];

  it('asks the Server to search, sending the words as typed and the space it is in', async () => {
    reply = () => envelope({ items: HITS });
    expect(await run(['memory', 'search', 'deploy', 'reload', '--format', 'json'])).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(SEARCH);
    expect(seen[0]?.method).toBe('POST');
    // The words go as typed — no lower-casing, no tokenizing, no re-quoting.
    // "quoted words", `or` and a leading minus are the Server's syntax to read,
    // and a CLI that pre-chewed them would be deciding what the caller meant.
    expect(body()).toEqual({ spaceId: SPACE, query: 'deploy reload', limit: 10 });
    const dto = JSON.parse(out()) as { query: string; items: Array<{ id: string }> };
    expect(dto.query).toBe('deploy reload');
    expect(dto.items.map((i) => i.id)).toEqual([MEMORY, SUCCESSOR]);
  });

  it('keeps the Server\'s order — relevance is decided once, where the rows are', async () => {
    reply = () => envelope({ items: [...HITS].reverse() });
    await run(['memory', 'search', 'deploy', '--format', 'json']);
    const dto = JSON.parse(out()) as { items: Array<{ id: string }> };
    expect(dto.items.map((i) => i.id)).toEqual([SUCCESSOR, MEMORY]);
  });

  it('--limit is what the Server is asked for; ten is the default and two hundred the ceiling', async () => {
    reply = () => envelope({ items: [] });
    await run(['memory', 'search', 'deploy', '--limit', '3', '--format', 'json']);
    expect(body()).toMatchObject({ limit: 3 });

    // Refused HERE, in a sentence, rather than by the wire as a schema error.
    expect(await run(['memory', 'search', 'deploy', '--limit', '500'])).toBe(2);
    expect(err()).toContain('at most 200 matches at a time');
    expect(await run(['memory', 'search', 'deploy', '--limit', '0'])).toBe(2);
    expect(err()).toContain('expects a positive count');
    expect(seen).toHaveLength(1); // only the first call reached the wire
  });

  it('the human view puts the id first, then the claim, then any marks — in this noun\'s own words', async () => {
    reply = () => envelope({ items: [
      { id: MEMORY, statement: 'the deploy needs a reload', subjectScope: 's', doesNotEstablish: 'd', rank: 1, marks: ['basis changed', 'disputed'] },
    ] });
    await run(['memory', 'search', 'deploy']);
    expect(out().trim()).toBe(`${MEMORY}  the deploy needs a reload  [rests on something since changed, disputed]`);
  });

  it('refuses a query longer than the Server takes, in a sentence about what was typed', async () => {
    expect(await run(['memory', 'search', 'x'.repeat(1001)])).toBe(2);
    expect(err()).toContain('too much to search for at once');
    expect(seen).toHaveLength(0);
  });

  it('says so plainly when nothing matched', async () => {
    reply = () => envelope({ items: [] });
    expect(await run(['memory', 'search', 'zebra'])).toBe(0);
    expect(out().trim()).toBe('no memories mention "zebra"');
  });

  it('needs at least one word, refuses --mutation-id, and sends nothing either way', async () => {
    expect(await run(['memory', 'search'])).toBe(2);
    expect(err()).toContain('at least one word');
    expect(await run(['memory', 'search', 'x', '--mutation-id', 'm'])).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
