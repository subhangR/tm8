/**
 * T2-1a — THE SETTINGS SHELL: the section nav and the one-section-at-a-time
 * body (oracle L28–L45, plus the header line at L24: "a full view (menu ›
 * Settings) — section nav left, one section at a time").
 *
 * THE THING THIS FILE EXISTS TO PREVENT: the oracle's nav names EIGHT
 * destinations and draws exactly ONE body. Building only what is drawn would
 * ship seven nav rows that lead nowhere — seven silent voids on a screen whose
 * whole job is to tell you the truth about your space. So every row leads
 * somewhere honest:
 *
 *   profile  — REAL, read-only: name / description / members / created, off
 *              `SpaceSummary`. Editing is disabled-with-reason.
 *   members  — REAL rows, refused writes (MembersSection).
 *   invites  — no capability at all; the absence is stated (InviteFrames).
 *   axes     — REAL rows + CRUD over the ops that existed all along (W2;
              the old AXES_UNREADABLE refusal was measured false).
 *   projects — HALF B's body, injected. Unmounted ⇒ says so.
 *   menu     — REAL editor, refused save (MenuEditor).
 *   kinds    — HALF B's body, injected. Unmounted ⇒ says so.
 *   danger   — the two acts that must never be faked; both refused.
 *
 * SECTION SLOTS ARE HOW TWO LANES MEET WITHOUT EDITING EACH OTHER'S FILES.
 * Half B builds `Linked projects` and `Custom kinds` in its own module; the
 * host passes them through `sections`. Neither lane imports the other.
 */
import { useEffect, useState } from 'react';
import { useMobileSurface } from '../mobile';
import { VectorIcon } from '../kit';
import { MembersSection } from './MembersSection';
import { ModelsSection } from './ModelsSection';
import { InvitesPanel } from './InviteFrames';
import { IdentityProfileSection } from './IdentityProfileSection';
import { MenuEditor } from './MenuEditor';
import { AxesSection } from './AxesSection';
import { WorkflowsSection } from './WorkflowsSection';
import { ProfileSection } from './ProfileSection';
import { DangerSection } from './DangerSection';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SECTION_NOT_MOUNTED } from './reasons';
import { SETTINGS_SECTIONS, type SettingsData, type SettingsSectionId, type SettingsShellProps } from './types';

/* The drilldown's two marks, on `VectorIcon`'s 16x16 grid — the same geometry
   the phone shell's own header chevron uses, mirrored. Not an icon import: a
   chevron is one path, and this surface already draws all of its own marks. */
const CHEVRON_RIGHT: readonly string[] = ['M5.6 3.6 10.4 8l-4.8 4.4'];
const CHEVRON_LEFT: readonly string[] = ['M10.4 3.6 5.6 8l4.8 4.4'];

export function SettingsShell({
  port,
  sections,
  initialSection = 'members',
  onSectionChange,
  nodeKey = 'local',
  onAxesChanged,
}: SettingsShellProps) {
  /*
   * ── THE PHONE ARRANGEMENT ────────────────────────────────────────────────
   *
   * `oneSurface` is true only under the phone shell, so every branch below
   * that reads it is unreachable on a desktop BY CONSTRUCTION — there is no
   * provider on that path. The desktop screen is not touched by this file's
   * phone work; that is the property being relied on, not a selector that has
   * to be kept correct.
   *
   * COLLAPSE, DO NOT NARROW. The desktop is a 160px nav BESIDE a body. At
   * 390px that leaves ~214px, and `.set-menu__editor` alone is authored
   * against 470px — so narrowing gives a screen where both halves are too
   * small, which is the defect, not the fix. The phone shows the nav as a
   * full-width INDEX, and opening a section REPLACES it.
   *
   * `active === null` IS the index, and it is the only state that says so.
   * The alternative — keeping `active` non-null and adding a second
   * `atIndex` boolean — is two variables for one fact, and the one that
   * drifts is the phone's. Null is unreachable on a desktop: nothing sets it
   * there, and the render below proves it to the compiler.
   *
   * `initialSection` is deliberately NOT honoured on a phone. It names which
   * pane opens BESIDE the nav; there is no beside here, and opening straight
   * into a section would put the viewer one level down with no sense of what
   * they had skipped past.
   */
  const { oneSurface } = useMobileSurface();
  const [active, setActive] = useState<SettingsSectionId | null>(oneSurface ? null : initialSection);
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

  const spaceLabel = data.space?.name ?? '—';

  /* One definition, two possible homes. On a desktop it belongs above the
     section body, which is where a reader is looking. On a phone the body
     may not be rendered at all, so it is hoisted to the card — a failed read
     is a fact about the whole screen and must not be reachable only by
     drilling into a section. */
  const errorBlock = loadError ? (
    <div className="set-absent" data-testid="settings-load-error">
      <span className="set-absent__head">{loadError}</span>
      <span className="set-absent__why">
        the sections below show what did load — nothing here is filled in from a cache
      </span>
    </div>
  ) : null;

  /* WITHHOLD, DO NOT HIDE (Lane 2's rule). `display: none` drops the layout
     box and takes the scroll offset with it, so nothing is saved by keeping
     the pane — and it leaves that pane's reads running behind something the
     viewer is actually looking at. On a desktop both are true and this is
     the arrangement that ships today, unchanged. */
  const showIndex = !oneSurface || active === null;
  const showBody = active !== null;

  const navRow = (s: (typeof SETTINGS_SECTIONS)[number]) => (
    <button
      key={s.id}
      type="button"
      className={s.danger ? 'set-nav__row set-nav__row--danger' : 'set-nav__row'}
      /* NOT CURRENT ON A PHONE. `aria-current` marks which of two panes the
         body belongs to; at the index no section is showing, so announcing
         one as the current page is simply false. */
      aria-current={!oneSurface && active === s.id ? 'true' : undefined}
      onClick={() => go(s.id)}
    >
      {oneSurface ? <span className="set-nav__row-grow">{s.label}</span> : s.label}
      {/* The mark is what promises a DRILLDOWN rather than a pane switch.
          Decorative: the label is right beside it. */}
      {oneSurface ? (
        <span className="set-nav__row-chevron" aria-hidden="true">
          <VectorIcon paths={CHEVRON_RIGHT} size={16} strokeWidth={1.6} />
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="set-root cv2-root">
      <div className="set-card">
        {oneSurface ? errorBlock : null}

        {showIndex ? (
          <nav className="set-nav" aria-label="Space settings sections">
            <span className="set-nav__eyebrow">Space · {spaceLabel}</span>
            {SETTINGS_SECTIONS.filter((s) => !s.danger).map(navRow)}
            <div className="set-nav__spacer" />
            {SETTINGS_SECTIONS.filter((s) => s.danger).map(navRow)}
          </nav>
        ) : null}

        {showBody && active !== null ? (
          <div className="set-body">
            {/* UP, owned by this screen. The phone shell's header chevron pops
                the SCREEN STACK, and a settings section is not on it: it has
                no entity id and it is not in the address on either shell.
                Putting a non-address behind the one control whose contract is
                that it agrees with the URL is how the two shells' back
                buttons start disagreeing. */}
            {oneSurface ? (
              <button type="button" className="set-up" onClick={() => setActive(null)}>
                <span className="set-up__chevron" aria-hidden="true">
                  <VectorIcon paths={CHEVRON_LEFT} size={16} strokeWidth={1.6} />
                </span>
                All settings
              </button>
            ) : null}
            {oneSurface ? null : errorBlock}
            <SectionBody
              id={active}
              data={data}
              sections={sections}
              onGo={go}
              port={port}
              onProfileSaved={refreshIdentity}
              onMembersChanged={refreshMembers}
              onInvitesChanged={refreshInvites}
              onAxesChanged={refreshAxes}
              onWorkflowsChanged={refreshWorkflows}
              nodeKey={nodeKey}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SectionBody({
  id,
  data,
  sections,
  onGo,
  port,
  onProfileSaved,
  onMembersChanged,
  onInvitesChanged,
  onAxesChanged,
  onWorkflowsChanged,
  nodeKey,
}: {
  id: SettingsSectionId;
  data: SettingsData;
  sections: SettingsShellProps['sections'];
  onGo: (id: SettingsSectionId) => void;
  port: SettingsShellProps['port'];
  onProfileSaved: () => void;
  onMembersChanged: () => void;
  onInvitesChanged: () => void;
  onAxesChanged: () => void;
  onWorkflowsChanged: () => void;
  nodeKey: string;
}) {
  const injected = sections?.[id];
  if (injected !== undefined) return <>{injected}</>;

  const def = SETTINGS_SECTIONS.find((s) => s.id === id)!;

  switch (id) {
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
    case 'menu':
      /* `measure={false}`: the editor draws a two-column author/preview pair
         and capping it at the reading measure would stack them into a single
         narrow column on a screen with room for both. */
      return (
        <SectionFrame title={def.heading} measure={false} bodyTestId="menu-body">
          {data.menu ? (
            <MenuEditor menu={data.menu} spaceName={data.space?.name} />
          ) : (
            <SectionAbsent
              head="The menu could not be read."
              why="seam.menu did not resolve — the rail is showing its own fallback, and this editor has nothing to edit"
            />
          )}
        </SectionFrame>
      );
    case 'profile':
      return <ProfileSection space={data.space} heading={def.heading} />;
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
    case 'danger':
      return <DangerSection heading={def.heading} />;
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
