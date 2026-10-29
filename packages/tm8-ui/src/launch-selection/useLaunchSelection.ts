import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  SPAWN_SELECTION_GROUP_LIMIT,
  type EntityId,
  type LaunchDefaultsGroup,
  type LaunchDefaultsInput,
  type SpawnSelectionGroup,
} from '@tm8/contract';

import {
  CEILING_REFUSAL,
  groupDiff,
  groupIds,
  groupLock,
  LAUNCH_SELECTION_GROUPS,
  launchBlock,
  manualOutcome,
  NO_SELECTION_EDITS,
  toggleRow,
  UNKNOWN_DEFAULTS_NOTE,
  type GroupDiff,
  type GroupOutcome,
  type LaunchContextRow,
  type LaunchSelectionDefaults,
  type LaunchGroupEdit,
  type LaunchSelectionEdits,
} from '../domain/launch-selection';
import {
  defaultsNote,
  launchDefaultsKey,
  nextDefaultsRead,
  NO_TEAMMATE_DEFAULTS_NOTE,
  selectionDefaultsOf,
  shownAnswer,
  type LaunchDefaultsRead,
  type LaunchDefaultsReadEvent,
} from '../domain/launch-defaults-read';
import type { LoadLaunchDefaults } from './port';

/**
 * What `launch.defaults` says a group's defaults COST (lane E, I7): each
 * default's prompt bytes and the group's budget, as the node measured them.
 * Read tolerantly: a node that predates #829 (a named Server on an older
 * build) omits them, and the meter then shows counts rather than invent bytes.
 */
export interface LaunchGroupBytes {
  /** Bytes per default id, measured by the node with spawn's serializers. Missing id: unknown. */
  readonly bytes: Readonly<Record<string, number>>;
  /** The group's budget; null: takes what the prompt has left; undefined: no answer read yet. */
  readonly budget: number | null | undefined;
}

function groupBytes(group: LaunchDefaultsGroup): LaunchGroupBytes {
  const bytes: Record<string, number> = {};
  for (const item of group.items) if (typeof item.promptBytes === 'number') bytes[item.entityId] = item.promptBytes;
  return { bytes, budget: group.budget };
}

const NO_BYTES: LaunchGroupBytes = { bytes: {}, budget: undefined };
const NO_BYTES_ALL: Record<SpawnSelectionGroup, LaunchGroupBytes> = { memories: NO_BYTES, skills: NO_BYTES, references: NO_BYTES };

export interface LaunchSelection {
  defaults: LaunchSelectionDefaults;
  edits: LaunchSelectionEdits;
  /** The node's own words when a group came back emptier than asked. */
  warnings: readonly string[];
  /**
   * One line about the defaults drawn from this browser's last answer: they
   * turned out to differ from the node's, or the node could not confirm them
   * (`defaultsNote`). Null otherwise — a confirmation that matches merges in
   * without a word.
   */
  defaultsNote: string | null;
  /** Ask the node again after a failed read; a no-op otherwise. Edits are kept across it. */
  retryDefaults(): void;
  /** The read failed and can be asked again (`retryDefaults`). */
  canRetryDefaults: boolean;
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
  /** Whether the launch renders `<context_index>`, as `launch.defaults` stated it; null: not read yet. */
  contextIndex: 'on' | 'off' | null;
  refusal: { group: SpawnSelectionGroup; id: EntityId; reason: string } | null;
  diff(group: SpawnSelectionGroup): GroupDiff;
  lock(group: SpawnSelectionGroup): string | null;
  /** Why Launch must wait — an edited group's defaults are not confirmed yet, named; null when it need not. */
  launchBlock: string | null;
  /** Each group's outcome for `composeSelection`, read at Launch. */
  outcomes(): Record<SpawnSelectionGroup, GroupOutcome>;
}

const NOTHING_ADDED: LaunchSelection['added'] = { memories: [], skills: [], references: [] };

/** What the read is for on this render: a launch key and its input, or why there is nothing to read. */
type ReadTarget =
  | { readonly key: string; readonly input: LaunchDefaultsInput }
  | { readonly key: null; readonly reason: string };

function defaultsInput(teammateId: string, subjectId: string | null | undefined, agentTool: 'claude-code' | 'codex' | null, profileId: string | null): LaunchDefaultsInput {
  return {
    teamMemberId: teammateId as EntityId,
    ...(subjectId ? { subjectId: subjectId as EntityId } : {}),
    ...(agentTool ? { agentTool } : {}),
    ...(profileId ? { interactionProfileId: profileId as EntityId } : {}),
  };
}

function openEvent(target: ReadTarget, load: LoadLaunchDefaults | undefined): LaunchDefaultsReadEvent {
  return target.key === null
    ? { type: 'close', reason: target.reason }
    : { type: 'open', key: target.key, cached: load?.peek?.(target.input) ?? null };
}

function isOpenFor(read: LaunchDefaultsRead, target: ReadTarget): boolean {
  return target.key === null ? read.phase === 'idle' && read.reason === target.reason : read.key === target.key;
}

/**
 * The launch sheet's and Run composer's per-group selection (design 01a0d348
 * §5.1, I9). Reads the defaults for the teammate and subject, and holds the
 * person's edits as a diff against them.
 *
 * THE READ is the state machine in `domain/launch-defaults-read.ts`; this hook
 * only feeds it. A new launch key OPENS on the render that sees it — the
 * documented way to move state with a prop — so a cached answer (the loader's
 * `peek`) is on the very first frame instead of one frame of "loading", and
 * the call that confirms it starts in the effect.
 *
 * THE LOADER RIDES A REF: hosts may rebuild it, and keying the read on its
 * identity would re-read the defaults once per rebuild.
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

  const target: ReadTarget = !load
    ? { key: null, reason: UNKNOWN_DEFAULTS_NOTE }
    : !teammateId
      ? { key: null, reason: NO_TEAMMATE_DEFAULTS_NOTE }
      : (() => {
        const input = defaultsInput(teammateId, subjectId, agentTool, profileId);
        return { key: launchDefaultsKey(input), input };
      })();

  const [read, dispatch] = useReducer(nextDefaultsRead, target, (first) => nextDefaultsRead(
    { phase: 'idle', key: null, reason: '' },
    openEvent(first, load),
  ));
  if (!isOpenFor(read, target)) dispatch(openEvent(target, load));

  /* The read for the open key, again on every retry. The key is a function of
     these primitives, so they change only with it. */
  const openKey = target.key;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const fn = loadRef.current;
    if (!fn || openKey === null || !teammateId) return;
    let live = true;
    fn(defaultsInput(teammateId, subjectId, agentTool, profileId)).then(
      (result) => { if (live) dispatch({ type: 'answered', key: openKey, result }); },
      () => { if (live) dispatch({ type: 'failed', key: openKey }); },
    );
    return () => { live = false; };
  }, [openKey, attempt, teammateId, subjectId, agentTool, profileId]);
  const retryDefaults = useCallback(() => {
    if (read.phase !== 'failed') return;
    dispatch({ type: 'retry', key: read.key });
    setAttempt((n) => n + 1);
  }, [read]);

  const [edits, setEdits] = useState<LaunchSelectionEdits>(NO_SELECTION_EDITS);
  const [added, setAdded] = useState<LaunchSelection['added']>(NOTHING_ADDED);
  const [refusal, setRefusal] = useState<LaunchSelection['refusal']>(null);

  const defaults = useMemo(() => selectionDefaultsOf(read), [read]);
  const answer = shownAnswer(read);
  const bytes = useMemo(() => (answer
    ? { memories: groupBytes(answer.memories), skills: groupBytes(answer.skills), references: groupBytes(answer.references) }
    : NO_BYTES_ALL), [answer]);

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
    warnings: answer ? answer.warnings : [],
    defaultsNote: defaultsNote(read),
    retryDefaults,
    canRetryDefaults: read.phase === 'failed',
    added,
    toggle,
    setEdit,
    bytes,
    contextIndex: answer?.contextIndex ?? null,
    refusal,
    diff: (group) => groupDiff(defaults[group], edits[group]),
    lock: (group) => groupLock(defaults[group]),
    launchBlock: launchBlock(defaults, edits),
    outcomes,
  };
}
