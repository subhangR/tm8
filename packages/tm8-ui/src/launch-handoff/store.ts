/**
 * THE LAUNCH HAND-OFF'S STATE (task 01a182d2) — one record per pressed Launch,
 * keyed by the spawn's `clientMutationId`, and the ONE function that moves it.
 *
 * CONTRACT
 *   writes  `beginLaunch` (a press), `adoptLaunch` (a page re-attaching after a
 *           reload or in another window), `transition(id, event)` (everything
 *           after), `dropLaunch` (Dismiss, a retry taking the record's place,
 *           or the session going live: `retireLaunch`).
 *   reads   `launchRecord`, `launchForSession`, and their `useLaunch*` hooks.
 *   callers `views/useLaunchHandoff.ts` writes; the session's work view
 *           retires a record once its session is live (`retireLaunch`); the
 *           launching page and the session view read.
 *   invariants
 *     - `id` is the launch's clientMutationId and never changes;
 *     - `sessionId` is non-null exactly in `admitted`, `failure` exactly in
 *       `failed`; `input` is dropped at admission (nothing replays an admitted
 *       launch, and prompt bodies need not outlive their send);
 *     - an event the current state does not take is REFUSED: it returns null
 *       and changes nothing, so a late answer can never resurrect a launch the
 *       viewer dismissed or re-label one that already settled;
 *     - `bySession` indexes every admitted record by its session id.
 *
 * THE MACHINE (`state`)
 *
 *     press ──► starting ──admit──► admitted     terminal: from here the
 *                 │  │  │                         session's own status (and
 *                 │  │  └──fail──► failed         boot phase) tells the page
 *            check│  │reconnect     ▲   │         what happens next
 *                 ▼  ▼              │   └─ a press of the SAME id ──► starting
 *        checking  reconnecting ──fail
 *                 └──────┴──admit──► admitted
 *   failed ──choose (the person picks a found session)──► admitted
 *
 *   checking      THIS window's send timed out; it is asking whether it started
 *   reconnecting  a page re-attached after a reload / in another window is
 *                 replaying the stored input — no timeout happened here
 *
 * `page` is ORTHOGONAL to `state` — where the launching page lives: queued
 * behind Work's restore, in a Work tab (its id kept, so an answer reaching a
 * closed tab still lands through it), or nowhere. It moves by `land`, in any
 * state.
 *
 * WHY A STORE AND NOT COMPONENT STATE: Work renders only the ACTIVE tab, so the
 * page unmounts whenever the viewer looks elsewhere, while the spawn promise
 * outlives every mount. Page-lifetime only — what must survive a reload rides
 * the launch tab's draft values (`tab-workspace/runtime/launchTabs.ts`).
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import type { LaunchStarted } from '../new-session/launch-started';

export type LaunchState = 'starting' | 'checking' | 'reconnecting' | 'admitted' | 'failed';

export interface LaunchFailure {
  /** The node's own words. Never paraphrased: a paraphrase discards the remedy. */
  message: string;
  /** The error envelope's code when there was one (`upstream_unavailable`, …). */
  code: string | null;
  /**
   * The launch MAY have started after all — a timeout whose check could not
   * answer. The page then says "look before launching again" rather than
   * inviting a blind retry.
   */
  uncertain: boolean;
  /**
   * Sessions that started on the subject since the press, when the check could
   * not match one to this launch: the person picks (`choose`) — the page never
   * adopts one of them silently.
   */
  candidates?: readonly { id: EntityId; title: string }[];
}

/** Where the launching page lives, and in which (viewer, space) Work. */
export interface LaunchPage {
  at: 'queued' | 'tab' | 'none';
  viewerId: string;
  spaceId: string;
  /** The launch tab's id while `at` is `tab` — kept after a close, for the bind's closed-tab path. */
  tabId?: string;
}

export interface LaunchRecord {
  readonly id: string;
  readonly launch: LaunchStarted;
  /** The exact input sent, until admission; a replay sends it again unchanged. */
  readonly input: ExecutionSpawnInput | null;
  /** Epoch ms of the press — the page's elapsed timer counts from here. */
  readonly startedAt: number;
  readonly state: LaunchState;
  readonly sessionId: EntityId | null;
  /** Epoch ms of the node's answer. */
  readonly admittedAt: number | null;
  readonly failure: LaunchFailure | null;
  readonly page: LaunchPage | null;
}

export type LaunchEvent =
  /** The host's spawn ran: the input is on record (for the replay). */
  | { type: 'send'; input: ExecutionSpawnInput }
  /** This window's send timed out: ask whether it started. */
  | { type: 'check' }
  /** A re-attached page replays the stored input. */
  | { type: 'reconnect' }
  | { type: 'admit'; sessionId: EntityId; at: number }
  | { type: 'fail'; failure: LaunchFailure }
  /** The person picked, on a failed page, the session this launch started. */
  | { type: 'choose'; sessionId: EntityId; at: number }
  | { type: 'land'; page: LaunchPage };

const TAKES: Record<LaunchState, ReadonlySet<LaunchEvent['type']>> = {
  starting: new Set(['send', 'check', 'reconnect', 'admit', 'fail', 'land']),
  checking: new Set(['admit', 'fail', 'land']),
  reconnecting: new Set(['admit', 'fail', 'land']),
  admitted: new Set(['land']),
  failed: new Set(['choose', 'land']),
};

function next(record: LaunchRecord, event: LaunchEvent): LaunchRecord {
  switch (event.type) {
    case 'send':
      return { ...record, input: event.input };
    case 'check':
      return { ...record, state: 'checking' };
    case 'reconnect':
      return { ...record, state: 'reconnecting' };
    case 'admit':
    case 'choose':
      return { ...record, state: 'admitted', sessionId: event.sessionId, admittedAt: event.at, failure: null, input: null };
    case 'fail':
      return { ...record, state: 'failed', failure: event.failure };
    case 'land':
      return { ...record, page: event.page };
  }
}

interface LaunchesState {
  records: Readonly<Record<string, LaunchRecord>>;
  /** session id → record id, for every admitted record. */
  bySession: Readonly<Record<string, string>>;
}

export const launchesStore: StoreApi<LaunchesState> = createStore<LaunchesState>()(() => ({ records: {}, bySession: {} }));

function put(record: LaunchRecord): LaunchRecord {
  launchesStore.setState((s) => ({
    records: { ...s.records, [record.id]: record },
    bySession: record.sessionId ? { ...s.bySession, [record.sessionId]: record.id } : s.bySession,
  }));
  return record;
}

/**
 * Move a launch. Returns the new record, or null when there is no such launch
 * or its state does not take the event (see the machine above).
 */
export function transition(id: string, event: LaunchEvent): LaunchRecord | null {
  const current = launchesStore.getState().records[id];
  if (!current || !TAKES[current.state].has(event.type)) return null;
  return put(next(current, event));
}

/**
 * A launch as it stands the moment it is pressed — `starting`, nothing sent
 * back. Pure: the record a page draws while the store does not hold one yet.
 */
export function startingRecord(
  launch: LaunchStarted,
  input: ExecutionSpawnInput | null,
  startedAt: number,
  page: LaunchPage | null,
): LaunchRecord {
  return {
    id: launch.clientMutationId,
    launch,
    input,
    startedAt,
    state: 'starting',
    sessionId: null,
    admittedAt: null,
    failure: null,
    page,
  };
}

/**
 * A press. A press of an id still in flight IS that launch (returned as it
 * is); a press of a failed id starts it over (the ledger key is the launch's
 * identity, not the press); a press of an ADMITTED id is refused — null — for
 * there is no launch left to start: the caller lands its session instead.
 */
export function beginLaunch(launch: LaunchStarted, now: number = Date.now()): LaunchRecord | null {
  const current = launchesStore.getState().records[launch.clientMutationId];
  if (current?.state === 'admitted') return null;
  if (current && current.state !== 'failed') return current;
  /* A restart keeps where its page is and nothing else: the new press sends
     its own input. */
  return put(startingRecord(launch, null, now, current?.page ?? null));
}

/**
 * A page re-attaching to a launch this window has no record of — a reload, or
 * another window of the same viewer — from what its tab stored. The press time
 * is the stored one, so the timer does not restart at zero.
 */
export function adoptLaunch(
  launch: LaunchStarted,
  input: ExecutionSpawnInput | null,
  startedAt: number,
  page: LaunchPage,
): LaunchRecord {
  const current = launchesStore.getState().records[launch.clientMutationId];
  return current ?? put(startingRecord(launch, input, startedAt, page));
}

export function dropLaunch(id: string): void {
  const current = launchesStore.getState().records[id];
  if (!current) return;
  launchesStore.setState((s) => {
    const { [id]: _gone, ...records } = s.records;
    if (!current.sessionId) return { records };
    const { [current.sessionId]: _unindexed, ...bySession } = s.bySession;
    return { records, bySession };
  });
}

/**
 * The session is live: nothing about its launch is needed any more — the page
 * has given way to the session's own surfaces. Called by the session's work
 * view; a no-op for anything but an admitted record.
 */
export function retireLaunch(id: string): void {
  if (launchesStore.getState().records[id]?.state === 'admitted') dropLaunch(id);
}

export function launchRecord(id: string): LaunchRecord | null {
  return launchesStore.getState().records[id] ?? null;
}

function sessionRecord(s: LaunchesState, sessionId: string): LaunchRecord | null {
  const id = s.bySession[sessionId];
  return id ? s.records[id] ?? null : null;
}

/** The launch that produced `sessionId`, when this window watched it. */
export function launchForSession(sessionId: string): LaunchRecord | null {
  return sessionRecord(launchesStore.getState(), sessionId);
}

export function useLaunchRecord(id: string | null | undefined): LaunchRecord | null {
  return useStore(launchesStore, (s) => (id ? s.records[id] ?? null : null));
}

export function useLaunchForSession(sessionId: string | null | undefined): LaunchRecord | null {
  return useStore(launchesStore, (s) => (sessionId ? sessionRecord(s, sessionId) : null));
}

/** Test seam: forget every record. */
export function resetLaunches(): void {
  launchesStore.setState({ records: {}, bySession: {} });
}
