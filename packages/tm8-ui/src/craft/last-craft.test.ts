/**
 * THE LAST CRAFT (Subhang 2026-10-18): the rail's Craft reopens the craft and
 * page you were last in, per space, per device; nothing kept ⇒ the home.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { lastCraftKey, readLastCraft, writeLastCraft } from './last-craft';

const CRAFT = 'craft-1' as EntityId;
const PAGE = 'page-1' as EntityId;

beforeEach(() => localStorage.clear());

describe('the last craft', () => {
  it('keeps a craft and its page, per node and space', () => {
    const here = lastCraftKey('node', 'space-a');
    writeLastCraft(here, { craftId: CRAFT, pageId: PAGE });
    expect(readLastCraft(here)).toEqual({ craftId: CRAFT, pageId: PAGE });
    expect(readLastCraft(lastCraftKey('node', 'space-b'))).toBeNull();
    expect(readLastCraft(lastCraftKey('other-node', 'space-a'))).toBeNull();
  });

  it('a craft with no page reads back without one', () => {
    const key = lastCraftKey('node', 'space');
    writeLastCraft(key, { craftId: CRAFT });
    expect(readLastCraft(key)).toEqual({ craftId: CRAFT });
  });

  it('null forgets it (the home was the last place, or the craft is gone)', () => {
    const key = lastCraftKey('node', 'space');
    writeLastCraft(key, { craftId: CRAFT });
    writeLastCraft(key, null);
    expect(readLastCraft(key)).toBeNull();
  });

  it('a damaged entry reads as nothing kept', () => {
    const key = lastCraftKey('node', 'space');
    localStorage.setItem(key, '{not json');
    expect(readLastCraft(key)).toBeNull();
    localStorage.setItem(key, JSON.stringify({ craftId: 42 }));
    expect(readLastCraft(key)).toBeNull();
  });
});
