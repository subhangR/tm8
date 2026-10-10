import { describe, expect, it } from 'vitest';
import { SETTINGS_ROUTE_SECTIONS, NODE_ADMIN_ROUTE_SECTIONS } from '../routes/types';
import { SETTINGS_SECTIONS } from './types';
import { settingsNavGroups, settingsNavKeyOfRoute, settingsNavTargetOfKey } from './nav';

const keysOf = (access: { space: boolean; node: boolean }) =>
  settingsNavGroups(access).flatMap((group) => group.items.map((item) => item.key));

describe('the one settings nav', () => {
  it('groups You · Team · Work setup · Agents · Integrations · Danger zone', () => {
    expect(settingsNavGroups({ space: true, node: true }).map((g) => g.label)).toEqual([
      'You', 'Team', 'Work setup', 'Agents', 'Integrations', 'Danger zone',
    ]);
  });

  it('draws every section once for a space and node admin', () => {
    const keys = keysOf({ space: true, node: true });
    expect(new Set(keys).size).toBe(keys.length);
    /* Every space section but the two node-owned ones, plus the four node pages. */
    const space = SETTINGS_SECTIONS.filter((s) => s.id !== 'node-credentials' && s.id !== 'filesystem-access');
    expect(keys.filter((k) => k.startsWith('space:')).sort()).toEqual(space.map((s) => `space:${s.id}`).sort());
    expect(keys.filter((k) => k.startsWith('node:')).sort()).toEqual(NODE_ADMIN_ROUTE_SECTIONS.map((s) => `node:${s}`).sort());
  });

  it('is role-gated: admin rows only for people with the role', () => {
    const member = keysOf({ space: false, node: false });
    expect(member).not.toContain('space:invites');
    expect(member).not.toContain('space:sessions');
    expect(member.some((k) => k.startsWith('node:'))).toBe(false);
    expect(member).toContain('space:account');
    const spaceAdmin = keysOf({ space: true, node: false });
    expect(spaceAdmin).toContain('space:invites');
    expect(spaceAdmin.some((k) => k.startsWith('node:'))).toBe(false);
  });

  it('names the space profile "Space profile"', () => {
    const team = settingsNavGroups({ space: false, node: false }).find((g) => g.id === 'team')!;
    expect(team.items[0]!.label).toBe('Space profile');
  });

  it('lights a row for every address that already existed', () => {
    for (const section of SETTINGS_ROUTE_SECTIONS) {
      expect(settingsNavTargetOfKey(settingsNavKeyOfRoute({ section })), section).not.toBeNull();
      expect(settingsNavTargetOfKey(settingsNavKeyOfRoute({ scope: 'space', section })), section).not.toBeNull();
    }
    for (const section of NODE_ADMIN_ROUTE_SECTIONS) {
      expect(settingsNavKeyOfRoute({ scope: 'node', section })).toBe(`node:${section}`);
    }
    expect(settingsNavKeyOfRoute({ section: null })).toBe('space:members');
    expect(settingsNavKeyOfRoute({ scope: 'space', section: null })).toBe('space:profile');
    expect(settingsNavKeyOfRoute({ scope: 'node', section: null })).toBe('node:credentials');
    expect(settingsNavKeyOfRoute({ section: 'node-credentials' })).toBe('node:credentials');
  });
});
