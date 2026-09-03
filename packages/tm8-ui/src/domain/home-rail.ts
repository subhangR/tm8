/**
 * The unified Home's ROOT vocabulary and icon-rail composition (task
 * 01a00932, rulings R3/R4; docs/features/home/UNIFIED-HOME-DESIGN.md D3).
 *
 * Home's left column lists ONE root population at a time: the chat threads,
 * or one entity kind's collection. The icon rail and the list header's kind
 * switcher are two views of the SAME selection — R4 says the rail is entities
 * only and its grouping is purely visual, so both render from this one table
 * and neither can drift from the other.
 *
 * WHY THIS LIVES IN `domain/`. The rail must name kinds to group them, and
 * §15.2 makes a kind literal outside `domain/`/`fixtures/` a build failure —
 * the same D18 precedent that put `SHIPPED_DEFAULT_MENU` and
 * `HOME_RAIL_KINDS` here. It is registry-adjacent DATA: the groups only
 * CLASSIFY what `collectionKinds()` already offers, they never widen it
 * (R3: every collection kind is a root, custom kinds included).
 *
 * WHY THIS IS NOT MenuConfig. The frozen menu DTO caps a group at 12 items
 * and caret children at 8; the full kind list does not fit, and a server
 * round-trip would have to chase the registry. Home stays a RAILLESS menu
 * group (one childless `dashboard` view item) and this rail is part of the
 * Home SCREEN, derived from the registry at render time.
 */
import { collectionKinds } from './registry';
import type { KindConfig } from './types';

/**
 * The one non-kind root: the chat thread LIST — the two-pane conversation
 * surface, a thread column beside a transcript. Not a registry kind (it is
 * composed from `message` rows, which are `strategy: 'anchored'`), so it is a
 * named sentinel beside the kind names, and the rail still never draws it:
 * the `[Chats ＋]` header cell owns this root.
 *
 * IT IS NOT THE `chat` KIND ROW BELOW, and the two are deliberately both
 * reachable. Migration 176 made a chat an ENTITY, so `chat` is an ordinary
 * collection kind with an ordinary list — tiles carrying the turn state, the
 * lifecycle tabs, sort, in-panel search, the row-action cluster. That is a
 * different ARRANGEMENT over the same conversations, which is the same
 * two-doors posture the Board tab has always taken toward `task` (design R9),
 * and it is the reasoning revision 22 of the shipped menu wrote down for the
 * Chats TAB. This lane keeps the reasoning and moves the door: the tab is
 * gone from the top row and the arrangement is a rail row.
 */
export const CHATS_ROOT = 'chats';

/** A Home root: `CHATS_ROOT`, or the name of a collection kind. */
export type HomeRoot = string;

/** The kind the switcher cell shows before the viewer ever picks one. */
export const DEFAULT_HOME_KIND = 'task';

/**
 * `homeRegionStore` persisted the three-tab column's names before the roots
 * generalized (task 01a006f8 → 01a00932). A stored legacy value still means
 * what it meant.
 */
export const LEGACY_HOME_TAB_KINDS: Readonly<Record<string, string>> = {
  tasks: 'task',
  sessions: 'work_session',
};

interface HomeRailGroupSpec {
  id: string;
  label: string;
  kinds: readonly string[];
}

/**
 * Visual classification ONLY (R4): the order and the section labels. A kind
 * missing from the registry's collection set is skipped; a collection kind
 * missing from this spine still renders, appended under "More" — the spine
 * curates presentation, it never gates membership.
 */
const HOME_RAIL_GROUP_SPINE: readonly HomeRailGroupSpec[] = [
  {
    id: 'work',
    label: 'Work',
    // `chat` LEADS (2026-09-05): the Chats tab left the top row and its door
    // is this row. It leads rather than sitting wherever the registry happens
    // to order it because a conversation is where work in this space starts —
    // a chat is what spawns the `work_session` two rows down — and because the
    // door it replaces led the tab row too. Before this it was in no group at
    // all, so it rendered under "More": a real row, but filed as an
    // afterthought beside custom kinds.
    // `container` sits after `work_session` (Design §13.1): a machine is a
    // place work runs, so it belongs beside the runs and not in the library.
    kinds: ['chat', 'task', 'work_session', 'container', 'doc', 'project', 'pull_request', 'worktree', 'commit'],
  },
  {
    id: 'library',
    label: 'Library',
    kinds: ['file', 'artifact', 'memory', 'collection', 'spell', 'skill', 'loop'],
  },
  {
    id: 'people',
    label: 'People',
    kinds: ['team_member', 'member', 'channel'],
  },
];

export interface HomeRailGroup {
  id: string;
  label: string;
  kinds: readonly KindConfig[];
}

/** The rail, resolved against the live registry. Never empty groups. */
export function homeRailGroups(): HomeRailGroup[] {
  const eligible = collectionKinds();
  const byKind = new Map<string, KindConfig>(eligible.map((config) => [config.kind, config]));
  const placed = new Set<string>();
  const groups: HomeRailGroup[] = HOME_RAIL_GROUP_SPINE.map((spec) => ({
    id: spec.id,
    label: spec.label,
    kinds: spec.kinds.flatMap((kind) => {
      const config = byKind.get(kind);
      if (!config) return [];
      placed.add(kind);
      return [config];
    }),
  }));
  const rest = eligible.filter((config) => !placed.has(config.kind));
  if (rest.length > 0) groups.push({ id: 'more', label: 'More', kinds: rest });
  return groups.filter((group) => group.kinds.length > 0);
}

/**
 * The switcher's kind list — the rail FLATTENED, by construction (R4: same
 * state, same population; only the arrangement differs).
 */
export function homeRootKinds(): KindConfig[] {
  return homeRailGroups().flatMap((group) => [...group.kinds]);
}

export function isHomeRootKind(kind: string): boolean {
  return collectionKinds().some((config) => config.kind === kind);
}
