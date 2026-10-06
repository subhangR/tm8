/**
 * Server-side Workspaces against a REAL database (Spec D, migration 302):
 * the shared reducer applied on the node, compare-and-swap rows, drafts with
 * per-field last-writer-wins, the pending interaction only a window may
 * answer, the one-time import, the bounds, and privacy — another member of
 * the same space never reads the row or receives a frame.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { DbClaims } from '../../src/db/types.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../events/pg-harness.js';

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
      return q.query('select public.workspace_save($1, $2, $3, $4)', [spaceId, 1000, 1001, JSON.stringify(huge)]);
    })).rejects.toMatchObject({ code: '54000' });
  });
});
