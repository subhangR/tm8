/**
 * THE SESSION-START DISPATCHER — the executor behind the session list's
 * HEADER verbs.
 *
 * WHY IT IS NOT `usePanelPrimaries`. That dispatcher binds to ONE ENTITY:
 * `forEntity(id)` exists because Terminate kills the session you are looking
 * at. Starting a session is the opposite shape — there is no entity yet, and
 * the inputs are the SPACE and the project. Threading a space id through an
 * entity-scoped executor to serve one verb would make the next reader look for
 * an entity that never existed.
 *
 * WHY THE HEADER HAD NO EXECUTOR AT ALL BEFORE THIS. `EntityListPanel` is
 * mounted at several sites and not one passed `onAction`, so `HeaderActions`
 * evaluated `Boolean(quickLaunch && onAction)` to false and drew NOTHING. The
 * registry has declared `quickLaunch: 'launch-session'` on the work_session
 * kind the whole time. That is the same class of defect `usePanelPrimaries`
 * was extracted for — a declared verb with no handler — with a harsher
 * symptom: the detail panel at least drew its verb disabled, while the header
 * drew no control whatsoever, which is why it reads from outside as "Sessions
 * to Start Terminal or claude, or codex is not available" (task 019ff248)
 * rather than as a greyed-out button with a reason on it.
 *
 * `SESSION_START_ACTIONS` is what this hook can PERFORM, and it is now also
 * what the header DRAWS. `launch-session` is not in it: that verb opens the
 * five-section sheet against a launch SUBJECT, and the header has no subject
 * to open it against — picking one here would be this dispatcher guessing what
 * the member meant to launch.
 *
 * IT USED TO DRAW ANYWAY, refused, next to a live `▮ Terminal` (101). That was
 * right while 019ff248 was open: a visible refusal is reportable and an
 * absence is not. It stopped being right once the reason became permanent —
 * the header will never have a launch subject, so that button could never
 * resolve into anything. USER RULING 2026-08-17: remove it. `HeaderActions`
 * now draws only the verbs `wiredActions` names, so shortening this constant
 * is what removes the control; the two cannot drift.
 */
import { useCallback, useMemo } from 'react';
import type { CommandResult, EntityId } from '@tm8/contract';
import type { ActionRef } from '../domain';
import type { Seam } from '../data/seam';

/**
 * Exactly what this dispatcher performs, exported as a CONSTANT for the same
 * reason `PANEL_PRIMARY_ACTIONS` is: a host cannot hand the panel a list that
 * has drifted from the switch below.
 */
export const SESSION_START_ACTIONS: readonly ActionRef[] = ['start-terminal'];

export interface SessionStartHost {
  /** The space the terminal opens in. Absent ⇒ the verb cannot be performed. */
  spaceId?: EntityId | null;
  /** The command surface. Absent ⇒ `onAction` is undefined; the verb refuses. */
  seam?: Pick<Seam, 'commands'>;
  /**
   * Which project's root the shell opens in. Null/absent ⇒ a projectless
   * terminal in a server-owned scratch directory, which is the honest default:
   * the header has no project picker, and silently choosing the first linked
   * project would put a member in a repository they did not name.
   */
  projectId?: string | null;
  /** Fold the new session's patches into the store, as a spawn's are. */
  reconcileCommand?: (result: CommandResult) => void;
  /** Open the session that was just started — a terminal you cannot see is not one. */
  onOpen?: (id: EntityId) => void;
  /** The node refused, verbatim — never paraphrased into a generic failure. */
  onError?: (verb: ActionRef, error: unknown) => void;
}

export interface SessionStart {
  /** The panel's `onAction` prop. Undefined ⇒ every verb renders refused. */
  onAction?: (ref: ActionRef, entityId: string) => void;
  /** The panel's `wiredActions` prop. */
  wiredActions: readonly ActionRef[];
  /** The same verb unwrapped, for a host with its own affordance. */
  startTerminal: () => void;
}

export function useSessionStart(host: SessionStartHost): SessionStart {
  const { spaceId, seam, projectId, reconcileCommand, onOpen, onError } = host;
  const commands = seam?.commands;
  const canStart = Boolean(commands && spaceId);

  /**
   * FIRES ON CLICK, with no confirm step and no configuration expand.
   *
   * A vanilla terminal has nothing to configure — no teammate, no model, no
   * profile — so the two-clicks-to-launch rule that governs a spawn has an
   * empty card to show in between. That rule exists so the configuration you
   * are about to use is visible at the moment you commit it; with no
   * configuration there is nothing to make visible, and the second click would
   * only be ceremony. It is also cheap to undo: terminate.
   */
  const startTerminal = useCallback(() => {
    /*
     * NOT a silent swallow, for the reason `usePanelPrimaries.terminate` gives:
     * `onAction` below is undefined without these, so this is unreachable from
     * the header. A host calling `startTerminal` DIRECTLY without them has
     * wired a control it cannot perform, and absorbing that as a no-op is how
     * a dead button survives review.
     */
    if (!commands || !spaceId) {
      throw new Error(
        'useSessionStart.startTerminal was called with no seam or no space: the host rendered a control it '
          + 'cannot perform. Gate the affordance on `onAction != null`, which is undefined precisely so this '
          + 'cannot happen.',
      );
    }
    void commands
      .startTerminal({
        clientMutationId: `terminal:${spaceId}:${Date.now()}`,
        spaceId,
        projectId: projectId ?? null,
      })
      .then((result) => {
        reconcileCommand?.(result);
        const id = (result as { entity?: { id?: string } }).entity?.id;
        if (id) onOpen?.(id as EntityId);
      })
      .catch((error: unknown) => onError?.('start-terminal', error));
  }, [commands, spaceId, projectId, reconcileCommand, onOpen, onError]);

  const onAction = useCallback(
    (ref: ActionRef) => {
      /*
       * A SWITCH, not a lookup with a default: an unhandled verb must be
       * unreachable rather than silently absorbed. `SESSION_START_ACTIONS` is
       * what keeps it unreachable, and the two are edited together or the
       * guard is decorative.
       */
      switch (ref) {
        case 'start-terminal':
          startTerminal();
          return;
        default:
          return;
      }
    },
    [startTerminal],
  );

  return useMemo(
    () => ({
      ...(canStart ? { onAction } : {}),
      wiredActions: SESSION_START_ACTIONS,
      startTerminal,
    }),
    [canStart, onAction, startTerminal],
  );
}
