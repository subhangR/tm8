/**
 * Loops PR1 (design of record 01a182d5 §4): the definition and control ops over
 * authenticated HTTP, against a scratch database with every migration applied.
 *
 * What these pin that a "returned 200" check would miss: nextRunAt is the
 * server's (create, schedule change, enable recompute from now; disable keeps),
 * a client nextRunAt on entities.create is ignored, invalid schedules, zones and
 * config keys are refused with a field path, and the view parses as LoopView.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoopViewSchema } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2EntitiesCommandsTrackingHandlers } from '../../src/facade/handlers/w2/entities-commands-tracking.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerLoopHandlers } from '../../src/loops/handlers.js';
import { registerLoopRunHandlers } from '../../src/loops/run-handlers.js';
import { nextRunAt } from '../../src/scheduler/schedule.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), authSession = randomUUID(), persona = randomUUID();
const otherSpace = randomUUID(), writeTool = randomUUID(), goneTool = randomUUID();
const identityId = 'loops-http-owner', secret = generateSecret(), token = formatToken(authSession, secret);
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });

beforeAll(async () => {
  database = await createW1ScratchDatabase('loops_ops');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identityId]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identityId]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Loops fixture',$2),($3,'Elsewhere',$2)", [space, identityId, otherSpace]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3)", [member, space, identityId]);
    await c.query("insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values($1,$2,'cli',$3,$4,now()+interval '1 hour')", [authSession, account, space, hashToken(secret)]);
    await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Sweeper','','persona')", [persona, member]);
    // A tool that reaches tm8, so a loop running it needs a persona (coordinator ruling, §2.1).
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'tool',0,$3)", [writeTool, space, member]);
    await c.query("insert into public.tools(entity_id,space_id,title,definition) values($1,$2,'probe',$3)", [writeTool, space,
      { name: 'probe', description: 'Probe', help: '', runtime: 'bash', source: 'exit 0', inputs: [], tm8Access: 'write', timeoutSeconds: 60 }]);
    // A tool one case deletes after a loop is configured to run it.
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'tool',0,$3)", [goneTool, space, member]);
    await c.query("insert into public.tools(entity_id,space_id,title,definition) values($1,$2,'gone-probe',$3)", [goneTool, space,
      { name: 'gone-probe', description: 'Probe', help: '', runtime: 'bash', source: 'exit 0', inputs: [], tm8Access: 'none', timeoutSeconds: 60 }]);
  });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  const deps = { db, config, owner };
  registerLoopHandlers(registry, deps);
  registerLoopRunHandlers(registry, deps);
  registerW2EntitiesCommandsTrackingHandlers(registry, deps);
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function request(method: string, path: string, body?: Record<string, unknown>) {
  // Reads that carry a body (schedule preview) take no mutation id.
  const payload = body === undefined ? undefined : path.endsWith('/schedule-preview') ? body : { clientMutationId: randomUUID(), ...body };
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, json: await response.json() };
}
const ok = (result: { status: number; json: any }) => {
  expect([200, 201], JSON.stringify(result.json)).toContain(result.status);
  return result.json.data;
};
const refused = (result: { status: number; json: any }, status: number, code: string) => {
  expect(result.status, JSON.stringify(result.json)).toBe(status);
  expect(result.json.error.code).toBe(code);
  return result.json.error;
};
const create = (definition: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  request('POST', `/v2/spaces/${space}/loops`, { definition, ...extra });
const spawnLoop = (title: string, extra: Record<string, unknown> = {}) =>
  create({ title, schedule: '0 9 * * *', action: 'spawn', teamMemberId: persona, timezone: 'Europe/London', ...extra });
/** A stored state no door would write today (a value that predates validation, a run's failure); the version is untouched. */
async function rawLoopUpdate(loopId: string, assignments: string) {
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('alter table public.loops disable trigger loops_w2_snapshot_version');
    await c.query(`update public.loops set ${assignments} where entity_id = $1`, [loopId]);
    await c.query('alter table public.loops enable trigger loops_w2_snapshot_version');
  });
}

describe('loops.schedule.preview', () => {
  it('summarises a valid schedule with the next instants', () => {
    return request('POST', `/v2/spaces/${space}/loops/schedule-preview`, { schedule: '30 8 * * 1-5', timezone: 'UTC', count: 3 })
      .then(result => {
        const preview = ok(result);
        expect(preview).toMatchObject({ valid: true, problem: null, summary: 'Weekdays at 08:30 UTC' });
        expect(preview.next).toHaveLength(3);
      });
  });
  it('reports an invalid schedule or zone without refusing the request', async () => {
    expect(ok(await request('POST', `/v2/spaces/${space}/loops/schedule-preview`, { schedule: 'every 0m' })).valid).toBe(false);
    expect(ok(await request('POST', `/v2/spaces/${space}/loops/schedule-preview`, { schedule: '0 9 * * *', timezone: 'Mars/Olympus' })).problem).toMatch(/timezone/);
  });
  it('is refused outside a member space', async () => {
    refused(await request('POST', `/v2/spaces/${otherSpace}/loops/schedule-preview`, { schedule: 'every 1h' }), 403, 'forbidden');
  });
});

describe('loops.create / get / list', () => {
  it('creates a spawn loop whose nextRunAt the server computed in the loop timezone', async () => {
    const before = new Date();
    const view = LoopViewSchema.parse(ok(await spawnLoop('Morning sweep', { prompt: 'sweep', config: { model: 'claude-opus-5-5' } })));
    expect(view.definition).toMatchObject({ action: 'spawn', timezone: 'Europe/London', teamMemberId: persona,
      concurrency: 'skip', retry: { attempts: 0, delaySeconds: 300 }, config: { model: 'claude-opus-5-5' } });
    expect(view.state.nextRunAt).toBe(nextRunAt('0 9 * * *', before, 'Europe/London')!.toISOString());
    expect(view.schedule.summary).toBe('Every day at 09:00 Europe/London');
    expect(view.schedule.next).toHaveLength(5);
    // A human (cli) bearer arms the loop (343) and the next firing runs as them.
    expect(view.state.armedBy?.id).toBe(member);
    expect(view.state.armedAt).not.toBeNull();
    expect(view.state.actingAs).toMatchObject({ via: 'armer', identity: { id: member } });
    expect(view.capabilities).toEqual({ canEdit: true, canControl: true, canRun: true, canDelete: true });
    expect(view.runs).toMatchObject({ total: 0, last: null });
  });

  it('refuses a bad schedule, an unknown zone, an unknown config key and a runner mismatch', async () => {
    expect(refused(await spawnLoop('Bad', { schedule: '61 * * * *' }), 400, 'invalid_input').message).toMatch(/^schedule:/);
    expect(refused(await spawnLoop('Bad', { timezone: 'Mars/Olympus' }), 400, 'invalid_input').message).toMatch(/^timezone:/);
    // Unknown spawn-config keys are refused at the body boundary (LoopSpawnConfigSchema is strict).
    expect(JSON.stringify(refused(await spawnLoop('Bad', { config: { shell: 'rm -rf' } }), 400, 'invalid_input').details))
      .toMatch(/"definition","config"/);
    refused(await create({ title: 'No runner', schedule: 'every 1h', action: 'spawn' }), 400, 'invalid_input');
    refused(await create({ title: 'No tool', schedule: 'every 1h', action: 'tool' }), 400, 'invalid_input');
  });

  it('accepts an IANA zone the CLDR list leaves out (Asia/Kolkata)', async () => {
    const before = new Date();
    const view = ok(await spawnLoop('Kolkata', { timezone: 'Asia/Kolkata' }));
    expect(view.definition.timezone).toBe('Asia/Kolkata');
    expect(view.state.nextRunAt).toBe(nextRunAt('0 9 * * *', before, 'Asia/Kolkata')!.toISOString());
  });

  it('records a schedule that never matches on create instead of parking it silently', async () => {
    const view = ok(await create({ title: 'Feb 30', schedule: '0 0 30 2 *', action: 'dispatch' }));
    expect(view.state).toMatchObject({ enabled: true, nextRunAt: null, lastError: 'schedule never matches within a year' });
  });

  it('a disabled create stores no deadline', async () => {
    const view = ok(await spawnLoop('Parked', {}, ));
    const disabled = ok(await create({ title: 'Off', schedule: 'every 1h', action: 'dispatch' }, { enabled: false }));
    expect(view.state.nextRunAt).not.toBeNull();
    expect(disabled.state).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('lists with filters and a cursor, without per-row cron stepping', async () => {
    ok(await create({ title: 'Routed hourly', schedule: 'every 1h', action: 'dispatch' }));
    const all = ok(await request('GET', `/v2/spaces/${space}/loops?action=spawn&limit=1`));
    expect(all.items).toHaveLength(1);
    expect(all.items[0].definition.action).toBe('spawn');
    expect(all.items[0].schedule.next).toEqual([]);
    expect(all.nextCursor).not.toBeNull();
    const next = ok(await request('GET', `/v2/spaces/${space}/loops?action=spawn&limit=1&cursor=${encodeURIComponent(all.nextCursor)}`));
    expect(next.items[0].id).not.toBe(all.items[0].id);
    refused(await request('GET', `/v2/spaces/${space}/loops?action=spawn&limit=1&cursor=${encodeURIComponent(all.nextCursor)}&words=x`), 400, 'invalid_cursor');
    const dispatch = ok(await request('GET', `/v2/spaces/${space}/loops?action=dispatch&enabled=true`));
    expect(dispatch.items.every((item: any) => item.definition.action === 'dispatch' && item.state.enabled)).toBe(true);
  });
});

describe('loops.update and the control ops', () => {
  it('a schedule change recomputes from now; a stale version is a conflict', async () => {
    const view = ok(await spawnLoop('Editable'));
    const updated = ok(await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: view.version, definition: { schedule: 'every 2h', prompt: 'new' } }));
    const due = new Date(updated.state.nextRunAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(2 * 60 * 60_000 - 60_000);
    expect(due).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(updated.version).toBeGreaterThan(view.version);
    expect(updated.definition.prompt).toBe('new');
    refused(await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: view.version, definition: { prompt: 'late' } }), 409, 'version_conflict');
    // A patch that clears the runner of a spawn loop is refused by the door.
    refused(await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: updated.version, definition: { teamMemberId: null } }), 400, 'invalid_input');
  });

  it('disable keeps the deadline; enable recomputes it from now', async () => {
    const view = ok(await create({ title: 'Toggle', schedule: 'every 1d', action: 'dispatch' }));
    const off = ok(await request('POST', `/v2/loops/${view.id}/disable`, { expectedVersion: view.version }));
    expect(off.state).toMatchObject({ enabled: false, nextRunAt: view.state.nextRunAt });
    // Pretend the stored deadline went stale while disabled.
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('alter table public.loops disable trigger loops_w2_snapshot_version');
      await c.query("update public.loops set next_run_at = now() - interval '7 days' where entity_id = $1", [view.id]);
      await c.query('alter table public.loops enable trigger loops_w2_snapshot_version');
    });
    const on = ok(await request('POST', `/v2/loops/${view.id}/enable`, { expectedVersion: off.version }));
    expect(on.state.enabled).toBe(true);
    expect(new Date(on.state.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
  });

  it('a schedule change on a DISABLED loop still moves nextRunAt (lead ruling: show/list stay honest)', async () => {
    const view = ok(await spawnLoop('Disabled edit'));
    const off = ok(await request('POST', `/v2/loops/${view.id}/disable`, { expectedVersion: view.version }));
    const edited = ok(await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: off.version, definition: { schedule: 'every 6h' } }));
    expect(edited.state.enabled).toBe(false);
    expect(edited.state.nextRunAt).not.toBe(view.state.nextRunAt);
    const due = new Date(edited.state.nextRunAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(6 * 60 * 60_000 - 60_000);
    expect(due).toBeLessThanOrEqual(6 * 60 * 60_000);
  });

  it("fixing a parked loop's schedule clears its reason; a run's failure survives a schedule edit", async () => {
    const parked = ok(await create({ title: 'Parked', schedule: '0 0 30 2 *', action: 'dispatch' }));
    const fixed = ok(await request('PATCH', `/v2/loops/${parked.id}`, { expectedVersion: parked.version, definition: { schedule: 'every 1h' } }));
    expect(fixed.state.nextRunAt).not.toBeNull();
    expect(fixed.state.lastError).toBeNull();

    const failing = ok(await create({ title: 'Failing', schedule: 'every 1h', action: 'dispatch' }));
    await rawLoopUpdate(failing.id, "last_error = 'spawn refused: capacity'");
    const edited = ok(await request('PATCH', `/v2/loops/${failing.id}`, { expectedVersion: failing.version, definition: { schedule: 'every 2h' } }));
    expect(edited.state.lastError).toBe('spawn refused: capacity');
  });

  it('a stored schedule that predates validation blocks neither a rename nor a disable; enabling it is a 400', async () => {
    const view = ok(await create({ title: 'Legacy', schedule: 'every 1h', action: 'dispatch' }));
    await rawLoopUpdate(view.id, "schedule = 'sometimes'");
    const renamed = ok(await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: view.version, definition: { title: 'Legacy, renamed' } }));
    const off = ok(await request('POST', `/v2/loops/${view.id}/disable`, { expectedVersion: renamed.version }));
    expect(off.state.enabled).toBe(false);
    expect(refused(await request('POST', `/v2/loops/${view.id}/enable`, { expectedVersion: off.version }), 400, 'invalid_input').message)
      .toMatch(/^schedule:/);
  });

  it('a tool deleted after the loop was configured blocks nothing: rename, disable and the executor bookkeeping still write (review B2)', async () => {
    const view = ok(await create({ title: 'Probe hourly', schedule: 'every 1h', action: 'tool', toolId: goneTool }));
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query('update public.entities set deleted_at = now() where id = $1', [goneTool]);
    });
    const renamed = ok(await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: view.version, definition: { title: 'Probe, renamed' } }));
    const off = ok(await request('POST', `/v2/loops/${view.id}/disable`, { expectedVersion: renamed.version }));
    expect(off.state.enabled).toBe(false);
    // The executor's bookkeeping write (jobs/loops.ts recordRun): no version, a new deadline.
    await database.transaction(async c => {
      await c.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [identityId]);
      await c.query("select public.update_loop($1::uuid, null, null, p_next_run_at => now() + interval '3 hours')", [view.id]);
    });
    const after = ok(await request('GET', `/v2/loops/${view.id}`));
    expect(new Date(after.state.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 2 * 60 * 60_000);
    // Naming the runner again IS judged: the deleted tool cannot be re-pointed to.
    const repoint = await request('PATCH', `/v2/loops/${view.id}`, { expectedVersion: after.version, definition: { toolId: goneTool } });
    expect(repoint.status, JSON.stringify(repoint.json)).toBeGreaterThanOrEqual(400);
  });

  it('a dispatch loop names no runner; a tool loop becomes a dispatch loop only by clearing its tool and runner (review 3)', async () => {
    refused(await create({ title: 'Routed with a runner', schedule: 'every 1h', action: 'dispatch', teamMemberId: persona }), 400, 'invalid_input');
    const tool = ok(await create({ title: 'Probe as persona', schedule: 'every 1h', action: 'tool', toolId: writeTool, teamMemberId: persona }));
    refused(await request('PATCH', `/v2/loops/${tool.id}`, { expectedVersion: tool.version, definition: { action: 'dispatch' } }), 400, 'invalid_input');
    const routed = ok(await request('PATCH', `/v2/loops/${tool.id}`, { expectedVersion: tool.version,
      definition: { action: 'dispatch', toolId: null, teamMemberId: null } }));
    expect(routed.definition).toMatchObject({ action: 'dispatch', toolId: null, teamMemberId: null });
  });

  it('pause until a future instant, refuse a past one, resume clears it', async () => {
    const view = ok(await create({ title: 'Pausable', schedule: 'every 1h', action: 'dispatch' }));
    refused(await request('POST', `/v2/loops/${view.id}/pause`, { expectedVersion: view.version, until: '2001-01-01T00:00:00Z' }), 400, 'invalid_input');
    const until = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    const paused = ok(await request('POST', `/v2/loops/${view.id}/pause`, { expectedVersion: view.version, until }));
    expect(paused.state.pausedUntil).toBe(until);
    expect(paused.state.nextRunAt).toBe(view.state.nextRunAt);
    // Pause is bookkeeping: the armer stands.
    expect(paused.state.armedBy?.id).toBe(member);
    const resumed = ok(await request('POST', `/v2/loops/${view.id}/resume`, { expectedVersion: paused.version }));
    expect(resumed.state.pausedUntil).toBeNull();
  });

  it('without an execution runtime Run now is an honest 501; the runs projection still reads', async () => {
    const view = ok(await create({ title: 'Later', schedule: 'every 1h', action: 'dispatch' }));
    refused(await request('POST', `/v2/loops/${view.id}/run`, {}), 501, 'not_implemented');
    expect(ok(await request('GET', `/v2/loops/${view.id}/runs`)).items).toEqual([]);
  });
});

describe('entities.* loop arm', () => {
  it('computes nextRunAt itself and ignores a client value', async () => {
    const before = new Date();
    const result = ok(await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Old UI loop',
      content: { schedule: '0 6 * * *', teamMemberId: persona, nextRunAt: '2001-01-01T00:00:00.000Z' } }));
    const id = result.entity.id;
    const view = ok(await request('GET', `/v2/loops/${id}`));
    expect(view.definition.action).toBe('spawn');
    expect(view.state.nextRunAt).toBe(nextRunAt('0 6 * * *', before, 'UTC')!.toISOString());
  });

  it('refuses an invalid schedule (assertValidSchedule on every write)', async () => {
    refused(await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Broken', content: { schedule: 'sometimes' } }), 400, 'invalid_input');
  });

  it('refuses a member with the wrong type instead of letting Postgres coerce it (review 4)', async () => {
    const view = ok(await create({ title: 'Typed', schedule: 'every 1h', action: 'dispatch' }, { enabled: false }));
    for (const content of [{ schedule: 15 }, { enabled: 'true' }, { teamMemberId: 5 }, { prompt: 7 }]) {
      const error = refused(await request('PATCH', `/v2/entities/${view.id}`, { expectedVersion: view.version, content }), 400, 'invalid_input');
      expect(error.message).toMatch(new RegExp(`^content\\.${Object.keys(content)[0]}`));
    }
    expect(ok(await request('GET', `/v2/loops/${view.id}`)).state).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("keeps 091's meaning: clearing a spawn loop's runner routes it to the dispatcher", async () => {
    const id = ok(await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Old UI spawn',
      content: { schedule: 'every 1h', teamMemberId: persona } })).entity.id;
    const spawn = ok(await request('GET', `/v2/loops/${id}`));
    expect(spawn.definition.action).toBe('spawn');
    ok(await request('PATCH', `/v2/entities/${id}`, { expectedVersion: spawn.version, content: { teamMemberId: null } }));
    expect(ok(await request('GET', `/v2/loops/${id}`)).definition).toMatchObject({ action: 'dispatch', teamMemberId: null });
  });

  it("honours the loop panel's Run now (a nextRunAt of now) and ignores a later client value", async () => {
    const view = ok(await create({ title: 'Run me', schedule: 'every 1d', action: 'dispatch' }));
    ok(await request('PATCH', `/v2/entities/${view.id}`, { expectedVersion: view.version, content: { nextRunAt: new Date().toISOString() } }));
    const due = ok(await request('GET', `/v2/loops/${view.id}`));
    expect(new Date(due.state.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now());
    ok(await request('PATCH', `/v2/entities/${view.id}`, { expectedVersion: due.version, content: { nextRunAt: '2099-01-01T00:00:00.000Z' } }));
    expect(ok(await request('GET', `/v2/loops/${view.id}`)).state.nextRunAt).toBe(due.state.nextRunAt);
  });

  it('applies the tool persona rule loops.create applies', async () => {
    const tool = { schedule: 'every 1h', action: 'tool', toolId: writeTool };
    expect(refused(await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Tool, no persona', content: tool }),
      400, 'invalid_input').message).toMatch(/^definition\.teamMemberId/);
    const id = ok(await request('POST', '/v2/entities', { spaceId: space, kind: 'loop', title: 'Tool, persona',
      content: { ...tool, teamMemberId: persona } })).entity.id;
    const view = ok(await request('GET', `/v2/loops/${id}`));
    refused(await request('PATCH', `/v2/entities/${id}`, { expectedVersion: view.version, content: { teamMemberId: null } }), 400, 'invalid_input');
  });
});
