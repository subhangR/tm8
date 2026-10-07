/**
 * Server-side Workspaces against a REAL database (Spec D, migration 305):
 * the shared reducer applied on the node, compare-and-swap rows, drafts with
 * per-field last-writer-wins, the pending interaction only a window may
 * answer, the one-time import, the bounds, and privacy — another member of
 * the same space never reads the row or receives a frame.
 *
 * Migration 310 (multiple workspaces): the lazy "Main" + active pointer of an
 * identity's first write (S12), and the backfill of a seeded 305-era database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_COLORS, WORKSPACES_PER_IDENTITY_CAP } from '@tm8/contract';

import type { DbClaims } from '../../src/db/types.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../events/pg-harness.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

const url = TEST_DATABASE_URL;
const describeIfPg = url === undefined ? describe.skip : describe;

interface Frame { type: string; [key: string]: unknown }

describeIfPg('stored workspaces over real Postgres (Spec D)', () => {
  let db: TestDb;
  let service: WorkspaceService;
  let spaceId: string;
  let taskId: string;
  const alice = `identity_${randomUUID()}`;
  const bob = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const aliceFrames: Frame[] = [];
  const bobFrames: Frame[] = [];
  const claims = (identityId: string): DbClaims => ({ identityId, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  const window = (id: string, frames: Frame[]) => ({ id, isOpen: true, send: (t: string) => void frames.push(JSON.parse(t) as Frame) });

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: alice }, 'public.upsert_user_profile', ['Alice', null, null]);
    await db.rpc({ identityId: bob }, 'public.upsert_user_profile', ['Bob', null, null]);
    const created = await db.rpc<{ space: { id: string } }>({ identityId: alice }, 'public.create_space', [
      'Stored workspaces', 'spec d proof', 'private', null, null,
    ]);
    spaceId = created.space.id;
    const aliceMember = (await db.query<{ entity_id: string }>(
      { identityId: alice }, 'select entity_id from public.members where space_id = $1 and identity_id = $2', [spaceId, alice],
    ))[0]!.entity_id;
    // Bob joins the same space as a plain member (fixture insert, as the owner).
    const bobMember = randomUUID();
    await db.asOwner(async (q) => {
      await q.query(`insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'member', $1)`, [bobMember, spaceId]);
      await q.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', 'Bob')`,
        [bobMember, spaceId, bob],
      );
    });
    const task = await db.rpc<{ entity: { id: string } }>(claims(alice), 'public.create_task', [
      spaceId, 'Checkout review', aliceMember, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ]);
    taskId = task.entity.id;
    service = new WorkspaceService({ db, bridge });
    const reg = (instanceId: string) => ({
      type: 'workspace.register' as const, spaceId, instanceId, windowId: instanceId, focused: true, visible: true, view: 'tabs', mounted: true, revision: 0,
    });
    bridge.register(window('a-conn', aliceFrames), alice, aliceMember, reg('alice-win'));
    bridge.register(window('b-conn', bobFrames), bob, bobMember, reg('bob-win'));
  });

  afterAll(async () => {
    await db?.end();
  });

  it('an empty workspace reads as the default, revision 0', async () => {
    const got = await service.get(claims(alice), spaceId);
    expect(got.revision).toBe(0);
    expect(got.state['orderedTabIds']).toEqual([]);
    expect(got.windows).toBe(1);
  });

  it('an agent opens a tab with no window involved; only the owner’s windows hear about it', async () => {
    const result = await service.apply(claims(alice), spaceId, {
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: taskId, activate: false }, source: 'remote' },
      requestId: 'r1',
      origin: { kind: 'http' },
    });
    expect(result).toMatchObject({ status: 'applied', outcome: 'created', revision: 1 });
    const got = await service.get(claims(alice), spaceId);
    expect(got.revision).toBe(1);
    expect(Object.values(got.state['tabs'] as Record<string, { entityId?: string }>).map((t) => t.entityId)).toEqual([taskId]);
    expect(aliceFrames.filter((f) => f.type === 'workspace.state').at(-1)).toMatchObject({ revision: 1, spaceId });
    expect(bobFrames).toEqual([]);
  });

  it('refuses to open what does not exist, without saying more', async () => {
    const result = await service.apply(claims(alice), spaceId, {
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: randomUUID() }, source: 'remote' },
      requestId: 'r2',
      origin: { kind: 'http' },
    });
    expect(result).toMatchObject({ status: 'rejected', reason: 'entity_unavailable' });
  });

  it('another member of the same space has their own workspace and cannot read Alice’s row', async () => {
    expect((await service.get(claims(bob), spaceId)).revision).toBe(0);
    const rows = await db.tx(claims(bob), async (q) => {
      await q.query('set local role tm8_app');
      return q.query('select identity_id from public.workspaces where space_id = $1', [spaceId]);
    });
    expect(rows).toEqual([]);
    const theirs = await db.tx(claims(alice), async (q) => {
      await q.query('set local role tm8_app');
      return q.query<{ identity_id: string }>('select identity_id from public.workspaces where space_id = $1', [spaceId]);
    });
    expect(theirs.map((r) => r.identity_id)).toEqual([alice]);
  });

  it('an identity’s first write creates "Main" and its active pointer in one transaction (S12)', async () => {
    const carol = `identity_${randomUUID()}`;
    await db.rpc({ identityId: carol }, 'public.upsert_user_profile', ['Carol', null, null]);
    await db.asOwner(async (q) => {
      const member = randomUUID();
      await q.query(`insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'member', $1)`, [member, spaceId]);
      await q.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', 'Carol')`,
        [member, spaceId, carol],
      );
    });
    const mine = () => db.tx(claims(carol), (q) => q.query<{ workspace_id: string; name: string; active_id: string | null; same_tx: boolean }>(
      `select w.workspace_id, w.name, a.workspace_id as active_id, w.xmin = a.xmin as same_tx
         from public.workspaces w left join public.workspace_active a using (space_id, identity_id)
        where w.space_id = $1`,
      [spaceId],
    ));
    expect(await mine()).toEqual([]);
    const result = await service.apply(claims(carol), spaceId, {
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: taskId, activate: false }, source: 'remote' },
      requestId: 's12',
      origin: { kind: 'http' },
    });
    expect(result).toMatchObject({ status: 'applied', revision: 1 });
    const [row, ...rest] = await mine();
    expect(rest).toEqual([]);
    // Same xmin: the row and its pointer were written by one transaction.
    expect(row).toMatchObject({ name: 'Main', active_id: row!.workspace_id, same_tx: true });
    // A second "first write" is stale, not a second Main.
    await expect(db.tx(claims(carol), (q) => q.query('select public.workspace_save($1, null, 0, 1, $2)', [spaceId, '{}'])))
      .rejects.toMatchObject({ code: '40001' });
  });

  it('a window’s command reproduces the window’s own ids on the node', async () => {
    const tabId = randomUUID();
    const draftId = randomUUID();
    const result = await service.apply(claims(alice), spaceId, {
      env: { command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' },
      ids: [tabId, draftId],
      requestId: 'w1',
      origin: { kind: 'window', instanceId: 'alice-win' },
    });
    expect(result).toMatchObject({ status: 'applied', tabId });
    const pushed = aliceFrames.filter((f) => f.type === 'workspace.state').at(-1)!;
    expect(pushed['cause']).toMatchObject({ instanceId: 'alice-win', requestId: 'w1' });
    const tabs = (pushed['state'] as { tabs: Record<string, { draftId?: string }> }).tabs;
    expect(tabs[tabId]?.draftId).toBe(draftId);
  });

  it('drafts merge per field, last writer wins, and an agent’s write marks the draft dirty', async () => {
    const got = await service.get(claims(alice), spaceId);
    const draft = Object.values(got.state['tabs'] as Record<string, { type: string; draftId?: string; id: string }>).find((t) => t.type === 'draft')!;
    const first = await service.patchDraft(claims(alice), spaceId, draft.draftId!, { title: { v: 'From the window', base: 0 } }, { kind: 'window', instanceId: 'alice-win' });
    expect(first).toMatchObject({ revision: 1, fields: { title: { v: 'From the window', r: 1 } }, overwrote: [] });
    const agent = await service.patchDraft(claims(alice), spaceId, draft.draftId!, { title: { v: 'From an agent', base: 0 } }, { kind: 'http' });
    expect(agent).toMatchObject({ revision: 2, fields: { title: { v: 'From an agent', r: 2 } }, overwrote: ['title'] });
    const after = await service.get(claims(alice), spaceId);
    expect((after.state['tabs'] as Record<string, { dirty?: boolean }>)[draft.id]?.dirty).toBe(true);
    expect(after.drafts).toMatchObject([{ draftId: draft.draftId, revision: 2 }]);
    expect(aliceFrames.some((f) => f.type === 'workspace.draft' && f['draftId'] === draft.draftId)).toBe(true);
  });

  it('a dirty close from an agent becomes a stored prompt only a window can answer', async () => {
    const got = await service.get(claims(alice), spaceId);
    const draft = Object.values(got.state['tabs'] as Record<string, { type: string; id: string; draftId?: string }>).find((t) => t.type === 'draft')!;
    const asked = await service.apply(claims(alice), spaceId, {
      env: { command: 'workspace.tabs.close', args: { tabId: draft.id, discard: true }, source: 'remote' },
      requestId: 'c1',
      origin: { kind: 'http' },
    });
    expect(asked).toMatchObject({ status: 'requires_user_choice', reason: 'unsaved_changes' });
    const interactionId = asked.pendingInteractionId!;
    expect((await service.get(claims(alice), spaceId)).state['pending']).toMatchObject({ id: interactionId });

    const agentAnswer = await service.apply(claims(alice), spaceId, {
      env: { command: 'workspace.interactions.resolve', args: { interactionId, choice: 'discard' }, source: 'remote' },
      requestId: 'c2',
      origin: { kind: 'http' },
    });
    expect(agentAnswer).toMatchObject({ status: 'rejected', reason: 'permission_denied' });

    const human = await service.apply(claims(alice), spaceId, {
      env: { command: 'workspace.interactions.resolve', args: { interactionId, choice: 'discard' }, source: 'click' },
      requestId: 'c3',
      origin: { kind: 'window', instanceId: 'alice-win' },
    });
    expect(human.status).toBe('applied');
    const after = await service.get(claims(alice), spaceId);
    expect(after.state['pending']).toBeUndefined();
    expect(Object.values(after.state['tabs'] as Record<string, { type: string }>).some((t) => t.type === 'draft')).toBe(false);
    expect(after.drafts).toEqual([]);
  });

  it('imports a browser’s legacy state once, and only into an empty workspace', async () => {
    const legacyTab = randomUUID();
    const state = {
      orderedTabIds: [legacyTab],
      tabs: { [legacyTab]: { id: legacyTab, type: 'entity', kind: 'task', entityId: taskId, ui: { subview: 'entity', trail: [{ entityId: taskId, kind: 'task', title: 'A secret title' }] } } },
      scope: { mode: 'byType', selectedTypeIds: ['task'] },
    };
    expect(await service.importLegacy(claims(bob), spaceId, state, [])).toBe(true);
    expect(await service.importLegacy(claims(bob), spaceId, state, [])).toBe(false);
    const got = await service.get(claims(bob), spaceId);
    expect(got.revision).toBe(1);
    expect(got.state['scope']).toEqual({ mode: 'byType', selectedTypeIds: ['task'] });
    expect(JSON.stringify(got.state)).not.toContain('A secret title');
    // Bob's import reached Bob's window, never Alice's.
    expect(bobFrames.some((f) => f.type === 'workspace.state')).toBe(true);
    expect(aliceFrames.filter((f) => f.type === 'workspace.state').every((f) => (f['revision'] as number) !== 1 || f['cause'] === undefined)).toBe(true);
  });

  it('holds the hard tab limit', async () => {
    let last: { status: string; reason?: string } = { status: '' };
    for (let i = 0; i < 52; i += 1) {
      last = await service.apply(claims(alice), spaceId, {
        env: { command: 'workspace.tabs.open', args: { kind: 'doc', entityId: randomUUID(), activate: false }, source: 'click' },
        ids: [randomUUID()],
        requestId: `cap-${i}`,
        origin: { kind: 'window', instanceId: 'alice-win' },
      });
      if (last.status !== 'applied') break;
    }
    expect(last).toMatchObject({ status: 'rejected', reason: 'tab_limit' });
    expect(((await service.get(claims(alice), spaceId)).state['orderedTabIds'] as unknown[]).length).toBe(50);
  });

  it('refuses an oversized row in the database itself', async () => {
    const huge = { blob: 'x'.repeat(140_000) };
    await expect(db.tx(claims(alice), async (q) => {
      await q.query('set local role tm8_app');
      return q.query('select public.workspace_save($1, null, $2, $3, $4)', [spaceId, 0, 1, JSON.stringify(huge)]);
    })).rejects.toMatchObject({ code: '54000' });
  });
});

/**
 * Decision C (build log 01a115d7): no prod copy. A database is migrated to
 * 309, seeded through the 305 writers themselves — several identities across
 * two spaces, a workspace at the 30-draft cap, one at the 128 KB state cap,
 * and a member with no row — and then 310 is applied to it.
 */
describeIfPg('migration 310 backfills a seeded 305-era database', () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 600_000 });
  let scratch: W1ScratchDatabase;
  let sdb: TestDb;
  let s1: string;
  let s2: string;
  const ann = `identity_${randomUUID()}`;
  const ben = `identity_${randomUUID()}`;
  const cy = `identity_${randomUUID()}`;
  const as = (identityId: string): DbClaims => ({ identityId, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  const draftsOf = new Map<string, string[]>();

  async function join(spaceId: string, identityId: string, name: string): Promise<void> {
    await sdb.asOwner(async (q) => {
      const member = randomUUID();
      await q.query(`insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'member', $1)`, [member, spaceId]);
      await q.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $4)`,
        [member, spaceId, identityId, name],
      );
    });
  }

  /** A row through the 305 writer, then `drafts` drafts through the 305 draft writer. */
  async function seed(identityId: string, spaceId: string, state: object, drafts: number): Promise<void> {
    await sdb.rpc(as(identityId), 'public.workspace_save', [spaceId, 0, 1, JSON.stringify(state)]);
    const ids: string[] = [];
    for (let i = 0; i < drafts; i += 1) {
      const draftId = randomUUID();
      await sdb.rpc(as(identityId), 'public.workspace_draft_save', [spaceId, draftId, 'task', 0, JSON.stringify({ title: { v: `d${i}`, r: 1 } })]);
      ids.push(draftId);
    }
    draftsOf.set(`${spaceId}/${identityId}`, ids);
  }

  const workspaceOf = async (spaceId: string, identityId: string) =>
    (await scratch.query<{ workspace_id: string }>(
      'select workspace_id from public.workspaces where space_id = $1 and identity_id = $2',
      [spaceId, identityId],
    )).map((r) => r.workspace_id);

  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('mw310');
    const files = migrationFiles();
    const at = files.indexOf('310_multiple_workspaces.sql');
    expect(at).toBeGreaterThan(0);
    scratch.apply(files.slice(0, at));
    sdb = createTestDb(scratch.url);
    for (const [id, name] of [[ann, 'Ann'], [ben, 'Ben'], [cy, 'Cy']] as const) {
      await sdb.rpc({ identityId: id }, 'public.upsert_user_profile', [name, null, null]);
    }
    s1 = (await sdb.rpc<{ space: { id: string } }>({ identityId: ann }, 'public.create_space', ['One', 'mw310', 'private', null, null])).space.id;
    s2 = (await sdb.rpc<{ space: { id: string } }>({ identityId: ben }, 'public.create_space', ['Two', 'mw310', 'private', null, null])).space.id;
    await join(s1, ben, 'Ben');
    await join(s1, cy, 'Cy');
    await join(s2, ann, 'Ann');

    await seed(ann, s1, { orderedTabIds: [] }, 30);
    await seed(ann, s2, { orderedTabIds: [] }, 2);
    await seed(ben, s2, { orderedTabIds: [] }, 1);
    // At the 128 KB cap exactly: {"pad": "…"} renders as 11 characters plus the padding.
    await seed(ben, s1, { pad: 'x'.repeat(131072 - 11) }, 0);
    const [big] = await scratch.query<{ n: number }>(
      'select octet_length(state::text) as n from public.workspaces where space_id = $1 and identity_id = $2', [s1, ben],
    );
    expect(big!.n).toBe(131072);

    scratch.apply(files.slice(at, at + 1));
  });

  afterAll(async () => {
    await sdb?.end();
    await scratch?.destroy();
  });

  it('turns every row into "Main" with exactly one active pointer, and leaves the row-less member alone', async () => {
    const rows = await scratch.query<{ space_id: string; identity_id: string; name: string; position: number; active: string | null; pointers: number }>(
      `select w.space_id, w.identity_id, w.name, w.position,
              (select a.workspace_id::text from public.workspace_active a
                where a.space_id = w.space_id and a.identity_id = w.identity_id and a.workspace_id = w.workspace_id) as active,
              (select count(*)::int from public.workspace_active a where a.space_id = w.space_id and a.identity_id = w.identity_id) as pointers
         from public.workspaces w where w.space_id in ($1, $2)`,
      [s1, s2],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ name: 'Main', position: 0, pointers: 1, active: expect.any(String) });
    expect(await scratch.query('select 1 from public.workspace_active where space_id in ($1, $2)', [s1, s2])).toHaveLength(4);
    expect(await workspaceOf(s1, cy)).toEqual([]);
    expect(await scratch.query('select 1 from public.workspace_active where identity_id = $1', [cy])).toEqual([]);
  });

  it('gives every draft its row’s workspace_id, the 30 at the cap included', async () => {
    for (const [spaceId, identityId, count] of [[s1, ann, 30], [s2, ann, 2], [s2, ben, 1], [s1, ben, 0]] as const) {
      const [workspaceId] = await workspaceOf(spaceId, identityId);
      const drafts = await scratch.query<{ draft_id: string }>(
        'select draft_id from public.workspace_drafts where workspace_id = $1 order by draft_id', [workspaceId],
      );
      expect(drafts.map((d) => d.draft_id)).toEqual([...draftsOf.get(`${spaceId}/${identityId}`)!].sort());
      expect(drafts).toHaveLength(count);
    }
  });

  it('keys rows, pointers and drafts by workspace_id, and a pointer cannot cross identities', async () => {
    const defs = await scratch.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('public.workspaces'::regclass, 'public.workspace_drafts'::regclass, 'public.workspace_active'::regclass)
          and contype in ('p', 'f')`,
    );
    const def = (name: string) => defs.find((d) => d.conname === name)?.def;
    expect(def('workspaces_pkey')).toBe('PRIMARY KEY (workspace_id)');
    expect(def('workspace_drafts_pkey')).toBe('PRIMARY KEY (workspace_id, draft_id)');
    expect(def('workspace_active_pkey')).toBe('PRIMARY KEY (space_id, identity_id)');
    const [annS1] = await workspaceOf(s1, ann);
    await expect(scratch.query('update public.workspace_active set workspace_id = $1 where space_id = $2 and identity_id = $3', [annS1, s1, ben]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(scratch.query('update public.workspace_drafts set identity_id = $1 where workspace_id = $2', [ben, annS1]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('checks colours against the shared tokens and caps workspaces at the shared limit', async () => {
    const [benS2] = await workspaceOf(s2, ben);
    for (const color of WORKSPACE_COLORS) {
      await scratch.query('update public.workspaces set color = $1 where workspace_id = $2', [color, benS2]);
    }
    await expect(scratch.query(`update public.workspaces set color = 'magenta' where workspace_id = $1`, [benS2]))
      .rejects.toMatchObject({ code: '23514' });
    const insert = (name: string) => scratch.query(
      `insert into public.workspaces(space_id, identity_id, member_id, state, revision, name, position)
       select space_id, identity_id, member_id, '{}'::jsonb, 1, $2, 1 from public.workspaces where workspace_id = $1`,
      [benS2, name],
    );
    // Names are unique per (space, identity), case-insensitively.
    await expect(insert('main')).rejects.toMatchObject({ code: '23505' });
    for (let n = 2; n <= WORKSPACES_PER_IDENTITY_CAP; n += 1) await insert(`Workspace ${n}`);
    await expect(insert('One too many')).rejects.toMatchObject({ code: '53400' });
  });

  it('RLS: another identity reads none of the workspaces, pointers or drafts', async () => {
    const read = (identityId: string, spaceId: string) => sdb.tx(as(identityId), async (q) => ({
      workspaces: (await q.query<{ identity_id: string }>('select identity_id from public.workspaces where space_id = $1', [spaceId])).map((r) => r.identity_id),
      active: (await q.query<{ identity_id: string }>('select identity_id from public.workspace_active where space_id = $1', [spaceId])).map((r) => r.identity_id),
      drafts: (await q.query<{ identity_id: string }>('select identity_id from public.workspace_drafts where space_id = $1', [spaceId])).map((r) => r.identity_id),
    }));
    expect(await read(ben, s1)).toEqual({ workspaces: [ben], active: [ben], drafts: [] });
    expect(await read(ann, s2)).toEqual({ workspaces: [ann], active: [ann], drafts: [ann, ann] });
    expect(await read(cy, s1)).toEqual({ workspaces: [], active: [], drafts: [] });
  });

  it('analyzes the new and re-keyed tables at birth', async () => {
    const rows = await scratch.query<{ relname: string; reltuples: number }>(
      `select relname, reltuples from pg_class
        where oid in ('public.workspaces'::regclass, 'public.workspace_drafts'::regclass, 'public.workspace_active'::regclass)`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Number(row.reltuples), row.relname).toBeGreaterThanOrEqual(0);
  });

  it('cascades a workspace’s drafts and its pointer when it is deleted', async () => {
    const [annS1] = await workspaceOf(s1, ann);
    await scratch.query('delete from public.workspaces where workspace_id = $1', [annS1]);
    expect(await scratch.query('select 1 from public.workspace_drafts where workspace_id = $1', [annS1])).toEqual([]);
    expect(await scratch.query('select 1 from public.workspace_active where workspace_id = $1', [annS1])).toEqual([]);
    // Ann's other space is untouched.
    const [annS2] = await workspaceOf(s2, ann);
    expect(await scratch.query('select 1 from public.workspace_drafts where workspace_id = $1', [annS2])).toHaveLength(2);
  });
});

/**
 * Advisor rulings #4–#6 (build log 01a115d7): the active pointer heals itself,
 * and the 305 signatures stay as rollback shims that refuse, writing nothing,
 * once an identity holds two workspaces. The shims are called with the old
 * binary's exact untyped SQL text, so overload resolution is proven too.
 */
describeIfPg('migration 310: pointer healing and the 305 rollback shims', () => {
  let db: TestDb;
  let service: WorkspaceService;
  let spaceId: string;
  const dan = `identity_${randomUUID()}`;
  const as = (): DbClaims => ({ identityId: dan, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  const old = (sql: string, params: unknown[]) => db.tx(as(), async (q) => {
    await q.query('set local role tm8_app');
    return q.query<Record<string, string>>(sql, params);
  });
  const SAVE = 'select public.workspace_save($1,$2,$3,$4) as r';
  const DRAFT = 'select public.workspace_draft_save($1,$2,$3,$4,$5) as r';
  const rows = () => db.asOwner((q) => q.query<{ workspace_id: string; name: string; revision: string }>(
    'select workspace_id, name, revision from public.workspaces where space_id = $1 and identity_id = $2 order by position, created_at, workspace_id',
    [spaceId, dan],
  ));
  const pointers = () => db.asOwner((q) => q.query<{ workspace_id: string }>(
    'select workspace_id from public.workspace_active where space_id = $1 and identity_id = $2', [spaceId, dan],
  ));
  const seed = (name: string, position: number) => db.asOwner(async (q) => (await q.query<{ workspace_id: string }>(
    `insert into public.workspaces(space_id, identity_id, member_id, state, revision, name, position)
     select space_id, identity_id, member_id, '{}'::jsonb, 1, $3, $4 from public.workspaces where space_id = $1 and identity_id = $2 limit 1
     returning workspace_id`,
    [spaceId, dan, name, position],
  ))[0]!.workspace_id);

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: dan }, 'public.upsert_user_profile', ['Dan', null, null]);
    spaceId = (await db.rpc<{ space: { id: string } }>({ identityId: dan }, 'public.create_space', ['Shims', 'rollback', 'private', null, null])).space.id;
    service = new WorkspaceService({ db, bridge: new WorkspaceBridge() });
  });

  afterAll(async () => {
    await db?.end();
  });

  it('the new workspace_save needs five arguments, so the old four-argument text is never ambiguous', async () => {
    const [fn] = await db.asOwner((q) => q.query<{ n: number; d: number }>(
      `select pronargs as n, pronargdefaults as d from pg_proc
        where oid = 'public.workspace_save(uuid, uuid, bigint, bigint, jsonb, uuid)'::regprocedure`,
    ));
    expect(fn).toEqual({ n: 6, d: 1 });
  });

  it('old signatures, no workspace: the save creates "Main" and its pointer', async () => {
    expect(await old(SAVE, [spaceId, 0, 1, JSON.stringify({ orderedTabIds: [] })])).toEqual([{ r: '1' }]);
    const [main] = await rows();
    expect(main).toMatchObject({ name: 'Main', revision: '1' });
    expect(await pointers()).toEqual([{ workspace_id: main!.workspace_id }]);
  });

  it('old signatures, one workspace: 305 compare-and-swap semantics', async () => {
    expect(await old(SAVE, [spaceId, 1, 2, '{}'])).toEqual([{ r: '2' }]);
    await expect(old(SAVE, [spaceId, 1, 3, '{}'])).rejects.toMatchObject({ code: '40001' });
    expect(await old(DRAFT, [spaceId, randomUUID(), 'task', 0, JSON.stringify({ title: { v: 't', r: 1 } })])).toEqual([{ r: '1' }]);
  });

  it('old signatures, two workspaces: both refuse with 55000 and change nothing', async () => {
    await seed('Second', 1);
    const before = await rows();
    const drafts = () => db.asOwner((q) => q.query('select draft_id from public.workspace_drafts d join public.workspaces w using (workspace_id) where w.identity_id = $1', [dan]));
    const draftsBefore = await drafts();
    await expect(old(SAVE, [spaceId, 2, 3, '{}'])).rejects.toMatchObject({ code: '55000' });
    await expect(old(DRAFT, [spaceId, randomUUID(), 'task', 0, '{}'])).rejects.toMatchObject({ code: '55000' });
    expect(await rows()).toEqual(before);
    expect(await drafts()).toEqual(draftsBefore);
  });

  it('a lost pointer reads as the first workspace; the next write restores exactly one pointer to it', async () => {
    const [main] = await rows();
    const third = await seed('Third', 2);
    await db.asOwner((q) => q.query('update public.workspace_active set workspace_id = $1 where space_id = $2 and identity_id = $3', [third, spaceId, dan]));
    await db.asOwner((q) => q.query('delete from public.workspaces where workspace_id = $1', [third]));
    expect(await pointers()).toEqual([]);

    const got = await service.get(as(), spaceId);
    expect(got).toMatchObject({ activeWorkspaceId: main!.workspace_id, workspace: { id: main!.workspace_id, active: true } });
    expect(await pointers()).toEqual([]);

    const result = await service.apply(as(), spaceId, {
      env: { command: 'workspace.layout.set', args: { expanded: true }, source: 'remote' },
      requestId: randomUUID(),
      origin: { kind: 'http' },
    });
    expect(result).toMatchObject({ status: 'applied', workspace: { id: main!.workspace_id, resolvedBy: 'active' } });
    expect(await pointers()).toEqual([{ workspace_id: main!.workspace_id }]);
  });

  it('the new draft writer is SECURITY DEFINER with a pinned search_path, executable by tm8_app only', async () => {
    const [fn] = await db.asOwner((q) => q.query<{ secdef: boolean; config: string[]; app: boolean; pub: boolean }>(
      `select p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('tm8_app', p.oid, 'execute') as app,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p where p.oid = 'public.workspace_draft_write(uuid, uuid, text, bigint, jsonb)'::regprocedure`,
    ));
    expect(fn).toMatchObject({ secdef: true, app: true, pub: false });
    expect(fn!.config.some((c) => c.startsWith('search_path='))).toBe(true);
  });
});
