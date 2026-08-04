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
import { allKinds } from '../domain';
import type { ActionRef } from '../domain';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';

export interface RowLifecycle {
  /** Bound to `EntityListPanel.onSetState`. */
  setState: (entityId: string, next: string, via: ActionRef) => void;
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
  /** Bound to `EntityListPanel.onSetValue` — a registry `ValueControl` write. */
  setValue: (entityId: string, source: string, next: string) => void;
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
    (id: string, title: string, run: Promise<CommandResult>) => {
      run.then(reconcileCommand).catch((error: unknown) => report(id, title, error));
    },
    [reconcileCommand, report],
  );

  const setState = useCallback(
    (entityId: string, next: string, via: ActionRef) => {
      const id = entityId as EntityId;

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
          onNotice({
            id: `complete-unhydrated:${entityId}`,
            tone: 'error',
            title: 'Cannot complete this task yet',
            body: 'Its current version is not loaded, and completing without one could overwrite a change you have not seen. Open the task, then complete it.',
            ttlMs: 6_000,
          });
          return;
        }
        settle(
          entityId,
          'Task could not be completed',
          seam.commands.complete(id, {
            expectedVersion: version,
            // Attribution, and the points award rides it. Unknown viewer ⇒
            // empty, which the server accepts: it completes the task and pays
            // nobody, rather than crediting whoever happens to be calling.
            completerIds: viewerMemberId ? [viewerMemberId as EntityId] : [],
          }),
        );
        return;
      }

      settle(
        entityId,
        'State could not be changed',
        // `next` is a registry-declared id for this kind's own state field;
        // the seam types it as WorkStatus, which is what that vocabulary is.
        seam.commands.work(id, { status: next as never }),
      );
    },
    [data, onNotice, seam, settle, viewerMemberId],
  );

  const archive = useCallback(
    (ref: ActionRef, entityId: string) => {
      const id = entityId as EntityId;
      if (ref === 'archive') {
        settle(entityId, 'Could not archive', seam.commands.deleteEntity(id));
        return;
      }
      settle(entityId, 'Could not restore', seam.commands.restoreEntity(id));
    },
    [seam, settle],
  );

  const setValue = useCallback(
    (entityId: string, source: string, next: string) => {
      const id = entityId as EntityId;
      /**
       * THE VERSION IS READ, NOT REFUSED — the opposite of `complete` above,
       * and deliberately so. `complete` is a gated, one-way verb whose guard
       * exists to stop it firing against a state the user never saw. Setting
       * one enum is neither: the read is the user's own row, and refusing
       * until some other surface happens to have hydrated the detail would
       * make the control dead on a freshly loaded list, which is exactly the
       * inert chip this change exists to remove. The cached version is
       * preferred; a fresh `entity()` read is the fallback, and the guard
       * still does its job — a concurrent edit lands as `version_conflict`,
       * which surfaces as a notice rather than a silent overwrite.
       */
      const version = data.detailOf(entityId)?.version;
      const patch = (expectedVersion: number) =>
        seam.commands.patchEntity(id, { expectedVersion, content: { [source]: next } });
      settle(
        entityId,
        `${source} could not be changed`,
        version !== undefined
          ? patch(version)
          : seam.entity(id).then((detail) => patch(detail.version)),
      );
    },
    [data, seam, settle],
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
       */
      settle(
        entityId,
        'Could not unassign',
        seam.connections(id).then((page) => {
          const edge = page.items.find(
            (e) => e.type === edgeType && e.target.id === actorId && e.source.id === entityId,
          );
          if (!edge) {
            throw new Error('That assignment is no longer on this node — reload the list to see who is assigned.');
          }
          return seam.commands.deleteEdge(edge.id);
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
  const rosterKinds = useMemo(
    () => [
      ...new Set(allKinds().flatMap((k) => k.list.assignControl?.actorKinds ?? [])),
    ],
    [],
  );

  const assignable = useMemo(
    () =>
      rosterKinds.flatMap((kind) =>
        data.rowsFor(kind)(undefined).map(
          (row): ActorSummary => ({
            id: row.id as EntityId,
            // The roster kinds ARE the actor kinds; `ActorSummary` narrows the
            // field, and a registry that named a third kind would be the defect
            // to fix rather than something to silently drop here.
            kind: row.kind as ActorSummary['kind'],
            displayName: row.title,
            avatar: null,
            isAgent: row.kind !== 'member',
          }),
        ),
      ),
    [data, rosterKinds],
  );

  return { setState, archive, setValue, assign, assignable };
}
