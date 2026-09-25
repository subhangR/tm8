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
  type EntityId,
  type LaunchDefaultItem,
  type LaunchDefaultsGroup,
  type LaunchDefaultVia,
  type SpawnSelection,
  type SpawnSelectionDefaultReason,
  type SpawnSelectionGroup,
} from '@tm8/contract';

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
 * The spawn fields for a launch. `override` (Ask Jev's groups, while the sheet
 * is in Jev mode) replaces the manual outcome of the groups it names.
 *
 * `selection` is left out when no group is sent, so an untouched launch loads
 * exactly today's defaults. `selectionReasons` names EVERY omitted group — an
 * audit-only field the node records in `manifest.context.groups`, so a failed
 * Jev group is visible rather than a generic "no selection".
 *
 * Never sends a group above the ceiling: such a group falls back to its
 * defaults. `toggleRow` makes that unreachable from the sheet; this is the
 * floor under any other caller.
 */
export function composeSelection(
  manual: Readonly<Record<SpawnSelectionGroup, GroupOutcome>>,
  override: Partial<Record<SpawnSelectionGroup, GroupOutcome>> = {},
): LaunchSelectionFields {
  const selection: SpawnSelection = {};
  const reasons: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>> = {};
  for (const group of LAUNCH_SELECTION_GROUPS) {
    const outcome = override[group] ?? manual[group];
    if ('send' in outcome && outcome.send.length <= SPAWN_SELECTION_GROUP_LIMIT) {
      selection[SELECTION_KEY[group]] = [...outcome.send];
    } else {
      reasons[group] = 'omit' in outcome ? outcome.omit : 'not-asked';
    }
  }
  return {
    ...(Object.keys(selection).length > 0 ? { selection } : {}),
    ...(Object.keys(reasons).length > 0 ? { selectionReasons: reasons } : {}),
  };
}
