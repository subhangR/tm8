import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SPAWN_SELECTION_GROUP_LIMIT,
  type EntityId,
  type LaunchDefaultsGroup,
  type LaunchDefaultsInput,
  type LaunchDefaultsResult,
  type SpawnSelectionGroup,
} from '@tm8/contract';

import {
  CEILING_REFUSAL,
  groupDiff,
  groupIds,
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
  type LaunchGroupEdit,
  type LaunchSelectionEdits,
} from '../domain/launch-selection';

/**
 * What `launch.defaults` says a group's defaults COST (lane E, I7): each
 * default's prompt bytes and the group's budget. Optional on the wire until
 * E's fields land; absent, the meter shows counts only rather than invent bytes.
 */
export interface LaunchGroupBytes {
  /** Bytes per default id, measured by the node with spawn's serializers. Missing id: unknown. */
  readonly bytes: Readonly<Record<string, number>>;
  /** The group's budget; null: takes what the prompt has left; undefined: the node didn't say. */
  readonly budget: number | null | undefined;
}

/** `launch.defaults` with I7's byte facts, read as optional (lane E adds them). */
type DefaultsGroupWithBytes = LaunchDefaultsGroup & {
  readonly budget?: number | null;
  readonly items: ReadonlyArray<LaunchDefaultsGroup['items'][number] & { readonly promptBytes?: number }>;
};

function groupBytes(group: LaunchDefaultsGroup): LaunchGroupBytes {
  const g = group as DefaultsGroupWithBytes;
  const bytes: Record<string, number> = {};
  for (const item of g.items) if (typeof item.promptBytes === 'number') bytes[item.entityId] = item.promptBytes;
  return { bytes, budget: g.budget };
}

const NO_BYTES: LaunchGroupBytes = { bytes: {}, budget: undefined };
const NO_BYTES_ALL: Record<SpawnSelectionGroup, LaunchGroupBytes> = { memories: NO_BYTES, skills: NO_BYTES, references: NO_BYTES };

/**
 * What the launch will run with, which decides the defaults' bytes and
 * budgets (lane E, #829): the harness (a skill's entry reads differently
 * native) and the Interaction Profile (its `contextBudgets`). Query params on
 * `launch.defaults` — a node before #829 ignores them. Declared here until the
 * contract's `LaunchDefaultsInput` carries them; the intersection is harmless after.
 */
export interface LaunchDefaultsLaunchParams {
  agentTool?: 'claude-code' | 'codex';
  interactionProfileId?: EntityId;
}

/** `launch.defaults`, bound to the space by the host. */
export type LoadLaunchDefaults = (input: LaunchDefaultsInput & LaunchDefaultsLaunchParams) => Promise<LaunchDefaultsResult>;

export interface LaunchSelection {
  defaults: LaunchSelectionDefaults;
  edits: LaunchSelectionEdits;
  /** The node's own words when a group came back emptier than asked. */
  warnings: readonly string[];
  /** Rows the person added, so an added row keeps its title while it is ticked. */
  added: Readonly<Record<SpawnSelectionGroup, readonly LaunchContextRow[]>>;
  /** Returns the refusal when the tick is refused; the row shows it too. */
  toggle(group: SpawnSelectionGroup, row: LaunchContextRow): string | null;
  /**
   * Replace a group's edit wholesale — how an applied Jev group arrives (a
   * person's click on Apply, lane A's JevApplyHost): an ordinary edit, shown
   * as the same diff as hand ticks. `rows` names the non-default ids it adds.
   * Refused, and nothing changes, when the group is locked or the set would
   * pass the per-group ceiling.
   */
  setEdit(group: SpawnSelectionGroup, edit: LaunchGroupEdit, rows?: readonly LaunchContextRow[]): string | null;
  /** The defaults' prompt bytes and the group's budget, as `launch.defaults` stated them. */
  bytes: Readonly<Record<SpawnSelectionGroup, LaunchGroupBytes>>;
  /** Whether the launch renders `<context_index>`, as `launch.defaults` stated it; null: not said. */
  contextIndex: 'on' | 'off' | null;
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
  /** The launch's harness; re-reads the defaults when it changes. */
  agentTool?: string | null;
  /** The profile the launch will pin, when the surface picked one; re-reads the defaults when it changes. */
  interactionProfileId?: string | null;
}): LaunchSelection {
  const { load, teammateId, subjectId } = args;
  const agentTool = args.agentTool === 'claude-code' || args.agentTool === 'codex' ? args.agentTool : null;
  const profileId = args.interactionProfileId || null;
  const loadRef = useRef(load);
  loadRef.current = load;
  const canLoad = load !== undefined;
  const key = teammateId ? `${teammateId}|${subjectId ?? ''}|${agentTool ?? ''}|${profileId ?? ''}` : null;

  const [read, setRead] = useState<{
    key: string;
    defaults: LaunchSelectionDefaults;
    warnings: readonly string[];
    bytes: Record<SpawnSelectionGroup, LaunchGroupBytes>;
    contextIndex: 'on' | 'off' | null;
  } | null>(null);
  const [edits, setEdits] = useState<LaunchSelectionEdits>(NO_SELECTION_EDITS);
  const [added, setAdded] = useState<LaunchSelection['added']>(NOTHING_ADDED);
  const [refusal, setRefusal] = useState<LaunchSelection['refusal']>(null);

  useEffect(() => {
    const fn = loadRef.current;
    if (!key || !teammateId || !fn) return;
    let live = true;
    fn({
      teamMemberId: teammateId as EntityId,
      ...(subjectId ? { subjectId: subjectId as EntityId } : {}),
      ...(agentTool ? { agentTool } : {}),
      ...(profileId ? { interactionProfileId: profileId as EntityId } : {}),
    }).then(
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
          bytes: {
            memories: groupBytes(result.memories),
            skills: groupBytes(result.skills),
            references: groupBytes(result.references),
          },
          contextIndex: (result as LaunchDefaultsResult & { contextIndex?: 'on' | 'off' }).contextIndex ?? null,
        });
      },
      () => { if (live) setRead({ key, defaults: unknownDefaults(UNKNOWN_DEFAULTS_NOTE), warnings: [], bytes: NO_BYTES_ALL, contextIndex: null }); },
    );
    return () => { live = false; };
  }, [key, teammateId, subjectId, agentTool, profileId, canLoad]);

  const defaults = useMemo<LaunchSelectionDefaults>(() => {
    if (!canLoad) return unknownDefaults(UNKNOWN_DEFAULTS_NOTE);
    if (!key) return unknownDefaults('Pick a teammate to see what this launch loads by default.');
    return read && read.key === key ? read.defaults : loadingDefaults();
  }, [canLoad, key, read]);
  const current = read && read.key === key ? read : null;
  const warnings = current ? current.warnings : [];

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

  const setEdit = useCallback((group: SpawnSelectionGroup, edit: LaunchGroupEdit, rows: readonly LaunchContextRow[] = []): string | null => {
    const lock = groupLock(defaults[group]);
    const refused = lock ?? (groupIds(defaults[group], edit).length > SPAWN_SELECTION_GROUP_LIMIT ? CEILING_REFUSAL : null);
    if (refused) return refused;
    setEdits((prev) => ({ ...prev, [group]: { removed: [...edit.removed], added: [...edit.added] } }));
    if (rows.length > 0) {
      setAdded((prev) => {
        const known = new Set(prev[group].map((r) => r.id));
        const fresh = rows.filter((r) => edit.added.includes(r.id) && !known.has(r.id));
        return fresh.length ? { ...prev, [group]: [...prev[group], ...fresh] } : prev;
      });
    }
    setRefusal(null);
    return null;
  }, [defaults]);

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
    setEdit,
    bytes: current ? current.bytes : NO_BYTES_ALL,
    contextIndex: current ? current.contextIndex : null,
    refusal,
    diff: (group) => groupDiff(defaults[group], edits[group]),
    lock: (group) => groupLock(defaults[group]),
    launchBlock: launchBlock(defaults, edits),
    outcomes,
  };
}
