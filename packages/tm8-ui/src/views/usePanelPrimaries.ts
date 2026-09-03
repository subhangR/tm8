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
import { useCallback, useMemo, useState } from 'react';
import type { CommandResult, EntityId } from '@tm8/contract';
import type { ActionRef } from '../domain';
import type { Seam } from '../data/seam';

/**
 * Exactly what this dispatcher performs. Exported as a CONSTANT so a host
 * cannot hand the panel a list that has drifted from the switch below — the
 * enabled-inert failure mode, reintroduced one careless edit at a time.
 */
export const PANEL_PRIMARY_ACTIONS: readonly ActionRef[] = [
  'terminate',
  'resume',
  // Containers P0 (migration 177). `container-screen` is deliberately ABSENT:
  // it is deferred-with-reason in `domain/actions.ts`, so it refuses on its own
  // and must not be claimed here — a dispatcher entry for a verb that cannot
  // run is the enabled-inert shape this constant exists to prevent.
  'container-start',
  'container-stop',
  'container-destroy',
  'container-terminal',
];

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
  /**
   * The version the viewer is LOOKING AT, for the container verbs that carry
   * `expectedVersion` (catalog rows 2–8 make it mandatory).
   *
   * A PORT AND NOT A SEAM READ, deliberately. The panel already holds the
   * detail it rendered the button from; re-reading the version here would race
   * the very edit the guard is meant to catch — the point of
   * `expectedVersion` is that it is the version the HUMAN saw, not the newest
   * one. Absent ⇒ the verb reports the gap rather than guessing.
   */
  versionOf?: (entityId: string) => number | undefined;
  /**
   * Open an entity — used by `container-terminal`, which creates a
   * work_session and hands it back rather than rendering anything itself.
   * Absent ⇒ the exec session is still created; it simply is not navigated to.
   */
  onOpenEntity?: (entityId: string) => void;
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
  /**
   * The other half of the process control, unwrapped for the same reason — and
   * here there were already THREE surfaces to keep honest, not two: the panel
   * bar and the row cluster's tail slot both arrive by verb, and the exited
   * terminal canvas draws its own "Resume session" button (`ExitedFallback`),
   * which was the only resume the UI had at all before this.
   */
  resume: (entityId: string) => void;
  /**
   * The session a resume is currently in flight for, if any — the
   * ExitedFallback's `resuming`, and the guard that keeps a double press from
   * racing two spawns onto one session id. It lives with the executor rather
   * than in a host so that every surface that can fire a resume is covered by
   * the same guard; the node refuses the second with `conflict`, but the
   * honest UI is not to send it.
   */
  resumingId: string | null;
}

export function usePanelPrimaries(host: PanelPrimariesHost): PanelPrimaries {
  const { seam, reconcileCommand, onError, versionOf, onOpenEntity } = host;
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
      /*
       * REVIEW (1/2) note — NOT a silent swallow. `forEntity` already answers
       * `undefined` without a seam, so the panel renders the verb refused and
       * this is unreachable from the action bar. It is reachable from a host
       * that calls `primaries.terminate` DIRECTLY (the session tile's ✕), and
       * a host doing that without a seam has wired a control it cannot
       * perform — a defect that must not be absorbed as a no-op, exactly as
       * `domain/actions.ts` throws for a missing dispatcher.
       */
      if (!commands) {
        throw new Error(
          'usePanelPrimaries.terminate was called with no seam: the host rendered a control it cannot perform. '
            + 'Gate the affordance on `forEntity(...) != null`, which returns undefined precisely so this cannot happen.',
        );
      }
      void commands
        .terminate(entityId as EntityId, {
          clientMutationId: `terminate:${entityId}:${Date.now()}`,
        })
        .then((result) => reconcileCommand?.(result))
        .catch((error: unknown) => onError?.('terminate', entityId, error));
    },
    [commands, reconcileCommand, onError],
  );

  /**
   * RESUME — terminate's exact counterpart, and NOT a launch. It relaunches
   * the agent against the provider's own conversation id, re-reading persona,
   * project, tasks, model and workdir from the graph, so there is no
   * configuration to open and it commits on click as terminate does.
   *
   * `resumingId` is not cosmetic: this boots a real agent process.
   */
  const [resumingId, setResumingId] = useState<string | null>(null);
  const resume = useCallback(
    (entityId: string) => {
      /* Same posture as terminate above: unreachable through `forEntity`
         without a seam, so a host reaching it directly has wired a control it
         cannot perform, and that must not be absorbed as a no-op. */
      if (!commands) {
        throw new Error(
          'usePanelPrimaries.resume was called with no seam: the host rendered a control it cannot perform. '
            + 'Gate the affordance on `forEntity(...) != null`, which returns undefined precisely so this cannot happen.',
        );
      }
      setResumingId(entityId);
      void commands
        .resume(entityId as EntityId, { clientMutationId: `resume:${entityId}:${Date.now()}` })
        .then((result) => reconcileCommand?.(result))
        .catch((error: unknown) => onError?.('resume', entityId, error))
        .finally(() => setResumingId(null));
    },
    [commands, reconcileCommand, onError],
  );

  /**
   * THE CONTAINER LIFECYCLE VERBS — start · stop · destroy · terminal.
   *
   * EVERY ONE CARRIES `expectedVersion`, and it is MANDATORY on rows 2–8 of
   * the catalog rather than optional. That is why this hook needs
   * `versionOf`: the panel is already holding the detail, and a command sent
   * without the version the human was looking at is the lost-update the guard
   * exists to catch. A host that cannot supply one gets `undefined` from
   * `forEntity`, so the verb renders refused rather than sending a command
   * that would be rejected server-side for a reason the user cannot see.
   *
   * DESTROY CONFIRMS; the other three commit on click. Terminate next door
   * commits immediately and says why — "a terminated session is resumable, so
   * this is not the irreversible direction". A destroy IS the irreversible
   * direction: §11.1 makes `destroyed` terminal, the runtime is gone and the
   * row is soft-deleted. The asymmetry is the point, not an inconsistency.
   */
  const containerCommand = useCallback(
    (ref: ActionRef, entityId: string) => {
      if (!commands) {
        throw new Error(
          'usePanelPrimaries container verb was called with no seam: the host rendered a control it cannot perform. '
            + 'Gate the affordance on `forEntity(...) != null`, which returns undefined precisely so this cannot happen.',
        );
      }
      const expectedVersion = versionOf?.(entityId);
      if (expectedVersion === undefined) {
        /* NOT a silent return. A host that wired the dispatcher but cannot
           answer "what version is on screen" has a real gap, and swallowing it
           would send nothing while the button looked live. */
        onError?.(ref, entityId, new Error(
          'no expectedVersion for this container: the host must supply `versionOf` before a lifecycle verb can commit.',
        ));
        return;
      }
      const ctx = { clientMutationId: `${ref}:${entityId}:${String(Date.now())}`, expectedVersion };
      const sent =
        ref === 'container-start' ? commands.containerLifecycle(entityId as EntityId, 'start', ctx)
        : ref === 'container-stop' ? commands.containerLifecycle(entityId as EntityId, 'stop', ctx)
        : ref === 'container-destroy' ? commands.destroyContainer(entityId as EntityId, ctx)
        : null;
      if (sent) {
        void sent
          .then((result) => reconcileCommand?.(result))
          .catch((error: unknown) => onError?.(ref, entityId, error));
        return;
      }
      /*
       * TERMINAL IS THE ODD ONE and answers ids rather than patches, so there
       * is nothing to reconcile: it MINTS a work_session inside the container
       * and the host opens it. `containers.terminal.start` takes no
       * `expectedVersion` (freeze part 4/4), so the guard above is spent for
       * nothing here — kept anyway, because the alternative is a second code
       * path whose only difference is that it skips a check.
       */
      void commands
        .startContainerTerminal(entityId as EntityId, {
          clientMutationId: `${ref}:${entityId}:${String(Date.now())}`,
        })
        .then((result) => onOpenEntity?.(result.workSessionId))
        .catch((error: unknown) => onError?.(ref, entityId, error));
    },
    [commands, reconcileCommand, onError, versionOf, onOpenEntity],
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
          case 'resume':
            resume(entityId);
            return;
          case 'container-start':
          case 'container-stop':
          case 'container-destroy':
          case 'container-terminal':
            containerCommand(ref, entityId);
            return;
          default:
            return;
        }
      };
    },
    [commands, terminate, resume, containerCommand],
  );

  return useMemo(
    () => ({ forEntity, wiredActions: PANEL_PRIMARY_ACTIONS, terminate, resume, resumingId }),
    [forEntity, terminate, resume, resumingId],
  );
}

/**
 * TWO DISPATCHERS, ONE ACTION BAR.
 *
 * `usePanelPrimaries` performs `terminate`; `useEntityVerbs` performs `edit`
 * and `add-child`. They were written in separate lanes and each hands the panel
 * its own `onAction`/`wiredActions` pair, so a host that wants both cannot pass
 * either one alone — the other lane's verbs would drop back to
 * disabled-with-reason, which is the very defect both lanes set out to fix.
 *
 * Routing is by `wiredActions`, which each hook already derives from its own
 * handler set. A verb no part claims stays unclaimed and the bar keeps drawing
 * it refused; a verb two parts claim goes to the first, so the order here is
 * the precedence and there is no silent merge of two behaviours.
 */
export function composePanelActions(
  parts: readonly { onAction?: ((ref: ActionRef) => void) | undefined; wiredActions: readonly ActionRef[] }[],
): { onAction: (ref: ActionRef) => void; wiredActions: readonly ActionRef[] } {
  const live = parts.filter((part) => part.onAction);
  return {
    onAction: (ref) => {
      live.find((part) => part.wiredActions.includes(ref))?.onAction?.(ref);
    },
    wiredActions: live.flatMap((part) => [...part.wiredActions]),
  };
}
