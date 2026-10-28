/**
 * THE LAUNCH DEFAULTS READ — one launch's `launch.defaults` read as a state
 * machine, and what each state lets the launch card show (lane E of "Tm8
 * Session Launch Improvements": the card opens on its defaults, never on a
 * blank strip, and never waits on a read nobody needs).
 *
 * A LAUNCH KEY is what the read is a function of: teammate, subject, harness
 * and profile (`launchDefaultsKey`). One key, one read.
 *
 * STATES
 *   idle       nothing to read — no loader on this surface, or no teammate yet;
 *              `reason` says which, and every group is unknown with it
 *   loading    the read is in flight and this browser has no earlier answer
 *   cached     the read is in flight; the card draws this browser's last
 *              answer for the same key (`cached` groups: shown, editable)
 *   confirmed  the node answered; `changed` lists the groups whose defaults
 *              differ from the cached answer that was showing (none when they
 *              matched, or when nothing was cached)
 *   failed     the read failed: every group is unknown, as with no cache
 *
 * TRANSITIONS — `nextDefaultsRead` is the only place a read changes state:
 *   close(reason)       any → idle
 *   open(key, cached)   any → cached (an earlier answer) | loading (none)
 *   answered(key, r)    loading | cached → confirmed
 *   failed(key)         loading | cached → failed
 * An answer or failure for a key that is not the open one changes nothing,
 * so a slow read for a previous teammate can never land on the current one.
 *
 * INVARIANTS
 *   - a cached answer is never `confirmed` by anything but this read's answer;
 *   - `changed` is computed once, at cached → confirmed, by id: an order or
 *     title change alone merges silently, a different set is named;
 *   - what is SENT is decided elsewhere (`launchBlock`, `manualOutcome`): an
 *     edited group waits for `confirmed`, an untouched one is omitted.
 *
 * Pure: no React, no I/O. `useLaunchSelection` holds the state and dispatches;
 * `data/launch-defaults-cache.ts` supplies the cached answer.
 */
import type { LaunchDefaultsInput, LaunchDefaultsResult, SpawnSelectionGroup } from '@tm8/contract';

import {
  cachedDefaults,
  LAUNCH_GROUP_LABEL,
  LAUNCH_SELECTION_GROUPS,
  loadingDefaults,
  readyDefaults,
  UNKNOWN_DEFAULTS_NOTE,
  unknownDefaults,
  type LaunchSelectionDefaults,
} from './launch-selection';

/** How one group's defaults moved between the cached answer and the node's. */
export interface DefaultsChange {
  readonly group: SpawnSelectionGroup;
  /** Defaults the node has that the cached answer did not. */
  readonly added: number;
  /** Cached defaults the node no longer has. */
  readonly removed: number;
}

export type LaunchDefaultsRead =
  | { readonly phase: 'idle'; readonly key: null; readonly reason: string }
  | { readonly phase: 'loading'; readonly key: string }
  | { readonly phase: 'cached'; readonly key: string; readonly cached: LaunchDefaultsResult }
  | { readonly phase: 'confirmed'; readonly key: string; readonly result: LaunchDefaultsResult; readonly changed: readonly DefaultsChange[] }
  | { readonly phase: 'failed'; readonly key: string };

export type LaunchDefaultsReadEvent =
  | { readonly type: 'close'; readonly reason: string }
  | { readonly type: 'open'; readonly key: string; readonly cached: LaunchDefaultsResult | null }
  | { readonly type: 'answered'; readonly key: string; readonly result: LaunchDefaultsResult }
  | { readonly type: 'failed'; readonly key: string };

/** Why there is nothing to read: no teammate is picked yet. (No loader at all says `UNKNOWN_DEFAULTS_NOTE`.) */
export const NO_TEAMMATE_DEFAULTS_NOTE = 'Pick a teammate to see what this launch loads by default.';

/** The read's key: exactly the inputs `launch.defaults` answers for. */
export function launchDefaultsKey(input: LaunchDefaultsInput): string {
  return [input.teamMemberId, input.subjectId ?? '', input.agentTool ?? '', input.interactionProfileId ?? ''].join('|');
}

function idsOf(result: LaunchDefaultsResult, group: SpawnSelectionGroup): Set<string> {
  return new Set(result[group].items.map((item) => item.entityId));
}

/** The groups whose default SET differs between two answers, with how. */
export function defaultsChanges(before: LaunchDefaultsResult, after: LaunchDefaultsResult): DefaultsChange[] {
  return LAUNCH_SELECTION_GROUPS.flatMap((group) => {
    const was = idsOf(before, group);
    const now = idsOf(after, group);
    const added = [...now].filter((id) => !was.has(id)).length;
    const removed = [...was].filter((id) => !now.has(id)).length;
    return added || removed ? [{ group, added, removed }] : [];
  });
}

export function nextDefaultsRead(read: LaunchDefaultsRead, event: LaunchDefaultsReadEvent): LaunchDefaultsRead {
  switch (event.type) {
    case 'close':
      return read.phase === 'idle' && read.reason === event.reason ? read : { phase: 'idle', key: null, reason: event.reason };
    case 'open':
      return event.cached
        ? { phase: 'cached', key: event.key, cached: event.cached }
        : { phase: 'loading', key: event.key };
    case 'answered':
      if (read.key !== event.key) return read;
      if (read.phase === 'cached') {
        return { phase: 'confirmed', key: event.key, result: event.result, changed: defaultsChanges(read.cached, event.result) };
      }
      return read.phase === 'loading' ? { phase: 'confirmed', key: event.key, result: event.result, changed: [] } : read;
    case 'failed':
      if (read.key !== event.key) return read;
      return read.phase === 'loading' || read.phase === 'cached' ? { phase: 'failed', key: event.key } : read;
  }
}

/** What each group shows in this state. */
export function selectionDefaultsOf(read: LaunchDefaultsRead): LaunchSelectionDefaults {
  switch (read.phase) {
    case 'idle': return unknownDefaults(read.reason);
    case 'loading': return loadingDefaults();
    case 'cached': return groupsOf(read.cached, cachedDefaults);
    case 'confirmed': return groupsOf(read.result, readyDefaults);
    case 'failed': return unknownDefaults(UNKNOWN_DEFAULTS_NOTE);
  }
}

function groupsOf(result: LaunchDefaultsResult, as: typeof readyDefaults): LaunchSelectionDefaults {
  return { memories: as(result.memories), skills: as(result.skills), references: as(result.references) };
}

/** The answer the card is drawing — the node's, else this browser's last — for its warnings, bytes and index. */
export function shownAnswer(read: LaunchDefaultsRead): LaunchDefaultsResult | null {
  return read.phase === 'confirmed' ? read.result : read.phase === 'cached' ? read.cached : null;
}

/**
 * The one line said when the cached answer turned out to be out of date —
 * "This launch’s defaults changed since you last opened it: skills +1,
 * references −2." Null when nothing visible changed: a confirmation that
 * matches merges in silently.
 */
export function changedDefaultsNote(read: LaunchDefaultsRead): string | null {
  if (read.phase !== 'confirmed' || read.changed.length === 0) return null;
  const parts = read.changed.map((change) => [
    LAUNCH_GROUP_LABEL[change.group].toLowerCase(),
    ...(change.added ? [`+${String(change.added)}`] : []),
    ...(change.removed ? [`−${String(change.removed)}`] : []),
  ].join(' '));
  return `This launch’s defaults changed since you last opened it: ${parts.join(', ')}.`;
}
