/**
 * AUDIT (task 01a1181c, 2026-10-07) — FAILING tests that prove the server
 * half of the stale workspace numbers and the S12 gaps, against a REAL
 * database. On e71efecdc every test here FAILS. Ids F1… match the findings
 * doc; packages/tm8-ui/src/tab-workspace/bridge/audit-multiws.test.ts is the
 * window half.
 *
 * The switcher's numbers (tab count, activity dot) come ONLY from
 * `workspace.summary` frames and one HTTP `workspace.list` at proof time.
 * The node sends a summary on list changes and on an agent's write to a
 * NON-active workspace (service.ts:692) — never after any other content write.
 *
 * Run: TM8_DATABASE_URL=postgres://… npx vitest run test/workspace/audit-multiws.pg.test.ts
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
interface Item { id: string | null; name: string; tabCount: number; draftCount: number; agentChangedSinceActive: boolean }
const describeIfPg = url === undefined ? describe.skip : describe;

describeIfPg('AUDIT: what a capable window hears after content writes (real Postgres)', () => {
  let db: TestDb;
  let spaceId: string;
  let freshSpaceId: string;
  let member: string;
  const tasks: string[] = [];
  const human = `identity_${randomUUID()}`;
  const bridge = new WorkspaceBridge();
  const registry = new HandlerRegistry();
  const claims = (): DbClaims => ({ identityId: human, nodeAdmin: false, requestId: `req_${randomUUID()}` });
  let asHuman: RequestContext['identity'];
  let asAgent: RequestContext['identity'];
  let asUnboundAgent: RequestContext['identity'];
  let control: ReturnType<typeof createControlChannel>;

  class Win {
    readonly frames: Frame[] = [];
    readonly identity = { kind: 'auto-owner', identityId: human } as RequestContext['identity'];
    isOpen = true;
    constructor(readonly id: string) {}
    send(text: string): void {
      this.frames.push(JSON.parse(text) as Frame);
    }
  }

  const call = async (op: OperationName, body: unknown, opts: { as?: RequestContext['identity']; space?: string; query?: Record<string, string>; method?: string } = {}) =>
    ((await registry.get(op)!({
      op: getOperation(op), opName: op, params: { spaceId: opts.space ?? spaceId }, query: new URLSearchParams(opts.query),
      body, requestId: `req_${randomUUID()}`, identity: opts.as ?? asHuman, headers: {}, method: opts.method ?? 'POST', path: '/',
    } as unknown as RequestContext)) as { data: Data }).data;
  const list = async (space = spaceId) => (await call('workspace.list', undefined, { space, method: 'GET' })) as { items: Item[]; activeWorkspaceId: string };
  const reg = (instanceId: string, space: string, extra: Data = {}) => ({
    type: 'workspace.register', spaceId: space, instanceId, windowId: instanceId, focused: true, visible: true, view: 'tabs', mounted: true, revision: 0, ...extra,
  });
  const send = (win: Win, frame: Data) => control.handle(win as never, JSON.stringify(frame));
  /** The numbers the window's switcher shows: the items of the LAST summary it received. */
  const shownCount = (win: Win, workspaceId: string) => {
    const last = [...win.frames].reverse().find((f) => f.type === 'workspace.summary');
    return (last?.['items'] as Item[] | undefined)?.find((w) => w.id === workspaceId);
  };
  const newTask = async (title: string) =>
    (await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      spaceId, title, member, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ])).entity.id;

  beforeAll(async () => {
    db = createTestDb(url!);
    await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Auditor', null, null]);
    const space = async (name: string) =>
      (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', [name, 'workspace audit', 'private', null, null])).space.id;
    spaceId = await space('Audit space');
    freshSpaceId = await space('Audit fresh space');
    member = (await memberForClaims(db, { identityId: human }, spaceId))!;
    for (const title of ['One', 'Two', 'Three', 'Four']) tasks.push(await newTask(title));
    asHuman = { kind: 'bearer', identityId: human, authKind: 'cli' } as RequestContext['identity'];
    asAgent = { kind: 'bearer', identityId: human, actorId: member, authKind: 'agent' } as RequestContext['identity'];
    asUnboundAgent = { kind: 'bearer', identityId: human, authKind: 'agent' } as RequestContext['identity'];
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
    // Main (active) + Review, then a capable window on Main.
    await call('workspace.create', { requestId: randomUUID(), name: 'Review' });
  });

  afterAll(async () => {
    await db?.end();
  });

  it('F1c: the window’s own tab open in the active workspace — the node sends no summary, the switcher keeps the old count', async () => {
    const { items, activeWorkspaceId: main } = await list();
    const win = new Win('conn-f1c');
    await send(win, reg('win-f1c', spaceId, { caps: ['multiWorkspace'], workspaceId: main }));
    // A capable FIRST register gets the snapshot, summary first (§7.4).
    expect(win.frames[0]?.type).toBe('workspace.summary');
    const before = items.find((w) => w.id === main)!.tabCount;
    win.frames.length = 0;
    await send(win, {
      type: 'workspace.apply', spaceId, instanceId: 'win-f1c', requestId: randomUUID(), workspaceId: main, ids: [randomUUID()],
      env: { command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[0] }, source: 'click' },
    });
    await new Promise((r) => setTimeout(r, 200));
    // The truth (HTTP) moved…
    expect((await list()).items.find((w) => w.id === main)!.tabCount).toBe(before + 1);
    // …and the window only heard a workspace.state: no summary carries the new count.
    expect(win.frames.map((f) => f.type)).toContain('workspace.summary');
    expect(shownCount(win, main)?.tabCount).toBe(before + 1);
  });

  it('F1d: an agent opens a tab in the ACTIVE workspace over HTTP — no summary, stale count', async () => {
    const { activeWorkspaceId: main } = await list();
    const win = new Win('conn-f1d');
    await send(win, reg('win-f1d', spaceId, { caps: ['multiWorkspace'], workspaceId: main }));
    const before = shownCount(win, main)!.tabCount;
    win.frames.length = 0;
    const result = await call('workspace.command', {
      requestId: randomUUID(), command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[1], activate: false },
    }, { as: asAgent });
    expect(result).toMatchObject({ status: 'applied', workspace: { id: main, active: true } });
    expect(win.frames.map((f) => f.type)).toContain('workspace.summary');
    expect(shownCount(win, main)?.tabCount).toBe(before + 1);
  });

  it('F1e: the human’s own CLI open into a NON-active workspace (--workspace) — no summary, stale count', async () => {
    const { items, activeWorkspaceId: main } = await list();
    const review = items.find((w) => w.name === 'Review')!.id!;
    const win = new Win('conn-f1e');
    await send(win, reg('win-f1e', spaceId, { caps: ['multiWorkspace'], workspaceId: main }));
    const before = shownCount(win, review)!.tabCount;
    win.frames.length = 0;
    const result = await call('workspace.command', {
      requestId: randomUUID(), command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[2] }, workspaceId: review,
    });
    expect(result).toMatchObject({ status: 'applied', activation: 'not_active', workspace: { id: review, active: false } });
    expect(shownCount(win, review)?.tabCount ?? before).toBe(before + 1);
  });

  it('F4: an agent bearer with no persona binding (no actorId) writes to a non-active workspace — no activity dot, no summary', async () => {
    const { items, activeWorkspaceId: main } = await list();
    const review = items.find((w) => w.name === 'Review')!.id!;
    const win = new Win('conn-f4');
    await send(win, reg('win-f4', spaceId, { caps: ['multiWorkspace'], workspaceId: main }));
    win.frames.length = 0;
    const result = await call('workspace.command', {
      requestId: randomUUID(), command: 'workspace.tabs.open', args: { kind: 'task', entityId: tasks[3] }, workspaceId: review,
    }, { as: asUnboundAgent });
    expect(result).toMatchObject({ status: 'applied', workspace: { id: review, active: false } });
    // service.ts:675 stamps (and :692 summarises) only when claims.actorId is set.
    expect((await list()).items.find((w) => w.id === review)!.agentChangedSinceActive).toBe(true);
    expect(shownCount(win, review)?.agentChangedSinceActive).toBe(true);
  });

  it('F2d: workspace.create for an identity with no row materialises Main but pushes no workspace.state for it', async () => {
    const win = new Win('conn-f2d');
    await send(win, reg('win-f2d', freshSpaceId, { caps: ['multiWorkspace'], workspaceId: null }));
    // Snapshot of a no-row identity: summary (synthetic Main, id null) + state null.
    expect(win.frames.find((f) => f.type === 'workspace.state')).toMatchObject({ workspaceId: null, state: null });
    win.frames.length = 0;
    const created = await call('workspace.create', { requestId: randomUUID() }, { space: freshSpaceId });
    const main = created['activeWorkspaceId'] as string;
    expect(main).toEqual(expect.any(String));
    // The window is told Main (a real id now) is active — but never gets Main's state,
    // so its sync waits for it forever (switching) and keeps addressing null.
    expect(win.frames.map((f) => f.type)).toEqual(['workspace.summary']);
    expect(win.frames.some((f) => f.type === 'workspace.state' && f['workspaceId'] === main)).toBe(true);
  });

  it('F2e: the first window write of a no-row identity creates Main; capable windows get no summary naming its real id', async () => {
    const space = (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', ['Audit fresh 2', 'audit', 'private', null, null])).space.id;
    const win = new Win('conn-f2e');
    await send(win, reg('win-f2e', space, { caps: ['multiWorkspace'], workspaceId: null }));
    win.frames.length = 0;
    await send(win, {
      type: 'workspace.apply', spaceId: space, instanceId: 'win-f2e', requestId: randomUUID(), workspaceId: null, ids: [randomUUID()],
      env: { command: 'workspace.drafts.open', args: { kind: 'task' }, source: 'click' },
    });
    await new Promise((r) => setTimeout(r, 200));
    const state = win.frames.find((f) => f.type === 'workspace.state');
    expect(state?.['workspaceId']).toEqual(expect.any(String));
    // The window's list still names the synthetic Main (id null) as active.
    expect(win.frames.some((f) => f.type === 'workspace.summary' && f['activeWorkspaceId'] === state?.['workspaceId'])).toBe(true);
  });
});
