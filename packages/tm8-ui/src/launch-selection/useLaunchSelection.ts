import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, LaunchDefaultsInput, LaunchDefaultsResult, SpawnSelectionGroup } from '@tm8/contract';

import {
  groupDiff,
  groupLock,
  LAUNCH_SELECTION_GROUPS,
  launchBlock,
  loadingDefaults,
  manualOutcome,
  NO_SELECTION_EDITS,
  readyDefaults,
  toggleRow,
  UNKNOWN_DEFAULTS_NOTE,
  unknownDefaults,
  type GroupDiff,
  type GroupOutcome,
  type LaunchContextRow,
  type LaunchSelectionDefaults,
  type LaunchSelectionEdits,
} from '../domain/launch-selection';

/** `launch.defaults`, bound to the space by the host. */
export type LoadLaunchDefaults = (input: LaunchDefaultsInput) => Promise<LaunchDefaultsResult>;

export interface LaunchSelection {
  defaults: LaunchSelectionDefaults;
  edits: LaunchSelectionEdits;
  /** The node's own words when a group came back emptier than asked. */
  warnings: readonly string[];
  /** Rows the person added, so an added row keeps its title while it is ticked. */
  added: Readonly<Record<SpawnSelectionGroup, readonly LaunchContextRow[]>>;
  /** Returns the refusal when the tick is refused; the row shows it too. */
  toggle(group: SpawnSelectionGroup, row: LaunchContextRow): string | null;
  refusal: { group: SpawnSelectionGroup; id: EntityId; reason: string } | null;
  diff(group: SpawnSelectionGroup): GroupDiff;
  lock(group: SpawnSelectionGroup): string | null;
  /** Why Launch must wait (an edited group's defaults are still loading); null when it need not. */
  launchBlock: string | null;
  /** Each group's outcome for `composeSelection`, read at Launch. */
  outcomes(): Record<SpawnSelectionGroup, GroupOutcome>;
}

const NOTHING_ADDED: LaunchSelection['added'] = { memories: [], skills: [], references: [] };

/**
 * The launch sheet's and Run composer's per-group selection (design 01a0d348
 * §5.1, I9). Reads the defaults for the teammate and subject, and holds the
 * person's edits as a diff against them.
 *
 * THE LOADER RIDES A REF: hosts rebuild it on every graph event, and keying
 * the read on its identity would re-read the defaults once per event.
 *
 * A TEAMMATE CHANGE re-reads the defaults and keeps the edits: a removal of
 * something the new teammate doesn't carry falls away, and an addition stays
 * an addition (`effectiveEdit`).
 */
export function useLaunchSelection(args: {
  load?: LoadLaunchDefaults;
  teammateId: string | null | undefined;
  subjectId: string | null | undefined;
}): LaunchSelection {
  const { load, teammateId, subjectId } = args;
  const loadRef = useRef(load);
  loadRef.current = load;
  const canLoad = load !== undefined;
  const key = teammateId ? `${teammateId}|${subjectId ?? ''}` : null;

  const [read, setRead] = useState<{ key: string; defaults: LaunchSelectionDefaults; warnings: readonly string[] } | null>(null);
  const [edits, setEdits] = useState<LaunchSelectionEdits>(NO_SELECTION_EDITS);
  const [added, setAdded] = useState<LaunchSelection['added']>(NOTHING_ADDED);
  const [refusal, setRefusal] = useState<LaunchSelection['refusal']>(null);

  useEffect(() => {
    const fn = loadRef.current;
    if (!key || !teammateId || !fn) return;
    let live = true;
    fn({ teamMemberId: teammateId as EntityId, ...(subjectId ? { subjectId: subjectId as EntityId } : {}) }).then(
      (result) => {
        if (!live) return;
        setRead({
          key,
          defaults: {
            memories: readyDefaults(result.memories),
            skills: readyDefaults(result.skills),
            references: readyDefaults(result.references),
          },
          warnings: result.warnings,
        });
      },
      () => { if (live) setRead({ key, defaults: unknownDefaults(UNKNOWN_DEFAULTS_NOTE), warnings: [] }); },
    );
    return () => { live = false; };
  }, [key, teammateId, subjectId, canLoad]);

  const defaults = useMemo<LaunchSelectionDefaults>(() => {
    if (!canLoad) return unknownDefaults(UNKNOWN_DEFAULTS_NOTE);
    if (!key) return unknownDefaults('Pick a teammate to see what this launch loads by default.');
    return read && read.key === key ? read.defaults : loadingDefaults();
  }, [canLoad, key, read]);
  const warnings = read && read.key === key ? read.warnings : [];

  const toggle = useCallback((group: SpawnSelectionGroup, row: LaunchContextRow): string | null => {
    const result = toggleRow(defaults[group], edits[group], row.id);
    if ('refused' in result) {
      setRefusal({ group, id: row.id, reason: result.refused });
      return result.refused;
    }
    setEdits((current) => ({ ...current, [group]: result.edit }));
    if (result.edit.added.includes(row.id)) {
      setAdded((current) => (
        current[group].some((r) => r.id === row.id) ? current : { ...current, [group]: [...current[group], row] }
      ));
    }
    setRefusal(null);
    return null;
  }, [defaults, edits]);

  const outcomes = useCallback(() => {
    const out = {} as Record<SpawnSelectionGroup, GroupOutcome>;
    for (const group of LAUNCH_SELECTION_GROUPS) out[group] = manualOutcome(defaults[group], edits[group]);
    return out;
  }, [defaults, edits]);

  return {
    defaults,
    edits,
    warnings,
    added,
    toggle,
    refusal,
    diff: (group) => groupDiff(defaults[group], edits[group]),
    lock: (group) => groupLock(defaults[group]),
    launchBlock: launchBlock(defaults, edits),
    outcomes,
  };
}
