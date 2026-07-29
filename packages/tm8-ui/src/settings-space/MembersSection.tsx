/**
 * T2-1b — MEMBERS & ROLES (oracle L45–L89).
 *
 * The oracle's own annotation (L136) is the spec: "Humans only, round avatars.
 * Role is an inline select; owner is locked (⚿, transfer via Danger zone);
 * self-remove is disabled-with-reason. Pending invitees sit in the same table
 * — dashed avatar, wait pill."
 *
 * What is REAL here: the rows. Members are entities, `seam.query` returns
 * them, and the role rides on `EntityState`. What is not: every write. The
 * role control and the ✕ render disabled-with-reason with the mechanism named
 * (`reasons.ts`), because `PatchEntityInput` is `{expectedVersion, title?,
 * content?}` and role is not in `content`, and because the seam has no
 * membership verb at all.
 *
 * THE HANDLE IS HOLLOW, DELIBERATELY. The oracle draws "Ada Osei @ada", but
 * `EntitySummary` carries no username — only `identity()` does, and only for
 * the viewer. So the viewer's own row shows a real handle and every other row
 * shows T1-4's hollow marker carrying the reason. Inventing `@` + a slugged
 * title would be a lie of precision on the one field a user would trust.
 */
import type { EntitySummary } from '@tm8/contract';
import type { IdentityView } from '../data/seam';
import { DisabledAction, DisabledIconControl, HollowInline } from '../panels';
import { ownerRoleRef, roleOf } from './port';
import {
  MEMBER_REMOVE_SELF,
  MEMBER_REMOVE_UNAVAILABLE,
  OWNER_ROLE_LOCKED,
  ROLE_CHANGE_UNAVAILABLE,
} from './reasons';

export interface MembersSectionProps {
  members: EntitySummary[];
  identity: IdentityView | null;
  /** The oracle's ＋ Invite jumps to the invites section (L49). */
  onInvite?: () => void;
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

function initial(title: string): string {
  return (title.trim()[0] ?? '·').toUpperCase();
}

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

export function MembersSection({ members, identity, onInvite }: MembersSectionProps) {
  const selfMemberIds = new Set((identity?.memberships ?? []).map((m) => m.memberId));
  const ownerWord = ownerRoleRef();

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
          return (
            <div className="set-member" key={m.id} data-testid="member-row">
              <span className="set-member__avatar" aria-hidden>
                {initial(m.title)}
              </span>
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
              ) : isOwner ? (
                <DisabledIconControl label={`role: ${role} (locked)`} reason={OWNER_ROLE_LOCKED}>
                  <span className="set-role set-role--locked">{role} ⚿</span>
                </DisabledIconControl>
              ) : (
                <DisabledIconControl label={`change role from ${role}`} reason={ROLE_CHANGE_UNAVAILABLE}>
                  <span className="set-role set-role--select">{role} ▾</span>
                </DisabledIconControl>
              )}

              <span className="set-member__when">{shortAge(m.activityAt)}</span>

              <DisabledIconControl
                label={isSelf ? 'remove yourself' : `remove ${m.title}`}
                reason={isSelf ? MEMBER_REMOVE_SELF : MEMBER_REMOVE_UNAVAILABLE}
                glyph="✕"
              />
            </div>
          );
        })}

        <div className="set-stack">
          <span className="set-eyebrow">Roles</span>
          <span className="set-prose">{ROLES_LEGEND}</span>
          <span className="set-absent__why">{VIEWER_ROLE_FOOTNOTE}</span>
        </div>
      </div>
    </>
  );
}
