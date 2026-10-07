/**
 * The server-level integration test that stands in for browser E2E (decision
 * E): an agent works through a job while the human switches workspaces under
 * it. Real Postgres, the real handlers and control channel, two windows.
 *
 *   1. untargeted agent opens land in the active workspace, both windows see them;
 *   2. the human switches; both windows follow (R7);
 *   3. the agent's next batch, pinned to where it started, is refused whole:
 *      `conflict` / `workspace_switched`, and neither workspace changes.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
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
const itIfPg = url === undefined ? it.skip : it;

let db: TestDb;
let spaceId: string;
let member: string;
const tasks: string[] = [];
const human = `identity_${randomUUID()}`;
const bridge = new WorkspaceBridge();
const registry = new HandlerRegistry();
const asHuman = { kind: 'bearer', identityId: human, authKind: 'cli' } as const;
let asAgent: RequestContext['identity'];
const claims = (): DbClaims => ({ identityId: human, nodeAdmin: false, requestId: `req_${randomUUID()}` });

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
const laptop = new Win('conn-laptop');
const desktop = new Win('conn-desktop');

const call = async (op: OperationName, body: unknown, as: RequestContext['identity'], params: Record<string, string> = {}): Promise<Data> =>
  ((await registry.get(op)!({
    op: getOperation(op), opName: op, params: { spaceId, ...params }, query: new URLSearchParams(),
    body, requestId: `req_${randomUUID()}`, identity: as, headers: {}, method: 'POST', path: '/',
  } as unknown as RequestContext)) as { data: Data }).data;
const open = (args: Data, extra: Data = {}) =>
  call('workspace.command', { requestId: randomUUID(), command: 'workspace.tabs.open', args, ...extra }, asAgent);
const tabsIn = async (workspaceId: string) => (await db.asOwner((q) => q.query<{ revision: string; tabs: string[] }>(
  `select revision, coalesce((select array_agg(t.value->>'entityId') from jsonb_each(state->'tabs') t), '{}') as tabs
     from public.workspaces where workspace_id = $1`, [workspaceId],
)))[0]!;

beforeAll(async () => {
  if (url === undefined) return;
  db = createTestDb(url);
  await db.rpc({ identityId: human }, 'public.upsert_user_profile', ['Flow Human', null, null]);
  spaceId = (await db.rpc<{ space: { id: string } }>({ identityId: human }, 'public.create_space', [
    'Flow space', 'agent flow proof', 'private', null, null,
  ])).space.id;
  member = (await memberForClaims(db, { identityId: human }, spaceId))!;
  asAgent = { kind: 'bearer', identityId: human, actorId: member, authKind: 'agent' } as RequestContext['identity'];
  for (const title of ['Spec', 'Plan', 'Review', 'Ship']) {
    tasks.push((await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      spaceId, title, member, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ])).entity.id);
  }
  const service = new WorkspaceService({ db, bridge });
  registerEventHandlers(registry, { db, config: {} as never, workspace: bridge, workspaceService: service, owner: () => Promise.resolve({
    identityId: human, accountId: '00000000-0000-0000-0000-000000000000', username: 'h', isNodeAdmin: false, isOwner: true,
  }) });
  const control = createControlChannel({
    registry: new SubscriptionRegistry(),
    authorizer: { canSubscribe: () => Promise.resolve(true) } as unknown as SubscriptionAuthorizer,
    log: {} as DurableEventLog,
    claimsFor: () => Promise.resolve(claims()),
    workspace: { bridge, service, memberFor: () => Promise.resolve(member) },
  });
  for (const win of [laptop, desktop]) {
    await control.handle(win as never, JSON.stringify({
      spaceId, type: 'workspace.register', instanceId: `${win.id}-w`, windowId: win.id, focused: false, visible: true,
      view: 'tabs', mounted: true, revision: 0, caps: ['multiWorkspace'],
    }));
  }
});

afterAll(async () => {
  await db?.end();
});

itIfPg('an agent job across a human switch: untargeted opens land in active; the pinned rest is refused whole', async () => {
  // Two workspaces: "Main" (active, S12) and "Research".
  const research = ((await call('workspace.create', { requestId: randomUUID(), name: 'Research' }, asHuman))['workspace'] as { id: string }).id;
  const main = (await call('workspace.list', undefined, asHuman))['activeWorkspaceId'] as string;

  // 1. The agent's first steps carry no target: they land in the active one.
  const first = await open({ kind: 'task', entityId: tasks[0], activate: false });
  const startedIn = (first['workspace'] as { id: string }).id;
  expect(first).toMatchObject({ status: 'applied', workspace: { id: main, resolvedBy: 'active', active: true } });
  expect(await open({ kind: 'task', entityId: tasks[1], activate: false }, { expectedWorkspaceId: startedIn }))
    .toMatchObject({ status: 'applied', workspace: { id: main } });
  for (const win of [laptop, desktop]) {
    expect(win.frames.filter((f) => f.type === 'workspace.state' && f['workspaceId'] === main).at(-1))
      .toMatchObject({ active: true, cause: { actor: { actorClass: 'agent' } } });
  }

  // 2. The human switches mid-job; both windows follow.
  for (const win of [laptop, desktop]) win.frames.length = 0;
  expect(await call('workspace.switch', { requestId: randomUUID() }, asHuman, { workspaceId: research }))
    .toMatchObject({ status: 'applied', activeWorkspaceId: research });
  for (const win of [laptop, desktop]) {
    expect(win.frames[0]).toMatchObject({ type: 'workspace.switched', workspaceId: research, previousWorkspaceId: main });
  }

  // 3. The rest of the job, pinned to where it started: refused whole, nothing applied anywhere.
  const [mainBefore, researchBefore] = [await tabsIn(main), await tabsIn(research)];
  const rest = await open({ entities: [{ kind: 'task', entityId: tasks[2] }, { kind: 'task', entityId: tasks[3] }] }, { expectedWorkspaceId: startedIn });
  expect(rest).toMatchObject({ status: 'conflict', reason: 'workspace_switched', expectedWorkspaceId: main, activeWorkspaceId: research });
  expect([await tabsIn(main), await tabsIn(research)]).toEqual([mainBefore, researchBefore]);
  expect(mainBefore.tabs.sort()).toEqual([tasks[0], tasks[1]].sort());

  // Without a pin the agent would have landed in the new active workspace: the pin is what kept it honest.
  expect(await open({ kind: 'task', entityId: tasks[2], activate: false })).toMatchObject({ workspace: { id: research, active: true } });
});
