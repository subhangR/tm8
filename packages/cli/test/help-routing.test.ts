/**
 * Levers 2+3 of the token-efficiency work (task 01a0d305): an agent should
 * never need `entity get`, and `tm8 help` should answer a closeout question in
 * one call.
 *
 *  - `entity get --format json` is BOUNDED by default; `--full` restores it.
 *  - `help --query` routes the five closeout intents to the exact command,
 *    first, with a one-line example.
 *  - an operation id as a help topic resolves to its owning command, and any
 *    other unknown topic names the closest rows instead of a bare refusal.
 *  - root and noun help json drop per-row fields that repeat on every row.
 *
 * Driven through the real `run()` against a stub Server, like
 * discovery-commands.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { run } from '../src/run.js';
import { nounHelp, rootHelp, searchHelp } from '../src/discovery/help.js';
import { INTENT_ROUTES, matchIntent } from '../src/discovery/search.js';
import { commandDiscovery } from '../src/discovery/operations.js';
import { CONTENT_STRING_CAP, boundEntityDetail, isEntityDetail } from '../src/entity-bounded.js';

const ID = '55555555-5555-7555-8555-555555555555';

function summary(id: string, title: string): Record<string, unknown> {
  return {
    id,
    spaceId: 'spc',
    kind: 'task',
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-09-24T00:00:00.000Z',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act', kind: 'team_member', displayName: 'Worker' },
    counters: { children: 0 },
    state: { kind: 'task', status: 'open' },
    badges: [],
  };
}

function edge(type: string, n: number): Record<string, unknown> {
  return { id: `e${n}`, type, source: summary(ID, 'me'), target: summary(`t${n}`, `target ${n}`), props: {} };
}

/** An EntityDetail shaped like the measured 34 KB task: big neighbourhood, long description. */
function detail(): Record<string, unknown> {
  return {
    ...summary(ID, 'The task'),
    version: 7,
    state: { kind: 'task', status: 'working', acceptance: { total: 2, completed: 1 } },
    capabilities: { canEdit: true, canComplete: true },
    content: {
      kind: 'task',
      description: 'x'.repeat(5000),
      acceptanceCriteria: [
        { id: 'c1', text: 'first', done: true },
        { id: 'c2', text: 'second', done: false },
      ],
    },
    hierarchy: {
      parent: summary('p1', 'Parent'),
      path: [summary('root', 'Root'), summary('p1', 'Parent')],
      children: { items: Array.from({ length: 12 }, (_, i) => summary(`c${i}`, `child ${i}`)), nextCursor: 'cur' },
    },
    connections: {
      outgoing: [
        { type: 'assigned_to', direction: 'outgoing', label: 'assigned_to', edges: [edge('assigned_to', 1)] },
        { type: 'relates_to', direction: 'outgoing', label: 'relates_to', edges: Array.from({ length: 20 }, (_, i) => edge('relates_to', i)) },
      ],
      incoming: [{ type: 'created_in', direction: 'incoming', label: 'created_in', edges: [edge('created_in', 99)] }],
      unresolvedHardDependencyCount: 0,
    },
  };
}

let server: Server;
let stdout: string[] = [];
let stderr: string[] = [];
const savedClass = process.env.TM8_JOURNAL_CLASS;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: detail(), requestId: 'req_t' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  process.env.TM8_BASE_URL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  stdout = [];
  stderr = [];
  process.env.TM8_SPACE_ID = 'spc_test';
  process.env.TM8_JOURNAL_CLASS = 'human';
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

afterEach(() => {
  vi.restoreAllMocks();
  if (savedClass === undefined) delete process.env.TM8_JOURNAL_CLASS;
  else process.env.TM8_JOURNAL_CLASS = savedClass;
});

const out = (): string => stdout.join('');
const err = (): string => stderr.join('');

describe('entity get is bounded by default', () => {
  it('projects an EntityDetail to identity, version, state, capped content and COUNTS', () => {
    const full = detail();
    expect(isEntityDetail(full)).toBe(true);
    const b = boundEntityDetail(full);
    expect(b.projection).toBe('bounded');
    expect(b.version).toBe(7);
    expect(b.state).toEqual(full.state);
    const content = b.content as { description: string; acceptanceCriteria: unknown };
    // Structured content is what a caller rewrites: whole, never capped.
    expect(content.acceptanceCriteria).toEqual((full.content as { acceptanceCriteria: unknown }).acceptanceCriteria);
    expect(content.description.length).toBe(CONTENT_STRING_CAP + 1);
    expect(b.truncated).toEqual([{ field: 'content.description', shownChars: CONTENT_STRING_CAP, totalChars: 5000 }]);
    expect(b.hierarchy).toEqual({ parent: { id: 'p1', kind: 'task', title: 'Parent' }, depth: 2, children: 12, moreChildren: true });
    expect(b.edgeCounts).toEqual({
      outgoing: { assigned_to: 1, relates_to: 20 },
      incoming: { created_in: 1 },
      unresolvedHardDependencyCount: 0,
    });
    expect(b.next).toEqual({ relationships: `tm8 entity context ${ID}`, full: `tm8 entity get ${ID} --full` });
  });

  it('a DTO without hierarchy or connections passes through untouched', () => {
    expect(isEntityDetail({ id: ID, kind: 'task', title: 'T' })).toBe(false);
  });

  it('`entity get --format json` fits ~4 KB; `--full` returns the old envelope', async () => {
    expect(await run(['entity', 'get', ID, '--format', 'json'])).toBe(0);
    const bounded = out();
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(4096);
    const dto = JSON.parse(bounded) as Record<string, unknown>;
    expect(dto.projection).toBe('bounded');
    expect(dto).not.toHaveProperty('connections');

    stdout = [];
    expect(await run(['entity', 'get', ID, '--format', 'json', '--full'])).toBe(0);
    const full = JSON.parse(out()) as Record<string, unknown>;
    expect(full).toHaveProperty('connections');
    expect(full).not.toHaveProperty('projection');
    expect(out().length).toBeGreaterThan(bounded.length * 4);
  });

  it('an agent caller gets it minified', async () => {
    process.env.TM8_JOURNAL_CLASS = 'agent';
    expect(await run(['entity', 'get', ID, '--format', 'json'])).toBe(0);
    expect(out().trim().split('\n')).toHaveLength(1);
  });

  it('help says so', () => {
    const notes = commandDiscovery(['entity', 'get'])?.notes.join(' ') ?? '';
    expect(notes).toContain('BOUNDED');
    expect(notes).toContain('--full');
    expect(notes).toContain('tm8 entity context');
  });
});

describe('help --query routes closeout intents to the exact command, first', () => {
  const CASES: ReadonlyArray<[string, readonly string[]]> = [
    ['tick acceptance criterion', ['task tick', 'entity update']],
    ['check acceptance criteria', ['task tick', 'entity update']],
    ['complete task', ['task complete']],
    ['mark a task done', ['task complete']],
    ['reply to a message', ['message reply']],
    ['update task description', ['entity update']],
    ['update task content', ['entity update']],
    ['post result', ['message send']],
    ['report a blocker to the coordinator', ['message send']],
  ];
  for (const [q, allowed] of CASES) {
    it(`"${q}"`, () => {
      const top = searchHelp(q).matches[0];
      expect(allowed, q).toContain(top?.command);
      expect(top?.example, q).toMatch(/^tm8 /);
      expect(top?.example, q).toContain(`tm8 ${top?.command}`);
    });
  }

  it('the tick route prefers `task tick` and only falls back when that command is absent', () => {
    const tick = INTENT_ROUTES.find((r) => r.intent === 'tick acceptance criteria');
    expect(tick?.candidates[0]?.path).toEqual(['task', 'tick']);
    const top = searchHelp('tick acceptance criteria').matches[0];
    const expected = commandDiscovery(['task', 'tick']) === undefined ? 'entity update' : 'task tick';
    expect(top?.command).toBe(expected);
    // The fallback names the fact that bites: the array is replaced wholesale.
    expect(tick?.candidates[1]?.example).toContain('REPLACED');
  });

  it('never routes an unrelated query, and never duplicates the routed row', () => {
    expect(matchIntent('change task status')).toBeUndefined();
    expect(matchIntent('edit message body')).toBeUndefined();
    const res = searchHelp('complete task');
    const commands = res.matches.map((m) => m.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(res.matches.length).toBeLessThanOrEqual(5);
  });

  it('the human render prints the example', async () => {
    expect(await run(['help', '--query', 'complete task'])).toBe(0);
    expect(out()).toContain('e.g. tm8 task complete <task-id>');
  });
});

describe('help topics that are operation ids resolve; unknown topics suggest', () => {
  for (const argv of [
    ['entities.patch'],
    ['operation', 'entities.patch'],
    ['schema', 'entities.patch'],
  ]) {
    it(`tm8 help ${argv.join(' ')} → entity update`, async () => {
      expect(await run(['help', ...argv, '--format', 'json'])).toBe(0);
      expect((JSON.parse(out()) as { command: string }).command).toBe('entity update');
    });
  }

  it('tm8 help entities.commands.complete → task complete', async () => {
    expect(await run(['help', 'entities.commands.complete', '--format', 'json'])).toBe(0);
    expect((JSON.parse(out()) as { command: string }).command).toBe('task complete');
  });

  it('a commandless operation id gets its operation shard, never an invented invocation', async () => {
    expect(await run(['help', 'execution.prompt', '--format', 'json'])).toBe(0);
    const dto = JSON.parse(out()) as { command: unknown; syntax: unknown };
    expect(dto.command).toBeNull();
    expect(dto.syntax).toBeNull();
  });

  it('bare `help schema` explains where schemas live', async () => {
    expect(await run(['help', 'schema'])).toBe(2);
    expect(err()).toContain('--operation');
    expect(err()).toContain('tm8 help <noun> <verb>');
  });

  it('`help entity patch` names entity update as the closest', async () => {
    expect(await run(['help', 'entity', 'patch'])).toBe(2);
    expect(err()).toMatch(/closest: tm8 help entity update \(entities\.patch\)/);
  });

  it('a mistyped operation id suggests the real one', async () => {
    expect(await run(['help', 'entities.commands.completee'])).toBe(2);
    expect(err()).toContain('unknown help topic');
    expect(err()).toMatch(/closest: tm8 help task complete/);
    expect(err()).not.toContain('no help for');
  });
});

describe('root and noun help json state repeated fields once', () => {
  it('root nouns carry no per-row helpRef', () => {
    const root = rootHelp();
    expect(root.helpRefs).toContain('tm8://help/<noun>');
    for (const n of root.nouns) expect(Object.keys(n).sort()).toEqual(['name', 'summary']);
  });

  it('noun rows omit default exposure/availability and the derivable helpRef', () => {
    const shard = nounHelp('entity');
    expect(shard?.defaults).toEqual({ exposure: 'public', availability: 'unknown' });
    for (const c of shard?.commands ?? []) {
      expect(c).not.toHaveProperty('helpRef');
      if ('exposure' in c) expect(c.exposure).not.toBe('public');
      if ('availability' in c) expect(c.availability).not.toBe('unknown');
    }
    for (const o of shard?.operationsWithoutCommand ?? []) expect(o).not.toHaveProperty('helpRef');
  });

  it('agent callers get help json minified', async () => {
    process.env.TM8_JOURNAL_CLASS = 'agent';
    expect(await run(['help', 'entity', '--format', 'json'])).toBe(0);
    expect(out().trim().split('\n')).toHaveLength(1);
    // Measured before this change: 6,987 bytes, pretty. Now ~3.4 KB.
    expect(Buffer.byteLength(out())).toBeLessThan(4500);
  });
});
