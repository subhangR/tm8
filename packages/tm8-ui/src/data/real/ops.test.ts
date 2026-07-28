/**
 * ops.ts — the four seam↔server divergences, pinned (see the ops.ts header).
 *
 * These are the tests that would fail the day the server or the seam moves, and
 * they are written so the failure names WHICH one moved.
 */
import { describe, expect, it } from 'vitest';
import { OPERATIONS, bindPath, isOperationName } from '@tm8/contract';
import { LIVENESS_OP, createOps, livenessPath } from './ops';
import { createHttpClient } from './http';
import { fakeFetch, type FakeFetch } from './test-support';

function harness(reply: unknown = {}): { ops: ReturnType<typeof createOps>; f: FakeFetch } {
  const f = fakeFetch(() => ({ data: reply }));
  const ops = createOps(createHttpClient({ fetch: f.fetch }), {
    newClientMutationId: (prefix) => `${prefix}_fixed`,
  });
  return { ops, f };
}

describe('ops: execution.liveness — catalog row A21 (Delta 2, dd41e89)', () => {
  it('the canary retired honestly: the row EXISTS and the catalog owns the path', () => {
    // This test spent its first life asserting the row's ABSENCE (the scheduled
    // failure that fired on Delta 2's landing, per the disposition written in
    // liveness-absent.itest.ts). It flips, as planned, to assert presence — and
    // the literal-path branch it guarded is deleted, so the catalog is now the
    // ONLY source of this path.
    expect(isOperationName(LIVENESS_OP)).toBe(true);
    const names: readonly string[] = OPERATIONS.map((op) => op.name);
    expect(names).toContain(LIVENESS_OP);
  });

  it('binds via the catalog to the C-1 path shape', () => {
    expect(livenessPath('sp-1')).toBe('/v2/spaces/sp-1/execution/liveness');
    expect(livenessPath('sp-1')).toBe(bindPath(LIVENESS_OP, { spaceId: 'sp-1' }));
  });

  it('percent-encodes the spaceId (bindPath property, inherited not reimplemented)', () => {
    expect(livenessPath('a/b')).toBe('/v2/spaces/a%2Fb/execution/liveness');
  });

  it('stamps spaceId onto the snapshot from the REQUEST (C-1 does not echo it)', async () => {
    const { ops } = harness({ liveEntityIds: ['ws-1'], nodeBootId: 'boot-A', checkedAt: '2026-07-28T12:00:00.000Z' });
    const snap = await ops.liveness('sp-9');
    expect(snap).toEqual({
      spaceId: 'sp-9',
      liveEntityIds: ['ws-1'],
      nodeBootId: 'boot-A',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });
  });
});

describe('ops: divergence 1 — no task route; fields travel inside content', () => {
  it('createTask posts kind:"task" with content-nested payload fields', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.createTask({
      clientMutationId: 'cmid-1',
      spaceId: 'sp-1',
      title: 'ship it',
      description: 'the description',
      priority: 'high',
      pointsEstimate: 3,
      dueDate: null,
      parentId: 'e-parent',
    });

    expect(f.last().method).toBe('POST');
    expect(f.last().url).toBe('/v2/entities');
    expect(f.last().body).toEqual({
      parentId: 'e-parent',
      clientMutationId: 'cmid-1',
      spaceId: 'sp-1',
      kind: 'task',
      title: 'ship it',
      // Top-level task fields would be a 400: CreateEntityInputSchema is strict.
      content: { description: 'the description', priority: 'high', pointsEstimate: 3, dueDate: null },
    });
  });

  it('synthesizes a clientMutationId only when the caller omitted one (it is required server-side)', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.createTask({ spaceId: 'sp-1', title: 't' });
    expect((f.last().body as { clientMutationId: string }).clientMutationId).toBe('task_fixed');
  });

  it('patchTask nests workStatus in content — update_task_content reads it from there', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.patchTask('e-1', { expectedVersion: 4, workStatus: 'working', title: 'renamed' });

    expect(f.last().method).toBe('PATCH');
    expect(f.last().url).toBe('/v2/entities/e-1');
    expect(f.last().body).toEqual({
      title: 'renamed',
      expectedVersion: 4,
      content: { workStatus: 'working' },
    });
  });

  it('preserves an explicit null (clears the field) while dropping undefined', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.patchTask('e-1', { expectedVersion: 1, dueDate: null });
    expect(f.last().body).toEqual({ expectedVersion: 1, content: { dueDate: null } });
  });
});

describe('ops: divergence 2 — editMessage lifts a bare MessageView', () => {
  it('wraps the returned view as the authoritative patch list, inventing nothing', async () => {
    const view = { id: 'm-1', title: 'msg', version: 2 };
    const { ops } = harness(view);
    const result = await ops.editMessage('m-1', { clientMutationId: 'c', expectedVersion: 1, body: 'edited' });
    expect(result).toEqual({ patches: [view] });
    expect(result).not.toHaveProperty('entity');
  });
});

describe('ops: divergence 3 — the mutation ids the seam has no slot for', () => {
  it('markRead synthesizes the clientMutationId the server requires', async () => {
    const { ops, f } = harness({});
    await ops.markRead('n-1');
    expect(f.last().method).toBe('PUT');
    expect(f.last().url).toBe('/v2/inbox/n-1/read');
    expect(f.last().body).toEqual({ clientMutationId: 'read_fixed' });
  });

  it('upsertReadMark does NOT send lastReadAt — the schema is strict and the server stamps it', async () => {
    const { ops, f } = harness({});
    await ops.upsertReadMark('a-1');
    expect(f.last().url).toBe('/v2/read-marks/a-1');
    expect(f.last().body).toEqual({ clientMutationId: 'mark_fixed' });
    expect(f.last().body).not.toHaveProperty('lastReadAt');
  });
});

describe('ops: command bodies the server actually requires', () => {
  it('DELETE carries the command context as a body', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.deleteEntity('e-1', { clientMutationId: 'cmid-9' });
    expect(f.last().method).toBe('DELETE');
    expect(f.last().body).toEqual({ clientMutationId: 'cmid-9' });
  });

  it('an omitted context reaches the server as {} — an honest invalid_input, not a forged id', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.deleteEntity('e-1');
    expect(f.last().body).toEqual({});
  });
});

describe('ops: events.poll cursor vocabulary', () => {
  it('sends since as a decimal integer (a non-numeric value is a hard 400 invalid_cursor)', async () => {
    const { ops, f } = harness({ items: [], nextCursor: '0' });
    await ops.pollEvents('sp-1', 41, 200);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/spaces/sp-1/events?since=41&limit=200');
    // The control: no `cursor` param exists on this op.
    expect(f.last().url).not.toContain('cursor=');
  });
});

describe('ops: paged reads carry cursor + limit', () => {
  it('children, activity, messages and handoffs all page the same way', async () => {
    const { ops, f } = harness({ items: [], nextCursor: null });
    await ops.children('e-1', { cursor: 'c1', limit: 10 });
    expect(f.last().url).toBe('/v2/entities/e-1/children?cursor=c1&limit=10');
    await ops.activity('e-1', { cursor: 'c2' });
    expect(f.last().url).toBe('/v2/entities/e-1/activity?cursor=c2');
    await ops.messages('a-1', { limit: 5 });
    expect(f.last().url).toBe('/v2/entities/a-1/messages?limit=5');
    await ops.handoffs('ws-1');
    expect(f.last().url).toBe('/v2/work-sessions/ws-1/handoffs');
  });

  it('feed carries scope beside the page opts', async () => {
    const { ops, f } = harness({ items: [], nextCursor: null, previousCursor: null });
    await ops.feed('e-1', { scope: 'session_chat_v1', limit: 20 });
    expect(f.last().url).toBe('/v2/entities/e-1/feed?limit=20&scope=session_chat_v1');
  });
});
