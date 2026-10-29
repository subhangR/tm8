/**
 * LAUNCH TABS (task 01a182d2) — the Work tab a pressed Launch lands in before
 * the node has answered, and its in-place swap to the session.
 *
 * A LAUNCH TAB IS A `work_session` DRAFT TAB — the record ＋ New → Session
 * opens — whose stored values name the launch. That choice buys the swap
 * rather than building it: `drafts.bind` already turns a draft into its
 * entity's tab IN PLACE (same tab id, same position, no focus steal), and the
 * URL sync REPLACES the address for a system bind, so the session takes the
 * tab with no second navigation and no history entry. A new tab type would
 * have had to teach the node's reducer, its stored-workspace validation and
 * every window's sync about it.
 *
 * NEVER REUSED, NEVER REUSING. A launch tab is opened with `holds: 'launch'`,
 * a field of the tab record that persists and syncs (unlike `submitting`,
 * which every restore drops): `drafts.open` never hands it to ＋ New → Session
 * or to another launch, and a launch never takes over a blank New session
 * draft — it always opens its own.
 *
 * THE VALUES CARRY THE LAUNCH: its summary and its exact spawn input, so a
 * reload — or another window of the same viewer, which the node syncs the
 * draft to — draws the same page and can replay the SAME input. The node
 * answers a replayed `clientMutationId` with the session it already started.
 */
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import type { LaunchFailure } from '../../launch-handoff/store';
import type { LaunchStarted } from '../../new-session/launch-started';
import type { WorkspaceRuntime } from './dispatch';
import type { DraftTabRecord, Source } from './types';

export const LAUNCH_TAB_KIND = 'work_session';

/** A launch tab's stored draft values. */
export interface LaunchTabValues {
  /** The spawn's `clientMutationId` — the launch's identity on both sides. */
  launchId: string;
  launch: LaunchStarted;
  /** Absent until the host's spawn ran (the press and the send are one tick apart). */
  input: ExecutionSpawnInput | null;
  /** Epoch ms of the press. */
  startedAt: number;
  /**
   * The failure, once there is one — stored so a reload (or another window)
   * draws the failed page instead of replaying a launch the node refused.
   */
  failure: LaunchFailure | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a draft's values as a launch tab's, or null when they are not one —
 * a ＋ New → Session draft holds the screen's own fields instead. Shape-checked
 * because the values travel through storage and the node.
 */
export function launchTabValues(values: Record<string, unknown> | null | undefined): LaunchTabValues | null {
  if (!values || typeof values.launchId !== 'string' || values.launchId.length === 0) return null;
  const launch = values.launch;
  if (!isRecord(launch) || launch.clientMutationId !== values.launchId || typeof launch.title !== 'string') return null;
  if (typeof launch.subjectId !== 'string') return null;
  const startedAt = typeof values.startedAt === 'number' && Number.isFinite(values.startedAt) ? values.startedAt : Date.now();
  const input = isRecord(values.input) && values.input.clientMutationId === values.launchId
    ? (values.input as unknown as ExecutionSpawnInput)
    : null;
  const f = values.failure;
  const failure: LaunchFailure | null = isRecord(f) && typeof f.message === 'string'
    ? { message: f.message, code: typeof f.code === 'string' ? f.code : null, uncertain: f.uncertain === true }
    : null;
  return { launchId: values.launchId, launch: launch as unknown as LaunchStarted, input, startedAt, failure };
}

/** The open launch tab for `launchId`, if any. */
export function findLaunchTab(runtime: WorkspaceRuntime, launchId: string): DraftTabRecord | null {
  const state = runtime.store.getState();
  for (const id of state.orderedTabIds) {
    const tab = state.tabs[id];
    if (tab?.type !== 'draft' || tab.holds !== 'launch') continue;
    if (launchTabValues(runtime.drafts.get(tab.draftId))?.launchId === launchId) return tab;
  }
  return null;
}

/**
 * Open (and activate) a launch tab. `source` decides the history entry: a
 * person's `click` PUSHES the Work address, `system` writes none — the
 * caller that navigates INTO Work for the launch has already pushed one.
 * Returns the tab id, or null when Work refused the open (a scope prompt, the
 * tab limit) — the caller then lands the session the old way once it exists.
 */
export function openLaunchTab(runtime: WorkspaceRuntime, values: LaunchTabValues, source: Source): string | null {
  const existing = findLaunchTab(runtime, values.launchId);
  if (existing) {
    runtime.dispatch({ command: 'workspace.tabs.activate', args: { tabId: existing.id }, source });
    return existing.id;
  }
  const result = runtime.dispatch({ command: 'workspace.drafts.open', args: { kind: LAUNCH_TAB_KIND, holds: 'launch' }, source });
  const tab = result.tabId ? runtime.store.getState().tabs[result.tabId] : undefined;
  if (result.status !== 'applied' || tab?.type !== 'draft') return null;
  runtime.drafts.set(tab.draftId, { ...values });
  runtime.dispatch({
    command: 'workspace.drafts.markDirty',
    args: { tabId: tab.id, dirty: false, submitting: true },
    source: 'system',
  });
  return tab.id;
}

/** Rewrite a launch tab's values in place — a retry that takes over the tab. */
export function rewriteLaunchTab(runtime: WorkspaceRuntime, fromLaunchId: string, values: LaunchTabValues): string | null {
  const tab = findLaunchTab(runtime, fromLaunchId);
  if (!tab) return null;
  runtime.drafts.set(tab.draftId, { ...values });
  return tab.id;
}

/** Record what a reload needs on the tab: the input (for the replay), or the failure (for the page). */
export function storeLaunchFacts(
  runtime: WorkspaceRuntime,
  launchId: string,
  facts: { input: ExecutionSpawnInput } | { failure: LaunchFailure },
): void {
  const tab = findLaunchTab(runtime, launchId);
  if (!tab) return;
  const values = launchTabValues(runtime.drafts.get(tab.draftId));
  if (!values) return;
  runtime.drafts.set(tab.draftId, { ...values, ...facts });
}

/**
 * THE SWAP: the launch tab becomes the session's tab in place. `system` is
 * the only source `drafts.bind` accepts, and it is also the one the URL sync
 * answers with a REPLACE — the in-place, no-history half of the rule.
 * False when no launch tab is open for `launchId` (closed meanwhile).
 */
export function bindLaunchTab(runtime: WorkspaceRuntime, launchId: string, sessionId: EntityId, title: string): boolean {
  const tab = findLaunchTab(runtime, launchId);
  if (!tab) return false;
  runtime.dispatch({
    command: 'workspace.drafts.bind',
    args: { tabId: tab.id, entityId: sessionId, kind: LAUNCH_TAB_KIND, title },
    source: 'system',
  });
  return true;
}

/** Dismiss: close the launch tab. Not dirty, so the close never prompts. */
export function closeLaunchTab(runtime: WorkspaceRuntime, launchId: string, source: Source = 'click'): void {
  const tab = findLaunchTab(runtime, launchId);
  if (!tab) return;
  runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source });
}

// ---------------------------------------------------------------------------
// The queue — a launch pressed OUTSIDE Work
// ---------------------------------------------------------------------------

/*
 * WHY A QUEUE. Opening the draft into a runtime whose view is not mounted
 * would write into a PRISTINE store, and persistence restores the viewer's own
 * tabs only into a pristine store — so a launch from Observe or a craft right
 * after a reload would silently cost the viewer every saved tab. The arrival
 * queue (`arrival.ts`) exists for the same reason; the mounted Work view
 * drains this one right after it, behind the restore.
 */
const pending = new Map<string, LaunchTabValues[]>();
const listeners = new Set<() => void>();
const keyOf = (viewerId: string, spaceId: string) => `${viewerId}\u0000${spaceId}`;

export function queueLaunchTab(viewerId: string, spaceId: string, values: LaunchTabValues): void {
  const key = keyOf(viewerId, spaceId);
  const queued = (pending.get(key) ?? []).filter((v) => v.launchId !== values.launchId);
  pending.set(key, [...queued, values]);
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever a launch tab is queued. Returns the unsubscribe. */
export function onLaunchTabQueued(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Is `launchId` still waiting for Work to open its tab? */
export function launchTabQueued(viewerId: string, spaceId: string, launchId: string): boolean {
  return (pending.get(keyOf(viewerId, spaceId)) ?? []).some((v) => v.launchId === launchId);
}

/**
 * Hand every queued launch to `land`, oldest first, so the newest ends up
 * active. The lander decides at drain time, not at queue time: a launch the
 * node admitted while Work was still mounting opens as its SESSION's tab, and
 * one dismissed meanwhile opens nothing.
 */
export function drainLaunchTabs(runtime: WorkspaceRuntime, land: (values: LaunchTabValues) => void): number {
  const key = keyOf(runtime.viewerId, runtime.spaceId);
  const queued = pending.get(key);
  if (!queued || queued.length === 0) return 0;
  pending.delete(key);
  for (const values of queued) land(values);
  return queued.length;
}

/** Test seam. */
export function resetLaunchTabQueue(): void {
  pending.clear();
}
