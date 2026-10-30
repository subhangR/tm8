/**
 * 398 — the boot of a launch, recorded on its row.
 *
 * The state machine, against a real PostgreSQL, through the doors the server
 * really uses: `work_session_transition` as `tm8_app` with a member's claims,
 * and a raw resurrection the way `execution_resume` writes one.
 *
 *   admitted → lane → briefing → agent → live   forward only, steps skippable
 *   admitted | lane | briefing | agent → failed
 *   any → admitted                              a resume reboots the row
 *
 * and the two rules that make it trustworthy: a status change derives the
 * phase IN THE SAME WRITE (so `status` and `boot_phase` never disagree), and
 * nothing but the transition function may report a phase.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const IDENTITY = 'boot-phase-owner';
let database: W1ScratchDatabase;
let spaceId: string;
let memberId: string;
/** A session that existed before 398 was applied. */
let olderSessionId: string;

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** The transition door as the server calls it: `tm8_app`, a member's claims. */
async function transition(
  sessionId: string,
  status: string,
  opts: { error?: string; endedReason?: string; bootPhase?: string } = {},
): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-boot-phase',true)`,
      [IDENTITY],
    );
    await client.query(
      `select public.work_session_transition($1,$2,null,$3,null,null,null,$4,$5)`,
      [sessionId, status, opts.error ?? null, opts.endedReason ?? null, opts.bootPhase ?? null],
    );
  });
}

/**
 * A SHELL session: born `spawning` like every session, and minted with no
 * credential to record (273), so it may go `running` without the agent-only
 * binding a fixture would otherwise have to fake. The machine is the same for
 * every kind.
 */
async function newSession(c: Client): Promise<string> {
  const id = (await c.query<{ id: string }>(
    `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
     values(internal.new_id(),$1,'work_session',null,9,$2) returning id::text`,
    [spaceId, memberId],
  )).rows[0]!.id;
  await c.query(
    `insert into public.work_sessions(entity_id,title,node_id,workdir_mode,status,session_kind)
     values($1,'boot','node-1','scratch','spawning','shell')`,
    [id],
  );
  return id;
}

interface BootRow {
  status: string;
  boot_phase: string | null;
  boot_phase_at: Date | null;
  ended_reason: string | null;
  version: number;
}

async function rowOf(sessionId: string): Promise<BootRow> {
  return asOwner(async (c) => (await c.query<BootRow>(
    `select ws.status, ws.boot_phase, ws.boot_phase_at, ws.ended_reason, e.version
       from public.work_sessions ws join public.entities e on e.id = ws.entity_id
      where ws.entity_id = $1`,
    [sessionId],
  )).rows[0]!);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('boot_phase');
  const files = migrationFiles();
  const at = files.findIndex((file) => file.startsWith('398_'));
  database.apply(files.slice(0, at));
  // A space, a member, and one session from before boot phases existed.
  ({ spaceId, memberId, olderSessionId } = await asOwner(async (c) => {
    const ids = (await c.query<{ spaceId: string; memberId: string }>(
      `select internal.new_id()::text "spaceId", internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await c.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Boot owner')`, [IDENTITY]);
    await c.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Boots',$2)`, [ids.spaceId, IDENTITY]);
    await c.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values($1,$2,'member',null,0,$1)`,
      [ids.memberId, ids.spaceId],
    );
    await c.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Boot owner')`,
      [ids.memberId, ids.spaceId, IDENTITY],
    );
    spaceId = ids.spaceId;
    memberId = ids.memberId;
    return { ...ids, olderSessionId: await newSession(c) };
  }));
  database.apply(files.slice(at));
});

afterAll(async () => {
  await database?.destroy();
});

describe('398 — boot_phase', () => {
  it('leaves a row from before 398 with no phase, and gives every new row `admitted`', async () => {
    expect(await rowOf(olderSessionId)).toMatchObject({ boot_phase: null, boot_phase_at: null });

    const id = await asOwner(newSession);
    const row = await rowOf(id);
    expect(row.boot_phase).toBe('admitted');
    expect(row.boot_phase_at).toBeInstanceOf(Date);
  });

  it('moves forward through the reported steps, and `running` makes it live in the same write', async () => {
    const id = await asOwner(newSession);
    const admittedVersion = (await rowOf(id)).version;
    const upserts = async (): Promise<number> => asOwner(async (c) => Number((await c.query<{ n: string }>(
      `select count(*) n from public.workspace_events where event_type = 'entity.upsert' and payload->>'id' = $1`,
      [id],
    )).rows[0]!.n));
    const before = await upserts();
    const seen: string[] = [];
    for (const phase of ['lane', 'briefing', 'agent']) {
      await transition(id, 'spawning', { bootPhase: phase });
      const row = await rowOf(id);
      seen.push(row.boot_phase ?? '');
      expect(row.status).toBe('spawning');
    }
    expect(seen).toEqual(['lane', 'briefing', 'agent']);
    // A progress report is not an edit: the version a caller holds from the
    // admitted answer still writes, and recency feeds do not move...
    expect((await rowOf(id)).version).toBe(admittedVersion);
    // ...yet each one reaches the live socket as an `entity.upsert`.
    expect(await upserts()).toBe(before + 3);

    await transition(id, 'running');
    expect(await rowOf(id)).toMatchObject({ status: 'running', boot_phase: 'live' });
    // A status move is an edit, as it always was.
    expect((await rowOf(id)).version).toBeGreaterThan(admittedVersion);

    // The boot it describes succeeded; the run ending later leaves it alone.
    await transition(id, 'exited');
    expect(await rowOf(id)).toMatchObject({ status: 'exited', boot_phase: 'live' });
  });

  it('a step may be skipped, never repeated backwards', async () => {
    const id = await asOwner(newSession);
    await transition(id, 'spawning', { bootPhase: 'briefing' });
    await expect(transition(id, 'spawning', { bootPhase: 'lane' })).rejects.toMatchObject({ code: '23514' });
    // Reporting the phase it is already in is not a move.
    await transition(id, 'spawning', { bootPhase: 'briefing' });
    expect((await rowOf(id)).boot_phase).toBe('briefing');
  });

  it('a boot that fails is failed in the very write that records it', async () => {
    const id = await asOwner(newSession);
    await transition(id, 'spawning', { bootPhase: 'lane' });
    await transition(id, 'failed', { error: 'agent CLI not found', endedReason: 'Failed to launch: agent CLI not found' });

    expect(await rowOf(id)).toMatchObject({
      status: 'failed',
      boot_phase: 'failed',
      ended_reason: 'Failed to launch: agent CLI not found',
    });
  });

  it('refuses a report after the boot ended — which is how a boot learns its session was stopped', async () => {
    const id = await asOwner(newSession);
    await transition(id, 'exited', { endedReason: 'Stopped by request.' });
    expect((await rowOf(id)).boot_phase).toBe('failed');
    await expect(transition(id, 'spawning', { bootPhase: 'briefing' })).rejects.toMatchObject({ code: '23514' });

    const running = await asOwner(newSession);
    await transition(running, 'running');
    await expect(transition(running, 'running', { bootPhase: 'agent' })).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a reported phase alongside a status change, and a terminal phase reported at all', async () => {
    const id = await asOwner(newSession);
    await expect(transition(id, 'running', { bootPhase: 'agent' })).rejects.toMatchObject({ code: '22023' });
    await expect(transition(id, 'spawning', { bootPhase: 'live' })).rejects.toMatchObject({ code: '22023' });
    await expect(transition(id, 'spawning', { bootPhase: 'failed' })).rejects.toMatchObject({ code: '22023' });
  });

  it('a resurrected row (resume) boots again from `admitted`', async () => {
    const id = await asOwner(newSession);
    await transition(id, 'failed', { error: 'boom' });
    await asOwner(async (c) => {
      // The shape of `execution_resume`'s own write: it holds the status flag.
      await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
      await c.query(`update public.work_sessions set status = 'spawning' where entity_id = $1`, [id]);
    });
    expect((await rowOf(id)).boot_phase).toBe('admitted');
    await transition(id, 'spawning', { bootPhase: 'agent' });
    await transition(id, 'running');
    expect((await rowOf(id)).boot_phase).toBe('live');
  });

  it('has a single writer: no other path may report a phase', async () => {
    const id = await asOwner(newSession);
    await expect(asOwner((c) =>
      c.query(`update public.work_sessions set boot_phase = 'lane' where entity_id = $1`, [id]),
    )).rejects.toMatchObject({ code: '23514' });
  });
});
