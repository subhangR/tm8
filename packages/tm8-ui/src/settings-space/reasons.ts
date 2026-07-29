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
 * `PatchEntityInput` is `{expectedVersion, title?, content?}` and a member's
 * role lives in `EntityState`, not in `content`. There is no shape to send.
 */
export const ROLE_CHANGE_UNAVAILABLE = reason(
  'Changing a role has no executor in this build',
  'PatchEntityInput carries title and content only; role lives in the member entity’s state, which no seam command writes.',
);

/**
 * A RULING MADE ALONE, flagged for ratification or reversal (see HANDOVER §2).
 * `seam.commands.deleteEntity` exists and would accept a member id. It is NOT
 * wired, because "delete the member entity" and "remove a member from the
 * space" are not the same act, and wiring the first to a control labelled the
 * second would invent a semantic on a destructive path.
 */
export const MEMBER_REMOVE_UNAVAILABLE = reason(
  'Removing a member has no executor in this build',
  'deleteEntity exists but deleting the member ENTITY is not the same act as revoking space membership — the seam has no membership verb, so this control stays honest rather than guessing.',
);

/** The oracle's own locked control (T2-1 L54): "you can't remove yourself". */
export const MEMBER_REMOVE_SELF = reason(
  'you can’t remove yourself',
  'transfer ownership first, from Danger zone',
);

export const OWNER_ROLE_LOCKED = reason(
  'the owner’s role is not editable here',
  'ownership moves by transfer, not by reassignment',
);

// ---------------------------------------------------------------------------
// T2-1 — invites (the whole feature)
// ---------------------------------------------------------------------------

/**
 * Zero seam surface AND zero contract DTO. Searched both on 2026-07-29: no
 * invite type, no invite command, no invite read. So the invite LIST renders
 * an honest absence rather than specimen rows dressed as data — a list of
 * plausible-looking invite codes would be the worst thing on this screen.
 */
export const INVITES_UNREADABLE = reason(
  'No invite list exists to read',
  'the seam has no invites read and @tm8/contract defines no invite DTO — this is a missing capability, not a missing wire.',
);

export const INVITE_CREATE_UNAVAILABLE = reason(
  'Creating an invite link has no executor in this build',
  'no invite command exists in seam.commands and no invite DTO exists in the contract.',
);

export const INVITE_COPY_UNAVAILABLE = reason(
  'There is no link to copy',
  'invite links are not readable in this build',
);

export const INVITE_REVOKE_UNAVAILABLE = reason(
  'Revoking an invite has no executor in this build',
  'no invite command exists in seam.commands',
);

export const INVITE_REDEEM_UNAVAILABLE = reason(
  'Joining through an invite has no executor in this build',
  'redemption is an unauthenticated act against a node; nothing in this seam performs it.',
);

// ---------------------------------------------------------------------------
// T2-1 — space profile, axes, danger zone
// ---------------------------------------------------------------------------

export const SPACE_EDIT_UNAVAILABLE = reason(
  'Editing space details has no executor in this build',
  'seam.commands has no space-mutation verb; spaces() is a read.',
);

export const AXES_UNREADABLE = reason(
  'No task-axis configuration exists to read',
  'CollectionQuery consumes axes as a filter, but nothing in the seam or the contract DEFINES the axis set for a space.',
);

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
  ROLE_CHANGE_UNAVAILABLE,
  MEMBER_REMOVE_UNAVAILABLE,
  MEMBER_REMOVE_SELF,
  OWNER_ROLE_LOCKED,
  INVITES_UNREADABLE,
  INVITE_CREATE_UNAVAILABLE,
  INVITE_COPY_UNAVAILABLE,
  INVITE_REVOKE_UNAVAILABLE,
  INVITE_REDEEM_UNAVAILABLE,
  SPACE_EDIT_UNAVAILABLE,
  AXES_UNREADABLE,
  DANGER_ZONE_UNAVAILABLE,
  SECTION_NOT_MOUNTED,
];
