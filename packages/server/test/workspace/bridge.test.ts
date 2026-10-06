/**
 * The Workspace remote bridge (Spec C): who can see and drive which window,
 * and what a caller gets back when the window cannot answer.
 *
 * Seam tests over `WorkspaceBridge` and `createControlChannel` with fake
 * sinks, like test/w2/events-durable.test.ts. Every negative has a positive
 * half, so a bridge that refused everyone would fail here too.
 */
import { describe, expect, it } from 'vitest';
import { CollabError, type WorkspaceControlFrame } from '@tm8/contract';

import { createControlChannel, type SubscriptionAuthorizer } from '../../src/events/control.js';
import type { DurableEventLog } from '../../src/events/poll.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import type { EventSink } from '../../src/events/ws-connection.js';
import type { RequestIdentity } from '../../src/http/types.js';
import { WorkspaceBridge } from '../../src/workspace/bridge.js';

const SPACE = '019fb748-0068-76dc-9869-1bb36133c554';
const OTHER_SPACE = '019fb748-0068-76dc-9869-1bb36133c555';
const HUMAN = 'identity_owner';
const STRANGER = 'identity_other';

class Sink implements EventSink {
  readonly sent: string[] = [];
  isOpen = true;
  constructor(
    readonly id: string,
    readonly identity: RequestIdentity = { kind: 'auto-owner', identityId: HUMAN },
  ) {}
  send(text: string): void {
    if (!this.isOpen) throw new Error('closed');
    this.sent.push(text);
  }
  close(): void {
    this.isOpen = false;
  }
  onMessage(): void {}
  onClose(): void {}
  commands(): Array<Record<string, unknown>> {
    return this.sent.map((t) => JSON.parse(t) as Record<string, unknown>).filter((f) => f['type'] === 'workspace.command');
  }
}

type Register = Extract<WorkspaceControlFrame, { type: 'workspace.register' }>;

function reg(instanceId: string, extra: Partial<Register> = {}): Register {
  return {
    type: 'workspace.register',
    spaceId: SPACE,
    instanceId,
    windowId: `win-${instanceId}`,
    focused: false,
    visible: true,
    view: 'tabs',
    mounted: true,
    revision: 3,
    ...extra,
  };
}

function caught(promise: Promise<unknown>): Promise<CollabError> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error as CollabError,
  );
}

/** Wait until the sink has `n` forwarded commands. */
async function forwarded(sink: Sink, n = 1): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50 && sink.commands().length < n; i += 1) await Promise.resolve();
  const frame = sink.commands()[n - 1];
  if (!frame) throw new Error('no command was forwarded');
  return frame;
}

function answer(bridge: WorkspaceBridge, sink: Sink, frame: Record<string, unknown>, result: Record<string, unknown>) {
  return bridge.acceptResult(sink, {
    type: 'workspace.result',
    instanceId: frame['instanceId'] as string,
    requestId: frame['requestId'] as string,
    result,
  });
}

describe('discovery is per identity', () => {
  it('lists only the caller’s own windows, in the asked space', () => {
    const bridge = new WorkspaceBridge();
    bridge.register(new Sink('c1'), HUMAN, 'member_h', reg('i1'));
    bridge.register(new Sink('c2', { kind: 'bearer', identityId: STRANGER }), STRANGER, 'member_s', reg('i2'));
    bridge.register(new Sink('c3'), HUMAN, 'member_h', reg('i3', { spaceId: OTHER_SPACE }));

    expect(bridge.list(HUMAN, SPACE).map((v) => v.instanceId)).toEqual(['i1']);
    expect(bridge.list(STRANGER, SPACE).map((v) => v.instanceId)).toEqual(['i2']);
    // No titles, tab ids or entity ids in discovery.
    expect(Object.keys(bridge.list(HUMAN, SPACE)[0]!).sort()).toEqual([
      'connectedAt', 'focused', 'instanceId', 'lastFocusedAt', 'lastSeen', 'mounted', 'revision',
      'spaceId', 'view', 'viewerMemberId', 'visible', 'windowId',
    ]);
  });

  it('sorts most recently focused first and drops stale windows', () => {
    let now = 1_000_000;
    const bridge = new WorkspaceBridge({ now: () => now, staleAfterMs: 1000 });
    bridge.register(new Sink('c1'), HUMAN, 'm', reg('old', { focused: true }));
    now += 10;
    bridge.register(new Sink('c2'), HUMAN, 'm', reg('new', { focused: true }));
    expect(bridge.list(HUMAN, SPACE).map((v) => v.instanceId)).toEqual(['new', 'old']);
    now += 2000;
    bridge.register(new Sink('c2'), HUMAN, 'm', reg('new'));
    expect(bridge.list(HUMAN, SPACE).map((v) => v.instanceId)).toEqual(['new']);
  });

  it('refuses to let another identity take over an instance id', () => {
    const bridge = new WorkspaceBridge();
    const owner = new Sink('c1');
    expect(bridge.register(owner, HUMAN, 'm', reg('i1'))).toBe(true);
    expect(bridge.register(new Sink('c2'), STRANGER, 's', reg('i1'))).toBe(false);
    expect(bridge.list(HUMAN, SPACE)[0]?.instanceId).toBe('i1');
    expect(bridge.list(STRANGER, SPACE)).toEqual([]);
  });
});

describe('forwarding', () => {
  it('sends to the one owning connection and returns the window’s answer', async () => {
    const bridge = new WorkspaceBridge();
    const window = new Sink('c1');
    const bystander = new Sink('c2');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    bridge.register(bystander, HUMAN, 'm', reg('i2', { spaceId: OTHER_SPACE }));

    const pending = bridge.run({
      identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.tabs.open',
      args: { kind: 'task', entityId: 'e1' }, actorClass: 'agent', actorName: 'Worker',
    });
    const frame = await forwarded(window);
    expect(frame).toMatchObject({ command: 'workspace.tabs.open', actorClass: 'agent', actorName: 'Worker', instanceId: 'i1' });
    expect(bystander.sent).toEqual([]);

    // A result from a different connection does not complete it.
    expect(answer(bridge, bystander, frame, { status: 'applied', revision: 9 })).toBe(false);
    expect(answer(bridge, window, frame, { status: 'applied', revision: 4, tabId: 't1', outcome: 'created' })).toBe(true);
    await expect(pending).resolves.toEqual({
      requestId: 'r1', instanceId: 'i1', status: 'applied', revision: 4, tabId: 't1', outcome: 'created',
    });
  });

  it('never reaches another identity’s window, even when named', async () => {
    const bridge = new WorkspaceBridge();
    const theirs = new Sink('c1', { kind: 'bearer', identityId: STRANGER });
    bridge.register(theirs, STRANGER, 's', reg('theirs'));
    const error = await caught(bridge.run({
      identityId: HUMAN, spaceId: SPACE, requestId: 'r1', instanceId: 'theirs', command: 'workspace.inspect', actorClass: 'agent',
    }));
    expect(error.code).toBe('not_found');
    expect(error.details).toEqual({ reason: 'no_live_target', delivered: false });
    expect(theirs.sent).toEqual([]);
  });

  it('answers no_live_target when nobody is there, and does not record it', async () => {
    const bridge = new WorkspaceBridge();
    const first = await caught(bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.inspect', actorClass: 'human' }));
    expect(first.details).toEqual({ reason: 'no_live_target', delivered: false });

    // Once a window registers, the same request id runs instead of replaying "nobody".
    await Promise.resolve();
    const window = new Sink('c1');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    const pending = bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.inspect', actorClass: 'human' });
    answer(bridge, window, await forwarded(window), { status: 'no_op', revision: 3 });
    await expect(pending).resolves.toMatchObject({ status: 'no_op' });
  });

  it('a window that drops mid-command answers no_live_target, delivered', async () => {
    const bridge = new WorkspaceBridge();
    const window = new Sink('c1');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    const pending = caught(bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.tabs.close', args: { tabId: 't' }, actorClass: 'agent' }));
    await forwarded(window);
    bridge.dropConnection('c1');
    const error = await pending;
    expect(error.details).toEqual({ reason: 'no_live_target', delivered: true });
    expect(bridge.list(HUMAN, SPACE)).toEqual([]);
  });

  it('auto-picks only when the choice is unambiguous', async () => {
    const bridge = new WorkspaceBridge();
    const a = new Sink('ca');
    const b = new Sink('cb');
    bridge.register(a, HUMAN, 'm', reg('a'));
    bridge.register(b, HUMAN, 'm', reg('b'));
    const ambiguous = await caught(bridge.run({ identityId: HUMAN, spaceId: SPACE, command: 'workspace.inspect', actorClass: 'agent' }));
    expect(ambiguous.code).toBe('conflict');
    expect(ambiguous.details?.['reason']).toBe('ambiguous_target');
    expect((ambiguous.details?.['candidates'] as unknown[]).length).toBe(2);

    bridge.register(b, HUMAN, 'm', reg('b', { focused: true }));
    const pending = bridge.run({ identityId: HUMAN, spaceId: SPACE, command: 'workspace.inspect', actorClass: 'agent' });
    answer(bridge, b, await forwarded(b), { status: 'no_op', revision: 3 });
    await expect(pending).resolves.toMatchObject({ instanceId: 'b' });
    expect(a.commands()).toEqual([]);
  });

  it('a malformed answer is reported, not passed through', async () => {
    const bridge = new WorkspaceBridge();
    const window = new Sink('c1');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    const pending = bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r', command: 'workspace.inspect', actorClass: 'agent' });
    answer(bridge, window, await forwarded(window), { status: 'exploded' });
    await expect(pending).resolves.toMatchObject({ status: 'rejected', reason: 'malformed_result' });
  });
});

describe('request-id retry records', () => {
  it('times out, then a retry with the same id picks up the late answer without re-running', async () => {
    const bridge = new WorkspaceBridge();
    const window = new Sink('c1');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    const input = { identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.tabs.move', args: { tabId: 't', beforeTabId: 'u' }, timeoutMs: 500, actorClass: 'agent' as const };

    const timedOut = await caught(bridge.run(input));
    expect(timedOut.code).toBe('upstream_unavailable');
    expect(timedOut.details).toEqual({ reason: 'no_reply' });

    const frame = await forwarded(window);
    answer(bridge, window, frame, { status: 'applied', revision: 5 });
    // Same id, same payload (keys in another order): the recorded answer, no second forward.
    await expect(bridge.run({ ...input, args: { beforeTabId: 'u', tabId: 't' } })).resolves.toMatchObject({ status: 'applied', revision: 5 });
    expect(window.commands()).toHaveLength(1);
  });

  it('refuses the same id with different arguments', async () => {
    const bridge = new WorkspaceBridge();
    const window = new Sink('c1');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    const first = bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.tabs.activate', args: { tabId: 'a' }, actorClass: 'agent' });
    answer(bridge, window, await forwarded(window), { status: 'applied', revision: 4 });
    await first;
    const error = await caught(bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.tabs.activate', args: { tabId: 'b' }, actorClass: 'agent' }));
    expect(error.code).toBe('conflict');
    expect(error.details).toEqual({ reason: 'request_id_reused' });
  });

  it('records are per identity: the same id from someone else is a new request', async () => {
    const bridge = new WorkspaceBridge();
    const mine = new Sink('c1');
    const theirs = new Sink('c2', { kind: 'bearer', identityId: STRANGER });
    bridge.register(mine, HUMAN, 'm', reg('i1'));
    bridge.register(theirs, STRANGER, 's', reg('i2'));
    const a = bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.inspect', actorClass: 'agent' });
    answer(bridge, mine, await forwarded(mine), { status: 'no_op', revision: 1 });
    const b = bridge.run({ identityId: STRANGER, spaceId: SPACE, requestId: 'r1', command: 'workspace.inspect', actorClass: 'agent' });
    answer(bridge, theirs, await forwarded(theirs), { status: 'no_op', revision: 2 });
    await expect(a).resolves.toMatchObject({ instanceId: 'i1', revision: 1 });
    await expect(b).resolves.toMatchObject({ instanceId: 'i2', revision: 2 });
  });

  it('expires records after their lifetime', async () => {
    let now = 0;
    const bridge = new WorkspaceBridge({ now: () => now, retryTtlMs: 100, staleAfterMs: 1e9 });
    const window = new Sink('c1');
    bridge.register(window, HUMAN, 'm', reg('i1'));
    const run = () => bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.inspect', actorClass: 'agent' });
    const first = run();
    answer(bridge, window, await forwarded(window, 1), { status: 'no_op', revision: 1 });
    await first;
    now = 1000;
    // Any later recorded call sweeps; the expired id then runs fresh.
    const other = bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r2', command: 'workspace.inspect', actorClass: 'agent' });
    answer(bridge, window, await forwarded(window, 2), { status: 'no_op', revision: 1 });
    await other;
    const again = run();
    answer(bridge, window, await forwarded(window, 3), { status: 'no_op', revision: 7 });
    await expect(again).resolves.toMatchObject({ revision: 7 });
  });
});

describe('control frames', () => {
  const allowOnly = (spaceId: string): SubscriptionAuthorizer => ({
    canSubscribe: (_identity, asked) => Promise.resolve(asked === spaceId),
  });
  const log: DurableEventLog = { since: () => Promise.resolve({ items: [], nextCursor: '0' }) } as unknown as DurableEventLog;

  function channel(bridge: WorkspaceBridge, authorizer = allowOnly(SPACE)) {
    return createControlChannel({
      registry: new SubscriptionRegistry(),
      authorizer,
      log,
      claimsFor: (identity) => Promise.resolve({ identityId: identity.identityId ?? '' }),
      workspace: { bridge, memberFor: () => Promise.resolve('member_from_db') },
    });
  }

  it('registers under the socket’s identity and the member the node derived', async () => {
    const bridge = new WorkspaceBridge();
    const sink = new Sink('c1');
    await channel(bridge).handle(sink, JSON.stringify(reg('i1')));
    expect(bridge.list(HUMAN, SPACE)).toMatchObject([{ instanceId: 'i1', viewerMemberId: 'member_from_db' }]);
    expect(sink.sent).toEqual([]);
  });

  it('refuses a register for a space the caller cannot read, out loud', async () => {
    const bridge = new WorkspaceBridge();
    const sink = new Sink('c1');
    await channel(bridge).handle(sink, JSON.stringify(reg('i1', { spaceId: OTHER_SPACE })));
    expect(bridge.size()).toBe(0);
    expect(JSON.parse(sink.sent[0]!)).toEqual({ type: 'control.refused', frame: 'workspace.register', spaceId: OTHER_SPACE, reason: 'forbidden' });
  });

  it('rejects a register that tries to name its own member', async () => {
    const bridge = new WorkspaceBridge();
    const sink = new Sink('c1');
    await channel(bridge).handle(sink, JSON.stringify({ ...reg('i1'), viewerMemberId: 'someone_else' }));
    expect(bridge.size()).toBe(0);
    expect(JSON.parse(sink.sent[0]!)).toMatchObject({ type: 'control.refused', frame: 'workspace.register', reason: 'malformed' });
  });

  it('carries results and unregisters only from the owning connection', async () => {
    const bridge = new WorkspaceBridge();
    const sink = new Sink('c1');
    const other = new Sink('c2');
    const ch = channel(bridge);
    await ch.handle(sink, JSON.stringify(reg('i1')));
    const pending = bridge.run({ identityId: HUMAN, spaceId: SPACE, requestId: 'r1', command: 'workspace.inspect', actorClass: 'human' });
    await forwarded(sink);
    await ch.handle(sink, JSON.stringify({ type: 'workspace.result', instanceId: 'i1', requestId: 'r1', result: { status: 'no_op', revision: 3 } }));
    await expect(pending).resolves.toMatchObject({ status: 'no_op', revision: 3 });

    await ch.handle(other, JSON.stringify({ type: 'workspace.unregister', instanceId: 'i1' }));
    expect(bridge.size()).toBe(1);
    await ch.handle(sink, JSON.stringify({ type: 'workspace.unregister', instanceId: 'i1' }));
    expect(bridge.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The HTTP handlers: identity comes from the request, never the body.
// ---------------------------------------------------------------------------

import { getOperation, type OperationName } from '@tm8/contract';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerEventHandlers } from '../../src/events/handlers.js';

describe('workspace.* handlers', () => {
  const OWNER = { identityId: HUMAN, accountId: 'a', username: 'owner', isNodeAdmin: false, isOwner: true };

  function setup(readable = true) {
    const bridge = new WorkspaceBridge();
    const registry = new HandlerRegistry();
    const seen: Array<{ identityId: string | undefined }> = [];
    const db = {
      tx: async (claims: { identityId?: string }, fn: (q: unknown) => Promise<unknown>) => {
        seen.push({ identityId: claims.identityId });
        return fn({
          query: async (sql: string) => {
            if (sql.includes('from public.spaces')) return readable ? [{ '?column?': 1 }] : [];
            // loadActors' row for the agent's teammate.
            if (sql.includes('team_member_name')) {
              return [{ id: 'teammate', kind: 'team_member', space_id: SPACE, team_member_name: 'Worker' }];
            }
            return [];
          },
        });
      },
    } as unknown as Db;
    registerEventHandlers(registry, { db, config: {} as never, workspace: bridge, owner: () => Promise.resolve(OWNER) });
    // `async` so the registry's synchronous link-bearer refusal arrives as a rejection.
    const call = async (op: OperationName, identity: RequestContext['identity'], body?: unknown, query = '') =>
      registry.get(op)!({
        op: getOperation(op), opName: op, params: { spaceId: SPACE }, query: new URLSearchParams(query),
        body, requestId: 'req', identity, headers: {}, method: 'GET', path: '/',
      } as unknown as RequestContext) as Promise<{ data: unknown }>;
    return { bridge, call, seen };
  }

  it('an agent token lists its owner’s windows (it carries the owner’s identity)', async () => {
    const h = setup();
    h.bridge.register(new Sink('c1'), HUMAN, 'm', reg('mine'));
    h.bridge.register(new Sink('c2', { kind: 'bearer', identityId: STRANGER }), STRANGER, 's', reg('theirs'));
    const agent = { kind: 'bearer', identityId: HUMAN, actorId: 'teammate', authKind: 'agent' } as const;
    const out = await h.call('workspace.instances.list', agent);
    expect((out.data as { items: Array<{ instanceId: string }> }).items.map((i) => i.instanceId)).toEqual(['mine']);
  });

  it('forwards with actorClass agent and the actor’s name', async () => {
    const h = setup();
    const window = new Sink('c1');
    h.bridge.register(window, HUMAN, 'm', reg('mine'));
    const agent = { kind: 'bearer', identityId: HUMAN, actorId: 'teammate', authKind: 'agent' } as const;
    const pending = h.call('workspace.command', agent, { requestId: 'r1', command: 'workspace.dialogs.open', args: { dialogId: 'palette' } });
    const frame = await forwarded(window);
    expect(frame).toMatchObject({ actorClass: 'agent', actorName: 'Worker', command: 'workspace.dialogs.open' });
    answer(h.bridge, window, frame, { status: 'applied', revision: 3, dialogId: 'palette', dialogState: 'open' });
    await expect(pending).resolves.toMatchObject({ data: { status: 'applied', dialogState: 'open' } });
  });

  it('another member’s agent sees nothing and reaches nothing', async () => {
    const h = setup();
    const window = new Sink('c1');
    h.bridge.register(window, HUMAN, 'm', reg('mine'));
    const outsider = { kind: 'bearer', identityId: STRANGER, actorId: 'their_teammate', authKind: 'agent' } as const;
    const out = await h.call('workspace.instances.list', outsider);
    expect((out.data as { items: unknown[] }).items).toEqual([]);
    const error = await caught(h.call('workspace.inspect', outsider, undefined, 'instanceId=mine'));
    expect(error.details).toEqual({ reason: 'no_live_target', delivered: false });
    expect(window.sent).toEqual([]);
  });

  it('refuses a link session and an unreadable space', async () => {
    const link = { kind: 'bearer', identityId: HUMAN, authKind: 'link' } as const;
    const refused = await caught(setup().call('workspace.instances.list', link));
    expect(refused.code).toBe('forbidden');
    const hidden = await caught(setup(false).call('workspace.instances.list', { kind: 'auto-owner' }));
    expect(hidden.code).toBe('not_found');
  });

  it('auto-owner resolves to the node owner’s identity', async () => {
    const h = setup();
    h.bridge.register(new Sink('c1'), HUMAN, 'm', reg('mine'));
    const out = await h.call('workspace.instances.list', { kind: 'auto-owner' });
    expect((out.data as { items: unknown[] }).items).toHaveLength(1);
    expect(h.seen[0]?.identityId).toBe(HUMAN);
  });
});
