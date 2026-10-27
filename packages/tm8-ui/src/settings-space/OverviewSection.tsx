/**
 * THE SETTINGS OVERVIEW (settings redesign, 2026-10-18) — what a bare
 * `/settings` opens. Before it, the address dropped you on Members & roles
 * with no sense of what else there was or who each page affected.
 *
 * One card per scope, straight off the nav model (`SETTINGS_NAV_GROUPS`), so
 * the cards and the nav can never list different things. Each card leads with
 * a status line built ONLY from what the shell has already read on its boot
 * round trip (`SettingsData`): this page makes no request of its own. A read
 * that failed says nothing rather than a made-up zero — the same posture as
 * `phoneLiveHint`, which this reuses per row.
 *
 * Every control here is navigation: it switches the section the shell shows
 * (or, for a server row, asks the host to open the node page). None of them
 * asks the seam anything, which is why they are on `LIVE_VERBS`.
 */
import { useId, useMemo, useState } from 'react';
import type { NodeAdminRouteSection } from '../routes/types';
import { SectionFrame } from './SectionFrame';
import { stateOf } from './InviteFrames';
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SCOPE_CHIP,
  settingsNavRowLabel,
  settingsNavRowMatches,
  visibleSettingsNav,
  type SettingsAccess,
  type SettingsNavGroupDef,
  type SettingsNavRow,
} from './nav';
import { PHONE_SECTION_HINTS, phoneLiveHint } from './phone-sections';
import type { SettingsData, SettingsSectionId } from './types';
import './overview-section.css';

/**
 * Where the phone's hint is about the PHONE ("Status only on phone", "Needs a
 * folder picker"), the desktop says what the page is for instead.
 */
const DESKTOP_HINTS: Partial<Record<SettingsSectionId, string>> = {
  'space-credentials': 'Keys the whole space launches with',
  projects: 'Repositories this space works in',
  workflows: 'Statuses per task type',
  menu: 'Arrange the sidebar',
  kinds: 'Your own entity types',
  danger: 'Leave, transfer or delete',
};

const NODE_HINTS: Record<NodeAdminRouteSection, string> = {
  credentials: 'The server’s own keys and fallback policy',
  filesystem: 'Which folders members may browse',
  accounts: 'Everyone with an account on this server',
  configuration: 'Environment and code constants',
};

export interface OverviewSectionProps {
  data: SettingsData;
  access: SettingsAccess;
  /** The space sections this shell can open; rows outside it are not drawn. */
  openable: readonly SettingsSectionId[];
  onOpen: (section: SettingsSectionId) => void;
  /** Opens a node page. Absent ⇒ server rows list without a way in. */
  onOpenNode?: ((section: NodeAdminRouteSection) => void) | undefined;
}

export function OverviewSection({ data, access, openable, onOpen, onOpenNode }: OverviewSectionProps) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const groups = useMemo(
    () =>
      visibleSettingsNav(access)
        .map((group) => ({
          ...group,
          subgroups: group.subgroups
            .map((subgroup) => ({
              ...subgroup,
              rows: subgroup.rows.filter(
                (row) =>
                  (row.target.scope === 'node' ? !!onOpenNode : openable.includes(row.target.section)) &&
                  settingsNavRowMatches(row, { group, subgroup }, query),
              ),
            }))
            .filter((subgroup) => subgroup.rows.length > 0),
        }))
        .filter((group) => group.subgroups.length > 0),
    [access, openable, onOpenNode, query],
  );
  const serverHidden = !access.node && !query.trim();
  const shownRows = groups.reduce((n, g) => n + g.subgroups.reduce((m, s) => m + s.rows.length, 0), 0);

  return (
    <SectionFrame title="Settings" scope={null} bodyTestId="settings-overview">
      <div className="set-ov">
        <p className="set-ov__lede">
          {data.space ? <>Settings for <strong>{data.space.name}</strong>. </> : null}
          Grouped by who a change reaches — only you, everyone in this space, or the whole server.
        </p>
        <div className="set-ov__search">
          <label htmlFor={searchId} className="set-ov__search-label">Find a setting</label>
          <input
            id={searchId}
            type="search"
            className="set-ov__search-input"
            aria-label="Find a setting"
            placeholder="Try “api key”, “invite” or “model”"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
          <span className="set-ov__count" role="status" aria-live="polite">
            {query.trim() ? (shownRows === 0 ? `Nothing matches “${query.trim()}”.` : `${shownRows} setting${shownRows === 1 ? '' : 's'} match`) : ''}
          </span>
        </div>
        <div className="set-ov__grid">
          {groups.map((group) => (
            <ScopeCard key={group.id} group={group} data={data} onOpen={onOpen} onOpenNode={onOpenNode} />
          ))}
          {serverHidden ? (
            <section className="set-ov__card set-ov__card--locked" data-scope="node" aria-label="Server">
              <header className="set-ov__card-head">
                <h2 className="set-ov__card-title">Server</h2>
                <span className="set-scope-chip" data-scope="node">{SETTINGS_SCOPE_CHIP.node}</span>
              </header>
              <p className="set-ov__card-desc">
                {SETTINGS_NAV_GROUPS.find((g) => g.id === 'node')?.description} You are not a node admin here,
                so these are not listed.
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </SectionFrame>
  );
}

function ScopeCard({
  group,
  data,
  onOpen,
  onOpenNode,
}: {
  group: SettingsNavGroupDef;
  data: SettingsData;
  onOpen: (section: SettingsSectionId) => void;
  onOpenNode?: ((section: NodeAdminRouteSection) => void) | undefined;
}) {
  const status = statusOf(group.id, data);
  return (
    <section className="set-ov__card" data-scope={group.scope} data-group={group.id} aria-label={group.label}>
      <header className="set-ov__card-head">
        <h2 className="set-ov__card-title">{group.label}</h2>
        <span className="set-scope-chip" data-scope={group.scope}>{SETTINGS_SCOPE_CHIP[group.scope]}</span>
      </header>
      <p className="set-ov__card-desc">{group.description}</p>
      {status ? <p className="set-ov__status" data-testid={`overview-status-${group.id}`}>{status}</p> : null}
      {group.subgroups.map((subgroup, index) => (
        <div key={subgroup.label ?? index} className="set-ov__sub" data-tone={subgroup.tone}>
          {subgroup.label ? <h3 className="set-ov__sub-title">{subgroup.label}</h3> : null}
          <ul className="set-ov__rows">
            {subgroup.rows.map((row) => (
              <li key={`${row.target.scope}:${row.target.section}`}>
                <OverviewRow row={row} groupScope={group.scope} data={data} onOpen={onOpen} onOpenNode={onOpenNode} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function OverviewRow({
  row,
  groupScope,
  data,
  onOpen,
  onOpenNode,
}: {
  row: SettingsNavRow;
  groupScope: SettingsNavGroupDef['scope'];
  data: SettingsData;
  onOpen: (section: SettingsSectionId) => void;
  onOpenNode?: ((section: NodeAdminRouteSection) => void) | undefined;
}) {
  const label = settingsNavRowLabel(row);
  const target = row.target;
  const hint =
    target.scope === 'node'
      ? NODE_HINTS[target.section]
      : phoneLiveHint(target.section, data) ?? DESKTOP_HINTS[target.section] ?? PHONE_SECTION_HINTS[target.section];
  const scope = row.scope ?? groupScope;
  return (
    <button
      type="button"
      className="set-ov__row"
      aria-label={`Go to ${label} settings`}
      data-section={`${target.scope}:${target.section}`}
      onClick={() => (target.scope === 'node' ? onOpenNode?.(target.section) : onOpen(target.section))}
    >
      <span className="set-ov__row-label">{label}</span>
      {scope !== groupScope ? <span className="set-scope-chip set-scope-chip--quiet" data-scope={scope}>{SETTINGS_SCOPE_CHIP[scope]}</span> : null}
      {hint ? <span className="set-ov__row-hint">{hint}</span> : null}
      <span className="set-ov__row-chev" aria-hidden>›</span>
    </button>
  );
}

/** A card's one-line status, from reads the shell already made. */
function statusOf(group: SettingsNavGroupDef['id'], data: SettingsData): string | null {
  if (group === 'account') {
    const who = data.identity;
    if (!who) return null;
    return `Signed in as ${who.displayName ? `${who.displayName} (@${who.username})` : `@${who.username}`}`;
  }
  if (group === 'space') {
    const parts: string[] = [];
    if (data.members.length > 0) parts.push(`${data.members.length} member${data.members.length === 1 ? '' : 's'}`);
    if (data.invites) {
      const live = data.invites.filter((invite) => stateOf(invite) === 'live').length;
      parts.push(`${live} pending invite${live === 1 ? '' : 's'}`);
    }
    if (data.axes) parts.push(`${data.axes.length} task ax${data.axes.length === 1 ? 'is' : 'es'}`);
    if (data.workflows) parts.push(`${data.workflows.length} workflow${data.workflows.length === 1 ? '' : 's'}`);
    return parts.length ? parts.join(' · ') : null;
  }
  return null;
}
