/**
 * `execution.memoryPreview` — "What this agent will be told", against the REAL
 * migration chain and the REAL reader.
 *
 * ONE PROPERTY under test, and everything here is that property from some
 * side: THE PREVIEW IS THE HAND-OFF. Not "similar to it", not "computed the
 * same way" — `DbGraphPort.previewMemories` must answer the very set
 * `loadSpawnContext` would inject for the same inputs, in the same order, and
 * it must answer it without writing a row. That is enforced in the source by
 * both paths calling one function (`selectAgentMemories`); it is enforced here
 * by comparing the two ends against each other on a real database.
 *
 * Why it matters more than most equalities: a person reads this list and then
 * launches. A preview free to disagree with the launch is worse than no
 * preview at all — it is blind picking with a progress bar.
 *
 * The rest of the file pins what the preview ADDS on top of the injection and
 * therefore cannot inherit from it: which of the four plain words each entry
 * is labelled with, the marks it carries, how many memories did not fit, and
 * the percentage of the room used.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import {
  DbGraphPort,
  memoryPreviewOf,
  renderMemoryLines,
  type AgentMemorySet,
} from '../../src/facade/execution-handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'mem-preview-owner'::text "identityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId",
              internal.new_id()::text "teamMemberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Preview owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Preview',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Preview owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    // The post-088 world: the jsonb column is EMPTY, so `loadSpawnContext`'s
    // legacy remainder contributes nothing and the two readers can be compared
    // on the graph-selected section alone.
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity,memories)
       values($1,$2,'Previewed','','persona text','[]'::jsonb)`,
      [f.teamMemberId, f.memberId],
    );
    return f;
  });
}

/**
 * A memory entity + detail row, as the graph owner. `createdBy` DECIDES the
 * D10 authorship route: the fixture's human member by default, so a memory is
 * only reached through authorship when a test says so by stamping the
 * teammate. `measuredAt` fixes the order inside one rank tier (newest first).
 */
async function mintMemory(
  statement: string,
  opts: { createdBy?: string; measuredAt?: string } = {},
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'memory',null,0,$3)`,
      [id, fixture.spaceId, opts.createdBy ?? fixture.memberId],
    );
    await client.query(
      `insert into public.memories(entity_id,statement,mechanism,subject_scope,does_not_establish,measured_at)
       values($1,$2,'direct seed','this scratch database','runtime behavior',$3)`,
      [id, statement, opts.measuredAt ?? null],
    );
    return id;
  });
}

/** A bare task entity + detail row — a `remembers` HOLDER under D9 (089). */
async function mintTask(title: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'task',null,0,$3)`,
      [id, fixture.spaceId, fixture.memberId],
    );
    await client.query(`insert into public.tasks(entity_id,title) values($1,$2)`, [id, title]);
    return id;
  });
}

/**
 * A work_session belonging to the teammate — the C1 route that makes a memory
 * "learned last time" rather than "the teammate's own": the session remembers
 * it, and `relates_to` is the edge spawn draws from a session to its actor.
 */
async function mintSession(): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'work_session',null,0,$3)`,
      [id, fixture.spaceId, fixture.teamMemberId],
    );
    await client.query(`insert into public.work_sessions(entity_id) values($1)`, [id]);
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,'relates_to','{}'::jsonb,$2)`,
      [fixture.spaceId, id, fixture.teamMemberId],
    );
    return id;
  });
}

async function drawEdge(
  src: string, dst: string, type: string, props: Record<string, unknown> = {},
): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,$4,$5,$6)`,
      [fixture.spaceId, src, dst, type, JSON.stringify(props), fixture.teamMemberId],
    );
  });
}

/**
 * The REAL reader over the scratch pool — the same fake `Db` the injector
 * suite uses. The owner role stands in for RLS because row VISIBILITY is not
 * what this file is about; the preview and the injection run the same
 * SECURITY INVOKER functions, so they see the same rows as each other under
 * any claim.
 */
function graphPort(): DbGraphPort {
  const db = {
    tx: async <T>(_claims: unknown, fn: (q: unknown) => Promise<T>): Promise<T> =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        return fn({
          query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
            (await client.query(sql, [...params])).rows as R[],
          rpc: async () => { throw new Error('a read must not rpc'); },
        });
      }),
  } as unknown as Db;
  return new DbGraphPort(db);
}

interface Inputs { taskIds?: string[]; memoryIds?: string[] }

const previewOf = (inputs: Inputs = {}): Promise<AgentMemorySet> =>
  graphPort().previewMemories({} as DbClaims, {
    spaceId: fixture.spaceId,
    teamMemberId: fixture.teamMemberId,
    ...(inputs.taskIds ? { taskIds: inputs.taskIds } : {}),
    ...(inputs.memoryIds ? { memoryIds: inputs.memoryIds } : {}),
  });

const injectionOf = async (inputs: Inputs = {}): Promise<unknown[]> =>
  (await graphPort().loadSpawnContext({} as never, {
    spaceId: fixture.spaceId,
    teamMemberId: fixture.teamMemberId,
    ...(inputs.taskIds ? { taskIds: inputs.taskIds } : {}),
    ...(inputs.memoryIds ? { memoryIds: inputs.memoryIds } : {}),
  })).teamMember.memories;

/**
 * The ids the agent is actually shown, read back OUT of the injected prompt
 * lines rather than out of the preview — so this comparison cannot pass by
 * both sides agreeing on the same mistake. Every entry the graph renders ends
 * in ` (mem:<uuid>)`; the "N further memories not shown" line does not, and is
 * skipped here because it names no memory.
 */
function injectedIds(memories: readonly unknown[]): string[] {
  return memories.flatMap((line) => {
    if (typeof line !== 'string') return [];
    const match = / \(mem:([0-9a-f-]{36})\)$/.exec(line);
    return match ? [match[1]!] : [];
  });
}

/** Row counts across every table a read could conceivably disturb. */
async function graphFootprint(): Promise<Record<string, string>> {
  const rows = await database.query<{ table: string; n: string }>(
    `select 'entities' as "table", count(*)::text n from public.entities
     union all select 'edges', count(*)::text from public.edges
     union all select 'memories', count(*)::text from public.memories
     union all select 'work_sessions', count(*)::text from public.work_sessions
     union all select 'command_ledger', count(*)::text from public.command_ledger`,
  );
  return Object.fromEntries(rows.map((r) => [r.table, r.n]));
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('memory_preview');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('the preview IS the hand-off — same memories, same order', () => {
  let own: string;
  let disputed: string;
  let verified: string;
  let replaced: string;
  let successor: string;
  let task: string;
  let fromTask: string;
  let learned: string;
  let picked: string;

  beforeAll(async () => {
    // Newest first inside a rank tier, so the order below is deterministic and
    // a re-run cannot pass by luck.
    own = await mintMemory('the deploy needs a reload, not a restart', { measuredAt: '2026-09-10T00:00:00Z' });
    await drawEdge(fixture.teamMemberId, own, 'remembers');

    disputed = await mintMemory('a contested claim about the build', { measuredAt: '2026-09-09T00:00:00Z' });
    await drawEdge(fixture.teamMemberId, disputed, 'remembers');
    const counter = await mintMemory('the counter-measurement');
    await drawEdge(counter, disputed, 'disputes', {
      quote: 'a contested claim', expected: 'x', observed: 'y', pinnedVersion: 1,
    });

    // Verified by an INDEPENDENT author — the actor-tier basis, which is what
    // lets this preview say "verified" where a staleness badge cannot.
    verified = await mintMemory('the port is 5442', { measuredAt: '2026-09-08T00:00:00Z' });
    await drawEdge(fixture.teamMemberId, verified, 'remembers');
    const evidence = await mintMemory('re-ran the cluster check', { createdBy: fixture.teamMemberId });
    await drawEdge(evidence, verified, 'verifies', {
      mechanism: 're-ran it', answers: [], pinnedVersion: 1, independenceBasis: 'actor',
    });

    // Superseded and merely remembered: the selector hands its place to the
    // chain head, so the SUCCESSOR appears and the predecessor does not.
    replaced = await mintMemory('stale, remembered, replaced');
    await drawEdge(fixture.teamMemberId, replaced, 'remembers');
    successor = await mintMemory('its replacement', { measuredAt: '2026-09-07T00:00:00Z' });
    await drawEdge(successor, replaced, 'supersedes', { reason: 'measured again' });

    task = await mintTask('the task being launched against');
    fromTask = await mintMemory('the task remembers a deploy quirk');
    await drawEdge(task, fromTask, 'remembers');

    // Reached only through one of the teammate's own earlier sessions.
    const session = await mintSession();
    learned = await mintMemory('what a past session established');
    await drawEdge(session, learned, 'remembers');

    picked = await mintMemory('named for this launch only');
  });

  it('renders to exactly the lines loadSpawnContext injects, in injection order', async () => {
    const inputs = { taskIds: [task], memoryIds: [picked] };
    const injected = await injectionOf(inputs);
    const set = await previewOf(inputs);
    // Whole-line equality: the preview's set, rendered, is the prompt section.
    expect(renderMemoryLines(set)).toEqual(injected);
    // And the same claim read off the OTHER end — ids parsed out of the
    // injected text, so neither side is checked against itself.
    expect(memoryPreviewOf(set).entries.map((entry) => entry.id)).toEqual(injectedIds(injected));
    expect(set.automatic.length).toBeGreaterThan(0);
  });

  it('stays equal when nothing is picked and nothing is pointed at', async () => {
    const injected = await injectionOf();
    const set = await previewOf();
    expect(renderMemoryLines(set)).toEqual(injected);
    expect(memoryPreviewOf(set).entries.map((entry) => entry.id)).toEqual(injectedIds(injected));
  });

  it('names where each memory came from, in the four words the screen shows', async () => {
    const preview = memoryPreviewOf(await previewOf({ taskIds: [task], memoryIds: [picked] }));
    const byId = new Map(preview.entries.map((entry) => [entry.id, entry]));
    expect(byId.get(own)?.source).toBe('own');
    expect(byId.get(disputed)).toMatchObject({ source: 'own', marks: ['disputed'] });
    expect(byId.get(verified)).toMatchObject({ source: 'own', marks: ['verified'] });
    expect(byId.get(fromTask)?.source).toBe('task');
    expect(byId.get(learned)?.source).toBe('learned');
    expect(byId.get(picked)).toMatchObject({ source: 'picked', marks: [] });
    // The superseded predecessor is never shown; its chain head takes the place
    // AND the route, so the head reads as the teammate's own.
    expect(byId.has(replaced)).toBe(false);
    expect(byId.get(successor)?.source).toBe('own');
    expect(preview.shown).toBe(preview.entries.length);
  });

  it('shows a picked memory that is superseded WITH its mark, as the launch does', async () => {
    const inputs = { memoryIds: [replaced] };
    const injected = await injectionOf(inputs);
    const set = await previewOf(inputs);
    expect(renderMemoryLines(set)).toEqual(injected);
    // Named by the caller, so it is answered as THAT memory rather than
    // second-guessed into its successor — marked superseded so nobody is
    // misled about which one they picked.
    expect(memoryPreviewOf(set).entries.find((entry) => entry.id === replaced)).toMatchObject({
      source: 'picked',
      marks: ['superseded'],
    });
  });

  it('refuses a memory that cannot be read, in the same words the launch refuses it', async () => {
    const ghost = '00000000-0000-7000-8000-000000000000';
    await expect(previewOf({ memoryIds: [ghost] })).rejects.toThrow(/memoryIds not found/);
    await expect(injectionOf({ memoryIds: [ghost] })).rejects.toThrow(/memoryIds not found/);
  });

  it('refuses a teammate that is not in this space, as the launch would', async () => {
    const stranger = '00000000-0000-7000-8000-0000000000ff';
    await expect(
      graphPort().previewMemories({} as DbClaims, {
        spaceId: fixture.spaceId,
        teamMemberId: stranger,
      }),
    ).rejects.toThrow(/not found in this space/);
  });

  it('writes nothing at all — no session, no edge, no ledger row', async () => {
    const before = await graphFootprint();
    await previewOf({ taskIds: [task], memoryIds: [picked] });
    await previewOf();
    expect(await graphFootprint()).toEqual(before);
  });
});

describe('what did not fit, and how much of the room is used', () => {
  it('stays equal under budget pressure and says how many were left out', async () => {
    // ~600-byte statements overflow the 4,096-byte section while staying under
    // the 512-byte per-entry cap's truncation — the injector suite's own shape.
    // Every entry is clipped to 240 characters before the budget counts it, so
    // the overflow has to come from the NUMBER of memories, not the size of
    // one: ~285 bytes each against 4,096 means fourteen fit and the rest do not.
    const filler = 'x'.repeat(600);
    for (let i = 0; i < 30; i += 1) {
      const id = await mintMemory(`${String(i)}-${filler}`);
      await drawEdge(fixture.teamMemberId, id, 'remembers');
    }
    const injected = await injectionOf();
    const set = await previewOf();
    expect(renderMemoryLines(set)).toEqual(injected);

    const preview = memoryPreviewOf(set);
    expect(preview.omitted).toBeGreaterThan(0);
    // The agent is TOLD what it did not get; the preview says the same number.
    expect(injected.at(-1)).toMatch(new RegExp(`^\\[${String(preview.omitted)} further memor`));
    expect(set.usedBytes).toBeLessThanOrEqual(set.budgetBytes);
    expect(preview.roomUsedPercent).toBeGreaterThan(50);
    expect(preview.roomUsedPercent).toBeLessThanOrEqual(100);
    expect(preview.shown).toBe(preview.entries.length);
  });

  it('a picked memory is handed over even with no room left, and the room says so', async () => {
    const named = await mintMemory('named by hand although the room is full');
    const inputs = { memoryIds: [named] };
    const injected = await injectionOf(inputs);
    const set = await previewOf(inputs);
    expect(renderMemoryLines(set)).toEqual(injected);

    const preview = memoryPreviewOf(set);
    expect(preview.entries.find((entry) => entry.id === named)?.source).toBe('picked');
    // Picks are exempt from the budget, so the room can go past the line —
    // and a percentage that stopped at 100 would hide exactly that.
    expect(preview.roomUsedPercent).toBeGreaterThan(90);
  });
});

describe('a teammate with nothing to hand over', () => {
  it('answers an empty hand-off rather than pretending it could not look', async () => {
    const bare = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'team_member',null,9,$3)`,
        [id, fixture.spaceId, fixture.memberId],
      );
      await client.query(
        `insert into public.team_members(entity_id,owner_member_id,name,role,identity,memories)
         values($1,$2,'Brand new','','persona text','[]'::jsonb)`,
        [id, fixture.memberId],
      );
      return id;
    });

    const set = await graphPort().previewMemories({} as DbClaims, {
      spaceId: fixture.spaceId,
      teamMemberId: bare,
    });
    const preview = memoryPreviewOf(set);
    expect(preview).toEqual({ entries: [], shown: 0, omitted: 0, roomUsedPercent: 0 });
    expect(renderMemoryLines(set)).toEqual([]);
  });
});
