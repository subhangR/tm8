/**
 * A hand-written attention seam for the module's tests: rows live in `table`,
 * the list op filters them by status like the server, updates enforce
 * `expectedVersion` (050:126), a resolve stamps its batch and `unresolve`
 * reopens only that batch, and `upsert` fires an `entity.upsert` to every
 * subscriber (the store subscribes twice).
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  AttentionRequest,
  AttentionRequestListQuery,
  DurableWorkspaceEvent,
  EntityAttentionSummary,
  EntityId,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';
import type { AttentionSeam } from './attention-commands';

export const SPACE = 'space-1' as SpaceId;
export const ME = 'member-me';

let seq = 0;
export const nextId = (): string => `id-${++seq}`;
export function req(over: Partial<AttentionRequest> & { entityId: string }): AttentionRequest {
  seq += 1;
  return {
    id: over.id ?? `req-${seq}`,
    spaceId: SPACE,
    reason: over.reason ?? 'because',
    points: over.points ?? 40,
    status: over.status ?? 'open',
    version: over.version ?? 1,
    requestedBy: { id: 'agent-1' as EntityId, kind: 'member', displayName: 'Agent', avatar: null, isAgent: true },
    acknowledgedBy: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: over.createdAt ?? '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    ...over,
  } as AttentionRequest;
}

export function badge(pendingCount: number, totalPoints = 40 * pendingCount): EntityAttentionSummary {
  return { pendingCount, totalPoints, maxPoints: 40, latestReason: 'why', oldestRequestedAt: '2026-09-26T10:00:00.000Z' };
}

export function summary(id: string, attention: EntityAttentionSummary | null): EntitySummary {
  return { id, badges: { attention } } as unknown as EntitySummary;
}

export function fakeSeam(
  initial: AttentionRequest[],
  options: { v2?: boolean; failResolve?: boolean; gate?: Promise<void>; failUpdateFor?: string } = {},
) {
  const table = { rows: [...initial] };
  const listeners: ((e: DurableWorkspaceEvent) => void)[] = [];
  const pendingOn = (id: string) => table.rows.filter((r) => (r.rootId ?? r.entityId) === id && (r.status === 'open' || r.status === 'acknowledged'));
  const result = (id: string) => ({ request: null, entity: summary(id, pendingOn(id).length ? badge(pendingOn(id).length) : null), affectedCount: 1 });

  const attentionRequests = vi.fn(async (input: AttentionRequestListQuery) => ({
    items: table.rows.filter((r) => r.status === input.status).map((r) => ({ ...r })),
    nextCursor: null,
  }));
  /** The batch each resolved row was settled by, like `resolution_batch_id`. */
  const batchOf = new Map<string, string>();
  const resolveAttention = vi.fn(async (entityId: EntityId, input: { resolutionBatchId?: string }) => {
    if (options.gate) await options.gate;
    if (options.failResolve) throw new Error('node unreachable');
    for (const r of table.rows) {
      if (r.entityId === entityId && r.status === 'open') {
        r.status = 'resolved';
        r.version += 1;
        if (input.resolutionBatchId) batchOf.set(r.id, input.resolutionBatchId);
      }
    }
    return result(entityId);
  });
  const updateAttentionRequest = vi.fn(async (id: string, input: { status?: string; expectedVersion?: number }) => {
    const row = table.rows.find((r) => r.id === id)!;
    if (options.failUpdateFor === id) throw new Error('node unreachable');
    // As 050:126 does: a stale version is a conflict, not a write.
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw Object.assign(new Error(`expected ${input.expectedVersion}, have ${row.version}`), { code: 'version_conflict' });
    }
    row.status = input.status as AttentionRequest['status'];
    row.version += 1;
    return { ...result(row.entityId), request: row };
  });
  const postMessage = vi.fn(async () => ({}));
  const v2 = {
    markSeen: vi.fn(async (id: EntityId) => result(id)),
    unresolve: vi.fn(async (batchId: string) => {
      let affected = 0;
      for (const r of table.rows) {
        if (r.status === 'resolved' && batchOf.get(r.id) === batchId) { r.status = 'open'; affected += 1; }
      }
      return { ...result('task-1'), affectedCount: affected };
    }),
    withdraw: vi.fn(async (id: string) => {
      const row = table.rows.find((r) => r.id === id)!;
      row.status = 'dismissed';
      return { ...result(row.entityId), request: row };
    }),
  };
  const seam = {
    attentionRequests,
    onEvent: (cb: (e: DurableWorkspaceEvent) => void) => {
      listeners.push(cb);
      return () => { listeners.splice(listeners.indexOf(cb), 1); };
    },
    onResync: () => () => {},
    entity: vi.fn(async (id: EntityId) => ({ title: `Title ${id}`, state: { kind: 'task' } })),
    commands: {
      resolveAttention,
      updateAttentionRequest,
      postMessage,
      attentionV2: options.v2 ? v2 : {},
    },
  } as unknown as AttentionSeam;
  return {
    table, seam, attentionRequests, resolveAttention, updateAttentionRequest, postMessage, v2,
    upsert: (id: string, attention: EntityAttentionSummary | null) => act(() => {
      for (const l of [...listeners]) {
        l({ spaceId: SPACE, seq: 1, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: summary(id, attention) } as unknown as DurableWorkspaceEvent);
      }
    }),
  };
}

