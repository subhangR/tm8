import { describe, expect, it } from 'vitest';
import { SETTINGS_ROUTE_SECTIONS, NODE_ADMIN_ROUTE_SECTIONS } from '../routes/types';
import { SETTINGS_SECTIONS } from './types';
import {
  SETTINGS_NAV_GROUPS,
  scopeOfSection,
  settingsNavGroups,
  settingsNavKeyOfRoute,
  settingsNavRowMatches,
  settingsNavTargetOfKey,
  visibleSettingsNav,
} from './nav';

const keysOf = (access: { space: boolean; node: boolean }) =>
  settingsNavGroups(access).flatMap((group) => group.items.map((item) => item.key));

const MEMBER = { space: false, node: false };
const SPACE_ADMIN = { space: true, node: false };
const NODE_ADMIN = { space: true, node: true };

describe('the one settings nav', () => {
  it('leads with Overview, then groups by who a setting affects: Account · Space · Server', () => {
    const groups = settingsNavGroups(NODE_ADMIN);
    expect(groups.map((g) => g.label)).toEqual([null, 'Account', 'Space', 'Server']);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(['Overview']);
    /* Every scope group says, in one line, who it reaches. */
    for (const group of groups.slice(1)) expect(group.description?.length ?? 0, group.id).toBeGreaterThan(20);
  });

  it('puts Space rows under their topical subheadings, in order', () => {
    const spaceGroup = settingsNavGroups(NODE_ADMIN).find((g) => g.id === 'space')!;
    const headings = spaceGroup.items.map((i) => i.subheading).filter((h, i, all) => h !== all[i - 1]);
    expect(headings).toEqual(['General', 'People & access', 'Work model', 'Agents & tools', 'Advanced', 'Danger zone']);
    expect(spaceGroup.items.find((i) => i.key === 'space:danger')?.tone).toBe('danger');
  });

  it('draws every section once for a space and node admin', () => {
    const keys = keysOf(NODE_ADMIN);
    expect(new Set(keys).size).toBe(keys.length);
    /* Every space section but the two node-owned ones, plus the four node pages. */
    const space = SETTINGS_SECTIONS.filter((s) => s.id !== 'node-credentials' && s.id !== 'filesystem-access');
    expect(keys.filter((k) => k.startsWith('space:')).sort()).toEqual(space.map((s) => `space:${s.id}`).sort());
    expect(keys.filter((k) => k.startsWith('node:')).sort()).toEqual(NODE_ADMIN_ROUTE_SECTIONS.map((s) => `node:${s}`).sort());
  });

  it('is role-gated exactly as before: plain member / space admin / node admin', () => {
    const member = keysOf(MEMBER);
    expect(member).not.toContain('space:invites');
    expect(member).not.toContain('space:sessions');
    expect(member.some((k) => k.startsWith('node:'))).toBe(false);
    expect(member).toContain('space:account');
    expect(member).toContain('space:members');
    expect(member).toContain('space:danger');
    /* A group left with no rows is not drawn as an empty heading. */
    expect(settingsNavGroups(MEMBER).map((g) => g.id)).not.toContain('node');

    const spaceAdmin = keysOf(SPACE_ADMIN);
    expect(spaceAdmin).toContain('space:invites');
    expect(spaceAdmin).toContain('space:sessions');
    expect(spaceAdmin.some((k) => k.startsWith('node:'))).toBe(false);

    const nodeAdmin = keysOf(NODE_ADMIN);
    expect(nodeAdmin.filter((k) => k.startsWith('node:'))).toHaveLength(4);
  });

  it('names rows plainly, and marks Models as this browser inside Account', () => {
    const account = settingsNavGroups(MEMBER).find((g) => g.id === 'account')!;
    expect(account.items.map((i) => i.label)).toEqual(['Profile', 'Sign-ins & devices', 'Agent logins', 'Linked spaces', 'Models']);
    expect(account.items.find((i) => i.key === 'space:models')?.detail).toBe('this browser');
    const server = settingsNavGroups(NODE_ADMIN).find((g) => g.id === 'node')!;
    expect(server.items.map((i) => i.label)).toEqual(['Credentials & fallback', 'Filesystem access', 'Accounts', 'Configuration']);
  });

  it('lights a row for every address that already existed', () => {
    for (const section of SETTINGS_ROUTE_SECTIONS) {
      expect(settingsNavTargetOfKey(settingsNavKeyOfRoute({ section })), section).not.toBeNull();
      expect(settingsNavTargetOfKey(settingsNavKeyOfRoute({ scope: 'space', section })), section).not.toBeNull();
    }
    for (const section of NODE_ADMIN_ROUTE_SECTIONS) {
      expect(settingsNavKeyOfRoute({ scope: 'node', section })).toBe(`node:${section}`);
    }
    /* A bare /settings opens the Overview; the admin pages keep their own defaults. */
    expect(settingsNavKeyOfRoute({ section: null })).toBe('space:overview');
    expect(settingsNavKeyOfRoute({ scope: 'space', section: null })).toBe('space:profile');
    expect(settingsNavKeyOfRoute({ scope: 'node', section: null })).toBe('node:credentials');
    /* The legacy space-shaped node addresses light the node rows. */
    expect(settingsNavKeyOfRoute({ section: 'node-credentials' })).toBe('node:credentials');
    expect(settingsNavKeyOfRoute({ section: 'filesystem-access' })).toBe('node:filesystem');
  });
});

describe('scope — what each section header says it affects', () => {
  it('every section has a scope, except the Overview, which only links', () => {
    for (const section of SETTINGS_SECTIONS) {
      if (section.id === 'overview') expect(scopeOfSection(section.id)).toBeNull();
      else expect(scopeOfSection(section.id), section.id).not.toBeNull();
    }
  });

  it('reads the scope off the nav model', () => {
    expect(scopeOfSection('account')).toBe('you');
    expect(scopeOfSection('credentials')).toBe('you');
    expect(scopeOfSection('models')).toBe('browser');
    expect(scopeOfSection('members')).toBe('space');
    expect(scopeOfSection('space-credentials')).toBe('space');
    expect(scopeOfSection('danger')).toBe('space');
    expect(scopeOfSection('node-credentials')).toBe('node');
    expect(scopeOfSection('filesystem-access')).toBe('node');
  });
});

describe('search — the one matcher the frame nav and the Overview share', () => {
  const find = (query: string) =>
    visibleSettingsNav(NODE_ADMIN).flatMap((group) =>
      group.subgroups.flatMap((subgroup) =>
        subgroup.rows.filter((row) => settingsNavRowMatches(row, { group, subgroup }, query)).map((row) => `${row.target.scope}:${row.target.section}`),
      ),
    );

  it('"api key" finds the credentials sections at every scope', () => {
    expect(find('api key')).toEqual(['space:credentials', 'space:space-credentials', 'node:credentials']);
  });

  it('matches labels and subheadings, case-insensitively', () => {
    expect(find('INVITE')).toContain('space:invites');
    expect(find('people & access')).toEqual(['space:members', 'space:invites', 'space:sessions', 'space:sharing']);
    expect(find('mcp')).toEqual(['space:connectors']);
  });

  it('an empty query matches every row', () => {
    const all = SETTINGS_NAV_GROUPS.flatMap((g) => g.subgroups.flatMap((s) => s.rows));
    expect(find('  ')).toHaveLength(all.length);
  });

  it('the frame nav items carry the same keywords', () => {
    const items = settingsNavGroups(NODE_ADMIN).flatMap((g) => g.items);
    expect(items.find((i) => i.key === 'space:credentials')?.keywords).toContain('api key');
  });
});
