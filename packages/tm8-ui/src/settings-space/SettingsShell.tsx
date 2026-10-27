/** Shared settings layout. Optional sectionIds narrows navigation and mounted content;
 * omitted preserves legacy settings. SpaceAdminPage applies the authorization boundary. */
import { useEffect, useState } from 'react';
import type { SpaceSummary } from '@tm8/contract';
import { MembersSection, viewerRoleIn } from './MembersSection';
import { SharingSection } from './SharingSection';
import { ownerRoleRef } from './port';
import { ModelsSection } from './ModelsSection';
import { ChatDefaultsSection } from './ChatDefaultsSection';
import { InvitesPanel } from './InviteFrames';
import { IdentityProfileSection } from './IdentityProfileSection';
import { MenuEditor } from './MenuEditor';
import { AxesSection } from './AxesSection';
import { WorkflowsSection } from './WorkflowsSection';
import { ProfileSection } from './ProfileSection';
import { DangerSection } from './DangerSection';
import { ConfigsSection } from './ConfigsSection';
import { SessionsSection } from './SessionsSection';
import { SectionAbsent, SectionFrame, SectionScopeContext } from './SectionFrame';
import { OverviewSection } from './OverviewSection';
import { SETTINGS_SCOPE_CHIP, scopeOfSection, settingsNavRowLabel, visibleSettingsNav, type SettingsAccess } from './nav';
import { SECTION_NOT_MOUNTED } from './reasons';
import { DESKTOP_ONLY_SECTIONS, PHONE_READ_ONLY_TAGS, PHONE_SECTION_HINTS, PHONE_SECTION_ICONS, PHONE_SETTINGS_GROUPS, phoneLiveHint } from './phone-sections';
import { SETTINGS_SECTIONS, type SettingsData, type SettingsSectionDef, type SettingsSectionId, type SettingsShellProps } from './types';

export function SettingsShell({
  port,
  sections,
  initialSection,
  onSectionChange,
  onSectionClear,
  nodeKey = 'local',
  onAxesChanged,
  onLeftSpace,
  sectionIds,
  onOpenSpaceAdmin,
  onOpenNodeAdmin,
  onOpenNodeSection,
  framed = false,
  stacked = false,
  onOpenAppearance,
}: SettingsShellProps) {
  /* Stacked opens on the LIST unless the address named a section: a phone
     that landed on Members & roles would hide that the list exists. The
     desktop opens on the Overview for the same reason (settings redesign). */
  const [active, setActive] = useState<SettingsSectionId | null>(initialSection ?? (stacked ? null : 'overview'));
  const [data, setData] = useState<SettingsData>({
    space: null,
    members: [],
    identity: null,
    menu: null,
    invites: null,
    axes: null,
    workflows: null,
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Each read is settled independently: one failing read must not blank the
    // other three sections. A screen that goes empty because an unrelated
    // request failed is the failure mode "loading" states hide.
    void (async () => {
      const [space, members, identity, menu, invites, axes, workflows] = await Promise.allSettled([
        port.loadSpace(),
        port.loadMembers(),
        port.loadIdentity(),
        port.loadMenu(),
        port.loadInvites(),
        port.loadAxes(),
        port.loadWorkflows(),
      ]);
      if (!live) return;
      // The invite read is EXCLUDED from the failure count. It is admin-only,
      // so a plain member's settings screen rejects it every single time and
      // that is the correct answer, not a fault — counting it would tell every
      // member "1 of 5 settings reads failed" on a screen that is working.
      const failures = [space, members, identity, menu].filter((r) => r.status === 'rejected');
      setLoadError(failures.length ? `${failures.length} of 4 settings reads failed` : null);
      setData({
        space: space.status === 'fulfilled' ? space.value : null,
        members: members.status === 'fulfilled' ? members.value : [],
        identity: identity.status === 'fulfilled' ? identity.value : null,
        menu: menu.status === 'fulfilled' ? menu.value : null,
        // `null` on rejection, which the panel renders as "has not been read"
        // rather than as an empty list — the distinction the panel exists to
        // keep.
        invites: invites.status === 'fulfilled' ? invites.value : null,
        // Same posture as invites and EXCLUDED from the count for the same
        // reason: the read rides the admin-shaped settings round trip, and a
        // `null` renders as "not read", never as a space with no axes.
        axes: axes.status === 'fulfilled' ? axes.value : null,
        // W4 — same posture and same exclusion from the count as axes.
        workflows: workflows.status === 'fulfilled' ? workflows.value : null,
      });
    })();
    return () => {
      live = false;
    };
  }, [port]);

  function go(id: SettingsSectionId) {
    setActive(id);
    onSectionChange?.(id);
  }

  // After a profile save, the identity read is re-run rather than patched
  // locally: the server is the authority on what was actually written, and
  // every other section consuming `identity` (the members "you" row) should
  // reflect the same answer.
  function refreshIdentity() {
    void port.loadIdentity().then(
      (identity) => setData((d) => ({ ...d, identity })),
      () => undefined,
    );
  }

  /**
   * Re-read after a membership write rather than patching state locally.
   *
   * Same rule as `refreshIdentity` above and the same reason: the server is the
   * authority on what was actually written. It matters more here — the role
   * rules are enforced in SQL, so a locally-patched row could show a promotion
   * that a rule refused, and the refusal is exactly the case the reader needs
   * to see.
   */
  function refreshMembers() {
    void port.loadMembers().then(
      (members) => setData((d) => ({ ...d, members })),
      () => undefined,
    );
  }

  /**
   * After a sharing-default write, adopt the space the server RETURNED — the
   * write's own answer, not a local patch — so the radios show what
   * `w2_update_space` stored rather than what was clicked.
   */
  function spaceWritten(space: SpaceSummary) {
    setData((d) => ({ ...d, space }));
  }

  function refreshInvites() {
    void port.loadInvites().then(
      (invites) => setData((d) => ({ ...d, invites })),
      () => undefined,
    );
  }

  /** Re-read after an axis write — the server is the authority on what landed. */
  function refreshAxes() {
    void port.loadAxes().then(
      (axes) => setData((d) => ({ ...d, axes })),
      () => undefined,
    );
    // The workspace's own pickers (W1) and board options (W3) read a separate
    // projection; the host refreshes it here or not at all — axis rows are
    // not entities and emit no event.
    onAxesChanged?.();
  }

  /**
   * Re-read after a workflow write — same rule as `refreshAxes`. It reuses
   * `onAxesChanged` deliberately: the host's refresh re-reads the ONE
   * `spaceSettings()` round trip both registries ride, so one callback keeps
   * the workspace's pickers AND its workflow narrowing current together.
   */
  function refreshWorkflows() {
    void port.loadWorkflows().then(
      (workflows) => setData((d) => ({ ...d, workflows })),
      () => undefined,
    );
    onAxesChanged?.();
  }

  const visibleSections = SETTINGS_SECTIONS.filter((s) => !sectionIds || sectionIds.includes(s.id));
  const visibleActive = visibleSections.some((s) => s.id === active) ? active : visibleSections[0]?.id;

  const spaceLabel = data.space?.name ?? '—';
  /* The host hands the admin doors only to a viewer holding the role
     (GateApp's `adminAccess`), so their presence IS the access answer — the
     same one the frame nav is gated on. */
  const access: SettingsAccess = { space: !!onOpenSpaceAdmin, node: !!onOpenNodeAdmin };
  const openNode = onOpenNodeSection ?? (onOpenNodeAdmin ? () => onOpenNodeAdmin() : undefined);

  const loadErrorNote = loadError ? (
    <div className="set-absent" data-testid="settings-load-error">
      <span className="set-absent__head">{loadError}</span>
      <span className="set-absent__why">
        the sections below show what did load — nothing here is filled in from a cache
      </span>
    </div>
  ) : null;

  const sectionBody = (id: SettingsSectionId) => (
    <SectionScopeContext.Provider value={scopeOfSection(id)}>
    <SectionBody
      id={id}
      access={access}
      openable={visibleSections.map((s) => s.id)}
      onOpenNode={openNode}
      data={data}
      sections={sections}
      onGo={go}
      port={port}
      onProfileSaved={refreshIdentity}
      onMembersChanged={refreshMembers}
      {...(onLeftSpace ? { onLeftSpace } : {})}
      onInvitesChanged={refreshInvites}
      onMenuWritten={(menu) => setData((d) => ({ ...d, menu }))}
      onSpaceWritten={spaceWritten}
      onAxesChanged={refreshAxes}
      onWorkflowsChanged={refreshWorkflows}
      nodeKey={nodeKey}
      phone={stacked}
    />
    </SectionScopeContext.Provider>
  );

  if (stacked) {
    /* A section the address named but this scope does not list (a member
       following an admin's link) falls back to the list, not to a neighbour. */
    const open = visibleSections.find((s) => s.id === active) ?? null;
    return (
      <div className="set-root set-root--stacked cv2-root" data-stacked="true" data-testid="settings-stacked">
        {open ? (
          <section className="set-stack__page" aria-label={open.heading}>
            <button
              type="button"
              className="set-stack__back"
              data-testid="settings-back"
              aria-label="Back to Settings"
              onClick={() => {
                setActive(null);
                onSectionClear?.();
              }}
            >
              <span aria-hidden>‹</span>
              <span>Settings</span>
            </button>
            {loadErrorNote}
            {DESKTOP_ONLY_SECTIONS.has(open.id) ? (
              <DesktopOnlySection def={open} />
            ) : (
              <div className="set-body">{sectionBody(open.id)}</div>
            )}
          </section>
        ) : (
          <nav className="set-stack" aria-label="Settings sections">
            <span className="set-nav__eyebrow">Space · {spaceLabel}</span>
            {loadErrorNote}
            {onOpenSpaceAdmin ? (
              <div className="set-stack__group">
                <ul className="set-stack__rows">
                  <li>
                    <button type="button" className="set-stack__row" onClick={onOpenSpaceAdmin}>
                      <span className="set-stack__tile" data-tone="run" aria-hidden>⚿</span>
                      <span className="set-stack__text">
                        <span className="set-stack__label">Space admin</span>
                        <span className="set-stack__hint">Owner and admin settings</span>
                      </span>
                      <span className="set-stack__chev" aria-hidden>›</span>
                    </button>
                  </li>
                </ul>
              </div>
            ) : null}
            {PHONE_SETTINGS_GROUPS.map((group) => {
              const rows = group.ids
                .map((id) => visibleSections.find((s) => s.id === id))
                .filter((s): s is SettingsSectionDef => !!s);
              if (rows.length === 0) return null;
              return (
                <div key={group.title} className="set-stack__group">
                  <h2 className="set-stack__title">{group.title}</h2>
                  <ul className="set-stack__rows">
                    {rows.map((s) => {
                      const icon = PHONE_SECTION_ICONS[s.id];
                      const desktop = DESKTOP_ONLY_SECTIONS.has(s.id);
                      const tag = desktop ? 'desktop' : PHONE_READ_ONLY_TAGS[s.id];
                      const hint = phoneLiveHint(s.id, data) ?? PHONE_SECTION_HINTS[s.id];
                      /* The space's own mark, as drawn, where the space has a name. */
                      const glyph = s.id === 'profile' && data.space?.name ? spaceMark(data.space.name) : icon.glyph;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            className={`set-stack__row${s.danger ? ' set-stack__row--danger' : ''}${desktop ? ' set-stack__row--off' : ''}`}
                            data-section={s.id}
                            onClick={() => go(s.id)}
                          >
                            <span className="set-stack__tile" data-tone={icon.tone} aria-hidden>{glyph}</span>
                            <span className="set-stack__text">
                              <span className="set-stack__label">{s.label}</span>
                              {hint ? <span className="set-stack__hint" data-testid={`settings-hint-${s.id}`}>{hint}</span> : null}
                            </span>
                            {tag ? <span className="set-stack__tag" data-tag={tag}>{tag}</span> : null}
                            <span className="set-stack__chev" aria-hidden>›</span>
                          </button>
                        </li>
                      );
                    })}
                    {/* THERE IS NO APPEARANCE SECTION. Light / dark lives in the
                        account sheet, so this row points there (↗) rather than
                        copying it — two switches for one setting drift. */}
                    {group.title === 'You' && onOpenAppearance ? (
                      <li>
                        <button type="button" className="set-stack__row" data-testid="settings-appearance" onClick={onOpenAppearance}>
                          <span className="set-stack__tile" data-tone="idle" aria-hidden>◐</span>
                          <span className="set-stack__text">
                            <span className="set-stack__label">Appearance</span>
                            <span className="set-stack__hint">Light / dark lives in your account menu</span>
                          </span>
                          <span className="set-stack__chev" aria-hidden>↗</span>
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="set-root cv2-root" data-framed={framed || undefined}>
      <div className="set-card">
        {framed ? null : <nav className="set-nav" aria-label="Space settings sections">
          {onOpenSpaceAdmin && <button type="button" className="set-nav__row" onClick={onOpenSpaceAdmin}>Space admin</button>}
          {onOpenNodeAdmin && <button type="button" className="set-nav__row" onClick={onOpenNodeAdmin}>Node admin</button>}
          <span className="set-nav__eyebrow">Space · {spaceLabel}</span>
          {legacyNavGroups(visibleSections, access).map((group) => (
            <div key={group.id} className="set-nav__group" role="group" aria-label={group.label ?? undefined}>
              {group.label ? (
                <span className="set-nav__heading" title={group.description}>
                  {group.label}
                  {group.scope ? <span className="set-nav__scope">{SETTINGS_SCOPE_CHIP[group.scope]}</span> : null}
                </span>
              ) : null}
              {group.rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`set-nav__row${row.danger ? ' set-nav__row--danger' : ''}`}
                  aria-current={visibleActive === row.id ? 'true' : undefined}
                  onClick={() => go(row.id)}
                >
                  {row.label}
                </button>
              ))}
            </div>
          ))}
        </nav>}

        <div className="set-body">
          {loadErrorNote}
          {visibleActive && sectionBody(visibleActive)}
        </div>
      </div>
    </div>
  );
}

/**
 * The unframed shell's own nav (the legacy bar), grouped by the same scope
 * model as the frame nav. Sections this shell lists but the model does not
 * (the two node sections with space-shaped ids, on the unscoped legacy shell)
 * land under Server rather than vanishing.
 */
function legacyNavGroups(visible: readonly SettingsSectionDef[], access: SettingsAccess) {
  const shown = new Set(visible.map((s) => s.id));
  const placed = new Set<SettingsSectionId>();
  const take = (id: SettingsSectionId, label?: string) => {
    placed.add(id);
    const def = visible.find((s) => s.id === id)!;
    return { id, label: label ?? def.label, danger: !!def.danger };
  };
  const groups: { id: string; label: string | null; description?: string; scope?: keyof typeof SETTINGS_SCOPE_CHIP; rows: ReturnType<typeof take>[] }[] = [];
  if (shown.has('overview')) groups.push({ id: 'overview', label: null, rows: [take('overview')] });
  /* Role gating is the shell's `sectionIds`, not the nav's: an unframed
     shell lists every section its scope was given. */
  for (const group of visibleSettingsNav({ space: true, node: access.node })) {
    const rows = group.subgroups.flatMap((subgroup) => subgroup.rows)
      .flatMap((row) => (row.target.scope === 'space' && shown.has(row.target.section) ? [take(row.target.section, settingsNavRowLabel(row))] : []));
    if (rows.length) groups.push({ id: group.id, label: group.label, description: group.description, scope: group.scope, rows });
  }
  const rest = visible.filter((s) => !placed.has(s.id)).map((s) => take(s.id));
  if (rest.length) {
    const server = groups.find((g) => g.id === 'node');
    if (server) server.rows.push(...rest);
    else groups.push({ id: 'node', label: 'Server', description: 'Node admins only — reaches every space on this server.', scope: 'node', rows: rest });
  }
  return groups;
}

/** The space's initial, the mark it carries where it has no logo. */
function spaceMark(name: string): string {
  return ([...name.trim()][0] ?? '⌂').toUpperCase();
}

/**
 * A section that lists on the phone but does not open there. It names why and
 * hands over the address, which is the one thing a phone can usefully do with
 * an editor it cannot draw.
 */
function DesktopOnlySection({ def }: { def: SettingsSectionDef }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="mobile-empty set-stack__refusal" data-testid="settings-desktop-only" data-section={def.id}>
      <p>“{def.label}” doesn’t have a phone layout yet.</p>
      <p>It works on a desktop — this link opens it there.</p>
      <button
        type="button"
        className="mobile-empty__out"
        onClick={() => {
          const href = typeof window === 'undefined' ? '' : window.location.href;
          void (navigator.clipboard?.writeText(href) ?? Promise.reject(new Error('no clipboard'))).then(
            () => setCopied('copied'),
            () => setCopied('failed'),
          );
        }}
      >
        {copied === 'copied' ? 'Link copied' : copied === 'failed' ? 'Copy failed — use the address bar' : 'Copy link for desktop'}
      </button>
    </div>
  );
}

function SectionBody({
  id,
  access,
  openable,
  onOpenNode,
  data,
  sections,
  onGo,
  port,
  onProfileSaved,
  onMembersChanged,
  onLeftSpace,
  onInvitesChanged,
  onSpaceWritten,
  onMenuWritten,
  onAxesChanged,
  onWorkflowsChanged,
  nodeKey,
  phone,
}: {
  id: SettingsSectionId;
  access: SettingsAccess;
  openable: readonly SettingsSectionId[];
  onOpenNode?: SettingsShellProps['onOpenNodeSection'];
  data: SettingsData;
  sections: SettingsShellProps['sections'];
  onGo: (id: SettingsSectionId) => void;
  port: SettingsShellProps['port'];
  onProfileSaved: () => void;
  onMembersChanged: () => void;
  onLeftSpace?: SettingsShellProps['onLeftSpace'];
  onInvitesChanged: () => void;
  onMenuWritten: (menu: NonNullable<SettingsData['menu']>) => void;
  onSpaceWritten: (space: SpaceSummary) => void;
  onAxesChanged: () => void;
  onWorkflowsChanged: () => void;
  nodeKey: string;
  /** The stacked phone arrangement: sections with a phone layout take it. */
  phone: boolean;
}) {
  const injected = sections?.[id];
  if (injected !== undefined) return <>{injected}</>;

  const def = SETTINGS_SECTIONS.find((s) => s.id === id)!;

  switch (id) {
    case 'overview':
      return <OverviewSection data={data} access={access} openable={openable} onOpen={onGo} onOpenNode={onOpenNode} />;
    case 'members':
      return (
        <MembersSection
          members={data.members}
          identity={data.identity}
          onInvite={() => onGo('invites')}
          onRoleChange={async (memberId, role) => {
            // Deliberately NOT caught here: `MembersSection` renders the
            // server's own refusal text beside the row it belongs to, and a
            // catch at this level would swallow the one message that tells the
            // reader what to do next.
            await port.setMemberRole(memberId, role);
            onMembersChanged();
          }}
          {...(port.removeMember
            ? {
                onRemove: async (memberId: string) => {
                  // Not caught, as above: the confirmation prints the refusal.
                  // No local hide set: the entities query stops listing an
                  // ended member (G6, #841), so the re-read is the authority.
                  await port.removeMember!(memberId);
                  onMembersChanged();
                },
              }
            : {})}
        />
      );
    case 'invites':
      return (
        <InvitesPanel
          invites={data.invites}
          onCreate={async (input) => {
            await port.createInvite(input);
            onInvitesChanged();
          }}
          onRevoke={async (inviteId) => {
            await port.revokeInvite(inviteId);
            onInvitesChanged();
          }}
        />
      );
    case 'sharing': {
      const viewerRole = viewerRoleIn(data.members, data.identity);
      const viewerIsAdmin = viewerRole !== null
        && (viewerRole === ownerRoleRef() || viewerRole === 'admin');
      return (
        <SharingSection
          space={data.space}
          viewerIsAdmin={viewerIsAdmin}
          heading={def.heading}
          onChange={async (patch) => {
            // Not caught here, for the reason `onRoleChange` gives above: the
            // section renders the server's refusal beside its own dial.
            onSpaceWritten(await port.updateSharingDefaults(patch));
          }}
        />
      );
    }
    case 'menu':
      /* `measure={false}`: the editor draws a two-column author/preview pair
         and capping it at the reading measure would stack them into a single
         narrow column on a screen with room for both. */
      return (
        <SectionFrame title={def.heading} measure={false} bodyTestId="menu-body">
          {data.menu ? (
            <MenuEditor menu={data.menu} spaceName={data.space?.name}
              {...(port.saveMenu && data.identity?.memberships.some((m) => m.spaceId === data.space?.id && (m.role === ownerRoleRef() || m.role === 'admin')) ? {
                onSave: async (payload, revision) => { onMenuWritten(await port.saveMenu!(payload, revision)); },
                onReload: async () => { onMenuWritten(await port.loadMenu()); },
              } : {})} />
          ) : (
            <SectionAbsent
              head="The menu could not be read."
              why="seam.menu did not resolve — the rail is showing its own fallback, and this editor has nothing to edit"
            />
          )}
        </SectionFrame>
      );
    case 'profile':
      return <ProfileSection space={data.space} heading={def.heading}
        {...(data.identity?.memberships.some((m) => m.spaceId === data.space?.id && (m.role === ownerRoleRef() || m.role === 'admin')) && port.updateSpace
          ? { onSave: async (patch) => { onSpaceWritten(await port.updateSpace!(patch)); } } : {})} />;
    case 'account':
      return (
        <IdentityProfileSection
          identity={data.identity}
          spaceId={data.space?.id ?? ''}
          onSave={(input) => port.updateProfile(input)}
          onSaved={onProfileSaved}
        />
      );
    case 'models':
      // Browser-local, so it needs no port and cannot be refused by the seam.
      // The node key comes from the shell because the catalog is per node.
      return <ModelsSection nodeKey={nodeKey} heading={def.heading} />;
    case 'chat-defaults':
      // Space-wide and server-stored; self-loading through the shared
      // `useChatDefaults` cache. Writes are NOT caught here — the section
      // renders the server's refusal beside the row it belongs to.
      return <ChatDefaultsSection heading={def.heading} nodeKey={nodeKey} wiring={port.chatDefaults} phone={phone} />;
    case 'axes':
      /* W2 — the real registry, read off the same settings round trip as
         invites. The refusal this replaces (AXES_UNREADABLE) was measured
         FALSE on 2026-08-16: the contract defined `TaskAxis` and the seam
         already delivered `taskAxes`. Writes are NOT caught here — the
         section renders the server's own refusal beside the act, same rule
         as `MembersSection`. */
      return (
        <AxesSection
          axes={data.axes}
          onCreate={async (input) => {
            await port.createAxis(input);
            onAxesChanged();
          }}
          onUpdate={async (axisId, input) => {
            await port.updateAxis(axisId, input);
            onAxesChanged();
          }}
          onDelete={async (axisId) => {
            await port.deleteAxis(axisId);
            onAxesChanged();
          }}
          tasksUsing={(axis) => port.tasksUsingAxis(axis)}
          /* Read-only on the phone (mockup 01a14cc4): an axis edit changes
             what every workflow keys on, which is desktop work. */
          readOnly={phone}
        />
      );
    case 'workflows':
      /* W4 — per-type status vocabularies (132), authored beside Axes.
         Writes are NOT caught here — the section renders the server's own
         refusal beside the act, same rule as `MembersSection`/`AxesSection`. */
      return (
        <WorkflowsSection
          axes={data.axes}
          workflows={data.workflows}
          onUpsert={async (input) => {
            await port.upsertWorkflow(input);
            onWorkflowsChanged();
          }}
          onDelete={async (workflowId) => {
            await port.deleteWorkflow(workflowId);
            onWorkflowsChanged();
          }}
        />
      );
    case 'configs':
      /* Read-only and self-loading: the section reads `spaces.configs` when it
         opens, not on the shell's boot round trip, so a closed Configs tab
         costs nothing. */
      return <ConfigsSection heading={def.heading} load={port.loadConfigs} />;
    case 'my-sessions':
      return (
        <SessionsSection
          heading={def.heading}
          scope="own"
          {...(port.loadOwnSessions ? { load: port.loadOwnSessions } : {})}
          {...(port.revokeSession ? { revoke: port.revokeSession } : {})}
          {...(port.signOutHere ? { signOutHere: port.signOutHere } : {})}
        />
      );
    case 'sessions':
      return (
        <SessionsSection
          heading={def.heading}
          scope="space"
          {...(port.loadSpaceSessions ? { load: port.loadSpaceSessions } : {})}
          {...(port.revokeSession ? { revoke: port.revokeSession } : {})}
          {...(port.signOutHere ? { signOutHere: port.signOutHere } : {})}
        />
      );
    case 'danger':
      return (
        <DangerSection
          heading={def.heading}
          {...(data.space ? { spaceName: data.space.name } : {})}
          {...(port.leaveSpace
            ? {
                onLeave: async () => {
                  const result = await port.leaveSpace!();
                  onLeftSpace?.(result.spaceId);
                },
              }
            : {})}
        />
      );
    default:
      return (
        <SectionFrame title={def.heading}>
          <SectionAbsent
            head="This section is built in another module and is not mounted here."
            why={`${SECTION_NOT_MOUNTED.cause} — ${SECTION_NOT_MOUNTED.remedy}`}
          />
        </SectionFrame>
      );
  }
}
