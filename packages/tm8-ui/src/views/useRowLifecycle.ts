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
 *   archive   → `commands.deleteEntity`   the shared tombstone.
 *   restore   → `commands.restoreEntity`  its inverse.
 *
 * EVERY FAILURE SURFACES. A refusal here is usually a real server invariant
 * (an unmet acceptance criterion, a kind whose lifecycle is command-owned),
 * which is precisely the class of thing a user must be told about rather than
 * left to infer from a row that did not move.
 */
import { useCallback } from 'react';
import type { CommandResult, EntityId } from '@tm8/contract';
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

  return { setState, archive };
}
