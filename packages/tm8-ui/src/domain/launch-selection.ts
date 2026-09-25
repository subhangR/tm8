/**
 * THE LAUNCH SELECTION — what a launch carries per group, as a person edited it
 * (integrated design 01a0d348 §5.1–5.2, I9).
 *
 * Every `SpawnSelection` group (memories, skills, references) is either ABSENT
 * — the node loads that group's edge defaults — or an EXACT set. The sheet
 * pre-ticks the defaults (read from `launch.defaults`, the loaders spawn
 * itself runs), so an untouched group already shows what the launch will get.
 *
 * AN EDIT IS A DIFF, NOT A SET. A group holds `removed` (defaults unticked)
 * and `added` (entities ticked from the space). The exact set is derived:
 * defaults minus removed, then the additions. Keeping the diff rather than
 * the set means a teammate change re-applies the person's decisions to the new
 * teammate's defaults instead of silently dropping them — a set built for the
 * old teammate would strip every default the new one brings.
 *
 * PER-GROUP SEND. A group whose diff is empty against its defaults is omitted
 * (the node loads its defaults, and `selectionReasons` says why: `not-asked`).
 * An edited group is sent as its exact set. A group is never sent above the
 * node's ceiling (`SPAWN_SELECTION_GROUP_LIMIT`): ticking past it is refused
 * at the row, and a group whose defaults already exceed it cannot be edited.
 *
 * Pure: no React, no I/O. The hook and the component live beside their host.
 */
import {
  SPAWN_SELECTION_GROUP_LIMIT,
  SPAWN_SELECTION_REFERENCE_KINDS,
  type EntityId,
  type LaunchDefaultItem,
  type LaunchDefaultsGroup,
  type LaunchDefaultVia,
  type RankedEntity,
  type RankedEntityReason,
  type SpawnSelection,
  type SpawnSelectionDefaultReason,
  type SpawnSelectionGroup,
} from '@tm8/contract';

import type { LaunchMemory } from './launch';

export const LAUNCH_SELECTION_GROUPS = ['memories', 'skills', 'references'] as const satisfies readonly SpawnSelectionGroup[];

export const LAUNCH_GROUP_LABEL: Readonly<Record<SpawnSelectionGroup, string>> = {
  memories: 'Memories',
  skills: 'Skills',
  references: 'References',
};

/** One row of a group: a default, or a candidate the person may add. */
export interface LaunchContextRow {
  readonly id: EntityId;
  readonly kind: string;
  readonly title: string;
  /** Header text (`whenToUse` ?? `summary`), or a candidate's own detail. Plain text: graph content. */
  readonly text: string | null;
  /** True when `text` was not authored for this purpose — the row says "derived". */
  readonly derived: boolean;
  /** Set on defaults only: why the launch carries it. */
  readonly via: LaunchDefaultVia | null;
}

export type LaunchGroupDefaults =
  | { readonly status: 'loading' }
  /** No defaults read (no port, a failed read, no teammate yet): the group cannot be edited. */
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'ready'; readonly rows: readonly LaunchContextRow[]; readonly total: number };

export type LaunchSelectionDefaults = Readonly<Record<SpawnSelectionGroup, LaunchGroupDefaults>>;

export interface LaunchGroupEdit {
  /** Defaults the person unticked. */
  readonly removed: readonly EntityId[];
  /** Non-defaults the person ticked, in the order they were ticked. */
  readonly added: readonly EntityId[];
}

export type LaunchSelectionEdits = Readonly<Record<SpawnSelectionGroup, LaunchGroupEdit>>;

const EMPTY_EDIT: LaunchGroupEdit = { removed: [], added: [] };

export const NO_SELECTION_EDITS: LaunchSelectionEdits = {
  memories: EMPTY_EDIT,
  skills: EMPTY_EDIT,
  references: EMPTY_EDIT,
};

export function loadingDefaults(): LaunchSelectionDefaults {
  return { memories: { status: 'loading' }, skills: { status: 'loading' }, references: { status: 'loading' } };
}

export function unknownDefaults(reason: string): LaunchSelectionDefaults {
  const group = { status: 'unknown', reason } as const;
  return { memories: group, skills: group, references: group };
}

/** A space memory offered for adding, in the sheet's shape. Its scope and mark ride along: picking a claim blind is how a true statement about the wrong subject gets injected. */
export function memoryCandidateRow(memory: LaunchMemory): LaunchContextRow {
  return {
    id: memory.id as EntityId,
    kind: 'memory',
    title: memory.statement,
    text: `${memory.mark} · ${memory.subjectScope}`,
    derived: false,
    via: null,
  };
}

/** A space skill offered for adding (the `/` trigger's options: name and description). */
export function skillCandidateRow(option: { readonly id: string; readonly display: string; readonly meta?: string }): LaunchContextRow {
  return { id: option.id as EntityId, kind: 'skill', title: option.display, text: option.meta ?? null, derived: false, via: null };
}

/** The kinds `selection.referenceIds` may name, as the node's contract states them. */
export const REFERENCE_KINDS: readonly string[] = SPAWN_SELECTION_REFERENCE_KINDS;

/** A space doc, artifact, drawing, file or task offered for adding. */
export function referenceCandidateRow(summary: {
  readonly id: string;
  readonly title: string;
  readonly state: { readonly kind: string };
}): LaunchContextRow {
  return { id: summary.id as EntityId, kind: summary.state.kind, title: summary.title || summary.id, text: null, derived: false, via: null };
}

/** `launch.defaults` rows, in the sheet's shape. */
export function defaultRow(item: LaunchDefaultItem): LaunchContextRow {
  return {
    id: item.entityId as EntityId,
    kind: item.kind,
    title: item.title,
    text: item.headerText,
    derived: item.headerText !== null && item.headerSource !== 'authored',
    via: item.via,
  };
}

export function readyDefaults(group: LaunchDefaultsGroup): LaunchGroupDefaults {
  return { status: 'ready', rows: group.items.map(defaultRow), total: group.total };
}

export const UNKNOWN_DEFAULTS_NOTE = 'The node didn’t say what this launch loads by default, so this group can’t be edited. It launches with its defaults.';

export function ceilingNote(total: number): string {
  return `This launch has ${String(total)} defaults here. A launch can name at most ${String(SPAWN_SELECTION_GROUP_LIMIT)} per group, so this group can’t be edited and launches with its defaults.`;
}

export const CEILING_REFUSAL = `A launch can name at most ${String(SPAWN_SELECTION_GROUP_LIMIT)} per group. Untick one before ticking another.`;

/** Why a group cannot be edited; null when it can. */
export function groupLock(defaults: LaunchGroupDefaults): string | null {
  if (defaults.status === 'loading') return 'Reading this launch’s defaults…';
  if (defaults.status === 'unknown') return defaults.reason;
  if (defaults.total > defaults.rows.length || defaults.total > SPAWN_SELECTION_GROUP_LIMIT) return ceilingNote(defaults.total);
  return null;
}

export const DEFAULTS_LOADING_BLOCK = 'Reading this launch’s defaults… Launch waits so your edits to them are kept.';

/**
 * Why Launch must wait; null when it need not. An EDITED group whose defaults
 * are still loading (a teammate change re-reads them) is locked, so it would
 * be omitted and launch on its defaults — the person's removals silently
 * dropped. So Launch waits for that read. An untouched group never blocks: it
 * is omitted either way.
 */
export function launchBlock(defaults: LaunchSelectionDefaults, edits: LaunchSelectionEdits): string | null {
  const waiting = LAUNCH_SELECTION_GROUPS.some((group) =>
    defaults[group].status === 'loading' && (edits[group].removed.length > 0 || edits[group].added.length > 0));
  return waiting ? DEFAULTS_LOADING_BLOCK : null;
}

function defaultIds(defaults: LaunchGroupDefaults): readonly EntityId[] {
  return defaults.status === 'ready' ? defaults.rows.map((row) => row.id) : [];
}

/** The diff that actually applies to these defaults: stale removals and re-added defaults fall away. */
export function effectiveEdit(defaults: LaunchGroupDefaults, edit: LaunchGroupEdit): LaunchGroupEdit {
  const ids = new Set(defaultIds(defaults));
  return {
    removed: edit.removed.filter((id) => ids.has(id)),
    added: edit.added.filter((id) => !ids.has(id)),
  };
}

/** The exact set: kept defaults in spawn order, then additions in tick order. */
export function groupIds(defaults: LaunchGroupDefaults, edit: LaunchGroupEdit): EntityId[] {
  const removed = new Set(edit.removed);
  const kept = defaultIds(defaults).filter((id) => !removed.has(id));
  const seen = new Set(kept);
  return [...kept, ...edit.added.filter((id) => !seen.has(id))];
}

export function isTicked(defaults: LaunchGroupDefaults, edit: LaunchGroupEdit, id: EntityId): boolean {
  return defaultIds(defaults).includes(id) ? !edit.removed.includes(id) : edit.added.includes(id);
}

export type ToggleResult = { readonly edit: LaunchGroupEdit } | { readonly refused: string };

export function toggleRow(defaults: LaunchGroupDefaults, edit: LaunchGroupEdit, id: EntityId): ToggleResult {
  const lock = groupLock(defaults);
  if (lock) return { refused: lock };
  const current = effectiveEdit(defaults, edit);
  if (defaultIds(defaults).includes(id)) {
    if (current.removed.includes(id)) {
      if (groupIds(defaults, current).length >= SPAWN_SELECTION_GROUP_LIMIT) return { refused: CEILING_REFUSAL };
      return { edit: { ...current, removed: current.removed.filter((x) => x !== id) } };
    }
    return { edit: { ...current, removed: [...current.removed, id] } };
  }
  if (current.added.includes(id)) return { edit: { ...current, added: current.added.filter((x) => x !== id) } };
  if (groupIds(defaults, current).length >= SPAWN_SELECTION_GROUP_LIMIT) return { refused: CEILING_REFUSAL };
  return { edit: { ...current, added: [...current.added, id] } };
}

export interface GroupDiff {
  readonly removed: number;
  readonly added: number;
  /** "−2 defaults removed · +1 added"; null when the group is its defaults. */
  readonly line: string | null;
}

export function groupDiff(defaults: LaunchGroupDefaults, edit: LaunchGroupEdit): GroupDiff {
  const { removed, added } = effectiveEdit(defaults, edit);
  const parts = [
    ...(removed.length ? [`−${String(removed.length)} default${removed.length === 1 ? '' : 's'} removed`] : []),
    ...(added.length ? [`+${String(added.length)} added`] : []),
  ];
  return { removed: removed.length, added: added.length, line: parts.length ? parts.join(' · ') : null };
}

/** What one group contributes to the spawn: an exact set, or its defaults and why. */
export type GroupOutcome =
  | { readonly send: readonly EntityId[] }
  | { readonly omit: SpawnSelectionDefaultReason };

export function manualOutcome(defaults: LaunchGroupDefaults, edit: LaunchGroupEdit): GroupOutcome {
  if (groupLock(defaults)) return { omit: 'not-asked' };
  const diff = groupDiff(defaults, edit);
  if (diff.line === null) return { omit: 'not-asked' };
  return { send: groupIds(defaults, edit) };
}

export interface LaunchSelectionFields {
  selection?: SpawnSelection;
  selectionReasons?: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>>;
}

const SELECTION_KEY = {
  memories: 'memoryIds',
  skills: 'skillIds',
  references: 'referenceIds',
} as const satisfies Record<SpawnSelectionGroup, keyof SpawnSelection>;

/**
 * The spawn fields for a launch: each group's ordinary outcome, nothing else.
 * Ask Jev reaches this function only through the edits a person APPLIED (they
 * are `manual` outcomes like any other), so there is no Jev override here.
 *
 * `selection` is left out when no group is sent, so an untouched launch loads
 * exactly today's defaults. `selectionReasons` names EVERY omitted group — an
 * audit-only field the node records in `manifest.context.groups` — and
 * `defaultReasons` replaces a bare `not-asked` with why a group Jev was asked
 * about still launches on its defaults (`jev-failed`, `jev-pending`).
 *
 * Never sends a group above the ceiling: such a group falls back to its
 * defaults. `toggleRow` and `applyJevToEdit` make that unreachable from the
 * sheet; this is the floor under any other caller.
 */
export function composeLaunchSelection(
  manual: Readonly<Record<SpawnSelectionGroup, GroupOutcome>>,
  defaultReasons: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>> = {},
): LaunchSelectionFields {
  const selection: SpawnSelection = {};
  const reasons: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>> = {};
  for (const group of LAUNCH_SELECTION_GROUPS) {
    const outcome = manual[group];
    if ('send' in outcome && outcome.send.length <= SPAWN_SELECTION_GROUP_LIMIT) {
      selection[SELECTION_KEY[group]] = [...outcome.send];
    } else {
      const reason = 'omit' in outcome ? outcome.omit : 'not-asked';
      reasons[group] = reason === 'not-asked' ? defaultReasons[group] ?? reason : reason;
    }
  }
  return {
    ...(Object.keys(selection).length > 0 ? { selection } : {}),
    ...(Object.keys(reasons).length > 0 ? { selectionReasons: reasons } : {}),
  };
}

/**
 * @deprecated TRANSITIONAL — call `composeLaunchSelection(outcomes, defaultReasons)`.
 * The `override` (the retired "Jev mode") is ignored when absent and still
 * honoured when a not-yet-migrated caller passes one; `useJevSuggestions` no
 * longer produces it. Deleted once LaunchSheet and the Run popup move over.
 */
export function composeSelection(
  manual: Readonly<Record<SpawnSelectionGroup, GroupOutcome>>,
  override: Partial<Record<SpawnSelectionGroup, GroupOutcome>> = {},
  defaultReasons: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>> = {},
): LaunchSelectionFields {
  const merged = { ...manual };
  for (const group of LAUNCH_SELECTION_GROUPS) {
    const replaced = override[group];
    if (replaced) merged[group] = replaced;
  }
  return composeLaunchSelection(merged, defaultReasons);
}

/* ------------------------------------------------------------------------ *
 * APPLYING ASK JEV (Jev UX lane A). Jev only suggests; a person's Apply click
 * turns Jev's ticks for ONE group into that group's ordinary edit, and Undo
 * turns them back. Nothing here runs without that click.
 * ------------------------------------------------------------------------ */

/** One row Jev ranked, as Apply needs it: its id, and whether it is a default of this launch. */
export interface JevRankedRow {
  readonly id: EntityId;
  /** `RankedEntity.default`: spawn loads it for this group when nothing is selected. */
  readonly isDefault: boolean;
}

/**
 * What Applying Jev's ticks does to a group, as a diff against the launch's
 * defaults: `removed` = defaults Jev left unticked, `added` = picks that are
 * not defaults. Only rows JEV RANKED are decided — a default Jev never saw, or
 * a row the person added that Jev didn't rank, keeps its state.
 */
export function jevGroupDiff(rows: readonly JevRankedRow[], ticked: readonly EntityId[]): LaunchGroupEdit {
  const on = new Set(ticked);
  const removed: EntityId[] = [];
  const added: EntityId[] = [];
  for (const row of rows) {
    if (row.isDefault && !on.has(row.id)) removed.push(row.id);
    if (!row.isDefault && on.has(row.id)) added.push(row.id);
  }
  // Additions go in tick (rank) order, which is the order `ticked` is in.
  const addedSet = new Set(added);
  return { removed, added: ticked.filter((id) => addedSet.has(id)) };
}

/**
 * The group's edit after Applying Jev's ticks on top of the person's current
 * edit. Each row Jev ranked takes Jev's verdict; every other row is untouched.
 */
export function applyJevToEdit(
  current: LaunchGroupEdit,
  rows: readonly JevRankedRow[],
  ticked: readonly EntityId[],
): LaunchGroupEdit {
  const decided = new Set(rows.map((row) => row.id));
  const jev = jevGroupDiff(rows, ticked);
  const added = [...current.added.filter((id) => !decided.has(id)), ...jev.added];
  return {
    removed: [...current.removed.filter((id) => !decided.has(id)), ...jev.removed],
    added: [...new Set(added)],
  };
}

/**
 * Undo an Apply: every row the Apply decided goes back to its state in
 * `before` (the edit just before the Apply); rows the person changed since on
 * their own, outside Jev's rows, keep those changes.
 */
export function restoreRows(
  current: LaunchGroupEdit,
  before: LaunchGroupEdit,
  touched: readonly EntityId[],
): LaunchGroupEdit {
  const decided = new Set(touched);
  return {
    removed: [...current.removed.filter((id) => !decided.has(id)), ...before.removed.filter((id) => decided.has(id))],
    added: [...current.added.filter((id) => !decided.has(id)), ...before.added.filter((id) => decided.has(id))],
  };
}

/**
 * Why Applying `next` to this group must be refused; null when it may. A
 * locked group (defaults unread, or past the ceiling) launches on its defaults
 * whatever its edit says, so an Apply there would look applied and not be.
 */
export function jevApplyRefusal(defaults: LaunchGroupDefaults, next: LaunchGroupEdit): string | null {
  const lock = groupLock(defaults);
  if (lock) return lock;
  if (groupIds(defaults, next).length > SPAWN_SELECTION_GROUP_LIMIT) return CEILING_REFUSAL;
  return null;
}

/** Jev's answer for one group, as Apply reads it: the ranked rows and Jev's CURRENT ticks. */
export interface JevGroupSuggestion {
  readonly items: readonly RankedEntity[];
  /** Ticked ids in rank order (Jev's seed, plus any re-ticks the person made in the panel). */
  readonly ticked: readonly string[];
}

export interface JevGroupEditResult {
  /** The group's edit after Apply. */
  readonly edit: LaunchGroupEdit;
  /** Display rows for every id the edit ADDS — hand them to the sheet so a Jev pick keeps its title. */
  readonly rows: readonly LaunchContextRow[];
  /** Why each default Jev left unticked is out (`over-budget` / `below-floor`), so the row says it — never a silent drop. */
  readonly reasons: Readonly<Record<string, RankedEntityReason>>;
  /** The diff Jev itself decided (ledger material): removed defaults, added picks. */
  readonly diff: LaunchGroupEdit;
  /** Every id Apply decided — what Undo restores via `restoreRows`. */
  readonly touched: readonly EntityId[];
  /** Why Apply must be refused on this group (locked, or past the ceiling); null when it may. */
  readonly refusal: string | null;
}

/** A ranked row in the launch sheet's shape, for a row Apply adds. Plain text: graph content. */
export function jevContextRow(item: RankedEntity): LaunchContextRow {
  const text = item.header.whenToUse ?? item.header.summary;
  return {
    id: item.entityId as EntityId,
    kind: item.kind,
    title: item.title,
    text,
    derived: text !== null && item.header.source !== 'authored',
    via: null,
  };
}

/**
 * APPLYING JEV TO ONE GROUP — the one pure function every surface calls
 * (agreed with lanes B/C/D). Jev's ticks become the group's ordinary edit:
 * each row Jev ranked takes Jev's verdict, every other row keeps its state.
 */
export function jevGroupEdit(
  defaults: LaunchGroupDefaults,
  edit: LaunchGroupEdit,
  suggestion: JevGroupSuggestion,
): JevGroupEditResult {
  const decided = suggestion.items.map((item) => ({ id: item.entityId as EntityId, isDefault: item.default }));
  const ticked = suggestion.ticked as readonly EntityId[];
  const next = applyJevToEdit(edit, decided, ticked);
  const diff = jevGroupDiff(decided, ticked);
  const adding = new Set<string>(diff.added);
  const removing = new Set<string>(diff.removed);
  const reasons: Record<string, RankedEntityReason> = {};
  for (const item of suggestion.items) if (removing.has(item.entityId) && item.reason) reasons[item.entityId] = item.reason;
  return {
    edit: next,
    rows: suggestion.items.filter((item) => adding.has(item.entityId)).map(jevContextRow),
    reasons,
    diff,
    touched: decided.map((row) => row.id),
    refusal: jevApplyRefusal(defaults, next),
  };
}
