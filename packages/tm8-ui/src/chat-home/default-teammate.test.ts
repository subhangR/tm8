import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { defaultChatTeammateId } from './default-teammate';

const t = (id: string, label: string) => ({ id: id as EntityId, label });
const ROSTER = [t('w', 'Worker'), t('r', 'Reviewer'), t('g', 'Graph Architect')];

describe('defaultChatTeammateId', () => {
  it('a Craft chat starts with the Graph Architect', () => {
    expect(defaultChatTeammateId(ROSTER, { pinnedMode: 'craft' })).toBe('g');
  });

  it('any other chat starts with the first teammate listed', () => {
    expect(defaultChatTeammateId(ROSTER, {})).toBe('w');
    expect(defaultChatTeammateId(ROSTER, { pinnedMode: 'ask' })).toBe('w');
  });

  it('a seeded pick the space still has wins, even in Craft', () => {
    expect(defaultChatTeammateId(ROSTER, { seeded: 'r', pinnedMode: 'craft' })).toBe('r');
  });

  it('a seeded pick the space no longer has is ignored', () => {
    expect(defaultChatTeammateId(ROSTER, { seeded: 'gone', pinnedMode: 'craft' })).toBe('g');
  });

  it('Craft with no Graph Architect falls through to the first teammate, and no roster to nobody', () => {
    expect(defaultChatTeammateId([t('w', 'Worker')], { pinnedMode: 'craft' })).toBe('w');
    expect(defaultChatTeammateId([], { pinnedMode: 'craft' })).toBe('');
  });
});
