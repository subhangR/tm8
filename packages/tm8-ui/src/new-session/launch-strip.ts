import type { EntityId, SpawnSelectionGroup } from '@tm8/contract';

import {
  isTicked,
  type LaunchContextRow,
  type LaunchGroupEdit,
  type LaunchSelectionDefaults,
  type LaunchSelectionEdits,
} from '../domain/launch-selection';

/**
 * THE LAUNCH CARD v3 STRIP (mock 01a0df08 rev 9) — one row of TYPE groups
 * under the notes, in a fixed order: FILES FIRST, then memories, skills,
 * tasks, docs, artifacts, drawings. Each group shows only when it has a row.
 *
 * The node still speaks in three selection groups (memories, skills,
 * references); the strip is a VIEW over them. The five reference kinds are
 * exactly the kinds `selection.referenceIds` takes, so every strip group maps
 * back to one selection group and an edit made here is an ordinary selection
 * edit — the same diff the v2 chips wrote.
 *
 * WHOSE EACH ROW IS (rev 5): a default you kept or a row you added is YOURS;
 * a row Jev's Apply added is Jev's (`✦ N`); a default Jev's Apply left out is
 * "✦ left out". Jev's rows come from the hook's `carried` ledger, so a row a
 * person re-ticks by hand after Jev stops being Jev's.
 */

export type StripKind = 'file' | 'memory' | 'skill' | 'teammate' | 'task' | 'doc' | 'artifact' | 'drawing';

/** The strip's groups: the three selection groups, plus teammates (Decision 7 — not sendable until `selection.teammateIds`). */
export type StripGroupKey = SpawnSelectionGroup | 'teammates';

export interface StripKindDef {
  kind: StripKind;
  glyph: string;
  one: string;
  many: string;
  /** The selection group this kind rides. */
  group: StripGroupKey;
}

export const STRIP_KINDS: readonly StripKindDef[] = [
  { kind: 'file', glyph: '⎘', one: 'file', many: 'files', group: 'references' },
  { kind: 'memory', glyph: '◈', one: 'memory', many: 'memories', group: 'memories' },
  { kind: 'skill', glyph: '✧', one: 'skill', many: 'skills', group: 'skills' },
  /* Other teammates the agent can ask (roster entries, never inlined) — Decision 7. */
  { kind: 'teammate', glyph: '◉', one: 'teammate', many: 'teammates', group: 'teammates' },
  { kind: 'task', glyph: '▣', one: 'task', many: 'tasks', group: 'references' },
  { kind: 'doc', glyph: '▤', one: 'doc', many: 'docs', group: 'references' },
  { kind: 'artifact', glyph: '◇', one: 'artifact', many: 'artifacts', group: 'references' },
  { kind: 'drawing', glyph: '✎', one: 'drawing', many: 'drawings', group: 'references' },
];

export const STRIP_KIND: Readonly<Record<StripKind, StripKindDef>> = Object.fromEntries(
  STRIP_KINDS.map((def) => [def.kind, def]),
) as Record<StripKind, StripKindDef>;

/** The strip group a row lands in. A reference of a kind the strip doesn't name is shown with docs. */
export function stripKindOf(group: StripGroupKey, kind: string): StripKind {
  if (group === 'teammates') return 'teammate';
  if (group === 'memories') return 'memory';
  if (group === 'skills') return 'skill';
  return (STRIP_KINDS.some((def) => def.kind === kind) ? kind : 'doc') as StripKind;
}

/** Only these can be sent in full (rev 3): files, artifacts and drawings have no text to inline. */
export const IN_FULL_KINDS: readonly StripKind[] = ['memory', 'skill', 'task', 'doc'];

export const NOT_IN_FULL_REASON: Readonly<Partial<Record<StripKind, string>>> = {
  file: 'Files go in as file references, never inlined.',
  teammate: 'A teammate goes in as a roster entry, never inlined.',
  artifact: 'An artifact has no text to inline — it stays in the strip.',
  drawing: 'A drawing has no text to inline — it stays in the strip.',
};

export type StripSource = 'default' | 'added' | 'jev';

export interface StripRow {
  id: EntityId;
  kind: string;
  title: string;
  group: StripGroupKey;
  ticked: boolean;
  source: StripSource;
  /** A default's "why": the teammate's, linked to the task, … */
  via: string | null;
  /** Jev's hand in this row: it added it, or its Apply left this default out. */
  jev: 'picked' | 'left-out' | null;
  /** Jev's words for the row, when it said any. */
  jevWhy: string | null;
  /** Why this row can't reach the launch yet (teammates: no `selection.teammateIds`). */
  unsent?: string;
}

export interface StripGroup {
  def: StripKindDef;
  rows: readonly StripRow[];
  /** Ticked rows that are yours: kept defaults and your additions. */
  yours: number;
  /** Ticked rows Jev added. */
  jev: number;
  /** You added or removed something here — the chip turns amber. */
  edited: boolean;
  added: number;
  removed: number;
}

/** Jev's still-carried changes per selection group, and its words per row. */
export interface StripJev {
  carried: Partial<Record<SpawnSelectionGroup, { added: readonly EntityId[]; removed: readonly EntityId[] }>>;
  why: Readonly<Record<string, string>>;
}

const VIA_WORD: Readonly<Record<string, string>> = {
  teammate: 'the teammate’s',
  inherited: 'inherited',
  task: 'the task’s',
  linked: 'linked to the task',
  attached: 'attached to the task',
};

export function viaWord(via: string | null): string | null {
  return via ? VIA_WORD[via] ?? via : null;
}

/**
 * The strip, in order, empty groups dropped. Rows are the group's ready
 * defaults (ticked or not — an unticked default stays visible) plus every
 * addition still ticked.
 */
export function buildStrip(args: {
  defaults: LaunchSelectionDefaults;
  edits: LaunchSelectionEdits;
  added: Readonly<Record<SpawnSelectionGroup, readonly LaunchContextRow[]>>;
  jev?: StripJev;
  /** Teammate rows (Jev's other suggested teammates), drawn but not sent yet. */
  teammates?: readonly StripRow[];
}): StripGroup[] {
  const { defaults, edits, added, jev } = args;
  const rows: StripRow[] = [...(args.teammates ?? [])];
  for (const group of ['memories', 'skills', 'references'] as const) {
    const d = defaults[group];
    const edit = edits[group];
    const carried = jev?.carried[group] ?? { added: [], removed: [] };
    const jevAdded = new Set<string>(carried.added);
    const jevRemoved = new Set<string>(carried.removed);
    const seen = new Set<string>();
    if (d.status === 'ready') {
      for (const row of d.rows) {
        seen.add(row.id);
        const ticked = isTicked(d, edit, row.id);
        rows.push({
          id: row.id,
          kind: row.kind,
          title: row.title,
          group,
          ticked,
          source: 'default',
          via: viaWord(row.via),
          jev: !ticked && jevRemoved.has(row.id) ? 'left-out' : null,
          jevWhy: jev?.why[row.id] ?? null,
        });
      }
    }
    for (const id of edit.added) {
      if (seen.has(id)) continue;
      const row = added[group].find((r) => r.id === id);
      if (!row) continue;
      const byJev = jevAdded.has(id);
      rows.push({
        id,
        kind: row.kind,
        title: row.title,
        group,
        ticked: true,
        source: byJev ? 'jev' : 'added',
        via: null,
        jev: byJev ? 'picked' : null,
        jevWhy: byJev ? jev?.why[id] ?? null : null,
      });
    }
  }

  return STRIP_KINDS.flatMap((def) => {
    const mine = rows.filter((row) => stripKindOf(row.group, row.kind) === def.kind);
    if (mine.length === 0) return [];
    const ticked = mine.filter((row) => row.ticked);
    const jevN = ticked.filter((row) => row.jev === 'picked').length;
    const addedN = ticked.filter((row) => row.source === 'added').length;
    const removedN = mine.filter((row) => row.source === 'default' && !row.ticked && row.jev === null).length;
    return [{
      def,
      rows: mine,
      yours: ticked.length - jevN,
      jev: jevN,
      edited: addedN > 0 || removedN > 0,
      added: addedN,
      removed: removedN,
    }];
  });
}

/** The chip's tooltip (rev 5): "3 yours + 1 from Jev · you added 1 · context index entries". */
export function stripChipTitle(group: StripGroup): string {
  const parts = [`${String(group.yours)} yours${group.jev ? ` + ${String(group.jev)} from Jev` : ''}`];
  if (group.edited) {
    parts.push(`you ${[
      group.added ? `added ${String(group.added)}` : '',
      group.removed ? `removed ${String(group.removed)}` : '',
    ].filter(Boolean).join(', ')}`);
  }
  parts.push(group.def.kind === 'file' ? 'file references' : 'context index entries');
  return parts.join(' · ');
}

/**
 * ADD SEVERAL AT ONCE. `useLaunchSelection().toggle` computes each tick from
 * the render's edits, so ticking five rows in one click would keep only the
 * last per group. This folds the picks into ONE edit per group instead, for
 * `setEdit`: a default someone removed is ticked back (dropped from
 * `removed`), anything else joins `added` in pick order.
 */
export function addToEdits(
  defaults: LaunchSelectionDefaults,
  edits: LaunchSelectionEdits,
  picks: readonly LaunchContextRow[],
  groupOf: (row: LaunchContextRow) => SpawnSelectionGroup,
): Partial<Record<SpawnSelectionGroup, { edit: LaunchGroupEdit; rows: LaunchContextRow[] }>> {
  const out: Partial<Record<SpawnSelectionGroup, { edit: LaunchGroupEdit; rows: LaunchContextRow[] }>> = {};
  for (const row of picks) {
    const group = groupOf(row);
    const d = defaults[group];
    const current = out[group] ?? { edit: { removed: [...edits[group].removed], added: [...edits[group].added] }, rows: [] };
    const isDefault = d.status === 'ready' && d.rows.some((r) => r.id === row.id);
    if (isDefault) {
      current.edit = { ...current.edit, removed: current.edit.removed.filter((id) => id !== row.id) };
    } else if (!current.edit.added.includes(row.id)) {
      current.edit = { ...current.edit, added: [...current.edit.added, row.id] };
      current.rows.push(row);
    }
    out[group] = current;
  }
  return out;
}
