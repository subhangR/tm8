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

/**
 * Phase 3 safety (API doc 01a115c4 §3.2 step 5, §5.4, §5.10–§5.12, D6–D8):
 * pins, D7, batch open, the agent's prompts and the activity stamp.
 */
describeIfPg('workspace safety over real Postgres (pins, D7, batch, prompts)', () => {
  let db: TestDb;
  let spaceId: string;
  let member: string;
  let main: string;
  let second: string;
  const tasks: string[] = [];
  const human = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const registry = new HandlerRegistry();
  const asHuman = { kind: 'bearer', identityId: human, authKind: 'cli' } as const;
  let asAgent: RequestContext['identity'];
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
  const capable = new Win('conn-safety');

  type Data = Record<string, unknown>;
  interface Call { as?: RequestContext['identity']; params?: Record<string, string>; query?: Record<string, string>; method?: string }
  const call = async (op: OperationName, body?: unknown, opts: Call = {}): Promise<Data> =>
    ((await registry.get(op)!({
      op: getOperation(op), opName: op, params: { spaceId, ...opts.params }, query: new URLSearchParams(opts.query),
      body, requestId: `req_${randomUUID()}`, identity: opts.as ?? asAgent, headers: {}, method: opts.method ?? 'POST', path: '/',
    } as unknown as RequestContext)) as { data: Data }).data;
  const command = (command: string, args: unknown, extra: Data = {}, as?: RequestContext['identity']) =>
    call('workspace.command', { requestId: randomUUID(), command, args, ...extra }, as ? { as } : {});
  const switchTo = (workspaceId: string, as: RequestContext['identity']) =>
    call('workspace.switch', { requestId: randomUUID() }, { as, params: { workspaceId } });
  const remove = (workspaceId: string, as: RequestContext['identity'], query: Record<string, string> = {}) =>
    call('workspace.delete', undefined, { as, method: 'DELETE', params: { workspaceId }, query: { requestId: randomUUID(), ...query } });
  const resolve = (promptId: string, body: Data, as: RequestContext['identity'] = asHuman) =>
    call('workspace.prompts.resolve', { requestId: randomUUID(), ...body }, { as, params: { promptId } });
  const list = () => call('workspace.list', undefined, { as: asHuman }) as Promise<{
    activeWorkspaceId: string; items: Array<{ id: string; name: string }>; prompts: Array<{ promptId: string; state: string }>;
  }>;
  const stored = async (workspaceId: string) => (await call('workspace.get', undefined, { query: { workspaceId } }))['state'] as {
    tabs: Record<string, { id: string; entityId?: string; draftId?: string; type: string }>; orderedTabIds: string[]; recency: string[];
  };
  const row = async (workspaceId: string) => (await db.asOwner((q) => q.query<{ revision: string; last_agent_change_at: Date | null; last_agent_actor_id: string | null }>(
    'select revision, last_agent_change_at, last_agent_actor_id from public.workspaces where workspace_id = $1', [workspaceId],
  )))[0]!;
  const types = () => capable.frames.map((f) => f.type);

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Safety Human', null, null]);
    spaceId = (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', [
      'Safety space', 'workspace safety proof', 'private', null, null,
    ])).space.id;
    member = (await memberForClaims(db, { identityId: human }, spaceId))!;
    asAgent = { kind: 'bearer', identityId: human, actorId: member, authKind: 'agent' } as RequestContext['identity'];
    // One more than the tab limit, for the all-or-nothing batch.
    for (let i = 0; i < 52; i += 1) {
      tasks.push((await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
        spaceId, `Task ${i}`, member, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
      ])).entity.id);
    }
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
    second = ((await call('workspace.create', { requestId: randomUUID(), name: 'Second' }, { as: asHuman }))['workspace'] as { id: string }).id;
    main = (await list()).activeWorkspaceId;
    await control.handle(capable as never, JSON.stringify({
      spaceId, type: 'workspace.register', instanceId: 'safety-win', windowId: 'safety-win', focused: false, visible: true,
      view: 'tabs', mounted: true, revision: 0, caps: ['multiWorkspace'], workspaceId: main,
    }));
  });

  afterAll(async () => {
    await db?.end();
  });

  it('a pin that does not hold is conflict with the expected and active ids, and applies nothing (§3.2 step 5)', async () => {
    const before = await row(main);
    expect(await command('workspace.tabs.open', { kind: 'task', entityId: tasks[0] }, { expectedWorkspaceId: second })).toMatchObject({
      status: 'conflict', reason: 'workspace_switched', expectedWorkspaceId: second, activeWorkspaceId: main, workspace: { id: main },
    });
    expect(await command('workspace.tabs.open', { kind: 'task', entityId: tasks[0] }, { workspaceId: main, expectedWorkspaceId: second })).toMatchObject({
      status: 'conflict', reason: 'workspace_mismatch', expectedWorkspaceId: second, activeWorkspaceId: main,
    });
    // A pin naming no workspace answers the same way, not 404.
    const nowhere = randomUUID();
    expect(await command('workspace.tabs.open', { kind: 'task', entityId: tasks[0] }, { expectedWorkspaceId: nowhere })).toMatchObject({
      status: 'conflict', reason: 'workspace_switched', expectedWorkspaceId: nowhere,
    });
    await expect(call('workspace.get', undefined, { query: { expectedWorkspaceId: second } })).rejects.toMatchObject({
      code: 'conflict', details: { reason: 'workspace_switched', expectedWorkspaceId: second, activeWorkspaceId: main },
    });
    expect((await row(main)).revision).toBe(before.revision);
    expect(await command('workspace.tabs.open', { kind: 'task', entityId: tasks[0], activate: false }, { expectedWorkspaceId: main }))
      .toMatchObject({ status: 'applied', workspace: { id: main } });
  });

  it('an explicit non-active target leaves the pointer: activation not_active; a window verb there is not_active', async () => {
    const opened = await command('workspace.tabs.open', { kind: 'task', entityId: tasks[1] }, { workspaceId: second });
    expect(opened).toMatchObject({ status: 'applied', activation: 'not_active', workspace: { id: second, resolvedBy: 'explicit', active: false } });
    expect((await list()).activeWorkspaceId).toBe(main);
    expect(await command('workspace.tabs.activate', { tabId: opened['tabId'] }, { workspaceId: second })).toMatchObject({
      status: 'rejected', reason: 'not_active', workspace: { id: second },
    });
  });

  it('an agent stored write stamps the workspace and is named; a non-active target also gets a summary agent_change', async () => {
    capable.frames.length = 0;
    expect((await row(second)).last_agent_change_at).not.toBeNull();
    expect((await row(second)).last_agent_actor_id).toBe(member);
    await command('workspace.tabs.open', { kind: 'task', entityId: tasks[2], activate: false }, { workspaceId: second });
    expect(types()).toEqual(['workspace.state', 'workspace.summary']);
    expect(capable.frames[0]).toMatchObject({ workspaceId: second, active: false, cause: { actor: { actorClass: 'agent', actorName: 'Safety Human' } } });
    expect(capable.frames[1]).toMatchObject({ cause: { kind: 'agent_change', workspaceId: second, actorClass: 'agent' } });
    expect((capable.frames[1]!['items'] as Array<{ id: string; agentChangedSinceActive: boolean }>).find((w) => w.id === second))
      .toMatchObject({ agentChangedSinceActive: true });
    // The active one: the human sees it, so no summary and no dot.
    capable.frames.length = 0;
    await command('workspace.tabs.open', { kind: 'task', entityId: tasks[2], activate: false });
    expect(types()).toEqual(['workspace.state']);
    expect((await row(main)).last_agent_actor_id).toBe(member);
    // A human's write stamps nothing.
    const stamped = (await row(second)).last_agent_change_at;
    await command('workspace.tabs.open', { kind: 'task', entityId: tasks[3], activate: false }, { workspaceId: second }, asHuman);
    expect((await row(second)).last_agent_change_at).toEqual(stamped);
    // A window's draft write that fails is answered, not swallowed.
    capable.frames.length = 0;
    const draftId = randomUUID();
    await expect(control.handle(capable as never, JSON.stringify({
      spaceId, type: 'workspace.draft.patch', instanceId: 'safety-win', workspaceId: main, draftId, kind: 'task', fields: { title: { v: 'x', base: 0 } },
    }))).resolves.toBeUndefined();
    expect(capable.frames).toContainEqual(expect.objectContaining({ type: 'workspace.draft.rejected', workspaceId: main, draftId, reason: 'not_found' }));
  });

  it('D7: an agent closeVisible needs a pin once there are two workspaces; with one it applies', async () => {
    const before = await row(main);
    expect(await command('workspace.tabs.closeVisible', {})).toMatchObject({ status: 'rejected', reason: 'workspace_pin_required', workspace: { id: main } });
    expect((await row(main)).revision).toBe(before.revision);
    expect(await command('workspace.tabs.closeVisible', {}, {}, asHuman)).toMatchObject({ status: 'applied', workspace: { id: main } });
    expect(await command('workspace.tabs.closeVisible', {}, { workspaceId: second, expectedWorkspaceId: second })).toMatchObject({ status: 'applied', workspace: { id: second } });

    // Another space, one workspace: today's behaviour.
    const solo = (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', ['Solo', 'one workspace', 'private', null, null])).space.id;
    const task = (await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      solo, 'Solo task', (await memberForClaims(db, { identityId: human }, solo))!, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ])).entity.id;
    const inSolo = async (body: Data) => ((await registry.get('workspace.command')!({
      op: getOperation('workspace.command'), opName: 'workspace.command', params: { spaceId: solo }, query: new URLSearchParams(),
      body: { requestId: randomUUID(), ...body }, requestId: `req_${randomUUID()}`, identity: asAgent, headers: {}, method: 'POST', path: '/',
    } as unknown as RequestContext)) as { data: Data }).data;
    await inSolo({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: task, activate: false } });
    expect(await inSolo({ command: 'workspace.tabs.closeVisible', args: {} })).toMatchObject({ status: 'applied' });
  });

  it('a batch open is all or nothing: entity_unavailable names the unreadable, tab_limit past 50; it activates the first', async () => {
    const before = await row(main);
    const unreadable = randomUUID();
    expect(await command('workspace.tabs.open', { entities: [{ kind: 'task', entityId: tasks[0] }, { kind: 'task', entityId: unreadable }] })).toMatchObject({
      status: 'rejected', reason: 'entity_unavailable', unavailableEntityIds: [unreadable],
    });
    const fifty = tasks.slice(0, 50).map((entityId) => ({ kind: 'task', entityId }));
    expect(await command('workspace.tabs.open', { entities: fifty, activate: false })).toMatchObject({ status: 'applied' });
    expect((await stored(main)).orderedTabIds).toHaveLength(50);
    const full = await row(main);
    expect(Number(full.revision)).toBe(Number(before.revision) + 1);
    expect(await command('workspace.tabs.open', { entities: [{ kind: 'task', entityId: tasks[0] }, { kind: 'task', entityId: tasks[50] }] }))
      .toMatchObject({ status: 'rejected', reason: 'tab_limit' });
    expect((await row(main)).revision).toBe(full.revision);
    await command('workspace.tabs.closeVisible', {}, { expectedWorkspaceId: main });

    const batch = await command('workspace.tabs.open', { entities: [{ kind: 'task', entityId: tasks[50] }, { kind: 'task', entityId: tasks[51] }] });
    const tabIds = batch['tabIds'] as string[];
    // The stored workspace focuses the first; the test window doesn't answer the forward.
    expect(batch).toMatchObject({ status: 'applied', tabId: tabIds[0], outcomes: ['created', 'created'], activation: 'no_window' });
    expect((await stored(main)).recency[0]).toBe(tabIds[0]);
    await expect(command('workspace.tabs.open', { kind: 'task', entityId: tasks[0], entities: [{ kind: 'task', entityId: tasks[0] }] }))
      .resolves.toMatchObject({ status: 'rejected', reason: 'invalid_arguments' });
  });

  it('an agent switch raises Switch/Stay (newest supersedes); a human switch applies and supersedes; agents cannot answer', async () => {
    capable.frames.length = 0;
    const first = await switchTo(second, asAgent);
    expect(first).toMatchObject({
      status: 'requires_user_choice', reason: 'agent_switch', choices: ['switch', 'stay'], promptDelivered: 1, activeWorkspaceId: main,
      prompt: { kind: 'switch', workspaceId: second, workspaceName: 'Second', state: 'open', actorName: 'Safety Human' },
    });
    expect(await switchTo(main, asAgent)).toMatchObject({ status: 'no_op' });
    const newer = await switchTo(second, asAgent);
    const [a, b] = [first, newer].map((r) => (r['prompt'] as { promptId: string }).promptId);
    expect((await list()).prompts.map((p) => [p.promptId, p.state])).toEqual([[a, 'superseded'], [b, 'open']]);
    expect(capable.frames.filter((f) => f.type === 'workspace.prompt').map((f) => (f['prompt'] as { state: string }).state))
      .toEqual(['open', 'superseded', 'open']);
    await expect(resolve(b!, { choice: 'accept' }, asAgent)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'human_only' } });

    expect(await switchTo(second, asHuman)).toMatchObject({ status: 'applied', activeWorkspaceId: second });
    expect((await list()).prompts.find((p) => p.promptId === b)).toMatchObject({ state: 'superseded' });
    await expect(resolve(b!, { choice: 'accept' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'prompt_resolved' } });
    await expect(resolve(randomUUID(), { choice: 'accept' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'prompt_not_found' } });

    const back = await switchTo(main, asAgent);
    const accepted = await resolve((back['prompt'] as { promptId: string }).promptId, { choice: 'accept' });
    expect(accepted).toMatchObject({ status: 'applied', activeWorkspaceId: main, prompt: { state: 'accepted' } });
    const stay = await switchTo(second, asAgent);
    expect(await resolve((stay['prompt'] as { promptId: string }).promptId, { choice: 'decline' }))
      .toMatchObject({ prompt: { state: 'declined' }, activeWorkspaceId: main });
  });

  it('an agent deletes only its own, inactive, clean workspace (D6); otherwise it asks, and F1 needs discard', async () => {
    const own = ((await call('workspace.create', { requestId: randomUUID(), name: 'Scratch' }))['workspace'] as { id: string }).id;
    expect(await remove(own, asAgent)).toMatchObject({ status: 'applied', workspace: { id: own } });

    // Not its own: a Delete/Keep prompt; its discard is ignored (F3).
    const asked = await remove(second, asAgent, { discard: 'true' });
    expect(asked).toMatchObject({ status: 'requires_user_choice', reason: 'agent_delete', choices: ['delete', 'keep'], prompt: { kind: 'delete', workspaceId: second } });
    // Its own but active: asks too.
    const mine = ((await call('workspace.create', { requestId: randomUUID(), name: 'Mine' }))['workspace'] as { id: string }).id;
    await switchTo(mine, asHuman);
    expect(await remove(mine, asAgent)).toMatchObject({ status: 'requires_user_choice', reason: 'agent_delete' });
    await switchTo(main, asHuman);

    // F1: the workspace has a dirty draft; accepting without discard keeps the prompt open.
    await command('workspace.drafts.open', { kind: 'task' }, { workspaceId: second });
    const draft = Object.values((await stored(second)).tabs).find((t) => t.type === 'draft')!;
    await call('workspace.drafts.patch', { fields: { title: { v: 'Unsaved' } } }, { params: { draftId: draft.draftId! } });
    const promptId = (asked['prompt'] as { promptId: string }).promptId;
    expect(await resolve(promptId, { choice: 'accept' })).toMatchObject({
      status: 'rejected', reason: 'unsaved_changes', dirtyDraftIds: [draft.draftId], prompt: { state: 'open' },
    });
    expect(await resolve(promptId, { choice: 'accept', discard: true })).toMatchObject({ status: 'applied', prompt: { state: 'accepted' } });
    expect((await list()).items.map((w) => w.id)).not.toContain(second);
  });
});
