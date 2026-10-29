/**
 * THE LAUNCH HAND-OFF (task 01a182d2) — the host half of the launch popup's
 * `onLaunchStarted` seam: ONE implementation, composed into every launching
 * surface by `useLaunchPort`.
 *
 * WHAT IT REPLACES. Every host awaited the whole spawn and only then navigated
 * (`await data.spawn(input); navigateTo(…); push(sessionId)`), so the popup sat
 * disabled for the 3–8 s the node took and the session appeared afterwards.
 * Now the press lands AT ONCE on a launching page in a Work tab, and the node's
 * answer turns that tab into the session's, in place.
 *
 * CONTRACT
 *   in    the popup's two calls, in this order: `onLaunchStarted(launch)` on
 *         the press, then `spawn(input, fallback)` with the input it sends;
 *         the launching page's `dismiss` and `resume`; Work's drain
 *         (`landQueuedLaunches`) for launches pressed outside it.
 *   out   transitions of the launch record (`launch-handoff/store`) and moves
 *         of the Work launch tab (`tab-workspace/runtime/launchTabs`).
 *   who   `useLaunchPort` (every host), the launch tab's page, TabWorkspaceView.
 *   invariants
 *     - ONE navigation per launch: the launch tab's own push inside Work, or
 *       one push INTO Work when the press happened elsewhere. The swap to the
 *       session is a system bind, which writes no history entry, so Back
 *       returns to where Launch was pressed.
 *     - ONE clientMutationId per launch: the timeout check REPLAYS the same
 *       input — the node answers a replayed id with the session it already
 *       started and boots nothing — and `sessionsSince` is asked only when the
 *       replay cannot answer either; what it finds is OFFERED, never adopted.
 *       The replay is safe only on a node that joins a replay to the attempt
 *       in flight (lane C, #1404: single-flight on the mutation id from
 *       request entry), which is why this ships after it.
 *     - A launch the popup did not hand over (no record: a host without the
 *       seam, the phone, the legacy desktop) runs the host's own spawn verb
 *       exactly as before, awaited, its errors rethrown into the card.
 */
import { useMemo } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import type { LaunchStarted } from '../new-session/launch-started';
import { isLaunchTimeout, LAUNCH_TIMEOUT_WORDS, launchFailureOf } from '../launch-handoff/failure';
import {
  adoptLaunch,
  beginLaunch,
  dropLaunch,
  launchRecord,
  transition,
  type LaunchFailure,
  type LaunchPage,
  type LaunchRecord,
} from '../launch-handoff/store';
import { getWorkspaceRuntime, type WorkspaceRuntime } from '../tab-workspace/runtime/dispatch';
import { kindInScope } from '../tab-workspace/runtime/selectors';
import { workspaceTabView } from '../tab-workspace/runtime/url';
import {
  bindLaunchTab,
  closeLaunchTab,
  drainLaunchTabs,
  findLaunchTab,
  LAUNCH_TAB_KIND,
  openLaunchTab,
  queueLaunchTab,
  rewriteLaunchTab,
  storeLaunchFacts,
  type LaunchTabValues,
} from '../tab-workspace/runtime/launchTabs';
import { navStore } from '../stores/navStore';

// ---------------------------------------------------------------------------
// Where a launch can land
// ---------------------------------------------------------------------------

/**
 * `work` while the desktop runs Work (the three-mode shell, D31) — the only
 * arrangement with a tab to land in. GateApp sets it from the same `threeModes`
 * that decides whether Work exists; the phone and the legacy desktop leave it
 * null, and their popups keep the in-card state (`onLaunchStarted` → false).
 *
 * A module value rather than a prop because the hosts that read it sit five
 * screens deep under GateApp, and the answer is the same for all of them. It is
 * read at PRESS time, never at render.
 */
let landing: 'work' | null = null;

export function setLaunchLanding(next: 'work' | null): void {
  landing = next;
}

export function launchLanding(): 'work' | null {
  return landing;
}

// ---------------------------------------------------------------------------
// The hand-off
// ---------------------------------------------------------------------------

/**
 * How long a page that finds a launch it did not start waits before replaying
 * it. Another window that is still sending the original will usually have
 * bound the tab by then, so the replay — harmless, but a second request to a
 * node mid-boot — is usually never sent.
 */
export const RESUME_GRACE_MS = 10_000;

export interface LaunchHandoff {
  /**
   * The popup's seam. True ⇒ the launching page is open and this host owns
   * everything after; false ⇒ the popup keeps its in-card state. `replaces`
   * is the launching page's own retry: the new launch takes over the failed
   * one's tab instead of opening another.
   */
  onLaunchStarted(launch: LaunchStarted, replaces?: string): boolean;
  /**
   * The host's spawn verb, composed. A launch this hand-off took over is
   * tracked on its page and the promise never rejects — the popup is gone and
   * the page shows the outcome. Any other launch runs `fallback` (else a bare
   * spawn) exactly as before.
   */
  spawn(input: ExecutionSpawnInput, fallback?: (input: ExecutionSpawnInput) => void | Promise<void>): Promise<void>;
  /** Dismiss: forget the launch and close its page's tab. A session that started keeps running. */
  dismiss(launchId: string): void;
  /** The person picked, on a failed page, the found session this launch started. */
  choose(launchId: string, sessionId: EntityId): void;
  /**
   * Re-attach to a launch this window has no record of — a reload, or another
   * window of the viewer — from what its tab stored. A stored failure is drawn
   * as it is; otherwise the SAME input is replayed once, after the grace, if
   * the tab still holds the launch then. Owned here, not by the page: a page
   * remounts, a scheduled replay must not care.
   */
  resume(values: LaunchTabValues): void;
}

/** Where Work stands right now: on screen, being mounted onto, or elsewhere. */
export type WorkPresence = 'mounted' | 'mounting' | 'elsewhere';

export interface LaunchHandoffDeps {
  viewerId: string | null | undefined;
  spaceId: string | null | undefined;
  /** `GateData.spawn`: resolves the new session's id. */
  spawnSession(input: ExecutionSpawnInput): Promise<EntityId>;
  /** Sessions working on the subject since `since` — the timeout check's fallback. */
  sessionsSince?: (subjectId: string, since: string) => Promise<readonly { id: string; title: string }[]>;
  /* Seams for tests; the real ones by default. */
  runtimeFor?: (viewerId: string, spaceId: string) => WorkspaceRuntime;
  workPresence?: (runtime: WorkspaceRuntime) => WorkPresence;
  /** Push the ONE navigation into Work. */
  navigateToWork?: () => void;
  landing?: () => 'work' | null;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
}

/**
 * Decided on the NAV VIEW: Work's route already showing means no push, whether
 * or not its view has finished mounting — a second push would leave Back on
 * bare Work.
 */
const defaultWorkPresence = (runtime: WorkspaceRuntime): WorkPresence =>
  navStore.getState().view.view !== 'tabs' ? 'elsewhere' : runtime.hooks.viewMounted() ? 'mounted' : 'mounting';
const defaultNavigateToWork = () => navStore.getState().navigate(workspaceTabView(null));
const defaultSchedule = (run: () => void, ms: number) => void setTimeout(run, ms);

function valuesOf(record: LaunchRecord): LaunchTabValues {
  return { launchId: record.id, launch: record.launch, input: record.input, startedAt: record.startedAt, failure: record.failure };
}

/** Open the session's own tab — the landing when no launch tab holds the page. */
function openSessionTab(runtime: WorkspaceRuntime, sessionId: string): void {
  runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: LAUNCH_TAB_KIND, entityId: sessionId }, source: 'system' });
}

/** Close the session's tab — Dismiss on a boot that failed after the swap. */
function closeSessionTab(runtime: WorkspaceRuntime, sessionId: string): void {
  const state = runtime.store.getState();
  const tabId = state.orderedTabIds.find((id) => {
    const tab = state.tabs[id];
    return tab?.type === 'entity' && tab.entityId === sessionId;
  });
  if (tabId) runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId }, source: 'click' });
}

export function createLaunchHandoff(deps: LaunchHandoffDeps): LaunchHandoff {
  const runtimeFor = deps.runtimeFor ?? getWorkspaceRuntime;
  const workPresence = deps.workPresence ?? defaultWorkPresence;
  const navigateToWork = deps.navigateToWork ?? defaultNavigateToWork;
  const landingNow = deps.landing ?? launchLanding;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;

  const runtimeOfPage = (page: LaunchPage | null) => (page ? runtimeFor(page.viewerId, page.spaceId) : null);

  /** The session is known: the page becomes it, wherever the page is. */
  const land = (record: LaunchRecord | null, sessionId: EntityId) => {
    const runtime = runtimeOfPage(record?.page ?? null);
    if (!record?.page || !runtime) return; // Dismissed while the node was answering.
    if (record.page.at === 'tab') bindLaunchTab(runtime, record.id, sessionId, record.launch.title);
    else if (record.page.at === 'none') openSessionTab(runtime, sessionId);
    /* `queued`: Work's drain opens it as the session's tab. A launch tab the
       viewer closed meanwhile stays closed — the session runs on regardless. */
  };
  const admit = (launchId: string, sessionId: EntityId) =>
    land(transition(launchId, { type: 'admit', sessionId, at: now() }), sessionId);

  /** The failure, on the record and on the tab — a reload draws it, never replays it. */
  const fail = (launchId: string, failure: LaunchFailure) => {
    const record = transition(launchId, { type: 'fail', failure });
    const runtime = runtimeOfPage(record?.page ?? null);
    if (record && runtime) storeLaunchFacts(runtime, launchId, { failure });
  };

  /** "Did it start?" — the replay first; the subject's sessions, offered, second. */
  const check = async (launchId: string, input: ExecutionSpawnInput) => {
    if (!transition(launchId, { type: 'check' })) return;
    try {
      admit(launchId, await deps.spawnSession(input));
      return;
    } catch (again) {
      if (!isLaunchTimeout(again)) {
        fail(launchId, launchFailureOf(again));
        return;
      }
    }
    const record = launchRecord(launchId);
    if (!record) return;
    if (!deps.sessionsSince) {
      fail(launchId, { message: LAUNCH_TIMEOUT_WORDS.cannotCheck, code: 'upstream_unavailable', uncertain: true });
      return;
    }
    try {
      const found = await deps.sessionsSince(record.launch.subjectId, new Date(record.startedAt).toISOString());
      fail(launchId, found.length > 0
        ? {
          message: LAUNCH_TIMEOUT_WORDS.foundSince,
          code: 'upstream_unavailable',
          uncertain: true,
          candidates: found.map((s) => ({ id: s.id as EntityId, title: s.title })),
        }
        : { message: LAUNCH_TIMEOUT_WORDS.none, code: 'upstream_unavailable', uncertain: false });
    } catch {
      fail(launchId, { message: LAUNCH_TIMEOUT_WORDS.checkFailed, code: 'upstream_unavailable', uncertain: true });
    }
  };

  const send = async (launchId: string, input: ExecutionSpawnInput) => {
    try {
      admit(launchId, await deps.spawnSession(input));
    } catch (error) {
      if (isLaunchTimeout(error)) await check(launchId, input);
      else fail(launchId, launchFailureOf(error));
    }
  };

  const onLaunchStarted = (launch: LaunchStarted, replaces?: string): boolean => {
    const { viewerId, spaceId } = deps;
    if (landingNow() !== 'work' || !viewerId || !spaceId) return false;
    const runtime = runtimeFor(viewerId, spaceId);
    const tabPage: LaunchPage = { at: 'tab', viewerId, spaceId };

    /* A RETRY FROM THE PAGE takes the failed launch's tab over, in place. */
    if (replaces && replaces !== launch.clientMutationId && findLaunchTab(runtime, replaces)) {
      const record = beginLaunch(launch, now());
      const tabId = rewriteLaunchTab(runtime, replaces, valuesOf(record));
      dropLaunch(replaces);
      if (tabId) {
        transition(record.id, { type: 'land', page: tabPage });
        runtime.dispatch({ command: 'workspace.tabs.activate', args: { tabId }, source: 'click' });
        return true;
      }
      dropLaunch(record.id);
      return false;
    }

    const presence = workPresence(runtime);
    if (presence === 'mounted') {
      /* A tab scope without sessions would answer the open with the reveal
         prompt, whose replay opens a BLANK New session draft; that launch
         keeps the popup's in-card state instead. */
      if (!kindInScope(runtime.store.getState().scope, LAUNCH_TAB_KIND)) return false;
      const record = beginLaunch(launch, now());
      if (!openLaunchTab(runtime, valuesOf(record), 'click')) {
        dropLaunch(record.id);
        return false;
      }
      transition(record.id, { type: 'land', page: tabPage });
      return true;
    }

    /* Work not on screen (or still mounting): the tab waits behind Work's
       restore, and the ONE navigation is a push into Work — unless Work's
       route is already the one showing. */
    const record = beginLaunch(launch, now());
    queueLaunchTab(viewerId, spaceId, valuesOf(record));
    transition(record.id, { type: 'land', page: { at: 'queued', viewerId, spaceId } });
    if (presence === 'elsewhere') navigateToWork();
    return true;
  };

  const spawn = async (
    input: ExecutionSpawnInput,
    fallback?: (input: ExecutionSpawnInput) => void | Promise<void>,
  ): Promise<void> => {
    const record = launchRecord(input.clientMutationId);
    if (!record?.page) {
      if (fallback) await fallback(input);
      else await deps.spawnSession(input);
      return;
    }
    /* Only the first send of a launch goes out; anything after it is the
       same launch, already on its way (or settled). */
    if (record.input !== null || record.state !== 'starting') return;
    transition(record.id, { type: 'send', input });
    const runtime = runtimeOfPage(record.page);
    if (runtime && record.page.at === 'tab') storeLaunchFacts(runtime, record.id, { input });
    await send(record.id, input);
  };

  const dismiss = (launchId: string) => {
    const record = launchRecord(launchId);
    const runtime = runtimeOfPage(record?.page ?? null);
    if (record && runtime) {
      if (findLaunchTab(runtime, launchId)) closeLaunchTab(runtime, launchId);
      else if (record.sessionId) closeSessionTab(runtime, record.sessionId);
    }
    dropLaunch(launchId);
  };

  const choose = (launchId: string, sessionId: EntityId) =>
    land(transition(launchId, { type: 'choose', sessionId, at: now() }), sessionId);

  const resume = (values: LaunchTabValues): void => {
    const { viewerId, spaceId } = deps;
    if (!viewerId || !spaceId || launchRecord(values.launchId)) return;
    adoptLaunch(values.launch, values.input, values.startedAt, { at: 'tab', viewerId, spaceId });
    if (values.failure) {
      transition(values.launchId, { type: 'fail', failure: values.failure });
      return;
    }
    const input = values.input;
    if (!input) {
      /* Pressed, but the page went away before the input was sent: there is
         nothing to replay, and composing one now would be a second launch. */
      fail(values.launchId, {
        message: 'This launch was interrupted before it reached the node, so nothing started. Edit and retry to launch it.',
        code: null,
        uncertain: false,
      });
      return;
    }
    const runtime = runtimeFor(viewerId, spaceId);
    schedule(() => {
      /* Still this window's to settle? Another window may have bound or
         dismissed the tab meanwhile, or this one dropped the launch. */
      const record = launchRecord(values.launchId);
      if (!record || record.state !== 'starting' || !findLaunchTab(runtime, values.launchId)) return;
      void check(values.launchId, input);
    }, Math.max(0, values.startedAt + RESUME_GRACE_MS - now()));
  };

  return { onLaunchStarted, spawn, dismiss, choose, resume };
}

/**
 * Work's drain of launches pressed elsewhere, called by the mounted Work view
 * right after its restore. One the node already admitted opens as its
 * SESSION's tab; one still starting (or failed) opens its launching page.
 */
export function landQueuedLaunches(runtime: WorkspaceRuntime): void {
  drainLaunchTabs(runtime, (values) => {
    const record = launchRecord(values.launchId);
    if (!record) return; // Dismissed while Work was mounting.
    const page = (at: LaunchPage['at']): LaunchPage => ({ at, viewerId: runtime.viewerId, spaceId: runtime.spaceId });
    if (record.state === 'admitted' && record.sessionId) {
      transition(record.id, { type: 'land', page: page('none') });
      openSessionTab(runtime, record.sessionId);
      return;
    }
    const tabId = kindInScope(runtime.store.getState().scope, LAUNCH_TAB_KIND)
      ? openLaunchTab(runtime, valuesOf(record), 'system')
      : null;
    transition(record.id, { type: 'land', page: page(tabId ? 'tab' : 'none') });
  });
}

/** The hand-off for a host, memoised on what it closes over. */
export function useLaunchHandoff(deps: LaunchHandoffDeps): LaunchHandoff {
  const { viewerId, spaceId, spawnSession, sessionsSince } = deps;
  return useMemo(
    () => createLaunchHandoff({ viewerId, spaceId, spawnSession, ...(sessionsSince ? { sessionsSince } : {}) }),
    [viewerId, spaceId, spawnSession, sessionsSince],
  );
}
