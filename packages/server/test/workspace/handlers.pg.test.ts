/**
 * The `workspace.*` handlers and the register-time member lookup against a
 * REAL database (Spec C). The seam tests in bridge.test.ts fake the queries;
 * this file runs the SQL itself, which is where a wrong column hides.
 *
 * Multiple workspaces (API doc 01a115c4): which workspace a command lands in,
 * over HTTP and the socket, and what each kind of window hears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getOperation, type OperationName } from '@tm8/contract';

import { defaultWorkspaceState, toStoredState } from '@tm8/contract/workspace';

import type { DbClaims } from '../../src/db/types.js';
import { createControlChannel, type SubscriptionAuthorizer } from '../../src/events/control.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import type { DurableEventLog } from '../../src/events/poll.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import { HandlerRegistry } from '../../src/facade/index.js';
import type { RequestContext } from '../../src/http/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';
import { memberForClaims } from '../../src/workspace/handlers.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../events/pg-harness.js';

const url = TEST_DATABASE_URL;
interface Frame { type: string; [key: string]: unknown }
const describeIfPg = url === undefined ? describe.skip : describe;

describeIfPg('workspace.* over real Postgres', () => {
  let db: TestDb;
  let spaceId: string;
  let memberId: string;
  const human = `identity_${randomUUID()}`;
  const outsider = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const registry = new HandlerRegistry();
  const sent: string[] = [];
  const sink = { id: 'conn-1', isOpen: true, send: (text: string) => void sent.push(text) };

  const owner = (): Promise<LoopbackOwner> =>
    Promise.resolve({ identityId: human, accountId: '00000000-0000-0000-0000-000000000000', username: 'h', isNodeAdmin: false, isOwner: true });

  const call = async (op: OperationName, identity: RequestContext['identity'], body?: unknown) =>
    registry.get(op)!({
      op: getOperation(op), opName: op, params: { spaceId }, query: new URLSearchParams(),
      body, requestId: `req_${randomUUID()}`, identity, headers: {}, method: 'GET', path: '/',
    } as unknown as RequestContext) as Promise<{ data: unknown }>;

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Bridge Human', null, null]);
    await db.rpc({ identityId: outsider }, 'public.upsert_user_profile', ['Someone Else', null, null]);
    const created = await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', [
      'Bridge space', 'workspace bridge proof', 'private', null, null,
    ]);
    spaceId = created.space.id;
    registerEventHandlers(registry, { db, config: {} as never, workspace: bridge, owner });
  });

  afterAll(async () => {
    await db?.end();
  });

  it('derives the window’s member from its identity, and nobody else’s', async () => {
    memberId = (await memberForClaims(db, { identityId: human }, spaceId))!;
    expect(memberId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await memberForClaims(db, { identityId: outsider }, spaceId)).toBeNull();
    bridge.register(sink, human, memberId, {
      type: 'workspace.register', spaceId, instanceId: 'win-1', windowId: 'w', focused: true,
      visible: true, view: 'tabs', mounted: true, revision: 0,
    });
  });

  it('an agent carrying the human’s identity lists the window and is named in the forward', async () => {
    const agent = { kind: 'bearer', identityId: human, actorId: memberId, authKind: 'agent' } as const;
    const list = await call('workspace.instances.list', agent);
    expect((list.data as { items: Array<{ instanceId: string; viewerMemberId: string }> }).items)
      .toMatchObject([{ instanceId: 'win-1', viewerMemberId: memberId }]);

    const pending = call('workspace.command', agent, { requestId: 'r-1', command: 'workspace.dialogs.open', args: { dialogId: 'palette' } });
    for (let i = 0; i < 200 && sent.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    const frame = JSON.parse(sent[0]!) as { requestId: string; actorClass: string; actorName?: string };
    expect(frame).toMatchObject({ actorClass: 'agent', actorName: 'Bridge Human' });
    bridge.acceptResult(sink, { type: 'workspace.result', instanceId: 'win-1', requestId: frame.requestId, result: { status: 'applied', revision: 0, dialogId: 'palette', dialogState: 'open' } });
    await expect(pending).resolves.toMatchObject({ data: { status: 'applied', dialogState: 'open' } });
  });

  it('a caller who cannot read the space is refused before the bridge is asked', async () => {
    const stranger = { kind: 'bearer', identityId: outsider, authKind: 'cli' } as const;
    await expect(call('workspace.instances.list', stranger)).rejects.toMatchObject({ code: 'not_found' });
  });
});

/**
 * Multiple workspaces (API doc 01a115c4 §3, §7): one resolver for HTTP and the
 * socket. A second workspace is seeded with SQL (no create op yet), and the
 * active pointer is moved with SQL where a test needs a "switch".
 */
describeIfPg('workspace targets over real Postgres (multiple workspaces)', () => {
  let db: TestDb;
  let spaceId: string;
  let main: string;
  let second: string;
  const tasks: string[] = [];
  const human = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const registry = new HandlerRegistry();
  const agent = { kind: 'bearer', identityId: human, authKind: 'agent' } as const;
  const claims = (): DbClaims => ({ identityId: human, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  let service: WorkspaceService;
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
  const capable = new Win('conn-new');
  const capless = new Win('conn-old');

  const call = async (op: OperationName, body?: unknown, query: Record<string, string> = {}, params: Record<string, string> = {}) =>
    ((await registry.get(op)!({
      op: getOperation(op), opName: op, params: { spaceId, ...params }, query: new URLSearchParams(query),
      body, requestId: `req_${randomUUID()}`, identity: agent, headers: {}, method: 'GET', path: '/',
    } as unknown as RequestContext)) as { data: Record<string, unknown> }).data;
  const command = (command: string, args: unknown, extra: Record<string, unknown> = {}) =>
    call('workspace.command', { requestId: randomUUID(), command, args, ...extra });
  const send = (win: Win, frame: Record<string, unknown>) => control.handle(win as never, JSON.stringify({ spaceId, ...frame }));
  const point = (workspaceId: string) =>
    db.asOwner((q) => q.query('update public.workspace_active set workspace_id = $1 where space_id = $2 and identity_id = $3', [workspaceId, spaceId, human]));
  const revisionOf = async (workspaceId: string) =>
    Number((await db.asOwner((q) => q.query<{ revision: string }>('select revision from public.workspaces where workspace_id = $1', [workspaceId])))[0]!.revision);
  const tabsOf = async (workspaceId: string) =>
    Object.values(((await call('workspace.get', undefined, { workspaceId }))['state'] as {
      tabs: Record<string, { id: string; entityId?: string; draftId?: string; type: string }>;
    }).tabs);

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Many Workspaces', null, null]);
    spaceId = (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', [
      'Workspaces space', 'multiple workspaces proof', 'private', null, null,
    ])).space.id;
    const member = (await memberForClaims(db, { identityId: human }, spaceId))!;
    for (const title of ['One', 'Two', 'Three']) {
      tasks.push((await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
        spaceId, title, member, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
      ])).entity.id);
    }
    service = new WorkspaceService({ db, bridge });
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

    // The first write creates "Main"; a second workspace is seeded beside it.
    const first = await command('workspace.tabs.open', { kind: 'task', entityId: tasks[0], activate: false });
    main = (first['workspace'] as { id: string }).id;
    second = (await db.asOwner((q) => q.query<{ workspace_id: string }>(
      `insert into public.workspaces(space_id, identity_id, member_id, state, revision, name, position)
       select space_id, identity_id, member_id, $2, 1, 'Second', 1 from public.workspaces where workspace_id = $1
       returning workspace_id`,
      [main, JSON.stringify(toStoredState(defaultWorkspaceState(spaceId)))],
    )))[0]!.workspace_id;

    const reg = (instanceId: string, extra: Record<string, unknown> = {}) => ({
      type: 'workspace.register', instanceId, windowId: instanceId, focused: false, visible: true, view: 'tabs', mounted: true, revision: 0, ...extra,
    });
    await send(capable, reg('new-win', { caps: ['multiWorkspace'], workspaceId: main }));
    await send(capless, reg('old-win'));
  });

  afterAll(async () => {
    await db?.end();
  });

  it('registers caps and the shown workspace; the snapshot names the active workspace', async () => {
    expect(bridge.list(human, spaceId).map((w) => [w.instanceId, w.caps, w.workspaceId]).sort()).toEqual([
      ['new-win', ['multiWorkspace'], main],
      ['old-win', [], main],
    ]);
    expect(capless.frames[0]).toMatchObject({ type: 'workspace.state', workspaceId: main, active: true, revision: 1 });
  });

  it('untargeted goes to the active workspace; a tab or draft id goes to its owner while another is active', async () => {
    // Fill the second workspace while it is active, then switch back to Main.
    await point(second);
    const inSecond = await command('workspace.tabs.open', { kind: 'task', entityId: tasks[1], activate: false });
    expect(inSecond['workspace']).toEqual({ id: second, name: 'Second', color: null, resolvedBy: 'active', active: true });
    await command('workspace.drafts.open', { kind: 'task' });
    const draft = (await tabsOf(second)).find((t) => t.type === 'draft')!;
    await point(main);
    capable.frames.length = 0;
    capless.frames.length = 0;

    const untargeted = await command('workspace.tabs.open', { kind: 'task', entityId: tasks[2], activate: false });
    expect(untargeted).toMatchObject({ status: 'applied', workspace: { id: main, name: 'Main', resolvedBy: 'active', active: true } });
    expect((await tabsOf(main)).map((t) => t.entityId).sort()).toEqual([tasks[0], tasks[2]].sort());

    const tabId = (await tabsOf(second)).find((t) => t.entityId === tasks[1])!.id;
    const owned = await command('workspace.tabs.setUi', { tabId, ui: { scroll: 1 } });
    expect(owned['workspace']).toEqual({ id: second, name: 'Second', color: null, resolvedBy: 'owner', active: false });
    expect(await revisionOf(main)).toBe(2);

    const patched = await call('workspace.drafts.patch', { fields: { title: { v: 'Owned' } } }, {}, { draftId: draft.draftId! });
    expect(patched).toMatchObject({ revision: 1, workspace: { id: second, resolvedBy: 'owner', active: false } });
    expect(await db.asOwner((q) => q.query('select workspace_id from public.workspace_drafts where draft_id = $1', [draft.draftId])))
      .toEqual([{ workspace_id: second }]);

    // S9: the old window hears only the active workspace; the new one hears both.
    expect(capless.frames.map((f) => f['workspaceId'])).toEqual([main]);
    expect(new Set(capable.frames.filter((f) => f.type === 'workspace.state').map((f) => `${String(f['workspaceId'])}:${String(f['active'])}`)))
      .toEqual(new Set([`${main}:true`, `${second}:false`]));
    expect(capable.frames.find((f) => f.type === 'workspace.draft')).toMatchObject({ workspaceId: second, draftId: draft.draftId });
  });

  it('a window frame addressed to a workspace applies there, not to the active one (R9)', async () => {
    const [mainBefore, secondBefore] = [await revisionOf(main), await revisionOf(second)];
    const tabId = randomUUID();
    await send(capable, {
      type: 'workspace.apply', instanceId: 'new-win', requestId: randomUUID(), workspaceId: second, ids: [tabId],
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[0], activate: false }, source: 'click' },
    });
    expect(await revisionOf(main)).toBe(mainBefore);
    expect(await revisionOf(second)).toBe(secondBefore + 1);
    expect((await tabsOf(second)).map((t) => t.id)).toContain(tabId);
    expect(capable.frames.at(-1)).toMatchObject({ type: 'workspace.applied', workspaceId: second, result: { workspace: { id: second, resolvedBy: 'window' } } });
  });

  it('an old window’s unaddressed apply goes to the active workspace (S9)', async () => {
    const [mainBefore, secondBefore] = [await revisionOf(main), await revisionOf(second)];
    const tabId = randomUUID();
    await send(capless, {
      type: 'workspace.apply', instanceId: 'old-win', requestId: randomUUID(), ids: [tabId],
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[1], activate: false }, source: 'click' },
    });
    expect(await revisionOf(main)).toBe(mainBefore + 1);
    expect(await revisionOf(second)).toBe(secondBefore);
    expect((await tabsOf(main)).map((t) => t.id)).toContain(tabId);
  });

  it('D5 over HTTP: a retry after a switch replays the original workspace; another payload is refused', async () => {
    const body = { requestId: randomUUID(), command: 'workspace.tabs.close', args: { tabId: (await tabsOf(main)).find((t) => t.entityId === tasks[2])!.id } };
    const once = await call('workspace.command', body);
    expect(once).toMatchObject({ status: 'applied', workspace: { id: main, resolvedBy: 'owner' } });
    const revision = await revisionOf(main);
    await point(second);
    expect(await call('workspace.command', body)).toEqual(once);
    expect(await revisionOf(main)).toBe(revision);
    await expect(call('workspace.command', { ...body, workspaceId: second })).rejects.toMatchObject({
      code: 'conflict', details: { reason: 'request_id_reused' },
    });
  });

  it('D5 over the socket: a resend after a switch replays the original workspace; another payload is refused', async () => {
    // The active workspace is "Second" now.
    const frame = {
      type: 'workspace.apply', instanceId: 'old-win', requestId: randomUUID(), ids: [randomUUID()],
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[2], activate: false }, source: 'click' },
    };
    await send(capless, frame);
    const first = capless.frames.at(-1)!;
    expect(first).toMatchObject({ type: 'workspace.applied', workspaceId: second, result: { status: 'applied', workspace: { id: second } } });
    const revision = await revisionOf(second);
    await point(main);
    await send(capless, frame);
    expect(capless.frames.at(-1)).toEqual(first);
    expect(await revisionOf(second)).toBe(revision);
    await send(capless, { ...frame, ids: [randomUUID()] });
    expect(capless.frames.at(-1)).toMatchObject({ type: 'workspace.applied', result: { status: 'rejected', reason: 'request_id_reused' } });
  });

  it('workspace.get and workspace.list name the workspaces, in list order', async () => {
    const got = await call('workspace.get');
    expect(got).toMatchObject({ workspace: { id: main, resolvedBy: 'active', active: true }, activeWorkspaceId: main });
    expect((got['workspaces'] as { id: string }[]).map((w) => w.id)).toEqual([main, second]);
    const listed = await call('workspace.list');
    expect(listed).toMatchObject({ activeWorkspaceId: main, cap: 20, prompts: [] });
    expect((listed['items'] as { id: string; name: string; active: boolean }[]).map((w) => [w.name, w.active])).toEqual([['Main', true], ['Second', false]]);
    await expect(call('workspace.get', undefined, { workspaceId: randomUUID() })).rejects.toMatchObject({
      code: 'not_found', details: { reason: 'workspace_not_found' },
    });
  });
});
