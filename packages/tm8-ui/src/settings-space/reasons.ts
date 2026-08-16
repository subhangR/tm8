/**
 * THE GAP LEDGER, IN CODE — every act this surface draws that the seam cannot
 * perform, in one file, auditable in one read.
 *
 * The precedent is `src/auth/reasons.ts`, and the reason for the shape is the
 * R5 finding it exists to prevent: five dead verbs turned out to be a CLASS,
 * not five instances, and nobody could see that while the refusals were spread
 * across five components. A list you can count is a list you can audit.
 *
 * EVERY entry below was checked against `src/data/seam.ts` and
 * `@tm8/contract` on 2026-07-29 — not remembered. Where the contract HAS the
 * DTO and the seam does not carry the verb, the entry says so, because those
 * two gaps have very different remedies (one is a seam amendment, the other is
 * a server capability that does not exist).
 *
 * `ALL_SETTINGS_REASONS` is asserted non-empty and fully-formed by
 * `settings.test.tsx`, and a sweep there asserts that no control on any frame
 * promises an act without one of these attached.
 */
import type { UnavailableReason } from '../panels';

/** Cause = what is true. Remedy = the named constraint or the next step. */
function reason(cause: string, remedy: string): UnavailableReason {
  return { cause, remedy };
}

// ---------------------------------------------------------------------------
// T2-3 — the menu editor
// ---------------------------------------------------------------------------

/**
 * The single biggest gap in this half. `data/seam.ts`'s own header records the
 * ruling verbatim: "spaces.menu.update stays OUT of this seam until their
 * phase; adding either is a deferred amendment requiring dual re-consensus".
 * The CONTRACT has `UpdateMenuInput` with `expectedRevision` — so the conflict
 * and version-lock states this editor draws are contract-real and merely
 * unreachable, which is exactly why they are built rather than skipped.
 */
export const MENU_SAVE_UNAVAILABLE = reason(
  'Saving a menu has no executor in this build',
  'seam.commands carries no spaces.menu.update — a deferred seam amendment (data/seam.ts, Amendment 1 note). Your edits live in this editor and the preview only.',
);

export const MENU_SAVE_VERSION_LOCKED = reason(
  'read-only — this menu was edited by a newer tm8',
  'update this node to edit',
);

export const MENU_RELOAD_UNAVAILABLE = reason(
  'Reloading a newer menu revision has no executor',
  'the conflict is detected from the loaded revision, but re-reading it needs seam.menu on a live space — wire a spaceId to enable this control.',
);

/** Stated by the control itself, with its live numbers substituted. */
export function menuChildCapReason(used: number, max: number): UnavailableReason {
  return reason(`this row has ${used} of ${max}`, 'the rail renders at most one level of children (T1-4 cap)');
}

export const MENU_NO_FREE_VIEW_REF = reason(
  'every view the rail knows is already on this menu',
  'view refs are a closed set in this build; remove one to free it',
);

export const MENU_NO_FREE_KIND_REF = reason(
  'every menu-eligible kind is already on this menu',
  'a kind is eligible when the registry gives it a collection route and a slug',
);

export const MENU_GROUP_CAP_REASON = (used: number, max: number): UnavailableReason =>
  reason(`this menu has ${used} of ${max} groups`, 'the rail renders at most 8 bands');

// ---------------------------------------------------------------------------
// T2-1 — members & roles
// ---------------------------------------------------------------------------

/**
 * ROLE CHANGE IS NO LONGER A GAP. It used to read "Changing a role has no
 * executor in this build" — true when written: `PatchEntityInput` is
 * `{expectedVersion, title?, content?}` and a member's role lives in
 * `EntityState`, not in `content`. Migration 114 added `set_member_role` and
 * the `spaces.members.updateRole` operation, and seam Amendment 11 carries it,
 * so `MembersSection` performs a real write.
 *
 * The two entries below are NOT the old gap under a new name. They are the
 * two cases where the person at the keyboard may not do the thing — the same
 * two SQL enforces — stated before the click rather than returned as a 42501.
 */
export const ROLE_CHANGE_NOT_ADMIN = reason(
  'you can’t change roles in this space',
  'changing a member’s role needs admin or owner here; ask someone who has it.',
);

export const ROLE_CHANGE_NEEDS_OWNER = reason(
  'only an owner can grant or revoke owner',
  'an admin who could mint an owner could mint themselves a superior — so ownership moves only by an owner’s hand.',
);

/**
 * STILL REFUSED, and 109's investigation upgraded the reason from a ruling to
 * a measured fact.
 *
 * The old text said `deleteEntity` exists and would accept a member id, and
 * that wiring it would invent a semantic on a destructive path. Both still
 * true, and now there is a harder reason underneath: `entities.created_by`
 * references `entities(id)` with NO on-delete clause
 * (`001_core_graph.sql:338`), so **Postgres already refuses** to delete the
 * member row of anyone who has authored a single entity — it refuses with a
 * bare 23503, which is not an answer a person can act on.
 *
 * The correct shape is a SOFT removal (`members.removed_at`) that keeps
 * attribution and revokes access. That is its own change: 57 `from
 * public.members` predicates across 23 migrations currently mean "is a member"
 * by the row's mere existence, and six of them are RLS policies. Doing half of
 * it leaves a removed member still reading the space, which is worse than not
 * having the button.
 */
export const MEMBER_REMOVE_UNAVAILABLE = reason(
  'Removing a member has no executor in this build',
  'a member row is the attribution target of everything they authored, so it cannot be deleted — removal needs a soft-removal column and an audit of every membership predicate in the schema (migration 118 header). Demote them to member in the meantime.',
);

/** The oracle's own locked control (T2-1 L54): "you can't remove yourself". */
export const MEMBER_REMOVE_SELF = reason(
  'you can’t remove yourself',
  'transfer ownership first, from Danger zone',
);

/**
 * Kept, with its meaning narrowed by 114: an owner's role IS editable — by an
 * owner. This is the lock a non-owner sees.
 */
export const OWNER_ROLE_LOCKED = reason(
  'the owner’s role is not yours to change',
  'only an owner can grant or revoke owner, and a space always keeps at least one',
);

// ---------------------------------------------------------------------------
// T2-1 — invites (the whole feature)
// ---------------------------------------------------------------------------

/**
 * THE INVITE FAMILY IS NO LONGER A GAP, and the old entries said the opposite
 * as loudly as this file knows how: "Zero seam surface AND zero contract DTO.
 * Searched both on 2026-07-29: no invite type, no invite command, no invite
 * read." That was true of the SEAM and false of the SERVER — `create_invite`,
 * `w2_revoke_invite` and `redeem_invite` had been in `007_rpc_catalog.sql`
 * since W1, with `spaces.invites.*` operations in the catalog. The capability
 * existed; the seam had not carried it, and this file could not tell the
 * difference from where it was standing.
 *
 * That is the reusable lesson and it is why this comment replaces the entries
 * rather than deleting them: **"the seam cannot" and "the node cannot" are
 * different facts, and only one of them is a missing capability.** The reason
 * text said the second when it could only observe the first.
 *
 * `InvitesSection` now reads, creates, copies and revokes for real (seam
 * Amendment 11, migration 118 for the role column). One refusal survives, and
 * it is genuinely a refusal rather than a gap: see below.
 */

/**
 * The only invite act this surface still cannot perform, and it is a REFUSAL
 * rather than a gap — the operation exists and is deliberately not reachable
 * from here.
 *
 * `auth.invite.resolve` and `spaces.invites.redeem` both exist, so an invite
 * CAN be redeemed. But redemption joins the CURRENT viewer, and the current
 * viewer is already a member of the space they are looking at the settings of.
 * A redeem control on this screen could only ever act on the person who least
 * needs it. Redemption belongs on the join landing, where the person holding
 * the code is not yet anybody here.
 */
/**
 * The two invite acts a non-admin cannot perform. Same shape and same reason
 * as the role locks: `create_invite` and `w2_revoke_invite` both call
 * `internal.require_space_admin`, so this states before the click what SQL
 * would answer after it.
 */
export const INVITE_CREATE_NOT_ADMIN = reason(
  'you can’t create invitations for this space',
  'minting a join code needs admin or owner here; ask someone who has it.',
);

export const INVITE_REVOKE_NOT_ADMIN = reason(
  'you can’t revoke this invitation',
  'revoking a join code needs admin or owner in this space.',
);

export const INVITE_REDEEM_LANDING_UNWIRED = reason(
  'Joining from this card has no executor yet',
  'the verbs exist — `auth.invite.resolve` reads a code before you join and `spaces.invites.redeem` performs the join — but no /join route mounts this card against them yet. Redeem from the CLI in the meantime: `tm8 space invite redeem <code>`.',
);

export const INVITE_REDEEM_NOT_HERE = reason(
  'this is not where a code is redeemed',
  'redemption joins whoever is signed in, and you are already a member of this space — a join link opens its own landing.',
);

// ---------------------------------------------------------------------------
// T2-1 — space profile, axes, danger zone
// ---------------------------------------------------------------------------

export const SPACE_EDIT_UNAVAILABLE = reason(
  'Editing space details has no executor in this build',
  'seam.commands has no space-mutation verb; spaces() is a read.',
);

/* AXES_UNREADABLE stood here until 2026-08-16 and was measured FALSE on both
   halves: `TaskAxis` is in the contract (contract.ts) and `seam.spaceSettings()`
   already carried `taskAxes` on the round trip `port.ts` makes for invites.
   Deleted with the gap it named (W2 wired the real read + CRUD) — the SECOND
   stale refusal found in this file; re-verify the mechanism a reason cites
   before trusting it. */

export const DANGER_ZONE_UNAVAILABLE = reason(
  'Transfer and delete have no executor in this build',
  'the seam carries no space-lifecycle verb; these are the two acts that must never be faked.',
);

/**
 * Half B's sections mount into this shell. Until one does, its nav row leads
 * somewhere honest instead of nowhere — a nav row that renders blank is the
 * silent void this whole pass exists to remove.
 */
export const SECTION_NOT_MOUNTED = reason(
  'This section has no body mounted here',
  'it is built in another module and wired by the host — pass it through the `sections` prop.',
);

/** Every reason above, in one array. Counted and shape-checked by the tests. */
export const ALL_SETTINGS_REASONS: readonly UnavailableReason[] = [
  MENU_SAVE_UNAVAILABLE,
  MENU_SAVE_VERSION_LOCKED,
  MENU_RELOAD_UNAVAILABLE,
  MENU_NO_FREE_VIEW_REF,
  MENU_NO_FREE_KIND_REF,
  ROLE_CHANGE_NOT_ADMIN,
  ROLE_CHANGE_NEEDS_OWNER,
  MEMBER_REMOVE_UNAVAILABLE,
  MEMBER_REMOVE_SELF,
  OWNER_ROLE_LOCKED,
  INVITE_CREATE_NOT_ADMIN,
  INVITE_REVOKE_NOT_ADMIN,
  INVITE_REDEEM_NOT_HERE,
  INVITE_REDEEM_LANDING_UNWIRED,
  SPACE_EDIT_UNAVAILABLE,
  DANGER_ZONE_UNAVAILABLE,
  SECTION_NOT_MOUNTED,
];
