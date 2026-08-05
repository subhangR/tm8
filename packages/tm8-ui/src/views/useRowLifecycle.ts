/**
 * D67 — the host executor behind the expanded row's state dropdown and its
 * archive control.
 *
 * WHY THIS IS A HOOK IN `views/` AND NOT LOGIC IN THE PANEL. `EntityListPanel`
 * never taps the seam — every signal it draws is injected, and every write it
 * offers leaves through a callback. That is what lets the same panel render
 * against the fixture seam, the real seam and a test double without knowing
 * which. So the panel decides WHAT was asked for (which row, which value,
 * which verb, all from registry data) and this decides what that MEANS as a
 * seam call.
 *
 * THE VERB → CALL MAP IS THE WHOLE POINT, because the three writes are NOT
 * interchangeable:
 *
 *   set-state → `commands.work`      no version guard; also maintains the
 *                                    actor's `working_on` edge server-side.
 *   complete  → `commands.complete`  version-guarded AND gated: the server
 *                                    refuses unless every acceptance criterion
 *                                    is checked. It is the ONLY operation
 *                                    permitted to write `done`.
 *   set-value → `commands.patchEntity`    a CONTENT edit, version-guarded, and
 *                                    sparse (the node COALESCEs the fields the
 *                                    patch omits) — so one field moves and the
 *                                    rest of the record is not restated.
 *   assign    → `commands.createEdge` / `commands.deleteEdge`  one edge at a
 *                                    time; `state.assignees` is a PROJECTION of
 *                                    `assigned_to`, so there is no array to PUT.
 *   archive   → `commands.deleteEntity`   the shared tombstone.
 *   restore   → `commands.restoreEntity`  its inverse.
 *
 * THE PANEL NAMES THE FIELD, THIS NAMES THE CALL. `setValue` is handed the
 * registry's `source` ("priority") and `assign` the registry's `edgeType`
 * ("assigned_to"); neither is spelled here, so a second value control or a
 * second relationship needs registry data and not an edit to this file — the
 * same rule that keeps `EntityListPanel` free of kind literals.
 *
 * EVERY FAILURE SURFACES. A refusal here is usually a real server invariant
 * (an unmet acceptance criterion, a kind whose lifecycle is command-owned),
 * which is precisely the class of thing a user must be told about rather than
 * left to infer from a row that did not move.
 */
import { useCallback, useMemo } from 'react';
import type { ActorSummary, CommandResult, EntityId } from '@tm8/contract';
import { nextMutationId } from '../authoring';
import { allKinds } from '../domain';
import type { ActionRef, SetStateOutcome } from '../domain';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';

/**
 * EVERY DELETE ON THIS SEAM NEEDS ONE, and the three that omitted it were all
 * guaranteed 400s. `entities.delete`, `entities.restore` and `edges.delete`
 * all bind `RequiredCommandContextSchema` (server `input-schemas.ts:149,150,165`),
 * which is `.strict()` with `clientMutationId: z.string().min(1)`. The server
 * synthesizes an id ONLY when idempotency is off (`idempotency.ts:23`) and
 * `TM8_IDEMPOTENCY_ENABLED` defaults to TRUE (`config.ts:239`) — so on a
 * default-configured node an omitted context arrives as `{}` and earns
 * `invalid_input`, which this hook then reports as "Could not unassign".
 *
 * `nextMutationId` is the SAME minter the authoring lane uses, deliberately:
 * ids carrying only a counter collide across principals and
 * `require_replay_principal` refuses the second human's write as a replay
 * (see its docblock in `authoring/commands.ts`). A second convention here
 * would be a second way to get that wrong.
 */
const commandContext = () => ({ clientMutationId: nextMutationId() });

/**
 * `ActorSummary` narrows `kind` to exactly these two, so a registry naming a
 * third assignable kind is a defect in the registry and NOT something this
 * file may cast away: `row.kind as ActorSummary['kind']` would mislabel it
 * silently, and a mislabelled actor is drawn with the wrong provenance mark —
 * an agent shown as a human. Validated once, loudly, below.
 */
const ACTOR_KINDS: readonly ActorSummary['kind'][] = ['member', 'team_member'];

function isActorKind(kind: string): kind is ActorSummary['kind'] {
  return (ACTOR_KINDS as readonly string[]).includes(kind);
}

/** The server's own `MAX_LIMIT` (`facade/context.ts:139`). Asking for more is a 400. */
const MAX_EDGE_PAGE = 200;

export interface RowLifecycle {
  /**
   * Bound to `EntityListPanel.onSetState`.
   *
   * RETURNS the outcome, because the board renders refusals INLINE at the
   * refusing column (doc 06 §1.5 — no toasts on the board) and so needs to
   * know. `opts.notify: false` suppresses the notice for exactly that caller;
   * the dropdown path passes nothing and keeps its notice. One executor, two
   * refusal surfaces, zero double-reporting.
   */
  setState: (
    entityId: string,
    next: string,
    via: ActionRef,
    opts?: { notify?: boolean },
  ) => Promise<SetStateOutcome>;
  /**
   * Bound to `EntityListPanel.onArchive` — NOT to the general `onAction`.
   *
   * Binding this to `onAction` would tell the panel that EVERY registry verb
   * now has a host, and the panel would enable them: the Sessions header's
   * `quickLaunch` lit up as a working control that this executor does not own
   * and would have dropped on the floor. An executor advertises only the verbs
   * it can actually perform.
   */
  archive: (ref: ActionRef, entityId: string) => void;
  /**
   * Bound to `EntityListPanel.onSetValue` — a registry `ValueControl` write.
   *
   * `label` rides along beside `source` because a failure notice is USER copy:
   * `source` is the wire field name and titling a notice with it produced
   * "priority could not be changed", lowercase mid-sentence. Both come off the
   * same registry control, so they cannot disagree.
   */
  setValue: (entityId: string, source: string, next: string, label: string) => void;
  /** Bound to `EntityListPanel.onAssign` — ONE actor's edge, added or removed. */
  assign: (entityId: string, actorId: string, edgeType: string, assigned: boolean) => void;
  /**
   * Bound to `EntityListPanel.assignableActors` — everyone the menu may offer.
   *
   * EMPTY MEANS NOT LOADED, and the panel refuses in those words rather than
   * drawing an empty menu that claims the space has nobody in it. It fills in
   * as the roster kinds hydrate (`rowsFor` reads a key it has not seen), so the
   * refusal is transient by construction.
   */
  assignable: readonly ActorSummary[];
}

export interface RowLifecycleOptions {
  data: GateData;
  viewerMemberId?: string | null;
  onNotice: (notice: Notice) => void;
}

export function useRowLifecycle({ data, viewerMemberId, onNotice }: RowLifecycleOptions): RowLifecycle {
  const { seam, reconcileCommand } = data;

  const report = useCallback(
    (id: string, title: string, error: unknown) => {
      onNotice({
        id: `${title}:${id}`,
        tone: 'error',
        title,
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      });
    },
    [onNotice],
  );

  const settle = useCallback(
    (id: string, title: string, run: Promise<CommandResult>, notify = true): Promise<SetStateOutcome> =>
      run
        .then((result): SetStateOutcome => {
          reconcileCommand(result);
          return { ok: true };
        })
        .catch((error: unknown): SetStateOutcome => {
          if (notify) report(id, title, error);
          return { ok: false, reason: String((error as { message?: string })?.message ?? error) };
        }),
    [reconcileCommand, report],
  );

  const setState = useCallback(
    (entityId: string, next: string, via: ActionRef, opts?: { notify?: boolean }): Promise<SetStateOutcome> => {
      const id = entityId as EntityId;
      const notify = opts?.notify ?? true;

      if (via === 'complete') {
        /**
         * The version comes from the DETAIL, not the summary, and its absence
         * is refused rather than guessed. `complete` is version-guarded, and a
         * fabricated `expectedVersion` would either fail the guard or — worse,
         * if it happened to match — complete a task against a state the user
         * never saw. A row whose detail is not hydrated genuinely cannot be
         * completed yet, which is the same rule the panel's capability gate
         * already applies to every other verb.
         */
        const version = data.detailOf(entityId)?.version;
        if (version === undefined) {
          const reason =
            'Its current version is not loaded, and completing without one could overwrite a change you have not seen. Open the task, then complete it.';
          if (notify) {
            onNotice({
              id: `complete-unhydrated:${entityId}`,
              tone: 'error',
              title: 'Cannot complete this task yet',
              body: reason,
              ttlMs: 6_000,
            });
          }
          return Promise.resolve({ ok: false, reason });
        }
        return settle(
          entityId,
          'Task could not be completed',
          seam.commands.complete(id, {
            expectedVersion: version,
            // Attribution, and the points award rides it. Unknown viewer ⇒
            // empty, which the server accepts: it completes the task and pays
            // nobody, rather than crediting whoever happens to be calling.
            completerIds: viewerMemberId ? [viewerMemberId as EntityId] : [],
          }),
          notify,
        );
      }

      return settle(
        entityId,
        'State could not be changed',
        // `next` is a registry-declared id for this kind's own state field;
        // the seam types it as WorkStatus, which is what that vocabulary is.
        seam.commands.work(id, { status: next as never }),
        notify,
      );
    },
    [data, onNotice, seam, settle, viewerMemberId],
  );

  const archive = useCallback(
    (ref: ActionRef, entityId: string) => {
      const id = entityId as EntityId;
      if (ref === 'archive') {
        void settle(entityId, 'Could not archive', seam.commands.deleteEntity(id, commandContext()));
        return;
      }
      void settle(entityId, 'Could not restore', seam.commands.restoreEntity(id, commandContext()));
    },
    [seam, settle],
  );

  const setValue = useCallback(
    (entityId: string, source: string, next: string, label: string) => {
      const id = entityId as EntityId;
      /**
       * THE CACHED VERSION IS THE ONLY VERSION — there is no `entity()`
       * fallback, because in production there is nothing for it to fall back
       * from. `RowValueControl` refuses with CheckingPermission the moment
       * `capabilitiesOf(row.id)` is `undefined` (`EntityListPanel.tsx:1472`),
       * and all three call sites wire that to `data.detailOf(id)?.capabilities`
       * (`WorkspaceView.tsx:405,488`, `EntityView.tsx:379`). Capabilities
       * present therefore IMPLIES the detail is cached, which implies the
       * version is defined: a fallback read here could only ever fire behind a
       * control the user could not have clicked.
       *
       * The refusal below is what an unreachable case is allowed to cost. It
       * is not a guess and not a second read — the panel gate and this
       * executor are separate modules, and if that invariant is ever broken
       * this says so instead of patching against a version nobody saw.
       */
      const version = data.detailOf(entityId)?.version;
      if (version === undefined) {
        onNotice({
          id: `value-unhydrated:${entityId}`,
          tone: 'error',
          title: `${label} could not be changed`,
          body: 'This row’s current version is not loaded, and writing without one could overwrite a change you have not seen. Open the row, then try again.',
          ttlMs: 6_000,
        });
        return;
      }
      settle(
        entityId,
        `${label} could not be changed`,
        // Sparse: the node COALESCEs the fields the patch omits, so one field
        // moves and the rest of the record is not restated. The guard still
        // does its job — a concurrent edit lands as `version_conflict`, which
        // surfaces as a notice rather than a silent overwrite.
        seam.commands.patchEntity(id, { expectedVersion: version, content: { [source]: next } }),
      );
    },
    [data, onNotice, seam, settle],
  );

  const assign = useCallback(
    (entityId: string, actorId: string, edgeType: string, assigned: boolean) => {
      const id = entityId as EntityId;

      if (assigned) {
        settle(
          entityId,
          'Could not assign',
          // UPSERT on (src, dst, type) server-side, so a double-click adds
          // nothing twice and needs no read first.
          seam.commands.createEdge({ srcId: id, dstId: actorId as EntityId, type: edgeType }),
        );
        return;
      }

      /**
       * Removal is addressed by the EDGE's id, which only `connections()`
       * knows — `state.assignees` is the projection and carries the actor,
       * never the edge. So an unassign is a read then a write, and an edge
       * that is already gone is reported rather than swallowed: the row shows
       * an assignment the node does not have, and the user should be told
       * that instead of watching a chip refuse to move.
       *
       * THE READ IS FILTERED, AND THE ERROR TEXT IS WHY. An unfiltered
       * `connections()` is capped at the server's `DEFAULT_LIMIT` of 50 across
       * every edge type on the entity (`facade/context.ts:138`), so on a busy
       * task the assignment could sit off the first page and this would throw
       * "no longer on this node" about an edge that is plainly still there —
       * a false statement to the user, dressed as a diagnosis. Naming the type
       * and the direction bounds the page by ASSIGNEES rather than by edges,
       * so "absent from the page" and "absent from the node" mean the same
       * thing again. (`ConnectionOpts` in `data/seam.ts` carries them.)
       */
      settle(
        entityId,
        'Could not unassign',
        seam
          .connections(id, { types: [edgeType], direction: 'outgoing', limit: MAX_EDGE_PAGE })
          .then((page) => {
            const edge = page.items.find(
              (e) => e.type === edgeType && e.target.id === actorId && e.source.id === entityId,
            );
            if (!edge) {
              throw new Error('That assignment is no longer on this node — reload the list to see who is assigned.');
            }
            return seam.commands.deleteEdge(edge.id, commandContext());
          }),
      );
    },
    [seam, settle],
  );

  /**
   * The union of every assign control's `actorKinds`, resolved once — the
   * registry decides who is assignable and this file only reads it, which is
   * the same rule that keeps the panel free of kind literals.
   */
  const rosterKinds = useMemo(() => {
    const declared = [...new Set(allKinds().flatMap((k) => k.list.assignControl?.actorKinds ?? []))];
    const unrepresentable = declared.filter((kind) => !isActorKind(kind));
    if (unrepresentable.length > 0) {
      // LOUD, not silent. The registry is static, so this either throws on the
      // first render in dev and test or it never throws at all — which makes it
      // a build-shaped failure, not a runtime risk. The alternative was a cast
      // that drew the new kind with a fabricated `kind` and `isAgent`.
      throw new Error(
        `assignControl.actorKinds names ${unrepresentable.join(', ')}, which ActorSummary cannot represent ` +
          `(it is '${ACTOR_KINDS.join("' | '")}'). Widen the contract type before making that kind assignable.`,
      );
    }
    return declared.filter(isActorKind);
  }, []);

  /**
   * The roster the assign menu offers.
   *
   * IT PREFERS THE ACTOR THE SPACE ALREADY LOADED. `data.members` is the real
   * membership projection (`useGateData.ts:267`) and carries the AVATAR the
   * server resolved; an `EntitySummary` does not carry one at all, so a roster
   * built purely from `rowsFor` draws every face blank and quietly discards
   * the avatars PR #12 merged.
   *
   * IT STILL WALKS `rowsFor` FOR THE KINDS. `data.members` is `public.members`
   * — the HUMAN membership rows — so it does not contain `team_member`
   * actors, and using it alone would drop every agent from a menu the registry
   * says agents belong in. So: the registry names the kinds, the rows name the
   * population, and `members` supplies the real actor wherever it has one.
   */
  const assignable = useMemo(() => {
    const loaded = new Map(data.members.map((actor) => [actor.id as string, actor]));
    return rosterKinds.flatMap((kind) =>
      data.rowsFor(kind)(undefined).map(
        (row): ActorSummary =>
          loaded.get(row.id) ?? {
            id: row.id as EntityId,
            // `kind` here is the ROSTER kind — the registry key this group was
            // read under, already proven representable above — not the row's
            // own unchecked string.
            kind,
            displayName: row.title,
            avatar: null,
            // The server derives it the same way (`seam-fixture.ts:620`, and
            // `ActorSummary.ownerMemberId` "present for a team_member").
            isAgent: kind === 'team_member',
          },
      ),
    );
  }, [data, rosterKinds]);

  return { setState, archive, setValue, assign, assignable };
}
