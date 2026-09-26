import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { openEntityAndMarkRead } from './open-entity';

/**
 * THE POINT OF THIS FILE IS A NEGATIVE (Attention v2, G4/G5/Q18): opening an
 * entity must not write to the space-wide attention queue. It used to, and the
 * `resolveAttention` assertions that used to live here were the guard that made
 * the behaviour deliberate — so removing them without replacing them with the
 * opposite assertion would leave nothing stopping the call coming back.
 *
 * `commands` is deliberately typed loosely in these tests so that a
 * `resolveAttention` spy can be handed in at all: the production type no longer
 * admits the key, which is the compile-time half of the same guarantee.
 */
describe('openEntityAndMarkRead — opening never settles attention', () => {
  const id = 'entity-1' as EntityId;

  it('opens synchronously and issues NO attention write, even when requests are pending', () => {
    const open = vi.fn();
    const resolveAttention = vi.fn();
    const upsertReadMark = vi.fn().mockResolvedValue(undefined);

    openEntityAndMarkRead({
      entityId: id,
      open,
      commands: { upsertReadMark, resolveAttention } as never,
      now: () => 42,
    });

    expect(open).toHaveBeenCalledWith(id);
    // THE REGRESSION GUARD. An entity with a pending request is exactly the case
    // that used to fire a bulk resolve on the way past.
    expect(resolveAttention).not.toHaveBeenCalled();
  });

  it('opens even with no read-mark command wired, and never throws', () => {
    const open = vi.fn();
    openEntityAndMarkRead({ entityId: id, open, commands: {} as never });
    expect(open).toHaveBeenCalledWith(id);
  });
});

describe('read marks — the per-viewer half that survived', () => {
  const id = 'entity-1' as EntityId;

  it('marks read on EVERY open and reports it so the rail can catch up', async () => {
    const upsertReadMark = vi.fn().mockResolvedValue(undefined);
    const onRead = vi.fn();

    openEntityAndMarkRead({
      entityId: id,
      open: vi.fn(),
      commands: { upsertReadMark },
      onRead,
      now: () => 0,
    });

    expect(upsertReadMark).toHaveBeenCalledWith(id, new Date(0).toISOString());
    await Promise.resolve();
    await Promise.resolve();
    expect(onRead).toHaveBeenCalled();
  });

  it('coalesces repeated clicks through the in-flight set, and clears it after', async () => {
    const marking = new Set<EntityId>();
    let finish!: () => void;
    const upsertReadMark = vi.fn().mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const input = {
      entityId: id,
      open: vi.fn(),
      commands: { upsertReadMark },
      marking,
    };

    openEntityAndMarkRead(input);
    openEntityAndMarkRead(input);
    expect(upsertReadMark).toHaveBeenCalledTimes(1);

    finish();
    await Promise.resolve();
    await Promise.resolve();
    // Cleared, so a LATER open of the same entity marks it read again rather
    // than being suppressed forever by the first one.
    expect(marking.has(id)).toBe(false);
  });

  it('opens the entity even when the read mark is already in flight', () => {
    const marking = new Set<EntityId>([id]);
    const open = vi.fn();
    const upsertReadMark = vi.fn();

    openEntityAndMarkRead({ entityId: id, open, commands: { upsertReadMark }, marking });

    // NAVIGATION IS NEVER THE THING THAT GETS COALESCED — only the write is.
    expect(open).toHaveBeenCalledWith(id);
    expect(upsertReadMark).not.toHaveBeenCalled();
  });

  it('a failed read mark is SILENT — no throw, no onRead', async () => {
    const onRead = vi.fn();
    const upsertReadMark = vi.fn().mockRejectedValue(new Error('offline'));

    openEntityAndMarkRead({
      entityId: id,
      open: vi.fn(),
      commands: { upsertReadMark },
      onRead,
    });

    await Promise.resolve();
    await Promise.resolve();
    // The row simply keeps its unseen mark, which self-corrects on the next
    // open. A toast over a completed navigation would be worse than the state.
    expect(onRead).not.toHaveBeenCalled();
  });
});
