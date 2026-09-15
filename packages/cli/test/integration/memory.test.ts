/**
 * `tm8 memory …` — REAL-SERVER INTEGRATION, through the BUILT BINARY.
 *
 * The coordinator-owned harness starts the real Server as a child process on
 * an isolated, freshly migrated scratch database, and every step here is
 * `node packages/cli/dist/index.js …` talking to it over HTTP — exactly what
 * an agent in a work session does. Nothing is imported from the command
 * module; if the registry, the projection, or the dist were wrong, this suite
 * would not exit 0.
 *
 * WHAT IS PROVED, in order, because each step needs the one before it:
 *
 *  1. `record` reaches `create_memory` through `entities.create` with the
 *     content shape the door reads — all four fields land, the title is
 *     derived from the statement, and the id comes back first on stdout.
 *  2. `show` reads the four parts back under plain labels.
 *  3. `--about` draws a real `about` edge the graph can list back.
 *  4. `list --holder` is the holder's `remembers` working set — after a
 *     `remembers` edge is drawn (any kind may hold one since 090 D9), the
 *     memory appears under that holder and a stranger's list stays empty.
 *  5. `supersede` writes the corrected memory, then the append-only
 *     `supersedes` mark with its reason; the OLD memory's own read now names
 *     the replacement, and superseding it again is refused before any write.
 *  6. `search` finds a memory by a word in each of its four parts — including
 *     the two scope fields that only ride in `state` — ignoring letter case.
 *  7. A session id the acting actor does not participate in is refused by the
 *     door (42501 → forbidden, exit 4) and the CLI explains it in plain words.
 *
 * WHAT IS NOT PROVED HERE, and why. The session-authored path (`content.
 * workSessionId` → `authored_from` + `remembers(session → memory)`) needs a
 * `work_session` the acting actor `participates_in`, and a work_session is
 * born ONLY through `execution.spawn` — a live PTY agent this harness cannot
 * host. That chain is proved in two halves that meet at the wire: the unit
 * suite pins that the CLI sends `content.workSessionId` from `TM8_SESSION_ID`,
 * and `packages/server/test/db/memory-working-set.pg.test.ts` pins that
 * `create_memory` given a session writes both edges and that the spawn
 * injector reads them. Step 7 proves the refusal half end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

let server: RealServer;
let spaceId = '';
/** The Member `spaces.create` minted for the auto-owner — a real actor id and a real holder. */
let memberId = '';

/** Ids produced by the steps, consumed by the ones after. */
let memoryId = '';
let taskId = '';
let successorId = '';

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('memory-noun');
  const health = await server.health();
  process.stderr.write(
    `[memory] ${server.baseUrl} operations=${health.operations} registered=${health.implemented} ` +
      `bind-start ${server.bindStart.files}/${server.bindStart.digest}\n`,
  );
  const res = await fetch(new URL('/v2/spaces', server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'memory noun scratch', clientMutationId: 'memory-noun-setup' }),
  });
  const body = (await res.json()) as { data?: { space?: { id?: string }; memberId?: string } };
  const id = body.data?.space?.id;
  if (!res.ok || id === undefined || body.data?.memberId === undefined) {
    throw new Error(`space setup failed (${res.status}): ${JSON.stringify(body)}`);
  }
  spaceId = id;
  memberId = body.data.memberId;
}, 180_000);

afterAll(async () => {
  // A throw here means the migration chain moved under the suite; every
  // number above is then bound to two trees and must be discarded, not reported.
  await server?.assertBindCoherent();
  await server?.stop();
});

/** The built binary, in this Space, as the auto-owner. */
async function tm8(argv: readonly string[], extraEnv: Record<string, string> = {}) {
  return await cli(argv, server, { TM8_SPACE_ID: spaceId, ...extraEnv });
}

function json<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

const FOUR = [
  '--statement', 'The production node needs a reload after a config change, not a restart',
  '--mechanism', 'Restarted twice and watched the port stay closed; reloaded once and it opened within a second',
  '--scope', 'The production node only, on its current init system',
  '--does-not-establish', 'Anything about staging, which boots through a different supervisor',
];

describe('tm8 memory — the door an agent in a work session uses to save what it learned', () => {
  it('1. record: the four parts reach the door and the memory comes back with its id first', async () => {
    const run = await tm8(['memory', 'record', ...FOUR, '--format', 'json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const dto = json<{ entity: { id: string; kind: string; title: string; version: number; content: Record<string, unknown> } }>(run.stdout);
    expect(dto.entity.kind).toBe('memory');
    expect(dto.entity.version).toBe(1);
    // The title is DERIVED from the statement by the server (design §3.1).
    expect(dto.entity.title).toBe('The production node needs a reload after a config change, not a restart');
    expect(dto.entity.content).toMatchObject({
      statement: 'The production node needs a reload after a config change, not a restart',
      mechanism: 'Restarted twice and watched the port stay closed; reloaded once and it opened within a second',
      subjectScope: 'The production node only, on its current init system',
      doesNotEstablish: 'Anything about staging, which boots through a different supervisor',
    });
    memoryId = dto.entity.id;

    // The human view puts the id FIRST — it is the argument every follow-up
    // command takes — and the id it prints is a real one.
    const human = await tm8(['memory', 'record', ...FOUR.slice(0, 2), '--mechanism', 'a second reading', ...FOUR.slice(4)]);
    expect(human.code).toBe(0);
    const [printedId] = human.stdout.trim().split('  ');
    expect(printedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(human.stdout).toContain('The production node needs a reload');
    const readBack = await tm8(['memory', 'show', printedId as string]);
    expect(readBack.code).toBe(0);
    expect(readBack.stdout).toMatch(/How it was found out:\s+a second reading/);
  });

  it('record refuses a memory missing a part before anything is sent — the door\'s rule, stated where it can be fixed', async () => {
    const run = await tm8(['memory', 'record', '--statement', 'half a memory']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--mechanism (how you found out)');
    expect(run.stderr).toContain('--does-not-establish (what it does not prove)');
    expect(run.stdout).toBe('');
  });

  it('2. show: reads the four parts back under plain labels', async () => {
    const run = await tm8(['memory', 'show', memoryId]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`memory ${memoryId}  v1`);
    expect(run.stdout).toMatch(/What is true:\s+The production node needs a reload/);
    expect(run.stdout).toMatch(/How it was found out:\s+Restarted twice/);
    expect(run.stdout).toMatch(/Where it applies:\s+The production node only/);
    expect(run.stdout).toMatch(/What it does not prove:\s+Anything about staging/);
    expect(run.stdout).toMatch(/Status:\s+nothing is marked against this memory/);
  });

  it('show refuses an id that is not a memory\'s, by name', async () => {
    const task = await tm8(['entity', 'create', 'task', 'Deploy the reload fix', '--format', 'json']);
    expect(task.code).toBe(0);
    taskId = json<{ entity: { id: string } }>(task.stdout).entity.id;

    const run = await tm8(['memory', 'show', taskId]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`${taskId} is a task, not a memory`);
  });

  it('3. --about draws a real link the graph lists back', async () => {
    const run = await tm8(['memory', 'record', ...FOUR, '--about', taskId]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`about ${taskId}  (linked)`);
    const aboutMemoryId = run.stdout.split('  ')[0] as string;

    const edges = await tm8(['edge', 'list', '--source', aboutMemoryId, '--type', 'about', '--format', 'json']);
    expect(edges.code).toBe(0);
    const page = json<{ items: Array<{ type: string; source: { id: string }; target: { id: string } }> }>(edges.stdout);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: 'about', source: { id: aboutMemoryId }, target: { id: taskId } });
  });

  it('4. list: every memory newest first; --holder only what that holder remembers', async () => {
    const all = await tm8(['memory', 'list', '--format', 'json']);
    expect(all.code).toBe(0);
    const ids = json<{ page: { items: Array<{ id: string; kind: string }> } }>(all.stdout).page.items;
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids.every((i) => i.kind === 'memory')).toBe(true);
    expect(ids.map((i) => i.id)).toContain(memoryId);
    // Newest first: the very first memory recorded is not at the top.
    expect(ids[ids.length - 1]?.id).toBe(memoryId);

    // Nobody remembers anything yet: the holder form is empty for the member.
    const before = await tm8(['memory', 'list', '--holder', memberId]);
    expect(before.code).toBe(0);
    expect(before.stdout.trim()).toBe('no memories');

    // Any kind may hold a working set (090 D9): give the member this memory.
    const link = await tm8(['edge', 'create', memberId, 'remembers', memoryId]);
    expect(link.stderr).toBe('');
    expect(link.code).toBe(0);

    const after = await tm8(['memory', 'list', '--holder', memberId, '--format', 'json']);
    expect(after.code).toBe(0);
    expect(json<{ page: { items: Array<{ id: string }> } }>(after.stdout).page.items.map((i) => i.id)).toEqual([memoryId]);

    // A holder with no working set — the task — stays empty.
    const stranger = await tm8(['memory', 'list', '--holder', taskId]);
    expect(stranger.stdout.trim()).toBe('no memories');
  });

  it('5. supersede: the corrected memory is written, the old one names its replacement, and a second replacement is refused', async () => {
    const run = await tm8([
      'memory', 'supersede', memoryId,
      '--reason', 'Measured again after the init system was upgraded',
      '--statement', 'The production node needs a restart after a config change since the init upgrade',
      '--mechanism', 'Reloaded twice after the upgrade and the port stayed closed; a restart opened it',
      '--scope', 'The production node on the upgraded init system',
      '--does-not-establish', 'Anything about nodes still on the old init system',
      '--format', 'json',
    ]);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const dto = json<{ entity: { id: string; kind: string }; supersedes: { memoryId: string; edgeId: string | null } }>(run.stdout);
    expect(dto.entity.kind).toBe('memory');
    expect(dto.supersedes.memoryId).toBe(memoryId);
    expect(typeof dto.supersedes.edgeId).toBe('string');
    successorId = dto.entity.id;
    expect(successorId).not.toBe(memoryId);

    // The old memory's own read carries the mark, derived server-side.
    const old = await tm8(['memory', 'show', memoryId]);
    expect(old.code).toBe(0);
    expect(old.stdout).toMatch(new RegExp(`Status:\\s+replaced by ${successorId}`));

    // And the list shows it beside the claim.
    const listed = await tm8(['memory', 'list']);
    expect(listed.stdout).toContain(`${memoryId}  The production node needs a reload after a config change, not a restart  v1  [replaced by ${successorId}]`);

    // Superseding an already-replaced memory is refused BEFORE any write,
    // pointing at the head — the chain of corrections stays one line.
    const again = await tm8([
      'memory', 'supersede', memoryId,
      '--reason', 'r', '--statement', 's', '--mechanism', 'm', '--scope', 'sc', '--does-not-establish', 'd',
    ]);
    expect(again.code).toBe(6);
    expect(again.stderr).toContain(`${memoryId} has already been replaced by ${successorId}`);
    const count = json<{ page: { items: unknown[] } }>((await tm8(['memory', 'list', '--format', 'json'])).stdout).page.items.length;
    expect(count).toBe(4); // three records + one successor; the refused one wrote nothing
  });

  it('6. search: a word in any of the four parts finds the memory, ignoring letter case', async () => {
    const byClaim = await tm8(['memory', 'search', 'UPGRADE', '--format', 'json']);
    expect(byClaim.code).toBe(0);
    expect(json<{ items: Array<{ id: string }> }>(byClaim.stdout).items.map((i) => i.id)).toContain(successorId);

    const byScope = await tm8(['memory', 'search', 'upgraded init', '--format', 'json']);
    const scopeHits = json<{ items: Array<{ id: string }>; exhaustive: boolean }>(byScope.stdout);
    expect(scopeHits.items[0]?.id).toBe(successorId); // both words, ranked first
    expect(scopeHits.exhaustive).toBe(true);

    const byBoundary = await tm8(['memory', 'search', 'supervisor', '--format', 'json']);
    const ids = json<{ items: Array<{ id: string }> }>(byBoundary.stdout).items.map((i) => i.id);
    expect(ids).toContain(memoryId); // "different supervisor" lives only in does-not-establish
    expect(ids).not.toContain(successorId);

    const none = await tm8(['memory', 'search', 'zebra']);
    expect(none.code).toBe(0);
    expect(none.stdout.trim()).toBe('no memories mention "zebra"');
  });

  it('7. a session the actor is not part of is refused by the door, and the CLI says what to do', async () => {
    const run = await tm8(['memory', 'record', ...FOUR], { TM8_SESSION_ID: '018f0000-0000-7000-8000-0000000005e5' });
    expect(run.code).toBe(4);
    expect(run.stderr).toContain('forbidden');
    expect(run.stderr).toMatch(/not part of/);
    expect(run.stderr).toMatch(/inside the session that is doing the work/);
    expect(run.stdout).toBe('');
  });

  it('help for the noun answers from the built binary, with no Server involved', async () => {
    const run = await cli(['help', 'memory'], server);
    expect(run.code).toBe(0);
    for (const verb of ['record', 'list', 'show', 'supersede', 'search']) expect(run.stdout).toContain(`memory ${verb}`);
  });
});
