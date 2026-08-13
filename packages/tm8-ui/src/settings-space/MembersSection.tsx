/**
 * T2-1b — MEMBERS & ROLES (oracle L45–L89).
 *
 * The oracle's own annotation (L136) is the spec: "Humans only, round avatars.
 * Role is an inline select; owner is locked (⚿, transfer via Danger zone);
 * self-remove is disabled-with-reason. Pending invitees sit in the same table
 * — dashed avatar, wait pill."
 *
 * WHAT CHANGED WITH 109. This file used to say "what is REAL here: the rows…
 * what is not: every write", and drew the role control as
 * disabled-with-reason because `PatchEntityInput` carries title and content
 * only and the seam had no membership verb. `spaces.members.updateRole` now
 * exists (migration 114, seam Amendment 11), so **the role select is a real
 * select** and this component performs a real write.
 *
 * THE CLIENT-SIDE RULES ARE UX, NOT AUTHORIZATION, and the distinction is
 * load-bearing. Every rule below is enforced in SQL by `set_member_role`, which
 * is SECURITY DEFINER and is the only thing actually protecting anything. What
 * this file does is tell a person *before* they click why an option is not
 * theirs, so the answer is a locked control with a reason rather than a round
 * trip that comes back 42501. If the two ever disagree, SQL wins and this
 * component is wrong — never the other way round.
 *
 * THE HANDLE IS STILL HOLLOW, DELIBERATELY. The oracle draws "Ada Osei @ada",
 * but `EntitySummary` carries no username — only `identity()` does, and only
 * for the viewer. So the viewer's own row shows a real handle and every other
 * row shows T1-4's hollow marker carrying the reason. Inventing `@` + a slugged
 * title would be a lie of precision on the one field a user would trust.
 *
 * REMOVAL IS STILL REFUSED, and for a better-understood reason than before —
 * see `MEMBER_REMOVE_UNAVAILABLE`.
 */
import { useState } from 'react';
import type { EntitySummary, SpaceMemberRole } from '@tm8/contract';
import type { IdentityView } from '../data/seam';
import { Avatar } from '../kit';
import { DisabledIconControl, HollowInline } from '../panels';
import { memberRoles, ownerRoleRef, roleOf } from './port';
import {
  MEMBER_REMOVE_SELF,
  MEMBER_REMOVE_UNAVAILABLE,
  OWNER_ROLE_LOCKED,
  ROLE_CHANGE_NOT_ADMIN,
  ROLE_CHANGE_NEEDS_OWNER,
} from './reasons';

export interface MembersSectionProps {
  members: EntitySummary[];
  identity: IdentityView | null;
  /** The oracle's ＋ Invite jumps to the invites section (L49). */
  onInvite?: () => void;
  /**
   * Perform the write. Absent means this surface is READ-ONLY and every role
   * control renders locked — which is what the dev review board passes, and
   * what any host that has no port should pass, rather than a no-op that looks
   * like it worked.
   */
  onRoleChange?: (memberId: string, role: SpaceMemberRole) => Promise<unknown>;
}

/** Oracle L88, verbatim — the ROLES legend prose. */
export const ROLES_LEGEND =
  'owner — everything + transfer/delete · admin — settings, members, trust · member — create/edit entities, run agents · viewer — read-only. Agents are teammates, not members; they hold no role and appear only in Teammates.';

/**
 * The legend names FOUR roles; `EntityState`'s member variant is a THREE-value
 * union (`owner | admin | member`). Stated in the UI rather than silently
 * reconciled: the legend is the oracle's words, and this line is the honest
 * footnote that the fourth role has no representation in this build.
 */
export const VIEWER_ROLE_FOOTNOTE =
  'viewer is described above but not representable in this build — the member state carries owner, admin, member.';

/**
 * The rule 109 R2/R3 enforce in SQL, restated for the person at the keyboard.
 * Rendered under the legend so the two locked cases have a written answer
 * somewhere on the screen and not only in a tooltip.
 */
export const ROLE_RULES_NOTE =
  'Only an owner can grant or revoke owner, and a space always keeps at least one — transfer is promote-then-step-down, two deliberate steps.';

/** Coarse and honest: the oracle prints "now / 2h / 4d", not a precise stamp. */
export function shortAge(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 2) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * The viewer's role IN THIS SPACE, taken from the members list rather than from
 * `identity.memberships`.
 *
 * Both carry it, and they can disagree by exactly one render: a viewer who has
 * just changed their own role gets a fresh members list and a stale identity
 * snapshot. The rows are what this table is already showing, so reading the
 * role from them keeps the locks consistent with what the reader can see.
 * Falls back to `memberships` when the viewer has no row here at all.
 */
function viewerRoleIn(members: EntitySummary[], identity: IdentityView | null): string | null {
  const selfIds = new Set((identity?.memberships ?? []).map((m) => m.memberId));
  const own = members.find((m) => selfIds.has(m.id));
  if (own) return roleOf(own);
  return (identity?.memberships ?? [])[0]?.role ?? null;
}

export function MembersSection({ members, identity, onInvite, onRoleChange }: MembersSectionProps) {
  const selfMemberIds = new Set((identity?.memberships ?? []).map((m) => m.memberId));
  const ownerWord = ownerRoleRef();
  const roles = memberRoles();
  const viewerRole = viewerRoleIn(members, identity);
  const viewerIsOwner = ownerWord !== null && viewerRole === ownerWord;
  const viewerIsAdmin = viewerIsOwner || viewerRole === 'admin';
  const ownerCount = ownerWord === null
    ? 0
    : members.filter((m) => roleOf(m) === ownerWord).length;

  /** Which row is mid-write, and what the last failure said. One at a time. */
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ memberId: string; message: string } | null>(null);

  async function change(memberId: string, role: string) {
    if (!onRoleChange) return;
    setPending(memberId);
    setFailure(null);
    try {
      await onRoleChange(memberId, role as SpaceMemberRole);
    } catch (error) {
      // The server's own words, not a rewrite. `set_member_role`'s refusals
      // are written to be read by a person ("a space must keep at least one
      // owner: promote a successor first"), and replacing them with "Failed"
      // would throw away the only part that tells them what to do next.
      setFailure({
        memberId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">Members &amp; roles</span>
        <div className="set-section__grow" />
        {onInvite ? (
          <button type="button" className="set-chip" onClick={onInvite}>
            ＋ Invite
          </button>
        ) : null}
      </div>

      <div className="set-section__scroll">
        {members.length === 0 ? (
          <div className="set-absent" data-testid="members-absent">
            <span className="set-absent__head">No member rows came back for this space.</span>
            <span className="set-absent__why">
              the members query ran and returned zero rows — this is a measured empty, not an unread
            </span>
          </div>
        ) : null}

        {members.map((m) => {
          const role = roleOf(m);
          const isSelf = selfMemberIds.has(m.id);
          const isOwner = ownerWord !== null && role === ownerWord;
          // The three locks, in the order SQL applies them. Each names WHY,
          // because "greyed out" with no reason is the thing this whole surface
          // was built to stop doing.
          const lock = !onRoleChange || !viewerIsAdmin
            ? ROLE_CHANGE_NOT_ADMIN
            : isOwner && !viewerIsOwner
              ? OWNER_ROLE_LOCKED
              : null;
          return (
            <div className="set-member" key={m.id} data-testid="member-row">
              <Avatar
                actorId={m.id}
                provenance="human"
                label={m.title}
                size={22}
                src={isSelf ? identity?.avatar ?? null : null}
              />
              <span className="set-member__name">
                {m.title}{' '}
                {isSelf && identity?.username ? (
                  <span className="set-member__handle">@{identity.username}</span>
                ) : (
                  <HollowInline caption="member entities carry no username in this build — only the viewer's own identity does">
                    <span className="set-member__handle">@—</span>
                  </HollowInline>
                )}
              </span>

              {role === null ? (
                <HollowInline caption="this row carries no role in its state">
                  <span className="set-role set-role--select">—</span>
                </HollowInline>
              ) : lock !== null ? (
                <DisabledIconControl label={`role: ${role}`} reason={lock}>
                  <span className={`set-role set-role--${isOwner ? 'locked' : 'select'}`}>
                    {role} {isOwner ? '⚿' : '▾'}
                  </span>
                </DisabledIconControl>
              ) : (
                <select
                  className="set-role set-role--select"
                  data-testid="member-role-select"
                  aria-label={`role for ${m.title}`}
                  value={role}
                  disabled={pending === m.id}
                  onChange={(event) => void change(m.id, event.target.value)}
                >
                  {roles.map((option) => {
                    // The last owner cannot be demoted (R3), and a non-owner
                    // cannot be handed the owner word (R2). Disabling the
                    // OPTION rather than hiding it keeps the vocabulary visible
                    // — a role you cannot see is a role you assume is missing.
                    const wouldOrphan =
                      isOwner && option !== ownerWord && ownerCount <= 1;
                    const needsOwner = option === ownerWord && !viewerIsOwner;
                    return (
                      <option key={option} value={option} disabled={wouldOrphan || needsOwner}>
                        {option}
                        {wouldOrphan ? ' — the only owner' : ''}
                        {needsOwner ? ' — owners only' : ''}
                      </option>
                    );
                  })}
                </select>
              )}

              <span className="set-member__when">{shortAge(m.activityAt)}</span>

              <DisabledIconControl
                label={isSelf ? 'remove yourself' : `remove ${m.title}`}
                reason={isSelf ? MEMBER_REMOVE_SELF : MEMBER_REMOVE_UNAVAILABLE}
                glyph="✕"
              />

              {failure?.memberId === m.id ? (
                <span className="set-absent__why" data-testid="member-role-error" role="alert">
                  {failure.message}
                </span>
              ) : null}
            </div>
          );
        })}

        <div className="set-stack">
          <span className="set-eyebrow">Roles</span>
          <span className="set-prose">{ROLES_LEGEND}</span>
          <span className="set-prose">{ROLE_RULES_NOTE}</span>
          <span className="set-absent__why">{VIEWER_ROLE_FOOTNOTE}</span>
          {!viewerIsAdmin ? (
            <span className="set-absent__why">{ROLE_CHANGE_NOT_ADMIN.remedy}</span>
          ) : null}
        </div>
      </div>
    </>
  );
}
