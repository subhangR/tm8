/**
 * The `workspace.*` handlers and the register-time member lookup against a
 * REAL database (Spec C). The seam tests in bridge.test.ts fake the queries;
 * this file runs the SQL itself, which is where a wrong column hides.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getOperation, type OperationName } from '@tm8/contract';

import { registerEventHandlers } from '../../src/events/handlers.js';
import { HandlerRegistry } from '../../src/facade/index.js';
import type { RequestContext } from '../../src/http/types.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';
import { memberForClaims } from '../../src/workspace/handlers.js';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../events/pg-harness.js';

const url = TEST_DATABASE_URL;
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
