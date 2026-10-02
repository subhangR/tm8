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
 * CLASSIFY what `collectionKinds()` already offers, they never widen or
 * narrow it (R3: every collection kind is a root, custom kinds included —
 * and since 2026-09-27, with no exceptions; see `setup` below).
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
 * WHAT THE COLUMN LISTS WHILE THE ADDRESS SAYS `CHATS_ROOT` (task 01a0df28):
 * the `chat` kind's own list. The `[Chats ＋]` header cell — the only door to
 * the thread-list arrangement — was removed once a chat became an entity, and
 * the reporter ruled the kind list replaces it. The address keeps its `chats`
 * form (`/home/chat/{id}` still names the open conversation); only the COLUMN
 * stopped drawing the thread list.
 */
export const CHATS_ROOT_LIST_KIND = 'chat';

/**
 * The quick-create icons, in order — task, chat, terminal (task 01a0df28).
 * Kinds, not verbs: each is born through its own registry birth verb
 * (`list.quickStart`) or the generic create, exactly as the kind menu's ＋.
 */
export const HOME_QUICK_BIRTH_KINDS: readonly string[] = ['task', 'chat', 'work_session'];

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
 *
 * FIVE GROUPS, EACH COLLAPSIBLE (reporter ruling 2026-10-02, task 01a0fb09
 * "Icon Rail Collapse"). The eight-group spine of 01a0ada5 answered "what
 * does each heading mean", but with every group open the rail was 26 rows
 * tall — "too many entities showing". The ruling consolidated to five and
 * made each group an accordion section that remembers its own open state
 * (`homeRailStore`), closed by default except the one holding the list you
 * are viewing. The rows you reach daily do not depend on a group being open:
 * the create buttons and the PINNED section sit above every group.
 *
 *   Work            — what is in flight right now.
 *   Library         — what the work produces and reads, and the arrangements
 *                     over it (the old Content + Structure).
 *   Agents & People — who does the work, what it carries into it, and the
 *                     humans and where they talk (old Agents + People).
 *   Code            — what the repository recorded.
 *   Admin           — how this space is wired, plus the kinds whose shape is
 *                     not settled yet (old Setup + Beta).
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
    //
    // `form` (209) follows `work_session` because a session is what asks one:
    // it is the question an agent is waiting on a human to answer, mid-work.
    // `story` (283) sits right above `task`: it is the level work is told at —
    // one idea, its roots and where it stands — so it reads before the tasks
    // it gathers rather than among the containers in Structure.
    kinds: ['chat', 'story', 'task', 'work_session', 'form', 'project'],
  },
  {
    id: 'library',
    label: 'Library',
    // Authored, produced, uploaded — then the two arrangements OVER those
    // things: a curated set and an extracted index. `drawing` sits beside
    // `doc` because it is AUTHORED, not an arrangement.
    kinds: ['doc', 'drawing', 'artifact', 'file', 'collection', 'graph'],
  },
  {
    id: 'people',
    label: 'Agents & People',
    // A teammate and the two libraries it draws on, then the humans and the
    // channels they talk in.
    kinds: ['team_member', 'skill', 'memory', 'member', 'channel'],
  },
  {
    id: 'code',
    label: 'Code',
    // The repository's own record, in the order a change travels: commit,
    // then the review it landed through, then the checkout it ran in.
    kinds: ['commit', 'pull_request', 'worktree'],
  },
  {
    id: 'admin',
    label: 'Admin',
    // OWNER RULING 2026-09-27: Home lists EVERY kind — nothing hidden. The
    // first four are settings with a home elsewhere (`KindConfig.settingsHome`
    // links there from the list header and the panel); none has a create door
    // on Home. What a session launches under, the keys it runs with, then the
    // other spaces and machines this one reaches.
    //
    // The last three were the "Beta" group: shipped and reachable, shape not
    // settled. They sit last so the settled kinds read first. `style` (284)
    // follows them: the space's published themes are picked from the
    // account menu, not created here — the same "listed, managed elsewhere" shape.
    // `op_request` (280) follows `server`: every op an agent may ask for today
    // changes one of these (a space link, a gate folder, a path grant).
    kinds: ['interaction_profile', 'credential', 'space_link', 'server', 'op_request', 'style', 'loop', 'spell', 'container'],
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

/**
 * Whether a stored root or a hand-typed `k/` route names a kind Home can list.
 * An unknown or non-collection kind falls back to the default root.
 */
export function isHomeRootKind(kind: string): boolean {
  return collectionKinds().some((config) => config.kind === kind);
}

/** The column root for an address root — `CHATS_ROOT` lists the chat kind. */
export function homeColumnRoot(root: HomeRoot): HomeRoot {
  if (root !== CHATS_ROOT) return root;
  return isHomeRootKind(CHATS_ROOT_LIST_KIND) ? CHATS_ROOT_LIST_KIND : DEFAULT_HOME_KIND;
}

/** The quick-create kinds this registry actually has, in `HOME_QUICK_BIRTH_KINDS` order. */
export function homeQuickBirthKinds(): KindConfig[] {
  const byKind = new Map<string, KindConfig>(homeRootKinds().map((config) => [config.kind, config]));
  return HOME_QUICK_BIRTH_KINDS.flatMap((kind) => {
    const config = byKind.get(kind);
    return config ? [config] : [];
  });
}

/**
 * The rail's PINNED section on first visit (task 01a0fb09) — the three lists
 * the ruling named. The viewer pins and unpins from there on; the stored set
 * replaces this one entirely (`homeRailStore`).
 */
export const DEFAULT_HOME_RAIL_PINS: readonly string[] = ['chat', 'task', 'work_session'];

/** Stored pin names → the collection kinds this registry still has, in pin order. */
export function homeRailPinnedKinds(pins: readonly string[]): KindConfig[] {
  const byKind = new Map<string, KindConfig>(collectionKinds().map((config) => [config.kind, config]));
  return [...new Set(pins)].flatMap((kind) => {
    const config = byKind.get(kind);
    return config ? [config] : [];
  });
}
