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
import type { SpaceSummary } from '@tm8/contract';
import { DisabledAction } from '../panels';
import { MembersSection } from './MembersSection';
import { ModelsSection } from './ModelsSection';
import { InvitesPanel } from './InviteFrames';
import { IdentityProfileSection } from './IdentityProfileSection';
import { MenuEditor } from './MenuEditor';
import { AxesSection } from './AxesSection';
import { WorkflowsSection } from './WorkflowsSection';
import {
  DANGER_ZONE_UNAVAILABLE,
  SECTION_NOT_MOUNTED,
  SPACE_EDIT_UNAVAILABLE,
} from './reasons';
import { SETTINGS_SECTIONS, type SettingsData, type SettingsSectionId, type SettingsShellProps } from './types';

export function SettingsShell({
  port,
  sections,
  initialSection = 'members',
  onSectionChange,
  nodeKey = 'local',
  onAxesChanged,
}: SettingsShellProps) {
  const [active, setActive] = useState<SettingsSectionId>(initialSection);
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

  return (
    <div className="set-root cv2-root">
      <div className="set-card">
        <nav className="set-nav" aria-label="Space settings sections">
          <span className="set-nav__eyebrow">Space · {spaceLabel}</span>
          {SETTINGS_SECTIONS.filter((s) => !s.danger).map((s) => (
            <button
              key={s.id}
              type="button"
              className="set-nav__row"
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => go(s.id)}
            >
              {s.label}
            </button>
          ))}
          <div className="set-nav__spacer" />
          {SETTINGS_SECTIONS.filter((s) => s.danger).map((s) => (
            <button
              key={s.id}
              type="button"
              className="set-nav__row set-nav__row--danger"
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => go(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="set-body">
          {loadError ? (
            <div className="set-absent" data-testid="settings-load-error">
              <span className="set-absent__head">{loadError}</span>
              <span className="set-absent__why">
                the sections below show what did load — nothing here is filled in from a cache
              </span>
            </div>
          ) : null}
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
      return (
        <>
          <Head title={def.heading} />
          <div className="set-section__scroll" style={{ padding: 16 }}>
            {data.menu ? (
              <MenuEditor menu={data.menu} spaceName={data.space?.name} />
            ) : (
              <Absent head="The menu could not be read." why="seam.menu did not resolve — the rail is showing its own fallback, and this editor has nothing to edit" />
            )}
          </div>
        </>
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
        <>
          <Head title={def.heading} />
          <Absent
            head="This section is built in another module and is not mounted here."
            why={`${SECTION_NOT_MOUNTED.cause} — ${SECTION_NOT_MOUNTED.remedy}`}
          />
        </>
      );
  }
}

function Head({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="set-section__head">
      <span className="set-section__title">{title}</span>
      <div className="set-section__grow" />
      {action}
    </div>
  );
}

function Absent({ head, why }: { head: string; why: string }) {
  return (
    <div className="set-absent" data-testid="section-absent">
      <span className="set-absent__head">{head}</span>
      <span className="set-absent__why">{why}</span>
    </div>
  );
}

/**
 * Profile: everything `SpaceSummary` actually carries, and NOTHING ELSE. The
 * oracle never draws this section's body, so there is no canvas to transcribe
 * — inventing an avatar picker and a timezone field would be designing, which
 * is not this pass's job. Four real facts beat four plausible ones.
 */
function ProfileSection({ space, heading }: { space: SpaceSummary | null; heading: string }) {
  return (
    <>
      <Head title={heading} />
      <div className="set-section__scroll">
        {space === null ? (
          <Absent head="This space did not resolve." why="spaces() returned no row with this id" />
        ) : (
          <div className="set-stack">
            <div className="set-kv">
              <span className="set-kv__k">Name</span>
              <span className="set-kv__v">{space.name}</span>
            </div>
            <div className="set-kv">
              <span className="set-kv__k">About</span>
              <span className="set-kv__v">{space.description || '—'}</span>
            </div>
            <div className="set-kv">
              <span className="set-kv__k">Members</span>
              <span className="set-kv__v">{space.memberCount}</span>
            </div>
            <div className="set-kv">
              <span className="set-kv__k">Repo</span>
              <span className="set-kv__v">{space.githubRepo || '—'}</span>
            </div>
            <div className="set-kv">
              <span className="set-kv__k">Created</span>
              <span className="set-kv__v">{space.createdAt}</span>
            </div>
            <div style={{ paddingTop: 8 }}>
              <DisabledAction reason={SPACE_EDIT_UNAVAILABLE} label="edit space details">
                Edit space details
              </DisabledAction>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Danger zone. The oracle names it in the nav (L43) and draws no body — and
 * this is the one section where that must not become an empty pane, because
 * the acts behind it (transfer ownership, delete the space) are irreversible.
 * Both render refused, and the reason says the seam carries no verb rather
 * than implying they are merely gated by permission.
 */
function DangerSection({ heading }: { heading: string }) {
  return (
    <>
      <Head title={heading} />
      <div className="set-stack">
        <span className="set-prose">
          These two acts are irreversible and neither has an executor in this build. They are shown so
          you know where they live — not so you can be told “nothing happened” after clicking.
        </span>
        <DisabledAction reason={DANGER_ZONE_UNAVAILABLE} label="transfer ownership">
          Transfer ownership
        </DisabledAction>
        <DisabledAction reason={DANGER_ZONE_UNAVAILABLE} label="delete this space">
          Delete this space
        </DisabledAction>
      </div>
    </>
  );
}
