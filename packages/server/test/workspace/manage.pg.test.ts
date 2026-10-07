/**
 * Managing the workspace list (API doc 01a115c4 §5.7–§5.11) against a REAL
 * database: create, update, reorder, delete and switch through the handlers,
 * the SQL writers of migration 311 underneath, and what each window hears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getOperation, type OperationName } from '@tm8/contract';

import type { DbClaims } from '../../src/db/types.js';
import { createControlChannel, type SubscriptionAuthorizer } from '../../src/events/control.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import type { DurableEventLog } from '../../src/events/poll.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import { HandlerRegistry } from '../../src/facade/index.js';
import type { RequestContext } from '../../src/http/types.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';
import { memberForClaims } from '../../src/workspace/handlers.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../events/pg-harness.js';

const url = TEST_DATABASE_URL;
interface Frame { type: string; [key: string]: unknown }
type Data = Record<string, unknown>;
const describeIfPg = url === undefined ? describe.skip : describe;

describeIfPg('workspace management over real Postgres (§5.7–§5.11)', () => {
  let db: TestDb;
  let spaceId: string;
  let otherSpaceId: string;
  let member: string;
  let task: string;
  const human = `identity_${randomUUID()}`;
  const stranger = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const registry = new HandlerRegistry();
  const asHuman = { kind: 'bearer', identityId: human, authKind: 'cli' } as const;
  const asAgent = { kind: 'bearer', identityId: human, authKind: 'agent' } as const;
  const claims = (): DbClaims => ({ identityId: human, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  let control: ReturnType<typeof createControlChannel>;

  class Win {
    readonly frames: Frame[] = [];
    readonly identity = { kind: 'auto-owner', identityId: human } as RequestContext['identity'];
    isOpen = true;
    constructor(readonly id: string) {}
    send(text: string): void {
      this.frames.push(JSON.parse(text) as Frame);
    }
    close(): void {
      this.isOpen = false;
    }
  }
  const capable = new Win('conn-capable');
  const capless = new Win('conn-capless');
  const elsewhere = new Win('conn-other-space');
  const someoneElse = new Win('conn-someone-else');
  const windows = [capable, capless, elsewhere, someoneElse];

  interface Call { as?: RequestContext['identity']; params?: Record<string, string>; query?: Record<string, string>; method?: string; space?: string }
  const call = async (op: OperationName, body?: unknown, opts: Call = {}): Promise<Data> =>
    ((await registry.get(op)!({
      op: getOperation(op), opName: op, params: { spaceId: opts.space ?? spaceId, ...opts.params }, query: new URLSearchParams(opts.query),
      body, requestId: `req_${randomUUID()}`, identity: opts.as ?? asHuman, headers: {}, method: opts.method ?? 'POST', path: '/',
    } as unknown as RequestContext)) as { data: Data }).data;
  const create = (body: Data = {}, opts: Call = {}) => call('workspace.create', { requestId: randomUUID(), ...body }, opts);
  const update = (workspaceId: string, body: Data, opts: Call = {}) =>
    call('workspace.update', { requestId: randomUUID(), ...body }, { ...opts, params: { workspaceId } });
  const reorder = (workspaceId: string, beforeWorkspaceId: string | null, opts: Call = {}) =>
    call('workspace.reorder', { requestId: randomUUID(), beforeWorkspaceId }, { ...opts, params: { workspaceId } });
  const switchTo = (workspaceId: string, body: Data = {}, opts: Call = {}) =>
    call('workspace.switch', { requestId: randomUUID(), ...body }, { ...opts, params: { workspaceId } });
  const remove = (workspaceId: string, query: Record<string, string> = {}, opts: Call = {}) =>
    call('workspace.delete', undefined, { ...opts, method: 'DELETE', params: { workspaceId }, query: { requestId: randomUUID(), ...query } });
  const list = async (space = spaceId) => (await call('workspace.list', undefined, { space })) as {
    items: Array<{ id: string; name: string; position: number; active: boolean }>; activeWorkspaceId: string; listRevision: number;
  };
  const names = async (space = spaceId) => (await list(space)).items.map((w) => w.name);
  const idOf = async (name: string) => (await list()).items.find((w) => w.name === name)!.id;
  const types = (win: Win) => win.frames.map((f) => f.type);
  const clear = () => { for (const w of windows) w.frames.length = 0; };
  const send = (win: Win, frame: Data) => control.handle(win as never, JSON.stringify({ spaceId, ...frame }));
  const reg = (instanceId: string, extra: Data = {}) => ({
    type: 'workspace.register', instanceId, windowId: instanceId, focused: false, visible: true, view: 'tabs', mounted: true, revision: 0, ...extra,
  });

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Manager', null, null]);
    await db.rpc({ identityId: stranger }, 'public.upsert_user_profile', ['Stranger', null, null]);
    const space = async (who: string, name: string) =>
      (await db.rpc<{ space: { id: string } }>({ identityId: who }, 'public.create_space', [name, 'workspace management proof', 'private', null, null])).space.id;
    spaceId = await space(human, 'Manage space');
    otherSpaceId = await space(human, 'Manage elsewhere');
    member = (await memberForClaims(db, { identityId: human }, spaceId))!;
    task = (await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      spaceId, 'Manage task', member, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ])).entity.id;
    const service = new WorkspaceService({ db, bridge });
    registerEventHandlers(registry, { db, config: {} as never, workspace: bridge, workspaceService: service, owner: () => Promise.resolve({
      identityId: human, accountId: '00000000-0000-0000-0000-000000000000', username: 'h', isNodeAdmin: false, isOwner: true,
    }) });
    control = createControlChannel({
      registry: new SubscriptionRegistry(),
      authorizer: { canSubscribe: () => Promise.resolve(true) } as unknown as SubscriptionAuthorizer,
      log: {} as DurableEventLog,
      claimsFor: () => Promise.resolve(claims()),
      workspace: { bridge, service, memberFor: () => Promise.resolve(member) },
    });
  });

  afterAll(async () => {
    await db?.end();
  });

  it('create: S12 makes "Main" active first; the default name is "Workspace N"; creating never switches, for anyone', async () => {
    const first = await create();
    const main = await idOf('Main');
    expect(first).toMatchObject({ status: 'applied', activeWorkspaceId: main, workspace: { name: 'Workspace 2', active: false, position: 1 } });

    const byAgent = await create({ name: 'Review', color: 'teal' }, { as: asAgent });
    expect(byAgent).toMatchObject({
      status: 'applied', activeWorkspaceId: main,
      workspace: { name: 'Review', color: 'teal', active: false, createdBy: { actorClass: 'agent' } },
    });
    expect(await create()).toMatchObject({ workspace: { name: 'Workspace 3' }, activeWorkspaceId: main });
    expect(await names()).toEqual(['Main', 'Workspace 2', 'Review', 'Workspace 3']);
    expect((await list()).items.map((w) => w.position)).toEqual([0, 1, 2, 3]);
  });

  it('create: a duplicate name (any case) is workspace_name_taken; a retry is the recorded answer; a reused id is refused', async () => {
    await expect(create({ name: 'review' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'workspace_name_taken' } });
    const requestId = randomUUID();
    const once = await create({ requestId, name: 'Once' });
    expect(await create({ requestId, name: 'Once' })).toEqual(once);
    await expect(create({ requestId, name: 'Twice' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'request_id_reused' } });
    await remove((once['workspace'] as { id: string }).id);
  });

  it('create past 20 is conflict / workspace_cap', async () => {
    // The first create also makes "Main" (S12): 19 creates reach the cap.
    for (let i = 0; i < 19; i += 1) await create({}, { space: otherSpaceId });
    expect((await list(otherSpaceId)).items).toHaveLength(20);
    await expect(create({}, { space: otherSpaceId })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'workspace_cap' } });
  });

  it('an agent may not reorder, switch or delete; nothing changes', async () => {
    const review = await idOf('Review');
    const before = await list();
    for (const attempt of [
      () => reorder(review, null, { as: asAgent }),
      () => switchTo(review, {}, { as: asAgent }),
      () => remove(review, {}, { as: asAgent }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'human_only' } });
    }
    expect(await list()).toEqual(before);
  });

  it('switch: capable windows hear switched → state → drafts → summary, capless ones state → drafts, nobody else anything', async () => {
    const main = await idOf('Main');
    const review = await idOf('Review');
    await send(capable, reg('win-capable', { caps: ['multiWorkspace'], workspaceId: main }));
    await send(capless, reg('win-capless'));
    bridge.register(elsewhere, human, member, reg('win-elsewhere', { spaceId: otherSpaceId, caps: ['multiWorkspace'] }) as never);
    bridge.register(someoneElse, stranger, member, reg('win-someone-else', { spaceId, caps: ['multiWorkspace'] }) as never);
    // Review gets a draft with a value (a row), written by an agent from outside.
    await call('workspace.command', { requestId: randomUUID(), command: 'workspace.drafts.open', args: { kind: 'task' }, workspaceId: review }, { as: asAgent });
    const stored = await call('workspace.get', undefined, { query: { workspaceId: review } });
    const draftId = Object.values((stored['state'] as { tabs: Record<string, { draftId?: string }> }).tabs).find((t) => t.draftId)!.draftId!;
    await call('workspace.drafts.patch', { fields: { title: { v: 'Pending' } }, workspaceId: review }, { as: asAgent, params: { draftId } });
    const revisionBefore = (await list()).listRevision;
    clear();

    const switched = await switchTo(review, { expectedActiveWorkspaceId: main });
    expect(switched).toMatchObject({ status: 'applied', activeWorkspaceId: review, listRevision: revisionBefore + 1, workspace: { id: review, active: true } });
    expect(types(capable)).toEqual(['workspace.switched', 'workspace.state', 'workspace.draft', 'workspace.summary']);
    expect(capable.frames[0]).toMatchObject({ workspaceId: review, previousWorkspaceId: main, listRevision: revisionBefore + 1 });
    expect(capable.frames[1]).toMatchObject({ workspaceId: review, active: true });
    expect(capable.frames[2]).toMatchObject({ workspaceId: review, draftId });
    expect(capable.frames[3]).toMatchObject({ activeWorkspaceId: review, cause: { kind: 'switched', workspaceId: review, actorClass: 'human' } });
    expect(types(capless)).toEqual(['workspace.state', 'workspace.draft']);
    expect(elsewhere.frames).toEqual([]);
    expect(someoneElse.frames).toEqual([]);
    expect(bridge.list(human, spaceId).map((w) => w.workspaceId)).toEqual([review, review]);
    const stamps = await db.asOwner((q) => q.query<{ n: string }>(
      'select count(*) as n from public.workspaces where workspace_id = any($1::uuid[]) and last_active_at is not null', [[main, review]],
    ));
    expect(Number(stamps[0]!.n)).toBe(2);

    // Already active: no_op, no frames. A stale guard: conflict / workspace_switched (F2), nothing moves.
    clear();
    expect(await switchTo(review)).toMatchObject({ status: 'no_op', listRevision: revisionBefore + 1 });
    expect(await switchTo(main, { expectedActiveWorkspaceId: main })).toMatchObject({
      status: 'conflict', reason: 'workspace_switched', expectedWorkspaceId: main, activeWorkspaceId: review,
    });
    expect(windows.flatMap((w) => w.frames)).toEqual([]);
  });

  it('a capable window registers to summary → state → drafts', async () => {
    const late = new Win('conn-late');
    await send(late, reg('win-late', { caps: ['multiWorkspace'] }));
    expect(types(late)).toEqual(['workspace.summary', 'workspace.state', 'workspace.draft']);
  });

  it('an agent’s untargeted tabs.open lands in the workspace the human switched to', async () => {
    const opened = await call('workspace.command', {
      requestId: randomUUID(), command: 'workspace.tabs.open', args: { kind: 'task', entityId: task, activate: false },
    }, { as: asAgent });
    expect(opened).toMatchObject({ status: 'applied', workspace: { id: await idOf('Review'), resolvedBy: 'active', active: true } });
  });

  it('update and reorder: rename, recolour, refusals with reasons, no_op, dense positions, one summary each', async () => {
    const w2 = await idOf('Workspace 2');
    clear();
    expect(await update(w2, { name: '  Billing  ' }, { as: asAgent })).toMatchObject({ status: 'applied', workspace: { name: 'Billing' } });
    expect(await update(w2, { color: 'red' })).toMatchObject({ status: 'applied', workspace: { color: 'red' } });
    expect(await update(w2, { name: 'Billing', color: 'red' })).toMatchObject({ status: 'no_op' });
    expect(capable.frames.map((f) => (f['cause'] as { kind: string; actorClass: string }))).toEqual([
      expect.objectContaining({ kind: 'renamed', actorClass: 'agent' }),
      expect.objectContaining({ kind: 'recolored', actorClass: 'human' }),
    ]);
    expect(types(capless)).toEqual([]);
    await expect(update(w2, { name: 'MAIN' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'workspace_name_taken' } });
    await expect(update(w2, { name: '   ' })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_name' } });
    await expect(update(w2, { color: 'mauve' })).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_color' } });

    expect(await reorder(w2, null)).toMatchObject({ status: 'applied', workspace: { position: 3 } });
    expect(await names()).toEqual(['Main', 'Review', 'Workspace 3', 'Billing']);
    expect(await reorder(w2, null)).toMatchObject({ status: 'no_op' });
    expect(await reorder(w2, await idOf('Review'))).toMatchObject({ status: 'applied', workspace: { position: 1 } });
    expect(await names()).toEqual(['Main', 'Billing', 'Review', 'Workspace 3']);
    expect((await list()).items.map((w) => w.position)).toEqual([0, 1, 2, 3]);
  });

  it('delete: unsaved drafts need discard; the active one hands over to the next first; drafts cascade', async () => {
    const review = await idOf('Review');
    const w3 = await idOf('Workspace 3');
    const refused = await remove(review);
    expect(refused).toMatchObject({ status: 'rejected', reason: 'unsaved_changes', activeWorkspaceId: review });
    expect(refused['dirtyDraftIds']).toHaveLength(1);

    clear();
    const requestId = randomUUID();
    const deleted = await remove(review, { discard: 'true', requestId });
    expect(deleted).toMatchObject({ status: 'applied', activeWorkspaceId: w3, workspace: { id: review, name: 'Review', active: false } });
    expect(types(capable)).toEqual(['workspace.switched', 'workspace.state', 'workspace.summary']);
    expect(capable.frames[2]).toMatchObject({ cause: { kind: 'deleted', workspaceId: review } });
    expect(types(capless)).toEqual(['workspace.state']);
    expect(await db.asOwner((q) => q.query('select 1 from public.workspace_drafts where workspace_id = $1', [review]))).toEqual([]);
    // A replay after success is the recorded result, not workspace_not_found.
    expect(await remove(review, { discard: 'true', requestId })).toEqual(deleted);

    // The last in order hands back to the previous one.
    expect(await remove(w3)).toMatchObject({ status: 'applied', activeWorkspaceId: await idOf('Billing') });
    expect(await names()).toEqual(['Main', 'Billing']);
    expect((await list()).items.map((w) => w.position)).toEqual([0, 1]);

    // A non-active one: the list changes, nothing switches.
    clear();
    await remove(await idOf('Main'));
    expect(types(capable)).toEqual(['workspace.summary']);
    expect(types(capless)).toEqual([]);
    await expect(remove(await idOf('Billing'))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'last_workspace' } });
    expect(await create()).toMatchObject({ workspace: { name: 'Workspace 2' } });
  });
});
