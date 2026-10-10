/**
 * THE ONE SETTINGS NAV (round 2, R2-D4/R2-D5): personal settings, space admin
 * and node admin under one list, grouped by what a section is about rather
 * than by which page used to host it. Each row names the route it opens, so
 * every existing address (`/settings/x`, `/space-admin/x`, `/node-admin/x`)
 * still lands on its section and lights its row.
 *
 * Role gating (R2-D4): a row marked `requires` is drawn only for a viewer
 * holding that role. Space sections a plain member could always open stay
 * open — their writes are already gated inside the section.
 */
import type { FrameNavGroup } from '../shell/FrameNav';
import type { NodeAdminRouteSection, SettingsRouteSection } from '../routes/types';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './types';

export type SettingsNavTarget =
  | { scope: 'space'; section: SettingsSectionId }
  | { scope: 'node'; section: NodeAdminRouteSection };

interface SettingsNavRow {
  target: SettingsNavTarget;
  /** Overrides the section's own label (node rows share names with space ones). */
  label?: string;
  requires?: 'space-admin' | 'node-admin';
}

const space = (section: SettingsSectionId, requires?: 'space-admin'): SettingsNavRow => ({
  target: { scope: 'space', section },
  ...(requires ? { requires } : {}),
});
const node = (section: NodeAdminRouteSection, label: string): SettingsNavRow => ({
  target: { scope: 'node', section },
  label,
  requires: 'node-admin',
});

export const SETTINGS_NAV_GROUPS: readonly { id: string; label: string; rows: readonly SettingsNavRow[] }[] = [
  { id: 'you', label: 'You', rows: [space('account'), space('my-sessions')] },
  {
    id: 'team',
    label: 'Team',
    rows: [space('profile'), space('members'), space('invites', 'space-admin'), space('sessions', 'space-admin'), space('sharing')],
  },
  { id: 'work-setup', label: 'Work setup', rows: [space('axes'), space('workflows'), space('kinds'), space('menu'), space('configs')] },
  {
    id: 'agents',
    label: 'Agents',
    rows: [
      space('models'),
      space('chat-defaults'),
      space('connectors'),
      space('credentials'),
      space('space-credentials'),
      node('credentials', 'Node credentials'),
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    rows: [
      space('space-links'),
      space('projects'),
      node('filesystem', 'Filesystem access'),
      node('accounts', 'Node accounts'),
      node('configuration', 'Node configuration'),
    ],
  },
  { id: 'danger', label: 'Danger zone', rows: [space('danger')] },
];

/** Every space section the one nav can open (the space shell mounts exactly these). */
export const SETTINGS_NAV_SPACE_SECTIONS: readonly SettingsSectionId[] = SETTINGS_NAV_GROUPS.flatMap((group) =>
  group.rows.flatMap((row) => (row.target.scope === 'space' ? [row.target.section] : [])),
);

export function settingsNavKey(target: SettingsNavTarget): string {
  return `${target.scope}:${target.section}`;
}

export function settingsNavTargetOfKey(key: string): SettingsNavTarget | null {
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const row of group.rows) if (settingsNavKey(row.target) === key) return row.target;
  }
  return null;
}

/**
 * The row a settings route lights. A bare `/settings` opens Members (the
 * shell's default), `/space-admin` the space profile, `/node-admin` node
 * credentials — each page's own default before the nav was one.
 */
export function settingsNavKeyOfRoute(route: {
  scope?: 'space' | 'node';
  section: SettingsRouteSection | NodeAdminRouteSection | null;
}): string {
  if (route.scope === 'node') return settingsNavKey({ scope: 'node', section: (route.section as NodeAdminRouteSection | null) ?? 'credentials' });
  const section = route.section as SettingsRouteSection | null;
  if (section === 'node-credentials') return settingsNavKey({ scope: 'node', section: 'credentials' });
  if (section === 'filesystem-access') return settingsNavKey({ scope: 'node', section: 'filesystem' });
  return settingsNavKey({ scope: 'space', section: section ?? (route.scope === 'space' ? 'profile' : 'members') });
}

/** The nav's groups for a viewer: rows needing a role they lack are not drawn. */
export function settingsNavGroups(access: { space: boolean; node: boolean }): FrameNavGroup[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.rows
      .filter((row) => !row.requires || (row.requires === 'space-admin' ? access.space : access.node))
      .map((row) => ({
        key: settingsNavKey(row.target),
        label: row.label ?? SETTINGS_SECTIONS.find((s) => s.id === row.target.section)?.label ?? row.target.section,
        ...(group.id === 'danger' ? { tone: 'danger' as const } : {}),
      })),
  })).filter((group) => group.items.length > 0);
}
