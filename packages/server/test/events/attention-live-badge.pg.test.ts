/**
 * Attention v2 S2 (G3) end to end: an attention create or resolve reaches an
 * already-subscribed socket as a FULL `entity.upsert` whose summary carries the
 * new badge, inside the 5s the spec allows.
 *
 * Before migration 254 both writes arrived as the thin `entity.activity_touched`
 * (`{id, kind, activity_at}`), so a tile or the graph kept the old badge. The
 * path here is the production one: HTTP command -> RPC -> attention_requests
 * flag trigger -> capture trigger -> pump -> projector (`attention_badges`) ->
 * socket frame.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  collect,
  connectWs,
  send,
  startWsE2eNode,
  type FrameCollector,
  type WsE2eNode,
} from './ws-e2e-harness.js';

/** G3: "a few seconds is fine"; the S2 acceptance bar is 5s end to end. */
const LIVE_BUDGET_MS = 5_000;

interface EntityFrame {
  type: string;
  entity?: { id: string; badges?: { attention?: { pendingCount?: number } | null } };
  entityId?: string;
  id?: string;
}

let node: WsE2eNode;
let spaceId: string;
let ws: WebSocket;
let frames: FrameCollector;

const cmid = () => `attention-live-${randomUUID()}`;

beforeAll(async () => {
  node = await startWsE2eNode('attention_live');
  const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', {
    name: 'attention live badge',
    clientMutationId: cmid(),
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  spaceId = created.data!.space.id;
  ws = await connectWs(node.wsUrl);
  frames = collect(ws);
  send(ws, { type: 'subscribe', spaceIds: [spaceId] });
}, 180_000);

afterAll(async () => {
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
  await node?.close();
});

async function createTask(title: string): Promise<string> {
  const res = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
    spaceId,
    kind: 'task',
    title,
    clientMutationId: cmid(),
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.entity.id;
}

/** The first entity frame for `id` after frame index `from`, and how long it took. */
async function nextEntityFrame(id: string, from: number, started: number): Promise<{
  frame: EntityFrame;
  ms: number;
  types: string[];
}> {
  const mine = (f: unknown) => {
    const e = f as EntityFrame;
    return e.type.startsWith('entity.') && (e.entity?.id ?? e.entityId ?? e.id) === id;
  };
  const frame = await frames.next(
    (f) => mine(f) && frames.all.indexOf(f) >= from && (f as EntityFrame).type === 'entity.upsert',
    LIVE_BUDGET_MS,
  ) as EntityFrame;
  const ms = Date.now() - started;
  return { frame, ms, types: frames.since(from).filter(mine).map((f) => (f as EntityFrame).type) };
}

describe('attention writes reach an open socket as a badge-carrying entity.upsert (S2)', () => {
  it('create raises the badge, resolve clears it, each inside the 5s budget', async () => {
    const taskId = await createTask(`live badge ${randomUUID()}`);
    // Let the create's own upsert land so it cannot satisfy the waits below.
    await frames.next((f) => (f as EntityFrame).entity?.id === taskId, LIVE_BUDGET_MS);

    let from = frames.all.length;
    let started = Date.now();
    const raised = await node.request('POST', `/v2/entities/${taskId}/attention-requests`, {
      reason: 'Live badge probe',
      points: 40,
      clientMutationId: cmid(),
    });
    expect(raised.status, JSON.stringify(raised.error)).toBe(201);
    const onCreate = await nextEntityFrame(taskId, from, started);
    expect(onCreate.frame.entity!.badges!.attention!.pendingCount).toBe(1);
    expect(onCreate.ms).toBeLessThan(LIVE_BUDGET_MS);
    // The write's touch is the full upsert, not a thin one beside it.
    expect(onCreate.types).not.toContain('entity.activity_touched');

    from = frames.all.length;
    started = Date.now();
    const resolved = await node.request('POST', `/v2/entities/${taskId}/attention-requests/resolve`, {
      clientMutationId: cmid(),
    });
    expect(resolved.status, JSON.stringify(resolved.error)).toBeLessThan(300);
    const onResolve = await nextEntityFrame(taskId, from, started);
    expect(onResolve.frame.entity!.badges!.attention ?? null).toBeNull();
    expect(onResolve.ms).toBeLessThan(LIVE_BUDGET_MS);
    expect(onResolve.types).not.toContain('entity.activity_touched');
  }, 60_000);
});
