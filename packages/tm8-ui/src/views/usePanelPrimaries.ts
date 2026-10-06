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
import { createElement, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { CommandResult, EntityId, EntityState, MessageBatchResult } from '@tm8/contract';
import {
  claimsFromEdges,
  isSessionState,
  sessionOutcomeOf,
  type ActionRef,
  type GroupBulk,
} from '../domain';
import type { SessionSharingPatch } from '../panels/controls/EntityControls';
import {
  SessionCompleteDialog,
  SessionReopenDialog,
  SessionTerminateDialog,
  type SessionOutcomeFacts,
} from '../panels/session/SessionOutcomeDialogs';
import type { Seam } from '../data/seam';

/**
 * Exactly what this dispatcher performs. Exported as a CONSTANT so a host
 * cannot hand the panel a list that has drifted from the switch below — the
 * enabled-inert failure mode, reintroduced one careless edit at a time.
 */
export const PANEL_PRIMARY_ACTIONS: readonly ActionRef[] = [
  'terminate',
  'resume',
  // Spec D1 §5: the outcome verbs that need no dialog. `complete-session` is
  // added per host, only where the host renders `dialog` (see `stateOf`).
  'close-process',
  'dismiss-session',
  'mark-lost',
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
  /**
   * SPEC D1 §5.4 / §5.5 — THE OPT-IN TO THE OUTCOME DIALOGS. A host that
   * passes this RENDERS `primaries.dialog`, and in return Terminate on an OPEN
   * session opens "This session hasn't completed" instead of firing, and
   * `complete-session` opens the Complete dialog. Answer from what the host
   * already holds (`detailOf(id)?.state`); `undefined` means "read it"
   * (`seam.entity`). A host without it keeps the old one-click terminate, which
   * the node treats as Stop on an open session.
   */
  stateOf?: (entityId: string) => EntityState | undefined;
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
  /**
   * THE TWO SHARING DIALS (187), unwrapped for the row cluster's sharing slot.
   * `patch` names only the dial the user clicked — see `SessionSharingPatch`.
   *
   * NOT in `PANEL_PRIMARY_ACTIONS` and not reachable through `forEntity`,
   * deliberately: that constant's whole contract is "exactly what the switch
   * below performs", and this verb is declared on `list.rowActions`, not on
   * `panel.primaries`. Listing it there would claim a dispatch path that does
   * not exist — the enabled-inert shape the constant exists to prevent.
   */
  shareSession: (entityId: string, patch: SessionSharingPatch) => void;
  /**
   * Spec D1 §5.5 — open the Complete dialog for a session (the row tick, the
   * panel's Complete). Unwrapped for the same reason `terminate` is.
   */
  completeSession: (entityId: string) => void;
  /** The session outcome verbs, by ref — the list's `onSessionVerb`. */
  sessionVerb: (ref: ActionRef, entityId: string) => void;
  /** §5.3 group bulk verbs — Complete all, Resume all, Stop all finished. */
  sessionBulk: (bulk: GroupBulk, entityIds: readonly string[]) => void;
  /**
   * The open outcome dialog, or null. A host that passed `stateOf` MUST render
   * this, or the dialogs open nowhere.
   */
  dialog: ReactNode;
}

/** The dialog the hook is showing, if any. */
type OutcomeDialog =
  | { kind: 'terminate'; sessionId: string }
  | { kind: 'complete'; sessionId: string; closeForced: boolean }
  /* Q2 = B: reopening a completed session is a confirmed, logged resume. */
  | { kind: 'reopen'; sessionId: string };

/** The new message's id from a post's answer — either shape the seam returns. */
function postedMessageId(result: CommandResult | MessageBatchResult): string | undefined {
  if ('messages' in result) return result.messages[0]?.id;
  return result.entity?.id ?? result.patches[0]?.id;
}

export function usePanelPrimaries(host: PanelPrimariesHost): PanelPrimaries {
  const { seam, reconcileCommand, onError, versionOf, onOpenEntity, stateOf } = host;
  const commands = seam?.commands;
  /* The two reads the dialogs make. Optional on the port: the narrow hosts
     (GraphScreen) and the unit tests hand only `commands`. */
  const reads = seam as Partial<Pick<Seam, 'entity' | 'messages'>> | undefined;
  const dialogsOn = stateOf !== undefined;
  const [dialog, setDialog] = useState<OutcomeDialog | null>(null);

  /**
   * TERMINATE — ONE EXECUTOR FOR THE ROW AND THE PANEL, and since Spec D1 §5.4
   * it ASKS on an open session. The 2026-08-07 ruling (fire on click, no
   * confirm) is REPLACED for open sessions: terminating unfinished work has to
   * say which ending is meant — Mark complete & close, or Stop without
   * completing — rather than letting the node default it to Stop. On a completed or stopped session it still fires
   * on click: it only closes the process (§5.4, "Close process, no dialog").
   * The row and the panel still share this function, so they cannot differ.
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
      const send = () =>
        void commands
          .terminate(entityId as EntityId, {
            clientMutationId: `terminate:${entityId}:${Date.now()}`,
          })
          .then((result) => reconcileCommand?.(result))
          .catch((error: unknown) => onError?.('terminate', entityId, error));
      /* SPEC D1 §5.4: an OPEN session asks which ending is meant. A completed
         or stopped one only closes its process — no dialog, no outcome. */
      const decide = (state: EntityState | undefined) => {
        if (dialogsOn && state !== undefined && isSessionState(state) && sessionOutcomeOf(state) === 'open') {
          setDialog({ kind: 'terminate', sessionId: entityId });
          return;
        }
        send();
      };
      const known = stateOf?.(entityId);
      if (known === undefined && dialogsOn && reads?.entity) {
        void reads
          .entity(entityId as EntityId)
          .then((detail) => decide(detail.state))
          .catch((error: unknown) => onError?.('terminate', entityId, error));
        return;
      }
      decide(known);
    },
    [commands, reconcileCommand, onError, dialogsOn, stateOf, reads],
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
   * TURN THE WATCH DIAL — `execution.sessions.share` with `shareMode` alone.
   *
   * IT NAMES ONE DIAL AND ONLY ONE. The RPC merges on omission, so sending a
   * `driveMode` here would author a decision the user did not make: closing
   * watching would silently also close driving, and re-opening it would not
   * put driving back. The drive dial has no UI control (see the `ActionRef`
   * members), and this is the reason that absence is safe rather than
   * lossy — what the UI cannot set, it also cannot clobber.
   *
   * NO `expectedVersion`. The row cluster holds an `EntitySummary`-shaped
   * subject with no version on it, and the guard's whole value is that it
   * carries THE VERSION THE HUMAN SAW — a version re-read here would be a
   * different number wearing the guard's name. The RPC accepts null and this
   * dial is idempotent in both directions, so an unguarded double press
   * settles on the state the last click asked for rather than flipping back.
   *
   * COMMITS ON CLICK, like terminate. Both directions are reversible by the
   * same control, so neither is the irreversible direction.
   */
  const shareSession = useCallback(
    (entityId: string, patch: SessionSharingPatch) => {
      /* Same posture as terminate and resume above. */
      if (!commands) {
        throw new Error(
          'usePanelPrimaries.shareSession was called with no seam: the host rendered a control it cannot perform. '
            + 'Gate the affordance on `forEntity(...) != null`, which returns undefined precisely so this cannot happen.',
        );
      }
      void commands
        .shareSession(entityId as EntityId, {
          /* Spread, never defaulted: an absent dial must stay absent on the
             wire, or the RPC's coalesce is bypassed and it gets reset. */
          ...patch,
          clientMutationId: `share:${entityId}:${String(Date.now())}`,
        })
        .then((result) => reconcileCommand?.(result))
        .catch((error: unknown) =>
          onError?.(patch.shareMode === 'none' ? 'unshare-session' : 'share-session', entityId, error),
        );
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

  /**
   * SPEC D1 — the outcome commands. Each reconciles like terminate and hands
   * a refusal to `onError` verbatim under its own verb.
   */
  const terminateWith = useCallback(
    (ref: ActionRef, entityId: string, input: Omit<Parameters<Pick<Seam, 'commands'>['commands']['terminate']>[1], 'clientMutationId'>) => {
      if (!commands) return Promise.reject(new Error('no seam'));
      return commands
        .terminate(entityId as EntityId, { ...input, clientMutationId: `${ref}:${entityId}:${Date.now()}` })
        .then((result) => { reconcileCommand?.(result); return result; });
    },
    [commands, reconcileCommand],
  );

  const completeSession = useCallback(
    (entityId: string) => {
      if (!commands) {
        throw new Error(
          'usePanelPrimaries.completeSession was called with no seam: the host rendered a control it cannot perform.',
        );
      }
      setDialog({ kind: 'complete', sessionId: entityId, closeForced: false });
    },
    [commands],
  );

  const sessionVerb = useCallback(
    (ref: ActionRef, entityId: string) => {
      const fail = (error: unknown) => onError?.(ref, entityId, error);
      switch (ref) {
        case 'complete-session':
          completeSession(entityId);
          return;
        case 'terminate':
          terminate(entityId);
          return;
        case 'resume':
          resume(entityId);
          return;
        case 'reopen-session':
          setDialog({ kind: 'reopen', sessionId: entityId });
          return;
        // §5.2: Stop on a ✓ row closes the process only — no outcome, no dialog.
        case 'close-process':
          void terminateWith(ref, entityId, {}).catch(fail);
          return;
        // §5.3 Interrupted "Dismiss": outcome → stopped; the row moves to Stopped.
        case 'dismiss-session':
          void terminateWith(ref, entityId, { outcome: 'stop', note: 'Dismissed from Interrupted.' }).catch(fail);
          return;
        // §5.6 Stale "Mark lost": the reaper, now (a process fact only).
        case 'mark-lost':
          void terminateWith(ref, entityId, { markLost: true }).catch(fail);
          return;
        default:
          return;
      }
    },
    [completeSession, terminate, resume, terminateWith, onError],
  );

  /**
   * §5.3.1 cases 3, 4 and the Running divider: one command per row, each
   * reconciled and reported on its own so one refusal does not hide the rest.
   * "Complete all" uses each session's latest close-out message as its receipt
   * (the server's default), which is what "Finished, not closed out" means.
   */
  const sessionBulk = useCallback(
    (bulk: GroupBulk, entityIds: readonly string[]) => {
      if (!commands) return;
      for (const id of entityIds) {
        if (bulk === 'complete-all') {
          void commands
            .completeSession(id as EntityId, { clientMutationId: `complete-session:${id}:${Date.now()}` })
            .then((result) => reconcileCommand?.(result))
            .catch((error: unknown) => onError?.('complete-session', id, error));
        } else if (bulk === 'resume-all' || bulk === 'reconnect-resume-all') {
          resume(id);
        } else if (bulk === 'stop-all-finished') {
          void terminateWith('close-process', id, {}).catch((error: unknown) => onError?.('close-process', id, error));
        }
      }
    },
    [commands, reconcileCommand, onError, resume, terminateWith],
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
          case 'complete-session':
          case 'reopen-session':
          case 'close-process':
          case 'dismiss-session':
          case 'mark-lost':
            sessionVerb(ref, entityId);
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
    [commands, terminate, resume, containerCommand, sessionVerb],
  );

  /** The facts both dialogs read once on open: title, claims, latest message. */
  const loadFacts = useCallback(
    async (sessionId: string): Promise<SessionOutcomeFacts> => {
      const detail = reads?.entity ? await reads.entity(sessionId as EntityId) : undefined;
      const edges = detail ? [...detail.connections.outgoing, ...detail.connections.incoming].flatMap((g) => g.edges) : [];
      const page = reads?.messages ? await reads.messages(sessionId as EntityId).catch(() => undefined) : undefined;
      const latest = [...(page?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return {
        title: detail?.title ?? '',
        claims: claimsFromEdges(sessionId, edges),
        latestMessage: latest
          ? { id: latest.id, body: latest.content.body, author: latest.state.author?.displayName ?? null, createdAt: latest.createdAt }
          : null,
      };
    },
    [reads],
  );

  const close = useCallback(() => setDialog(null), []);
  const dialogNode = useMemo<ReactNode>(() => {
    if (!dialog || !commands) return null;
    const id = dialog.sessionId;
    if (dialog.kind === 'reopen') {
      return createElement(SessionReopenDialog, {
        key: `reopen:${id}`,
        onCancel: close,
        onReopen: () =>
          commands
            .resume(id as EntityId, { clientMutationId: `resume:${id}:${Date.now()}` })
            .then((result) => { reconcileCommand?.(result); close(); }),
      });
    }
    if (dialog.kind === 'terminate') {
      return createElement(SessionTerminateDialog, {
        key: `terminate:${id}`,
        load: () => loadFacts(id),
        onCancel: close,
        onCompleteAndClose: () => setDialog({ kind: 'complete', sessionId: id, closeForced: true }),
        onStop: () => terminateWith('terminate', id, { outcome: 'stop' }).then(close),
      });
    }
    return createElement(SessionCompleteDialog, {
      key: `complete:${id}`,
      load: () => loadFacts(id),
      closeForced: dialog.closeForced,
      onCancel: close,
      ...(onOpenEntity ? { onOpenTask: (taskId: string) => { close(); onOpenEntity(taskId); } } : {}),
      onHandOff: (taskId: string, note: string) =>
        commands
          .releaseClaim(taskId as EntityId, { note, clientMutationId: `release:${taskId}:${Date.now()}` })
          .then((result) => reconcileCommand?.(result)),
      onComplete: async ({ receiptMessageId, receiptText, closeProcess }) => {
        let receipt = receiptMessageId;
        if (receiptText) {
          // Spec D1 §4.1: the operator's receipt is a message on the session's
          // anchor, posted first; its id is what `complete` records.
          const posted = await commands.postMessage({
            clientMutationId: `receipt:${id}:${Date.now()}`,
            anchorIds: [id as EntityId],
            body: receiptText,
          });
          receipt = postedMessageId(posted);
        }
        const result = await commands.completeSession(id as EntityId, {
          clientMutationId: `complete-session:${id}:${Date.now()}`,
          ...(receipt ? { receiptMessageId: receipt } : {}),
          closeProcess,
        });
        reconcileCommand?.(result);
        close();
      },
    });
  }, [dialog, commands, loadFacts, close, terminateWith, onOpenEntity, reconcileCommand]);

  const wiredActions = useMemo<readonly ActionRef[]>(
    () => (dialogsOn ? [...PANEL_PRIMARY_ACTIONS, 'complete-session', 'reopen-session'] : PANEL_PRIMARY_ACTIONS),
    [dialogsOn],
  );

  return useMemo(
    () => ({
      forEntity,
      wiredActions,
      terminate,
      resume,
      resumingId,
      shareSession,
      completeSession,
      sessionVerb,
      sessionBulk,
      dialog: dialogNode,
    }),
    [forEntity, wiredActions, terminate, resume, resumingId, shareSession, completeSession, sessionVerb, sessionBulk, dialogNode],
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
