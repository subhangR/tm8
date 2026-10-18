/**
 * THE ONE SETTINGS NAV (round 2, R2-D4/R2-D5): personal settings, space admin
 * and node admin under one list. Each row names the route it opens, so every
 * existing address (`/settings/x`, `/space-admin/x`, `/node-admin/x`) still
 * lands on its section and lights its row.
 *
 * GROUPED BY WHO A SETTING AFFECTS (settings redesign, 2026-10-18). The old
 * groups (You · Team · Work setup · Agents · Integrations) were topical, and
 * each mixed scopes: "Agents" held a browser-local catalog, the viewer's own
 * logins, the space's keys and the node's keys side by side. Now the three top
 * groups ARE the three scopes — Account (only you), Space (everyone here),
 * Server (node admins) — with topical subheadings inside Space. The same scope
 * drives the chip every section header carries (`scopeOfSection`).
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

/** Who a change in a section reaches. Drawn as the section header's chip. */
export type SettingsScope = 'you' | 'browser' | 'space' | 'node';

export const SETTINGS_SCOPE_CHIP: Record<SettingsScope, string> = {
  you: 'Only you',
  browser: 'This browser',
  space: 'Everyone in this space',
  node: 'Server-wide',
};

export interface SettingsNavRow {
  target: SettingsNavTarget;
  /** Overrides the section's own label (node rows have no section def). */
  label?: string;
  /** Overrides the group's scope (Models is browser-local inside Account). */
  scope?: SettingsScope;
  /** Extra words the filter matches — what someone types looking for this row. */
  keywords?: readonly string[];
  requires?: 'space-admin' | 'node-admin';
}

export interface SettingsNavSubgroup {
  /** Null draws the rows straight under the group heading. */
  label: string | null;
  rows: readonly SettingsNavRow[];
  tone?: 'danger';
}

export interface SettingsNavGroupDef {
  id: 'account' | 'space' | 'node';
  label: string;
  scope: SettingsScope;
  /** One line under the heading: who this group's settings reach. */
  description: string;
  subgroups: readonly SettingsNavSubgroup[];
}

type RowExtras = Pick<SettingsNavRow, 'scope' | 'keywords' | 'requires'>;
const space = (section: SettingsSectionId, extras: RowExtras = {}): SettingsNavRow => ({
  target: { scope: 'space', section },
  ...extras,
});
const node = (section: NodeAdminRouteSection, label: string, keywords: readonly string[]): SettingsNavRow => ({
  target: { scope: 'node', section },
  label,
  keywords,
  requires: 'node-admin',
});

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroupDef[] = [
  {
    id: 'account',
    label: 'Account',
    scope: 'you',
    description: 'Only you — your identity, sign-ins and logins.',
    subgroups: [
      {
        label: null,
        rows: [
          space('account', { keywords: ['name', 'display name', 'avatar', 'identity', 'username'] }),
          space('my-sessions', { keywords: ['sessions', 'sign out', 'devices', 'logout', 'browsers'] }),
          space('credentials', { keywords: ['api key', 'keys', 'token', 'claude', 'codex', 'github', 'login', 'credentials'] }),
          space('space-links', { keywords: ['links', 'other spaces', 'connect space'] }),
          space('models', { scope: 'browser', keywords: ['model', 'llm', 'catalog', 'launch'] }),
        ],
      },
    ],
  },
  {
    id: 'space',
    label: 'Space',
    scope: 'space',
    description: 'Everyone in this space sees these changes.',
    subgroups: [
      {
        label: 'General',
        rows: [
          space('profile', { keywords: ['name', 'description', 'about', 'rename', 'space name'] }),
          space('menu', { keywords: ['sidebar', 'rail', 'navigation', 'menu'] }),
        ],
      },
      {
        label: 'People & access',
        rows: [
          space('members', { keywords: ['people', 'roles', 'admin', 'owner', 'team', 'users'] }),
          space('invites', { requires: 'space-admin', keywords: ['invite', 'join', 'link', 'code'] }),
          space('sessions', { requires: 'space-admin', keywords: ['sign-ins', 'revoke', 'devices'] }),
          space('sharing', { keywords: ['terminal', 'share', 'visibility'] }),
        ],
      },
      {
        label: 'Work model',
        rows: [
          space('axes', { keywords: ['fields', 'priority', 'type', 'status', 'axes'] }),
          space('workflows', { keywords: ['status', 'states', 'workflow'] }),
          space('kinds', { keywords: ['kinds', 'schema', 'entity types', 'custom'] }),
        ],
      },
      {
        label: 'Agents & tools',
        rows: [
          space('chat-defaults', { keywords: ['chat model', 'default', 'effort'] }),
          space('space-credentials', { keywords: ['api key', 'keys', 'token', 'shared', 'credentials'] }),
          space('connectors', { keywords: ['mcp', 'tools', 'integrations', 'servers'] }),
          space('projects', { keywords: ['repo', 'repository', 'git', 'trust', 'branches'] }),
        ],
      },
      {
        label: 'Advanced',
        rows: [space('configs', { keywords: ['config', 'environment', 'env', 'constants', 'knobs'] })],
      },
      {
        label: 'Danger zone',
        tone: 'danger',
        rows: [space('danger', { keywords: ['leave', 'delete', 'transfer'] })],
      },
    ],
  },
  {
    id: 'node',
    label: 'Server',
    scope: 'node',
    description: 'Node admins only — reaches every space on this server.',
    subgroups: [
      {
        label: null,
        rows: [
          node('credentials', 'Credentials & fallback', ['api key', 'keys', 'node credentials', 'fallback', 'policy']),
          node('filesystem', 'Filesystem access', ['folders', 'paths', 'directories', 'grants']),
          node('accounts', 'Accounts', ['users', 'signup', 'node accounts']),
          node('configuration', 'Configuration', ['environment', 'env', 'restart', 'node configuration']),
        ],
      },
    ],
  },
];

/** The landing row, drawn above the three scope groups. */
export const SETTINGS_OVERVIEW_TARGET: SettingsNavTarget = { scope: 'space', section: 'overview' };

const ALL_ROWS: readonly { group: SettingsNavGroupDef; subgroup: SettingsNavSubgroup; row: SettingsNavRow }[] =
  SETTINGS_NAV_GROUPS.flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.rows.map((row) => ({ group, subgroup, row }))));

/** Every space section the one nav can open (the space shell mounts exactly these). */
export const SETTINGS_NAV_SPACE_SECTIONS: readonly SettingsSectionId[] = [
  SETTINGS_OVERVIEW_TARGET.section as SettingsSectionId,
  ...ALL_ROWS.flatMap(({ row }) => (row.target.scope === 'space' ? [row.target.section] : [])),
];

/** The nav label of a row: its own override, else its section's label. */
export function settingsNavRowLabel(row: SettingsNavRow): string {
  return row.label ?? SETTINGS_SECTIONS.find((s) => s.id === row.target.section)?.label ?? row.target.section;
}

/**
 * Who a section reaches. The two node sections that still have space-shaped
 * ids (`node-credentials`, `filesystem-access`, kept for old links) are the
 * server's. `overview` reaches nobody — it only links — so it has no chip.
 */
export function scopeOfSection(section: SettingsSectionId): SettingsScope | null {
  if (section === 'node-credentials' || section === 'filesystem-access') return 'node';
  const hit = ALL_ROWS.find(({ row }) => row.target.scope === 'space' && row.target.section === section);
  return hit ? (hit.row.scope ?? hit.group.scope) : null;
}

export function settingsNavKey(target: SettingsNavTarget): string {
  return `${target.scope}:${target.section}`;
}

export function settingsNavTargetOfKey(key: string): SettingsNavTarget | null {
  if (key === settingsNavKey(SETTINGS_OVERVIEW_TARGET)) return SETTINGS_OVERVIEW_TARGET;
  return ALL_ROWS.find(({ row }) => settingsNavKey(row.target) === key)?.row.target ?? null;
}

/**
 * The row a settings route lights. A bare `/settings` opens the Overview,
 * `/space-admin` the space profile, `/node-admin` node credentials — the last
 * two are each page's own default from before the nav was one.
 */
export function settingsNavKeyOfRoute(route: {
  scope?: 'space' | 'node';
  section: SettingsRouteSection | NodeAdminRouteSection | null;
}): string {
  if (route.scope === 'node') return settingsNavKey({ scope: 'node', section: (route.section as NodeAdminRouteSection | null) ?? 'credentials' });
  const section = route.section as SettingsRouteSection | null;
  if (section === 'node-credentials') return settingsNavKey({ scope: 'node', section: 'credentials' });
  if (section === 'filesystem-access') return settingsNavKey({ scope: 'node', section: 'filesystem' });
  return settingsNavKey({ scope: 'space', section: section ?? (route.scope === 'space' ? 'profile' : 'overview') });
}

export interface SettingsAccess {
  space: boolean;
  node: boolean;
}

function allowed(row: SettingsNavRow, access: SettingsAccess): boolean {
  return !row.requires || (row.requires === 'space-admin' ? access.space : access.node);
}

/**
 * The scope groups as a viewer sees them: rows needing a role they lack are
 * dropped, and so is a subgroup or group left with nothing in it.
 */
export function visibleSettingsNav(access: SettingsAccess): SettingsNavGroupDef[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    subgroups: group.subgroups
      .map((subgroup) => ({ ...subgroup, rows: subgroup.rows.filter((row) => allowed(row, access)) }))
      .filter((subgroup) => subgroup.rows.length > 0),
  })).filter((group) => group.subgroups.length > 0);
}

/** The nav's groups for a viewer, in `FrameNav`'s shape. */
export function settingsNavGroups(access: SettingsAccess): FrameNavGroup[] {
  return [
    {
      id: 'overview',
      label: null,
      items: [{ key: settingsNavKey(SETTINGS_OVERVIEW_TARGET), label: 'Overview', keywords: ['home', 'summary', 'all settings'] }],
    },
    ...visibleSettingsNav(access).map((group) => ({
      id: group.id,
      label: group.label,
      description: group.description,
      items: group.subgroups.flatMap((subgroup) =>
        subgroup.rows.map((row) => {
          const scope = row.scope ?? group.scope;
          return {
            key: settingsNavKey(row.target),
            label: settingsNavRowLabel(row),
            ...(subgroup.label ? { subheading: subgroup.label } : {}),
            /* A row whose scope differs from its group's says so in place. */
            ...(scope !== group.scope ? { detail: SETTINGS_SCOPE_CHIP[scope].toLowerCase() } : {}),
            keywords: [...(row.keywords ?? []), group.label],
            ...(subgroup.tone === 'danger' ? { tone: 'danger' as const } : {}),
          };
        }),
      ),
    })),
  ];
}

/**
 * Whether a row answers a filter query: its label, its subgroup heading, its
 * group, or one of its keywords contains the query. The ONE matcher — the
 * frame nav and the Overview's search both call it, so "api key" finds the
 * same rows in both places.
 */
export function settingsNavRowMatches(
  row: SettingsNavRow,
  context: { group: SettingsNavGroupDef; subgroup: SettingsNavSubgroup },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const words = [settingsNavRowLabel(row), context.subgroup.label ?? '', context.group.label, ...(row.keywords ?? [])];
  return words.some((word) => word.toLowerCase().includes(q));
}
