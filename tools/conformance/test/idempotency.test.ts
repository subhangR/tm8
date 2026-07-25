/**
 * DEV-9 — universal idempotency via the command ledger (04 §5, 01 §S8):
 * a retry with the same `clientMutationId` + same operation replays the stored
 * CommandResult as a no-op; the same id on a DIFFERENT operation is a
 * `409 invariant_violation`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { api, expectError } from '../src/client.js';
import { buildWorld, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('idem');
});

describe('idempotent replay (DEV-9)', () => {
  it('entities.create replays identically for a duplicate clientMutationId', async () => {
    const input = {
      spaceId: w.spaceId, kind: 'task', title: 'Once only', parentId: w.epic,
      clientMutationId: `cmid-once-${randomUUID()}`,
    };
    const first = await api.command('entities.create', input) as { entity?: { id: string } };
    const second = await api.command('entities.create', input) as { entity?: { id: string } };
    expect(second.entity?.id).toBe(first.entity?.id);
    const tasks = await api.command('collections.query', { spaceId: w.spaceId, kinds: ['task'] }) as { page: { items: { title: string }[] } };
    expect(tasks.page.items.filter((i) => i.title === 'Once only')).toHaveLength(1);
  });

  it('edges.create retries do not duplicate the edge', async () => {
    const id = `cmid-edge-${randomUUID()}`;
    await api.command('edges.create', { srcId: w.t104, dstId: w.docSpec, type: 'relates_to', clientMutationId: id });
    await api.command('edges.create', { srcId: w.t104, dstId: w.docSpec, type: 'relates_to', clientMutationId: id });
    const t104 = await api.read('entities.get', { id: w.t104 }) as { connections: { outgoing: { type: string; edges: unknown[] }[] } };
    const relates = t104.connections.outgoing.find((g) => g.type === 'relates_to');
    expect(relates?.edges).toHaveLength(1);
  });

  it('points grants dedupe on clientMutationId', async () => {
    const id = `cmid-pts-${randomUUID()}`;
    await api.command('entities.points.add', { amount: 5, reason: 'grant', clientMutationId: id }, { id: w.t104 });
    await api.command('entities.points.add', { amount: 5, reason: 'grant', clientMutationId: id }, { id: w.t104 });
    const t104 = await api.read('entities.get', { id: w.t104 }) as { counters: { points: number } };
    expect(t104.counters.points).toBe(5);
  });

  it('same clientMutationId on a DIFFERENT operation → 409 invariant_violation', async () => {
    const id = `cmid-cross-${randomUUID()}`;
    await api.command('messages.post', { anchorId: w.t104, body: 'first use', clientMutationId: id });
    await expectError(
      api.command('entities.points.add', { amount: 1, reason: 'grant', clientMutationId: id }, { id: w.t104 }),
      'invariant_violation',
    );
  });
});
