/**
 * THE PANEL PRIMARIES DISPATCHER — the executor behind `panel.primaries`.
 *
 * WHY THIS EXISTS AS A HOOK. `EntityDetailPanel` is mounted at FIVE sites
 * (WorkspaceView, EntityView ×2, ChannelView, GraphScreen) and not one of them
 * passed `onAction`. The registry has declared `terminate` a work_session
 * primary and derived `run` for every `launchable` kind since those rows were
 * written, so every one of those mounts drew the verbs and rendered them
 * permanently disabled: R5 #9 gates on whether a handler exists, and none did.
 * That is the reported defect — "there is a terminate button which is not
 * enabled and working" — and the same button on the same panel opened from a
 * kind screen, a channel or the graph was dead for the same reason.
 *
 * So the wiring lives here and every host calls it. Fixing one call site would
 * have left the identical dead button reachable by four other routes, which is
 * the shape `useLaunchPort` was extracted to stop: two screens, one wired and
 * one not, reads from the outside exactly like flaky state.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: `run` and the other `flow: 'launch'`
 * verbs. They do not dispatch at all — they expand the launch config, which
 * commits through `LaunchSources.onSpawn`. `wiredActions` below is therefore
 * the honest, complete list of what this dispatcher can perform, and a primary
 * outside it (a doc's `add-child`, which has no executor anywhere) keeps its
 * disabled-with-reason rather than lighting up and doing nothing.
 *
 * THE PORT IS STRUCTURAL, not `GateData`: `GraphScreen` takes a narrow port by
 * charter and must not import views' data type. It names exactly what a
 * terminate needs, so that screen passes its own `seam` unchanged.
 */
import { useCallback, useMemo } from 'react';
import type { CommandResult, EntityId } from '@tm8/contract';
import type { ActionRef } from '../domain';
import type { Seam } from '../data/seam';

/**
 * Exactly what this dispatcher performs. Exported as a CONSTANT so a host
 * cannot hand the panel a list that has drifted from the switch below — the
 * enabled-inert failure mode, reintroduced one careless edit at a time.
 */
export const PANEL_PRIMARY_ACTIONS: readonly ActionRef[] = ['terminate'];

export interface PanelPrimariesHost {
  /**
   * The command surface. OPTIONAL because `GraphScreenData.seam` is: a host
   * without one gets `onAction: undefined`, so the verb renders its honest
   * refusal instead of a button whose command cannot be sent.
   */
  seam?: Pick<Seam, 'commands'>;
  /** Fold the command's result back into the detail cache. */
  reconcileCommand?: (result: CommandResult) => void;
  /** The node refused, verbatim — never paraphrased into a generic failure. */
  onError?: (verb: ActionRef, entityId: string, error: unknown) => void;
}

export interface PanelPrimaries {
  /** Bind the dispatcher to one entity — the panel's `onAction` prop. */
  forEntity: (entityId: string) => ((ref: ActionRef) => void) | undefined;
  /** The panel's `wiredActions` prop. */
  wiredActions: readonly ActionRef[];
  /**
   * The same terminate, unwrapped — for the session tile's ✕, which takes an
   * entity id rather than a verb. ONE function behind both controls, so the
   * button the user reported dead and the ✕ they reported working cannot end
   * up doing two different things.
   */
  terminate: (entityId: string) => void;
}

export function usePanelPrimaries(host: PanelPrimariesHost): PanelPrimaries {
  const { seam, reconcileCommand, onError } = host;
  const commands = seam?.commands;

  /**
   * TERMINATE FIRES ON CLICK, with no confirm step (user ruling 2026-08-07).
   * It matches the session tile's ✕ exactly — same command, same immediacy —
   * because the two controls kill the same session and a header button that
   * asked first would make them read as different acts. A terminated session
   * is resumable, so this is not the irreversible direction.
   */
  const terminate = useCallback(
    (entityId: string) => {
      if (!commands) return;
      void commands
        .terminate(entityId as EntityId, {
          clientMutationId: `terminate:${entityId}:${Date.now()}`,
        })
        .then((result) => reconcileCommand?.(result))
        .catch((error: unknown) => onError?.('terminate', entityId, error));
    },
    [commands, reconcileCommand, onError],
  );

  const forEntity = useCallback(
    (entityId: string) => {
      if (!commands) return undefined;
      return (ref: ActionRef) => {
        /*
         * A SWITCH, not a lookup with a default: an unhandled verb must be
         * unreachable rather than silently absorbed. `wiredActions` is what
         * keeps it unreachable, and the two are edited together or the guard
         * is decorative.
         */
        switch (ref) {
          case 'terminate':
            terminate(entityId);
            return;
          default:
            return;
        }
      };
    },
    [commands, terminate],
  );

  return useMemo(
    () => ({ forEntity, wiredActions: PANEL_PRIMARY_ACTIONS, terminate }),
    [forEntity, terminate],
  );
}
