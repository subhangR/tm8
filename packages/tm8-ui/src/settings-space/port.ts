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
 * WHAT THIS PORT MAY WRITE, AND WHY THE LIST GREW (109 / seam Amendment 11).
 *
 * It used to be reads plus `updateProfile` alone, and the header said so at
 * length: role change, member removal and the whole invite family had no
 * executor anywhere in `seam.commands`, so they lived in `reasons.ts` as
 * disabled-with-reason and the port deliberately exposed no method for them.
 *
 * Four of those now have executors, and the port exposes exactly those four:
 * `setMemberRole`, `createInvite`, `revokeInvite` and the invite READ. Each is
 * a contract v1 operation backed by a SECURITY DEFINER RPC that carries its own
 * authorization — this file adds none and can therefore not disagree with the
 * server about who may do what.
 *
 * MEMBER REMOVAL IS STILL ABSENT, and its absence is now a different fact than
 * it was. It is not that nobody wrote the verb: `entities.created_by` references
 * `entities(id)` with no on-delete clause, so Postgres REFUSES to delete the
 * member row of anyone who has authored anything, and the correct shape — a
 * soft removal that keeps attribution and revokes access — needs every
 * membership predicate in the schema audited. `MEMBER_REMOVE_UNAVAILABLE` says
 * so. The port still exposes no method for it, for the original reason: a
 * component that cannot reach a verb cannot quietly acquire one.
 */
import type {
  CommandResult,
  CreateInviteInput,
  EntityId,
  EntitySummary,
  IdentityProfileUpdateInput,
  IdentityProfileView,
  MenuConfig,
  SpaceId,
  SpaceInviteView,
  SpaceMemberRole,
  SpaceSummary,
  TaskAxis,
  TaskAxisInput,
} from '@tm8/contract';
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

/**
 * The roles an INVITE may confer — every role except the owner word.
 *
 * Derived rather than written as `['admin', 'member']`, and §15.2 is the
 * immediate reason: the least-privileged role and the member KIND are the same
 * string, so a literal `'member'` anywhere in this lane is indistinguishable
 * from a kind-literal violation to the guard in `no-kind-literals.test.ts` —
 * and to any reader. It is also the more honest expression of 114 R4, which is
 * not "admin and member" but "anything except the owner": if the role
 * vocabulary ever gains a fourth word, an invite should be able to confer it
 * and a hard-coded pair would silently refuse.
 */
export function inviteRoles(): string[] {
  const owner = ownerRoleRef();
  return memberRoles().filter((role) => role !== owner);
}

/**
 * The roles that can administer a space — every role except the least
 * privileged one.
 *
 * Same derivation `defaultInviteRole` already relies on (the registry lists
 * roles most-privileged first, so the last entry is the plain one), and the
 * same reason for deriving it. This mirrors `internal.is_space_admin`, which
 * tests `role in ('owner','admin')` — but SQL is the authority and this is
 * only what the UI shows before the click.
 */
export function adminRoles(): string[] {
  const roles = memberRoles();
  return roles.slice(0, Math.max(0, roles.length - 1));
}

/**
 * The kinds whose rows carry per-space axes, from REGISTRY DATA — every kind
 * declaring `list.axisControls`. Today that is exactly the task kind; a
 * second axis-bearing kind arrives here by registry entry alone, which is the
 * same door the W1 picker uses.
 */
export function axisKindRefs(): string[] {
  return allKinds()
    .filter((row) => row.list.axisControls !== undefined)
    .map((row) => row.kind);
}

/*
 * `workflowStatusVocabulary()` STOOD HERE — the status list the Workflows
 * section offered, derived from the axis-bearing kind's own registry row.
 * It went with that section in phase 6 (migration 154): `task_workflows` is
 * dropped, so there is no per-`type` vocabulary to curate.
 */

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
  /**
   * Writes the VIEWER's own profile; the mutation id is minted here so
   * components stay declarative about fields.
   */
  updateProfile(input: Omit<IdentityProfileUpdateInput, 'clientMutationId'>): Promise<IdentityProfileView>;

  /** Outstanding and revoked invitations, newest first. Space-admin only. */
  loadInvites(): Promise<SpaceInviteView[]>;

  /**
   * Change one member's role in THIS space (118).
   *
   * Takes no space id: the port is already bound to one, and letting a caller
   * name a different space would be the exact confusion `set_member_role`'s
   * two-column predicate exists to prevent.
   */
  setMemberRole(memberId: EntityId, role: SpaceMemberRole): Promise<CommandResult>;

  /** Mint a join code. `role` is what redemption confers; never `owner`. */
  createInvite(input: Omit<CreateInviteInput, 'clientMutationId' | 'actorId'>): Promise<SpaceInviteView>;

  /** Kill a live code. The row survives, revoked, so the list stays truthful. */
  revokeInvite(inviteId: string): Promise<SpaceInviteView>;

  /**
   * The task-axis registry (W2), position order. Rides `spaces.settings` —
   * the round trip this shell already makes for invites (the precedent the
   * `loadInvites` docblock establishes) — NOT a call to `spaces.taskAxes.list`,
   * which answers from the same rows.
   */
  loadAxes(): Promise<TaskAxis[]>;

  /**
   * Create / reshape / delete one axis. Every rule is the server's and comes
   * back as its own words: space-admin authorization, name and value
   * validation, and the in-use refusals (delete, rename, or value-removal
   * while any task in the space carries the axis are all refused — measured
   * 2026-08-16; nothing is ever cleared or orphaned). `updateAxis` takes the
   * whole row shape because `w2_update_task_axis` has no sparse form.
   */
  createAxis(input: Omit<TaskAxisInput, 'clientMutationId' | 'actorId'>): Promise<TaskAxis>;
  updateAxis(axisId: string, input: Omit<TaskAxisInput, 'clientMutationId' | 'actorId'>): Promise<TaskAxis>;
  deleteAxis(axisId: string): Promise<{ axisId: string }>;

  /**
   * The tasks carrying ANY of this axis's declared values — what makes an
   * in-use refusal actionable (owner ruling: the UI names WHICH tasks still
   * use it). A free-text axis (no declared values) answers `[]`: the
   * `filters.axes` clause matches values, and "any value at all" is not a
   * question it can ask.
   */
  tasksUsingAxis(axis: TaskAxis): Promise<EntitySummary[]>;
}

let profileMutationSeq = 0;

/** Unique enough for idempotency-keying a hand-clicked save; injectable-free
 *  because no caller ever needs to recognise the id later. */
function newProfileMutationId(): string {
  profileMutationSeq += 1;
  return `profile_${profileMutationSeq.toString(36)}_${Date.now().toString(36)}`;
}

let mutationSeq = 0;

/**
 * The same shape for the membership writes, with the ACT in the prefix.
 *
 * The prefix is not decoration. `internal.ledger_replay` keys on the mutation
 * id alone and the operation label cannot distinguish two calls to the same
 * operation against different resources (031's own note), so a prefix that
 * names the act keeps a replayed id legible in the ledger to whoever is
 * reading it later.
 */
function newMutationId(prefix: string): string {
  mutationSeq += 1;
  return `${prefix}_${mutationSeq.toString(36)}_${Date.now().toString(36)}`;
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

    updateProfile(input) {
      return seam.commands.updateProfile({ ...input, clientMutationId: newProfileMutationId() });
    },

    /**
     * Invites ride `spaces.settings`, which already carries them, rather than
     * `spaces.invites.list`: the settings read is one round trip the shell
     * makes anyway, and the two answer from the same rows. If this ever needs
     * paging, that is the moment to reach for the dedicated list op.
     */
    async loadInvites() {
      const settings = await seam.spaceSettings(spaceId);
      return settings.invites;
    },

    setMemberRole(memberId, role) {
      return seam.commands.setMemberRole(spaceId, memberId, {
        role,
        clientMutationId: newMutationId('role'),
      });
    },

    createInvite(input) {
      return seam.commands.createInvite(spaceId, {
        ...input,
        clientMutationId: newMutationId('invite'),
      });
    },

    revokeInvite(inviteId) {
      return seam.commands.revokeInvite(spaceId, inviteId, {
        clientMutationId: newMutationId('revoke'),
      });
    },

    async loadAxes() {
      const settings = await seam.spaceSettings(spaceId);
      return settings.taskAxes ?? [];
    },

    createAxis(input) {
      return seam.commands.createTaskAxis(spaceId, {
        ...input,
        clientMutationId: newMutationId('axis'),
      });
    },

    updateAxis(axisId, input) {
      return seam.commands.updateTaskAxis(spaceId, axisId, {
        ...input,
        clientMutationId: newMutationId('axis'),
      });
    },

    deleteAxis(axisId) {
      return seam.commands.deleteTaskAxis(spaceId, axisId, {
        clientMutationId: newMutationId('axisrm'),
      });
    },

    async tasksUsingAxis(axis) {
      if (axis.axisValues.length === 0) return [];
      const result = await seam.query({
        spaceId,
        // The kinds whose registry rows declare axis pickers — the same
        // derivation rule as `memberKindRef` above, for the same §15.2
        // reason: the kind that CARRIES axes is registry data, not a literal.
        kinds: axisKindRefs() as never,
        filters: { axes: { [axis.name]: [...axis.axisValues] } },
      });
      return result.page.items;
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
