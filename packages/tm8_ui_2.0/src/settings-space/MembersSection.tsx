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
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT PASS (2026-08-16, off "settings page is fully fucked, not properly
 * laid out"). The frame fix landed first and capped the card; what was left was
 * this section's insides, and all of it was MEASURED in real Chrome before it
 * was changed (SECTION-CONTRACT.md §8; numbers in `members-section.css`):
 *
 *   · The section body scrolled SIDEWAYS — scrollWidth 1160 against
 *     clientWidth 919 — because both refusal tooltips sit at the row's right
 *     edge and `.hon-tip` opens rightwards up to 260px. So the reason on the
 *     remove ✕ was 241px off the edge and could not be read at all. Fixed by
 *     opening those tips leftwards, not by clipping them.
 *   · Three controls clustered at the right with one flat 9px gap and no
 *     column words, so the age read as a bare `3w`. They are a grid now, with
 *     a header strip that names the columns.
 *   · The locked owner pill measured 18px tall and the live select 20px, so
 *     the rows sat on no common baseline. One control height now.
 *   · The ROLES legend inherited the table's full bleed and ran 866px, over
 *     the 860px measure. The rows stay full-bleed — they are a table and their
 *     hairline should reach the card edge — and the prose below them is
 *     measured on its own. Two treatments in one body, which is the honest
 *     answer when a body genuinely holds two kinds of thing.
 */
import { useState } from 'react';
import type { EntitySummary, SpaceMemberRole } from '@tm8/contract';
import type { IdentityView } from '../data/seam';
import { Avatar, absTime, parseInstant, relTime } from '../kit';
import { DisabledIconControl, HollowInline } from '../panels';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { memberRoles, ownerRoleRef, roleOf } from './port';
import {
  MEMBER_REMOVE_SELF,
  MEMBER_REMOVE_UNAVAILABLE,
  OWNER_ROLE_LOCKED,
  ROLE_CHANGE_NOT_ADMIN,
  ROLE_CHANGE_NEEDS_OWNER,
} from './reasons';
import './members-section.css';

export interface MembersSectionProps {
  members: EntitySummary[];
  identity: IdentityView | null;
  /**
   * The section heading. Defaults to the word in `SETTINGS_SECTIONS`, so a
   * host that has the definition to hand can pass `def.heading` and a host
   * that does not still gets the same title rather than a blank head.
   */
  heading?: string;
  /** The Invite action jumps to the invites section. */
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
 * L88's closing sentence. It is about teammates, not about the `viewer` role —
 * which is why it is lifted out of the last definition instead of being read
 * as part of it.
 */
export const AGENTS_ARE_NOT_MEMBERS =
  'Agents are teammates, not members; they hold no role and appear only in Teammates.';

/**
 * The ROLES legend as ROWS, PARSED OUT OF `ROLES_LEGEND` rather than typed
 * beside it.
 *
 * TWO reasons, and the second is the one that decided the shape.
 *
 * The layout reason: one string rendered as one paragraph was a single 2800px
 * line on the reporter's display; the card cap took it to 866px, which is
 * still over the 860px measure and still four definitions the eye has to
 * re-parse out of a run of `·` separators. It was always a definition list.
 *
 * The reason it is DERIVED and not a literal array: the least-privileged role
 * word and the member KIND are the same string, so an array containing it is
 * indistinguishable from a §15.2 kind-literal to `no-kind-literals.test.ts` —
 * which is exactly what that guard said when this was first written as a
 * literal array, and exactly the ambiguity `port.ts`'s header warns about.
 * Parsing keeps the oracle's sentence as the single source and writes no role
 * word at all. A test pins the parse against the sentence.
 */
export function roleLegendRows(): Array<{ role: string; what: string }> {
  const defs = ROLES_LEGEND.slice(0, ROLES_LEGEND.length - AGENTS_ARE_NOT_MEMBERS.length)
    .trimEnd()
    .replace(/\.$/, '');
  return defs.split(' · ').map((segment) => {
    const at = segment.indexOf(' — ');
    return at < 0
      ? { role: segment, what: '' }
      : { role: segment.slice(0, at), what: segment.slice(at + 3) };
  });
}

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

/**
 * The one-member case, which is what a freshly created space renders.
 *
 * It is not an EMPTY state — there is a row, and it is correct — but every
 * control on it is locked, and without a sentence saying why that reads as a
 * broken table rather than as a space waiting for its second person.
 */
export const SOLO_SPACE_NOTE =
  'One member, so nothing in this table can move yet: a space always keeps at least one owner, and you can’t remove yourself. Invite someone and both controls come alive.';

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
 * The same age spelled out, for the cell's accessible name and its title.
 *
 * `3w` is four pixels of mono with a column header three rows above it. The
 * header answers "three weeks of WHAT"; this answers it again for a pointer
 * and for a screen reader, and carries the exact instant behind it so the
 * coarse word is never the only thing on offer.
 *
 * IT GOES THROUGH `kit/time.ts`, and that is enforced rather than chosen:
 * `kit/timestamp.test.tsx` walks every shipped source file and fails on a
 * hand-rolled relative label, because exactly one module in this UI is allowed
 * to format an instant. It caught the first draft of this function, which
 * spelled its own `… ago (<iso>)` — a raw ISO string is also the wrong thing
 * to show a person. `relTime` gives the reader's own words and falls back to a
 * date past the seven-day window; `absTime` is the full local instant every
 * relative label in this UI reveals on hover.
 *
 * `shortAge` above is NOT that violation and is deliberately left alone: it is
 * the oracle's own coarse ladder (L88 prints "now / 2h / 4d"), it never writes
 * a direction word, and it is what the column is drawn to.
 */
export function longAge(iso: string, now = Date.now()): string {
  const at = parseInstant(iso);
  if (at === null) return 'last active: not recorded';
  return `last active ${relTime(at, now)} — ${absTime(at)}`;
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

export function MembersSection({
  members,
  identity,
  heading = 'Members & roles',
  onInvite,
  onRoleChange,
}: MembersSectionProps) {
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
    <SectionFrame
      title={heading}
      /* `measure={false} pad={false}`: the rows below are a TABLE and are meant
         to span the card, carrying their own gutter so the hairline reaches the
         edge and reads as a rule rather than as an underline. The prose after
         them is measured by `.set-members__measure` instead — see the header. */
      measure={false}
      pad={false}
      bodyTestId="members-body"
      action={
        onInvite ? (
          <button type="button" className="set-chip" onClick={onInvite}>
            Invite
          </button>
        ) : undefined
      }
    >
      <div className="set-members">
        {members.length === 0 ? (
          <div className="set-members__measure">
            <SectionAbsent
              testId="members-absent"
              head="No member rows came back for this space."
              why="the members query ran and returned zero rows — this is a measured empty, not an unread"
            />
          </div>
        ) : (
          <div className="set-members__table">
            {/* aria-hidden: every cell below names itself. See the CSS note. */}
            <div className="set-members__head" aria-hidden data-testid="members-colhead">
              <span />
              <span className="set-members__col">Member</span>
              <span className="set-members__col">Role</span>
              <span className="set-members__col set-members__col--when">Active</span>
              <span />
            </div>

            {members.map((m) => {
              const role = roleOf(m);
              const isSelf = selfMemberIds.has(m.id);
              const isOwner = ownerWord !== null && role === ownerWord;
              // The three locks, in the order SQL applies them. Each names WHY,
              // because "greyed out" with no reason is the thing this whole
              // surface was built to stop doing.
              const lock = !onRoleChange || !viewerIsAdmin
                ? ROLE_CHANGE_NOT_ADMIN
                : isOwner && !viewerIsOwner
                  ? OWNER_ROLE_LOCKED
                  : null;
              return (
                <div className="set-members__row" key={m.id} data-testid="member-row">
                  <Avatar
                    actorId={m.id}
                    provenance="human"
                    label={m.title}
                    size={22}
                    src={isSelf ? identity?.avatar ?? null : null}
                  />
                  <span className="set-members__who">
                    <span className="set-members__name">{m.title}</span>
                    {isSelf && identity?.username ? (
                      <span className="set-members__handle">@{identity.username}</span>
                    ) : (
                      /* THE HOLLOW MARKER IS STATED ONCE, NOT NINE TIMES.
                         `EntitySummary` carries no username — only `identity()`
                         does, and only for the viewer — so inventing `@`+slug
                         would be a lie of precision on the field a reader most
                         trusts. That reasoning stands and the marker stays; it
                         moves off the ROW. Nine identical `@—` down one column
                         taught nothing after the first and read as nine broken
                         records. The reason now rides the name, where a reader
                         who wonders can find it, and the caption below the
                         table says it once in words. */
                      <HollowInline caption="member entities carry no username in this build — only the viewer's own identity does">
                        <span className="set-members__handle set-members__handle--none" aria-hidden />
                      </HollowInline>
                    )}
                  </span>

                  {/* THE ROLE IS PUBLISHED AS DATA so the stylesheet can colour
                      it. Owner, 2026-08-31: "each status items roles" should be
                      colourful. A role is a STANDING FACT about a person's
                      authority — the same class of fact as a kind, and it was
                      three identical grey pills, so the one column a reader
                      scans this page for carried no signal at all.
                      Lowercased because the vocabulary is the server's and its
                      casing is not ours to assume. */}
                  <span
                    className="set-members__cell set-members__cell--role"
                    data-role={String(role).toLowerCase()}
                  >
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
                          // The last owner cannot be demoted (R3), and a
                          // non-owner cannot be handed the owner word (R2).
                          // Disabling the OPTION rather than hiding it keeps
                          // the vocabulary visible — a role you cannot see is a
                          // role you assume is missing.
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
                  </span>

                  <span className="set-members__cell set-members__cell--when">
                    <span
                      className="set-members__when"
                      title={longAge(m.activityAt)}
                      aria-label={longAge(m.activityAt)}
                      data-testid="member-when"
                    >
                      {shortAge(m.activityAt)}
                    </span>
                  </span>

                  <span className="set-members__cell set-members__cell--x">
                    <DisabledIconControl
                      label={isSelf ? 'remove yourself' : `remove ${m.title}`}
                      reason={isSelf ? MEMBER_REMOVE_SELF : MEMBER_REMOVE_UNAVAILABLE}
                      glyph="✕"
                    />
                  </span>

                  {failure?.memberId === m.id ? (
                    <span
                      className="set-members__error"
                      data-testid="member-role-error"
                      role="alert"
                    >
                      {failure.message}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* THE MEASURED HALF. Everything below is prose, and prose is read. */}
        <div className="set-members__measure" data-testid="members-legend">
          {members.length === 1 ? (
            <p className="set-members__note" data-testid="members-solo">
              {SOLO_SPACE_NOTE}
            </p>
          ) : null}

          <details className="set-members__details">
            <summary className="set-members__details-summary">Role guide and ownership rules</summary>
            <div className="set-members__details-body">
              <span className="set-eyebrow">Roles</span>
              {roleLegendRows().map((row) => {
                // Which of the oracle's four words this build can actually store,
                // read off the registry vocabulary rather than typed — the same
                // derivation the selects use, so the legend cannot claim a role
                // the control does not offer.
                const representable = roles.includes(row.role);
                return (
                  <span className="set-members__legend-row" key={row.role}>
                    <span
                      className={`set-members__legend-role${representable ? '' : ' set-members__legend-role--absent'}`}
                    >
                      {row.role}
                    </span>
                    <span className="set-members__legend-what">{row.what}</span>
                  </span>
                );
              })}
              <span className="set-prose">{AGENTS_ARE_NOT_MEMBERS}</span>
              <span className="set-prose">{ROLE_RULES_NOTE}</span>
              <span className="set-absent__why">{VIEWER_ROLE_FOOTNOTE}</span>
              {viewerIsAdmin && !viewerIsOwner ? (
                <span className="set-absent__why">{ROLE_CHANGE_NEEDS_OWNER.remedy}</span>
              ) : null}
              {!viewerIsAdmin ? (
                <span className="set-absent__why">{ROLE_CHANGE_NOT_ADMIN.remedy}</span>
              ) : null}
            </div>
          </details>
        </div>
      </div>
    </SectionFrame>
  );
}
