import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { craftTeammateId, defaultChatTeammateId } from './default-teammate';

const t = (id: string, label: string) => ({ id: id as EntityId, label });
const ROSTER = [t('w', 'Worker'), t('r', 'Reviewer'), t('g', 'Graph Architect'), t('c', 'Crafter')];

describe('defaultChatTeammateId', () => {
  it('a Craft chat starts with the Crafter, not the Graph Architect', () => {
    expect(defaultChatTeammateId(ROSTER, { pinnedMode: 'craft' })).toBe('c');
  });

  it('any other chat starts with the first teammate listed', () => {
    expect(defaultChatTeammateId(ROSTER, {})).toBe('w');
    expect(defaultChatTeammateId(ROSTER, { pinnedMode: 'ask' })).toBe('w');
  });

  it('a seeded pick the space still has wins, even in Craft', () => {
    expect(defaultChatTeammateId(ROSTER, { seeded: 'r', pinnedMode: 'craft' })).toBe('r');
  });

  it('a seeded pick the space no longer has is ignored', () => {
    expect(defaultChatTeammateId(ROSTER, { seeded: 'gone', pinnedMode: 'craft' })).toBe('c');
  });

  it('Craft without a Crafter falls back to the Graph Architect, then the first teammate, then nobody', () => {
    expect(defaultChatTeammateId(ROSTER.slice(0, 3), { pinnedMode: 'craft' })).toBe('g');
    expect(defaultChatTeammateId([t('w', 'Worker')], { pinnedMode: 'craft' })).toBe('w');
    expect(defaultChatTeammateId([], { pinnedMode: 'craft' })).toBe('');
  });
});

describe('craftTeammateId', () => {
  it('is the Crafter for a craft session launch, null when neither craft role is on the roster', () => {
    expect(craftTeammateId(ROSTER)).toBe('c');
    expect(craftTeammateId([t('w', 'Worker')])).toBeNull();
  });
});
