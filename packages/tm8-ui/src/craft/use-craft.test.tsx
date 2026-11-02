// @vitest-environment jsdom
/** `useCraft` shows the newest read, whatever order the reads land in. */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { CraftRead, CraftSource } from './craft-source';
import { useCraft } from './useCraft';

function deferredSource() {
  const reads: Array<{ craftId: string; resolve(read: CraftRead): void }> = [];
  const source = {
    read: (craftId: EntityId) => new Promise<CraftRead>((resolve) => reads.push({ craftId, resolve })),
    subscribe: () => () => undefined,
  } as unknown as CraftSource;
  const answer = (index: number, title: string) =>
    reads[index]!.resolve({ id: reads[index]!.craftId as EntityId, title, version: 1, pages: [] });
  return { source, reads, answer };
}

describe('useCraft', () => {
  it('a read of the craft shown before a switch, landing late, does not replace the new craft', async () => {
    const { source, reads, answer } = deferredSource();
    const { result, rerender } = renderHook(({ id }) => useCraft(source, id as EntityId, null), {
      initialProps: { id: 'craft-a' },
    });
    rerender({ id: 'craft-b' });
    expect(reads.map((r) => r.craftId)).toEqual(['craft-a', 'craft-b']);
    await act(async () => answer(1, 'B'));
    await act(async () => answer(0, 'A'));
    expect(result.current.craft?.id).toBe('craft-b');
    expect(result.current.craft?.title).toBe('B');
  });
});
