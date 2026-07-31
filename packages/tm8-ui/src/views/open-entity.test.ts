import { describe, expect, it, vi } from 'vitest';
import type { AttentionRequestMutationResult, EntityId } from '@tm8/contract';
import { openEntityAndResolve } from './open-entity';

describe('openEntityAndResolve', () => {
  it('opens synchronously, resolves all pending attention, and reconciles the summary', async () => {
    const id = 'entity-1' as EntityId;
    const result = { entity: { id }, request: null, affectedCount: 3 } as AttentionRequestMutationResult;
    const open = vi.fn();
    const reconcile = vi.fn();
    const resolveAttention = vi.fn().mockResolvedValue(result);

    openEntityAndResolve({
      entityId: id,
      needsAttention: true,
      open,
      commands: { resolveAttention },
      reconcile,
      onError: vi.fn(),
      now: () => 42,
    });

    expect(open).toHaveBeenCalledWith(id);
    expect(resolveAttention).toHaveBeenCalledWith(id, { clientMutationId: 'attention-open:entity-1:42' });
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledWith(result);
  });

  it('only opens when the rendered entity has no pending attention', async () => {
    const id = 'entity-1' as EntityId;
    const open = vi.fn();
    const resolveAttention = vi.fn();

    openEntityAndResolve({
      entityId: id,
      needsAttention: false,
      open,
      commands: { resolveAttention },
      reconcile: vi.fn(),
      onError: vi.fn(),
    });

    expect(open).toHaveBeenCalledWith(id);
    expect(resolveAttention).not.toHaveBeenCalled();
  });

  it('coalesces repeated clicks while resolution is in flight', async () => {
    const id = 'entity-1' as EntityId;
    const resolving = new Set<EntityId>();
    let finish!: (result: AttentionRequestMutationResult) => void;
    const result = { entity: { id }, request: null, affectedCount: 1 } as AttentionRequestMutationResult;
    const resolveAttention = vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const input = {
      entityId: id,
      needsAttention: true,
      open: vi.fn(),
      commands: { resolveAttention },
      reconcile: vi.fn(),
      onError: vi.fn(),
      resolving,
    };

    openEntityAndResolve(input);
    openEntityAndResolve(input);
    expect(resolveAttention).toHaveBeenCalledTimes(1);

    finish(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolving).not.toContain(id);
  });
});

describe('read marks — the per-viewer half, independent of attention', () => {
  const id = 'entity-1' as EntityId;

  it('marks read on EVERY open, including entities with no pending attention', async () => {
    const upsertReadMark = vi.fn().mockResolvedValue(undefined);
    const resolveAttention = vi.fn();
    const onRead = vi.fn();

    openEntityAndResolve({
      entityId: id,
      needsAttention: false,
      open: vi.fn(),
      commands: { resolveAttention, upsertReadMark },
      reconcile: vi.fn(),
      onError: vi.fn(),
      onRead,
      now: () => 0,
    });

    // Attention is space-wide and stays conditional; the read mark is this
    // viewer's own and is what clears the rail's unseen number.
    expect(resolveAttention).not.toHaveBeenCalled();
    expect(upsertReadMark).toHaveBeenCalledWith(id, new Date(0).toISOString());
    await Promise.resolve();
    await Promise.resolve();
    expect(onRead).toHaveBeenCalled();
  });

  it('coalesces repeated clicks through its OWN in-flight set', () => {
    const marking = new Set<EntityId>();
    const upsertReadMark = vi.fn().mockReturnValue(new Promise(() => {}));
    const input = {
      entityId: id,
      needsAttention: false,
      open: vi.fn(),
      commands: { resolveAttention: vi.fn(), upsertReadMark },
      reconcile: vi.fn(),
      onError: vi.fn(),
      marking,
    };

    openEntityAndResolve(input);
    openEntityAndResolve(input);
    expect(upsertReadMark).toHaveBeenCalledTimes(1);
  });

  it('a failed read mark is SILENT — it never raises the error surface', async () => {
    const onError = vi.fn();
    const onRead = vi.fn();
    const upsertReadMark = vi.fn().mockRejectedValue(new Error('offline'));

    openEntityAndResolve({
      entityId: id,
      needsAttention: false,
      open: vi.fn(),
      commands: { resolveAttention: vi.fn(), upsertReadMark },
      reconcile: vi.fn(),
      onError,
      onRead,
    });

    await Promise.resolve();
    await Promise.resolve();
    // The row simply keeps its unseen mark, which self-corrects on the next
    // open. A toast over a completed navigation would be worse than the state.
    expect(onError).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
  });

  it('still resolves attention alongside the read mark when one is pending', async () => {
    const upsertReadMark = vi.fn().mockResolvedValue(undefined);
    const resolveAttention = vi.fn().mockResolvedValue(
      { entity: { id }, request: null, affectedCount: 2 } as AttentionRequestMutationResult,
    );

    openEntityAndResolve({
      entityId: id,
      needsAttention: true,
      open: vi.fn(),
      commands: { resolveAttention, upsertReadMark },
      reconcile: vi.fn(),
      onError: vi.fn(),
      now: () => 7,
    });

    expect(upsertReadMark).toHaveBeenCalledTimes(1);
    expect(resolveAttention).toHaveBeenCalledTimes(1);
  });
});
