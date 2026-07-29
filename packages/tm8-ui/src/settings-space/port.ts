/**
 * THE SETTINGS PORT — the only place this module knows a seam exists.
 *
 * WHY A PORT AND NOT A DIRECT SEAM CALL. `views/useGateData.ts` opens with
 * "This is the ONLY place the shell touches the seam", and that rule is load-
 * bearing: everything below it receives plain values and cannot tell a fixture
 * from a real node. The settings surface obeys the same rule — the components
 * take data and callbacks, and this file is the one adapter. The coordinator
 * wires `settingsPortFromSeam(seam, spaceId)` in the host; nothing in
 * `settings-space/` imports a seam implementation.
 *
 * WHY IT IS TESTED AGAINST A REAL FIXTURE SEAM (`port-seam.test.tsx`). The
 * brief's four-links lesson: declaration → data → implementation → CALL can
 * each be green while the feature is dead, because nobody asserted the caller
 * passes the argument. So the adapter is driven against an actual
 * `createFixtureSeam()` and the assertions are on what comes BACK, not on what
 * was called.
 *
 * READS ONLY, and that is the finding, not an omission. Every read here works.
 * Every WRITE this surface draws — role change, member removal, invite
 * create/revoke/redeem, space rename, menu save — has no executor anywhere in
 * `seam.commands`; they live in `reasons.ts` as disabled-with-reason, and the
 * port deliberately exposes no method for them so a future component cannot
 * quietly acquire one.
 */
import type { EntitySummary, MenuConfig, SpaceId, SpaceSummary } from '@tm8/contract';
import type { IdentityView, Seam } from '../data/seam';
import { allKinds } from '../domain';
import { resolveMenu, type ResolvedMenu } from '../shell/menu-resolve';

/**
 * The member kind, reached through REGISTRY DATA rather than typed.
 *
 * §15.2 makes a kind string literal outside `domain/` and `fixtures/` a build
 * failure, and this lane carries its own copy of that guard
 * (`no-kind-literals.test.ts`), so `kinds: ['member']` is not available to me
 * even though it is what this query means. The registry gives a better answer
 * anyway: exactly one row tints its chip by member role, and "the kind whose
 * rows carry a role" is precisely the kind a members table renders. If a
 * second such row ever appears, this throws rather than silently picking one —
 * a wrong-but-plausible members list is worse than a loud failure.
 */
export function memberKindRef(): string {
  const rows = allKinds().filter((row) => row.chip.tintBy === 'memberRole');
  if (rows.length !== 1) {
    throw new Error(
      `settings-space: expected exactly one registry row tinted by member role, found ${rows.length}`,
    );
  }
  return rows[0].kind;
}

/**
 * The role word that means "owner", taken from REGISTRY DATA.
 *
 * The member row tints its role chip `{owner: 'brand', admin: 'info', member:
 * 'idle'}` — brass is the registry's own mark for the privileged role, and it
 * is exactly the pill the oracle paints brass at T2-1 L55. So the owner lock
 * is driven by the same table that colours the chip, instead of by a typed
 * `'owner'` this lane is not allowed to write anyway.
 *
 * Returns `null` if no role tints brass — in which case NO row is locked and
 * every role renders as the (disabled) select. A missing lock is recoverable;
 * a lock on the wrong row is not.
 */
export function ownerRoleRef(): string | null {
  const row = allKinds().find((r) => r.chip.tintBy === 'memberRole');
  const tones = row?.chip.tones ?? {};
  return Object.keys(tones).find((role) => tones[role] === 'brand') ?? null;
}

/**
 * The role vocabulary, most-privileged first, from the same registry tones.
 *
 * There is a SECOND reason this is derived rather than typed, and this lane's
 * guard found it: the least-privileged role and the member KIND are the same
 * string, so a hard-coded `'member'` role is indistinguishable from a §15.2
 * kind-literal violation to any scanner — and to any reader. Deriving both
 * from one table removes the ambiguity instead of exempting it.
 *
 * Note this is the CONTRACT's vocabulary (owner/admin/member), which is three
 * words; the oracle's ROLES legend names four (it adds `viewer`). That gap is
 * surfaced in the UI rather than reconciled — see `MembersSection`.
 */
export function memberRoles(): string[] {
  const row = allKinds().find((r) => r.chip.tintBy === 'memberRole');
  return Object.keys(row?.chip.tones ?? {});
}

/** The least-privileged representable role — the sane default for an invite. */
export function defaultInviteRole(): string {
  // Index arithmetic, not `.at(-1)`: this package's tsc lib target predates it
  // (TS2550), and the build is the control that said so.
  const roles = memberRoles();
  return roles.length > 0 ? roles[roles.length - 1] : 'unknown';
}

/** The narrow surface the settings components consume. Reads only — see above. */
export interface SettingsPort {
  /** The space this settings view is about; `null` when the id is not in `spaces()`. */
  loadSpace(): Promise<SpaceSummary | null>;
  /** Human members as entities. The role is on `state`, not on a separate DTO. */
  loadMembers(): Promise<EntitySummary[]>;
  /** The viewer — used for the "you" row and the owner lock. */
  loadIdentity(): Promise<IdentityView>;
  /**
   * The menu AND why it is the menu it is. The C-4 soft fallback is applied
   * here through the rail's own resolver, so the editor edits exactly what the
   * rail renders — including the case where that is the shipped default and
   * the space has no stored menu at all.
   */
  loadMenu(): Promise<ResolvedMenu>;
}

export function settingsPortFromSeam(seam: Seam, spaceId: SpaceId): SettingsPort {
  return {
    async loadSpace() {
      const all = await seam.spaces();
      return all.find((s) => s.id === spaceId) ?? null;
    },

    async loadMembers() {
      const result = await seam.query({ spaceId, kinds: [memberKindRef() as never] });
      return result.page.items;
    },

    loadIdentity() {
      return seam.identity();
    },

    async loadMenu() {
      // The rejection path matters as much as the value: `resolveMenu(raw,
      // error)` distinguishes "no menu row" (normal, silent) from "the read
      // failed" (worth surfacing), and collapsing them would tell the user the
      // space has no menu when in fact nothing could be reached.
      let raw: MenuConfig | null = null;
      try {
        raw = await seam.menu(spaceId);
      } catch (error) {
        return resolveMenu(null, error);
      }
      return resolveMenu(raw);
    },
  };
}

/**
 * The role a member row carries, read off `EntityState` without naming a kind.
 *
 * `EntityState` is a discriminated union and only the member variant has a
 * `role`, so a structural read is both type-honest and literal-free. Returns
 * `null` for a row that carries none — which renders as a hollow value, never
 * as a guessed default role.
 */
export function roleOf(summary: EntitySummary): string | null {
  const state = summary.state as { role?: unknown };
  return typeof state?.role === 'string' ? state.role : null;
}
