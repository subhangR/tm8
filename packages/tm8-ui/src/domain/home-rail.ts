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
 * (R3: every collection kind is a root, custom kinds included) — with one
 * stated exception, `HOME_RAIL_WITHHELD_KINDS`, which NARROWS it and says
 * per kind why.
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
 * curates presentation, it never gates membership (the one exception is
 * `HOME_RAIL_WITHHELD_KINDS` below, which is a stated withdrawal rather than
 * an omission).
 *
 * THE SPINE IS SEVEN GROUPS, AND THE GROUPING IS THE POINT (reporter ruling,
 * 2026-09-17, task 01a0ada5 "Organizing the icon rail"). Before this it was
 * three — Work / Library / People — and "Work" had swallowed nine kinds
 * spanning three unrelated questions: what is being done (chats, tasks,
 * sessions), what it is being done to (projects, docs), and what the
 * repository recorded afterwards (commits, PRs, worktrees). A nine-row group
 * under one word is an unsorted list wearing a label, which is what the
 * ruling names. Each group below answers ONE question, and its label is that
 * question's short noun:
 *
 *   Work       — what is in flight right now.
 *   Agents     — who does the work and what they carry into it.
 *   Content    — what the work produces and reads.
 *   Structure  — how any of it is organised or related.
 *   People     — the humans, and where they talk.
 *   Code       — what the repository recorded.
 *   Beta       — shipped, reachable, and not yet settled.
 *
 * THE LABELS ARE LOAD-BEARING, NOT DECORATION. The collapsed rail is the
 * DEFAULT state (72px, `HomeView`), so a label only the expanded rail draws
 * is a label most viewers never see — which would have left this ruling's
 * "give each of them an apt subheading" satisfied in code and unsatisfied on
 * screen. `HomeRail` therefore draws the eyebrow in BOTH widths; that is why
 * every label here is short enough to set at 72px.
 */
const HOME_RAIL_GROUP_SPINE: readonly HomeRailGroupSpec[] = [
  {
    id: 'work',
    label: 'Work',
    // `chat` still LEADS, for the reason it has led since 2026-09-05: the
    // Chats tab left the top row and this row is its door, a conversation is
    // where work in this space starts, and a chat is what spawns the
    // `work_session` two rows down. `project` closes the group as the thing
    // all three hang off.
    kinds: ['chat', 'task', 'work_session', 'project'],
  },
  {
    id: 'agents',
    label: 'Agents',
    // A teammate and the two libraries it draws on. `skill` and `memory` sat
    // in the old "Library" beside files and artifacts, which filed a
    // teammate's capability and its recall as documents; they are neither.
    kinds: ['team_member', 'skill', 'memory'],
  },
  {
    id: 'content',
    label: 'Content',
    // Authored, produced, uploaded — in that order, which is also the order
    // of how much of it a space typically has.
    //
    // `drawing` sits beside `doc` because it is AUTHORED: someone made it here,
    // in the app, from nothing. It is deliberately not in `structure` beside
    // `collection` and `graph` — those are arrangements OVER things work
    // produced, and a hand-drawn canvas arranges nothing; it IS the thing.
    kinds: ['doc', 'drawing', 'artifact', 'file'],
  },
  {
    id: 'structure',
    label: 'Structure',
    // Neither of these is a thing work produces; both are arrangements OVER
    // things work produced. A curated set, and an extracted index.
    kinds: ['collection', 'graph'],
  },
  {
    id: 'people',
    label: 'People',
    // Humans only. `team_member` used to share this group; it moved to
    // `agents`, where the things that configure it live.
    kinds: ['member', 'channel'],
  },
  {
    id: 'code',
    label: 'Code',
    // The repository's own record, which the old spine had scattered across
    // the tail of a nine-row "Work". Read in the order a change travels:
    // commit, then the review it landed through, then the checkout it ran in.
    kinds: ['commit', 'pull_request', 'worktree'],
  },
  {
    id: 'beta',
    label: 'Beta',
    // NAMED BY THE RULING, and the name is the content: these three ship and
    // are reachable, and their shape is not settled. The group exists so a
    // viewer can tell that from the rail instead of from a release note.
    // `container` left the Work group for this one — a machine is where work
    // runs, but the kind itself is still moving.
    kinds: ['loop', 'spell', 'container'],
  },
];

/**
 * Collection kinds the rail deliberately does NOT offer as a Home root —
 * the single, stated exception to "the spine curates, it never gates" (R3).
 *
 * `interaction_profile` (reporter ruling, 2026-09-17): a profile is not a
 * population anybody browses. It is a SETTING that a session or a teammate
 * carries, it is chosen from the entity that carries it (`EntityControls`),
 * and it is immutable once pinned. Under the old spine it belonged to no
 * group at all, so it rendered under "More" — a browsable root filed beside
 * whatever custom kinds a space happens to have, which is how a settings row
 * ended up in an entity rail in the first place.
 *
 * WITHHELD, NOT DELETED, and the distinction is the whole design. The
 * registry row stays; the kind is still created, still resolved, still drawn
 * wherever an entity names its profile. What goes is the ROOT: the rail row,
 * the list header's kind switcher entry, the Workspace column menu and the
 * mobile drawer row, all four of which read this one table.
 *
 * `isHomeRootKind` honours this too, on purpose. A withheld kind that a
 * stored root or a hand-typed `k/` route could still select would open a list
 * whose own switcher cannot name it — so a stale selection falls back to the
 * default root instead. Withholding a kind here is therefore a real decision
 * about the product, not a display filter, and it is deliberately harder to
 * reach for than adding a spine group.
 */
export const HOME_RAIL_WITHHELD_KINDS: readonly string[] = ['interaction_profile'];

export interface HomeRailGroup {
  id: string;
  label: string;
  kinds: readonly KindConfig[];
}

/** Every collection kind the rail is willing to offer as a root. */
function railEligibleKinds(): KindConfig[] {
  return collectionKinds().filter((config) => !HOME_RAIL_WITHHELD_KINDS.includes(config.kind));
}

/** The rail, resolved against the live registry. Never empty groups. */
export function homeRailGroups(): HomeRailGroup[] {
  const eligible = railEligibleKinds();
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
  return railEligibleKinds().some((config) => config.kind === kind);
}
