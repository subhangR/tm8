/**
 * HomePage — the merged single home (user ruling, task 01a0027d, 2026-08-14).
 *
 * A DASHBOARD, NOT A DIRECTORY (owner ruling, 2026-08-30). Every element here
 * is one of three things — something LIVE, something MINE and recent, or an
 * ACTION I can start. Anything that is none of the three belongs on another
 * screen:
 *
 *   1. MY LIVE SESSIONS first: what is running right now, wearing the seam's
 *      verdict rather than its own record, so a session the node cannot
 *      account for reads `stale` instead of claiming to run.
 *   2. NEEDS YOU beneath it — triage outranks everything.
 *   3. MY TASKS — mine, and recent.
 *   4. The CHAT is the hero, mounted solo (its thread sidebar hidden by this
 *      module's stylesheet; full thread management stays on Messages).
 *
 * The WORKSPACE MAP used to lead this page and is gone: it rendered the same
 * `EntityNavigationGroup[]` as the rail beside it, so the screen asked "what
 * kinds of thing exist here" twice and answered "what am I doing" nowhere.
 * The taxonomy lives in the rail, once; `Open Workspace` is still the escape
 * hatch, so Home never becomes a capability cul-de-sac.
 *
 * WHAT THIS FILE DELIBERATELY REUSES rather than re-implements:
 *   - `useHomeData` / `composeMyWork` (src/home) — the NEEDS YOU composition
 *     with all its honesty rules (viewer-unknown ≠ empty, refused inbox ≠
 *     quiet inbox). This module renders the section; it re-derives nothing.
 *   - `homeRowOf` — the one summary→row projection, so a rail card's status
 *     word and dot obey the same verdict-outranks-record law as every other
 *     surface.
 *
 * Rails are GLANCEABLE, not exhaustive: the top rows by `activityAt`,
 * sideways-scrolling, with the rail header opening the full collection. Depth
 * lives in Workspace; this page is peripheral vision around the conversation.
 *
 * §15.2: no kind literal appears in this directory — the rail and presence
 * kinds come from `domain/home-page.ts`, presence state is read structurally
 * (`'liveWork' in state`), and every glyph resolves through the registry.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  entityNavigationLabel,
  getKind,
  KindIcon,
  type EntityNavigationGroup,
} from '../domain';
import {
  composeMyWork,
  type ChatThreadLite,
  useHomeData,
  type HomeScreenData,
  type HomeSection,
  type HomeRow,
} from '../home';
import { EntityNavigationMetrics } from '../navigation';
import { LinkedPullRequestChips, type LinkedPullRequestFacts } from '../pull-requests';
/* THE LIST PANEL'S OWN BADGE ROW, mounted here rather than re-implemented — see
   the links-line note at its mount. One component, one vocabulary, one set of
   honesty rules about absent and zero counters. */
import { TileCountBadges, hasTileCounts } from '../panels/list/TileCountBadges';
import './home-page.css';

export interface HomePageProps {
  data: HomeScreenData;
  /** The chat surface — the host mounts it (seam wiring is its business). */
  chat: ReactNode;
  /**
   * The entity opened FROM this page, shown BESIDE it rather than instead of
   * it. Absent ⇒ no column at all: a host with nowhere to put a detail must
   * not be handed a slot that draws an empty one.
   *
   * The column AND its chrome are the host's (`views/HomeView`), exactly as
   * they are on the channel screen — this page only makes room. That is why
   * the node lands here unwrapped: the separator that resizes the column has
   * to be its SIBLING, not something inside it.
   */
  aside?: ReactNode;
  /**
   * The icon rail (task 01a00932 R4) — the host builds it (its state is the
   * host's root selection); this page only seats it leftmost in the row,
   * exactly as it makes room for the aside.
   */
  rail?: ReactNode;
  /**
   * THE SPLITTER BETWEEN THE TWO PANES — the drag handle and the control that
   * flips which way they sit (owner, 2026-08-31: "ideally horizontal split like
   * this? or some other layout … max height width adjustable up and down",
   * then "Priority is vertical split with full height").
   *
   * The host builds it for the same reason it builds the aside and the rail:
   * only the host holds the measurement the ceiling is solved from, and only
   * the host owns the persisted preference. This page seats it BETWEEN the two
   * panes as a real sibling — a separator nested inside one of the things it
   * moves cannot be dragged past that thing's own edge.
   *
   * Absent ⇒ the two panes still render, stacked, at their natural sizes. A
   * page that drew a seam with no handle on it would be a divider pretending to
   * be a control.
   */
  splitter?: ReactNode;
  /**
   * WHICH WAY THE TWO PANES SIT. `vertical` is side by side (each pane full
   * height on its own — the ruled default); `horizontal` is stacked (the grid
   * above, the conversation below, sharing the height).
   *
   * IT IS AN ATTRIBUTE, NOT A BRANCH, and that is load-bearing. Flipping the
   * arrangement must not remount either pane: the chat holds a scroll position,
   * a draft in its composer and possibly an in-flight read, and a conditional
   * that rendered two different trees would drop all three every time the
   * reader changed their mind about the shape. So the JSX below is IDENTICAL in
   * both arrangements and the axis reaches CSS as `data-split`.
   */
  splitAxis?: 'vertical' | 'horizontal';
  /**
   * BAND 3 — the ACTIVE pane collapsed to the seam, the conversation taking the
   * whole area. An attribute for the same reason `splitAxis` is one: the pane
   * stays MOUNTED and keeps its scroll position, its lens and any loaded page,
   * so revealing it puts the reader back exactly where they were. Unmounting it
   * would re-read on every toggle — the same reasoning `.tch-sidebar` carries
   * for its own collapse.
   */
  sideCollapsed?: boolean;
  /* `listRail` RETIRED (2026-08-30). It was the drag handle and reveal button
     for column A — `.tch-sidebar` — which no longer exists on this page: a
     kind's list is the working area now, not a third column. A separator for a
     panel that cannot appear is the same defect as the one measured at
     9px x 901px over the cards, one level up. */
  /** Rail + column A collapsed as one. Read by CSS off `data-focus`. */
  focus?: boolean;
  /** The exact enriched model also rendered by the persistent entity rail. */
  navigationGroups?: readonly EntityNavigationGroup[];
  /** A kind root is current only while Home is browsing an entity list. */
  activeKind?: string | null;
  /** Absent keeps the map informative but non-interactive. */
  onOpenKind?(kind: string): void;
  onOpenEntity(id: string): void;
  onOpenWorkspace(): void;
  /** Back to the new-conversation composer. Chat's own create. */
  onNewChat?: (() => void) | undefined;
  /** Create a kind and land on its root. The host already owns this verb. */
  onCreateKind?: ((kind: string) => void) | undefined;
  /**
   * WHY A CREATE IS REFUSED, when it is. A refused verb renders DISABLED WITH
   * THE REASON rather than vanishing — H2's ruling and it is right: a missing
   * button reads as a missing feature, a disabled one that says why reads as a
   * product that knows its own state. That difference is visible in a demo.
   */
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
  /**
   * THE PULL REQUESTS ALREADY ATTACHED TO A ROW. Owner, 2026-08-30, on the
   * deployed build: "PR links are clearly there" — they are, on the task list,
   * and Home simply never asked for them.
   *
   * Nothing new is fetched. `useGateData` already builds this index from the
   * graph nodes and edges it holds (`indexLinkedPullRequests`) and already
   * hands it to `EntityListPanel`; this is the same function reaching one more
   * surface. Optional, because a host that has not built the index must render
   * no chips rather than an empty row: "no PR row" and "no pull requests" are
   * different claims and only one of them is ours to make.
   */
  linkedPullRequestsOf?: ((id: string) => readonly LinkedPullRequestFacts[]) | undefined;
  /**
   * THE SELECTED KIND'S LIST — the working area when `activeKind` is set.
   *
   * Selecting a kind in the rail means "show me all of those", and it has
   * meant that since the rail existed. What broke was WHERE: the list rendered
   * into `.tch-sidebar`, a third column that restated the rail's own taxonomy,
   * and removing that column (twice, on the owner's instruction) silently made
   * the rail a no-op. Rendering it HERE, at full width, in place of the
   * dashboard, is the only arrangement where both instructions hold at once.
   */
  list?: ReactNode;
}

/**
 * START — the three verbs, first, before anything that merely exists.
 *
 * The owner asked for exactly these three by name and asked for them FIRST.
 * They are not new plumbing: `HomeChatRegions` already carries `onShowChat`
 * and `onCreateKind`, and `home-dashboard.ts` already declares this shape as
 * `HomeCreateVerbs` — which had no consumer until now. This is the consumer.
 *
 * ONE CONTROL PER VERB. `ListRootHeader` renders a create for the current kind
 * and the chat surface has its own `+ New chat`; this row is the SAME handlers
 * reached from the one screen the owner starts on, not a second set. Two
 * controls for one verb is how "options repeating" comes back.
 */
function HomeStart({
  onNewChat,
  onCreateKind,
  createKindUnavailable,
}: {
  onNewChat?: (() => void) | undefined;
  onCreateKind?: ((kind: string) => void) | undefined;
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
}) {
  /* A verb whose handler is absent is not rendered at all — that is a host
     that never wired it, which is different from a host that wired it and the
     server refused. The second gets a disabled control with its reason; the
     first would be a button we invented. */
  const kindVerb = (kind: string, label: string, blurb: string) => {
    if (!onCreateKind) return null;
    const refusal = createKindUnavailable?.(kind) ?? null;
    if (refusal) {
      return (
        <span className="hp-start__card hp-start__card--off" title={`${refusal.cause} — ${refusal.remedy}`}>
          <b>{label}</b>
          <span>{refusal.cause}</span>
        </span>
      );
    }
    return (
      <button type="button" className="hp-start__card" onClick={() => onCreateKind(kind)}>
        <b>{label}</b>
        <span>{blurb}</span>
      </button>
    );
  };

  /* NEW CHAT IS DELIBERATELY ABSENT, and this is the one place this row
   * departs from the owner's literal words ("one create new chat, New SESSIONS
   * AND New Task first").
   *
   * The chat surface ALREADY owns that verb — `ListRootHeader` renders a `+`
   * labelled "New chat" beside the Chats tab, two inches from here, on this
   * same screen. Adding a second one made the gate fail with
   *
   *   Found multiple elements with the role "button" and name /^New chat$/
   *
   * which is exactly what `HomeCreateVerbs`' own docblock predicted: "Two
   * controls for one verb is how 'options repeating' comes back, which is the
   * complaint the dashboard exists to answer." I quoted that rule and then
   * broke it in the same change.
   *
   * Removing the OTHER control was the alternative and it is the riskier half:
   * seven assertions across three files defend it, one of them the subtle
   * "a new conversation is not stolen" case.
   *
   * SO THIS IS THE OWNER'S CALL, NOT A SETTLED DESIGN. If they want all three
   * verbs together, the `+` moves into this row and those tests move with it.
   * What is not on the table is shipping two buttons that say "New chat". */
  /* NEW CHAT IS BACK. It was pulled on 2026-08-30 because `ListRootHeader`
     rendered a second control with the same accessible name and the gate
     caught it — "Found multiple elements with the role button and name
     /^New chat$/". That header lived in the middle column. The column is gone,
     so the duplicate is gone, so the third card returns. */
  const chat = onNewChat ? (
    <button type="button" className="hp-start__card" onClick={onNewChat}>
      <b>New chat</b>
      <span>Ask, plan, or think out loud</span>
    </button>
  ) : null;
  /* THE KIND MUST BE THE REGISTRY'S OWN `kind`, not the word in the label.
     This row read `'session'` and shipped a dead button: `getKind` never
     throws — a miss falls back to the `c:*` row (registry.ts) — so
     `rootBirthAction('session')` was undefined, the host's `birthFor` took
     the GENERIC-CREATE arm instead of `start-terminal`, and the fallback
     row's own `kind` (`c:*`) went out as the kind to create. Nothing caught
     it on the way: `c:*` satisfies `CustomEntityKindSchema` (`startsWith('c:')`),
     so `creatableKind` accepted it and the refusal never fired — the card
     rendered ENABLED and the node answered 409 `unregistered entity kind: c:*`.
     A wrong kind here is silent all the way to the database. */
  const session = kindVerb('work_session', 'New session', 'Put an agent on it and watch it work');
  const task = kindVerb('task', 'New task', 'Track a piece of work to done');

  /* Nothing wired ⇒ no row, rather than an empty box asserting "you can start
     things" and offering none. */
  if (!chat && !session && !task) return null;

  return (
    <section className="hp-start" aria-label="Start something">
      {chat}
      {session}
      {task}
    </section>
  );
}


/**
 * "2m" / "3h" / "5d" — the shortest true form.
 *
 * NO "just now" AND NO ROUNDING UP. A session stamped four minutes ago reads
 * `4m`, not `just now`, because the whole point of this line is telling a
 * stalled session from a live one at a glance. Anything under a minute is the
 * only case where a word beats a number, and it says `now` rather than `0m`.
 *
 * An unparseable stamp renders NOTHING rather than `NaN` or a guess.
 */
function sinceLabel(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}


/* ---------------------------------------------------------------------------
   THE ACTIVE STRIP'S TREE CONSTANTS (owner, 2026-08-31, choosing option B:
   "make sessions expand and collapse with limits — if it reaches limits break
   UI, just show 'other 3 sessions are running' … like a pagination approach
   within a tree")
   ---------------------------------------------------------------------------
   VALUES, NOT NUMBERS BURIED IN A BRANCH, so they can be tuned without hunting.
   They live HERE rather than beside the split's geometry in `views/HomeView`
   because the dependency only runs one way — the view mounts the page — and a
   page constant imported from its own host would be a cycle. */

/** How many children of one parent are drawn before the tree pages. Six is a
    glance: past it the eye stops counting rows and starts scanning, which is
    the point at which "how many are running under this" is better answered by
    a number than by a list. */
export const ACTIVE_CHILD_PAGE = 6;
/**
 * HOW FAR THE PANE INDENTS BEFORE IT STOPS.
 *
 * The DEPTH IS NOT CAPPED IN THE MODEL — `orderActive` walks n-deep and a
 * depth-6 subtree is fully ordered. What is capped is the INDENT, because 16px
 * a level walks a deep tree off the right edge of a 480px pane and the rows
 * that suffer are the deepest ones, which is exactly backwards. Past the cap
 * the row stops moving right and states its lineage in words instead — the
 * tether mark, which is the same fact carried by a different means.
 */
export const ACTIVE_INDENT_MAX_DEPTH = 4;

/** The four lenses on the active strip. `all` is the resting state. */
type ActiveLens = 'all' | 'chats' | 'sessions' | 'tasks';

/**
 * ONE LIST OF WHAT IS HAPPENING — sessions, chats and tasks together, because
 * the owner asked for exactly that ("Running sessions chats all active works
 * across all these is filter by chats active sessions active task active").
 *
 * THE LENS FILTERS; IT DOES NOT FETCH. Every row is already on the page, so
 * switching lens cannot fail, cannot spin, and cannot show a different truth
 * than `all` did a moment earlier. A filter that re-reads is a second source
 * of truth wearing a chip.
 */
function activeRows(
  live: HomeSection | null,
  tasks: HomeSection | null,
  chats: readonly ChatThreadLite[] | null,
  lens: ActiveLens,
): readonly (HomeRow & { lens: ActiveLens })[] {
  const s = (live?.rows ?? []).map((r) => ({ ...r, lens: 'sessions' as const }));
  const t = (tasks?.rows ?? []).map((r) => ({ ...r, lens: 'tasks' as const }));
  /* Chats arrive from the seam rather than the registry, so they are shaped
     here into the same row the other two already are — one row type, one card,
     one renderer. A second card shape per source is how a list stops looking
     like a list. */
  const c = (chats ?? []).map((thread) => ({
    id: thread.id,
    kind: null,
    title: thread.title?.trim() || 'Untitled chat',
    word: null,
    tone: 'idle' as const,
    dot: null,
    ...(thread.activityAt ? { activityAt: thread.activityAt } : {}),
    ...(typeof thread.messageCount === 'number' && thread.messageCount > 0
      ? { turns: thread.messageCount }
      : {}),
    lens: 'chats' as const,
  }));
  const all = [...s, ...c, ...t];
  const picked = lens === 'all' ? all : all.filter((r) => r.lens === lens);
  /* Most recently active first, across all three kinds — the only ordering
     that answers "what is happening" rather than "what kind is it". */
  return [...picked].sort((a, b) => (b.activityAt ?? '').localeCompare(a.activityAt ?? ''));
}


/** A row is LIVE iff its dot says so. Same predicate `liveCountLabel` counts
 *  with (home-model `liveCount`) — one definition of "running", not two. */
function isLive(row: HomeRow): boolean {
  return row.dot === 'pulse' || row.dot === 'solid';
}

/**
 * RUNNING FIRST, THEN BY ACTIVITY — and EVERYTHING is on the screen.
 *
 * THIS REPLACED A TOP-TEN CAP. The cap seated ten cards and put the other
 * fifty-three behind a button as rows. The owner's verdict on it, seeing it
 * live: "grid idea bane undi kani, showing only top few is not scalable and
 * limiting" — the grid is right, the ceiling is not. A fixed N is a guess
 * about how much work a space has, and it is wrong the moment the space grows.
 *
 * So nothing is dropped and nothing is hidden. The grid became a bounded
 * SCROLL REGION instead (`.hp-active__grid`), which is what actually scales:
 * ten items and a hundred items both cost the same vertical space on the page,
 * and the lens chips narrow it when you want less. The cap's one real job —
 * stopping sixty chats burying five running sessions — survives as the sort:
 * anything running comes first, everything else follows it by time.
 */
export function orderActive<T extends HomeRow>(rows: readonly T[]): readonly (T & { depth: number })[] {
  const at = (r: T) => r.activityAt ?? '';
  const byStanding = (a: T, b: T) => {
    const live = Number(isLive(b)) - Number(isLive(a));
    return live !== 0 ? live : at(b).localeCompare(at(a));
  };

  /*
   * THE TREE IS A DEPTH-FIRST WALK OF THE SAME ORDER, NOT A SECOND ORDER.
   *
   * Sessions spawn sessions, so `parentId` describes a real hierarchy on this
   * strip (owner ruling, 2026-08-31: "the session/sub-session tree must be
   * visible in the grid"). Two constraints decide the shape and they pull
   * against each other:
   *
   *   · A RUNNING CHILD IS ACTIVE WORK IN ITS OWN RIGHT. It must be a card and
   *     a row of its own — never something you have to expand a parent to
   *     find, because hiding running work is the exact opposite of what this
   *     strip is for. So nothing is nested AWAY; every row is still emitted.
   *   · AND THE TWO BANDS SHARE ONE DOM. The cards and the rows are the same
   *     markup under a container query, so there is ONE order and it has to
   *     serve both. A row band that nests needs children adjacent to their
   *     parent; a card band does not care, as long as the top-level ordering
   *     still puts what is running first.
   *
   * Depth-first satisfies both: siblings are ranked by the SAME running-first,
   * then-most-recent rule at every level, and each row is followed immediately
   * by its own children. The card band reads it as a flat sequence (and it is
   * one — no indentation, which in a wrapped grid reads as misalignment rather
   * than hierarchy); the row band indents on `depth`.
   *
   * A ROW WHOSE PARENT IS NOT IN THIS SET IS A ROOT HERE. That is the honest
   * reading: the lens may have filtered the parent out, or it may be older than
   * anything on screen. It is still marked as having a parent — see
   * `lineageOf` — so the card can say "spawned by something" without naming a
   * title it does not have.
   *
   * NO COLLAPSE MACHINERY, DELIBERATELY. The live data is depth two and one
   * child wide; expand/collapse state, its persistence and its keyboard model
   * would be a mechanism for a problem that does not exist yet. The depth is
   * uncapped in the MODEL — an n-deep walk — and capped only by what the pane
   * can show before it scrolls.
   */
  const present = new Set(rows.map((r) => r.id));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const row of rows) {
    const parent = row.parentId && present.has(row.parentId) ? row.parentId : null;
    if (parent === null || parent === row.id) {
      roots.push(row);
      continue;
    }
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(row);
    else childrenOf.set(parent, [row]);
  }

  const out: (T & { depth: number })[] = [];
  /* `seen` is a cycle guard, not defensive decoration: `parentId` comes off the
     wire and a cycle would make this walk never return. A row already emitted
     is skipped rather than repeated. */
  const seen = new Set<string>();
  const walk = (level: readonly T[], depth: number) => {
    for (const row of [...level].sort(byStanding)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ ...row, depth });
      const kids = childrenOf.get(row.id);
      if (kids) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  /* Anything a cycle stranded is still WORK, and work is never dropped from
     this strip. It comes out at the end, at the top level, in the same order. */
  for (const row of [...rows].sort(byStanding)) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      out.push({ ...row, depth: 0 });
    }
  }
  return out;
}

/**
 * WHAT A CARD SAYS ABOUT WHERE IT CAME FROM — resolved against the rows already
 * on screen, and never by asking for more.
 *
 * THREE ANSWERS, and the middle one is the one that is easy to get wrong:
 *   · no parent at all      → nothing is drawn. Absence is not a claim.
 *   · a parent WE CAN NAME  → "↳ from {title}".
 *   · a parent we cannot    → "↳ sub-session" — it says the row was spawned by
 *                             something without naming a title it does not
 *                             have. An empty "↳ from " is the failure this
 *                             branch exists to prevent: it reads as a missing
 *                             name rather than as an unresolved one.
 */
export function lineageOf(
  row: HomeRow,
  titleOf: (id: string) => string | undefined,
): string | null {
  if (!row.parentId) return null;
  const parent = titleOf(row.parentId)?.trim();
  return parent ? `↳ from ${parent}` : '↳ sub-session';
}

/** What a parent is hiding, counted from the DATA and never from what is drawn. */
export interface ChildTally {
  /** Direct children present in this result set. */
  total: number;
  /** How many of them are RUNNING. */
  running: number;
}

export function childTallies<T extends HomeRow>(rows: readonly T[]): Map<string, ChildTally> {
  const present = new Set(rows.map((r) => r.id));
  const out = new Map<string, ChildTally>();
  for (const row of rows) {
    if (!row.parentId || row.parentId === row.id || !present.has(row.parentId)) continue;
    const tally = out.get(row.parentId) ?? { total: 0, running: 0 };
    tally.total += 1;
    if (isLive(row)) tally.running += 1;
    out.set(row.parentId, tally);
  }
  return out;
}

/**
 * WHICH ROWS ARE ON SCREEN — expansion and pagination, applied to the ordered
 * walk (owner, 2026-08-31, option B).
 *
 * "make sessions expand and collapse with limits — if it reaches limits break
 *  UI, just show 'other 3 sessions are running'; if they wanted to close
 *  others, sessions open before sessions view so other can be seen — like a
 *  pagination approach within a tree"
 *
 * THE RULE THAT DECIDES EVERY BRANCH BELOW: a running child session is ACTIVE
 * WORK. It may be put away by the READER's own action — that is a choice they
 * made and can undo — but it must never be hidden by the LAYOUT deciding there
 * is no room. Hence:
 *
 *   · a parent with a running child DEFAULTS OPEN. A parent whose children are
 *     all idle may default closed; nothing running is behind a control the
 *     reader has not touched.
 *   · past `ACTIVE_CHILD_PAGE` the tree does not keep growing and it does not
 *     push the parent off the top. One more row stands in the child position
 *     saying how many are left AND that they are running — "3 more running" and
 *     "3 more" are different facts and only the first is worth interrupting a
 *     reader for. Pressing it pages the next N in, in place; nothing already
 *     open closes and the scroll does not move, because nothing above it
 *     changes height.
 *   · a collapsed parent still STATES its tally on its own row, so a closed
 *     branch never silently swallows running work.
 *
 * IT IS PURE. The strip owns the expansion state; this decides only what that
 * state means, which is what makes both halves testable without a browser.
 */
export type ActiveNode<T> =
  | { type: 'row'; key: string; row: T; depth: number }
  /** The pagination row. `running` is a subset of `hidden`, both counted from
   *  the data — a tally that read the visible rows would be a number that gets
   *  smaller as you reveal, which is the opposite of what it means. */
  | { type: 'more'; key: string; parentId: string; depth: number; hidden: number; running: number };

export function visibleTree<T extends HomeRow>(
  rows: readonly T[],
  opts: {
    /** The reader's override, where they have expressed one. */
    expandedOf(id: string): boolean | undefined;
    /** How many PAGES of children this parent has revealed (1 = the first N). */
    pagesOf(id: string): number;
    perPage?: number;
  },
): readonly ActiveNode<T>[] {
  const perPage = opts.perPage ?? ACTIVE_CHILD_PAGE;
  const ordered = orderActive(rows);
  const byId = new Map(ordered.map((r) => [r.id, r]));
  /* The ordered walk already has children immediately after their parent, so
     the child groups can be read straight off it — no second sort, and the
     sibling ranking (running first, then most recent) is inherited rather than
     recomputed, which is what stops the two orders drifting apart. */
  const kidsOf = new Map<string, (T & { depth: number })[]>();
  for (const row of ordered) {
    const parent = row.parentId && byId.has(row.parentId) && row.parentId !== row.id
      ? row.parentId
      : null;
    if (!parent) continue;
    const bucket = kidsOf.get(parent);
    if (bucket) bucket.push(row);
    else kidsOf.set(parent, [row]);
  }

  const out: ActiveNode<T>[] = [];
  const emit = (row: T & { depth: number }, depth: number) => {
    out.push({ type: 'row', key: row.id, row, depth });
    const kids = kidsOf.get(row.id);
    if (!kids || kids.length === 0) return;
    const override = opts.expandedOf(row.id);
    /* DEFAULT OPEN IFF SOMETHING UNDER IT IS RUNNING. */
    const open = override ?? kids.some(isLive);
    if (!open) return;
    const shown = Math.min(kids.length, Math.max(1, opts.pagesOf(row.id)) * perPage);
    for (const kid of kids.slice(0, shown)) emit(kid, depth + 1);
    const rest = kids.slice(shown);
    if (rest.length > 0) {
      out.push({
        type: 'more',
        key: `more:${row.id}`,
        parentId: row.id,
        depth: depth + 1,
        hidden: rest.length,
        running: rest.filter(isLive).length,
      });
    }
  };
  for (const row of ordered) {
    if (row.depth === 0) emit(row, 0);
  }
  return out;
}

const LENSES: readonly { id: ActiveLens; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'chats', label: 'chats' },
  { id: 'sessions', label: 'sessions' },
  { id: 'tasks', label: 'tasks' },
];

/**
 * ACTIVE — the whole dashboard, in one strip.
 *
 * ORDERED BY ACTIVITY, NOT BY KIND (owner: "have everything modified based on
 * date activity and progress"). The newest thing is first whether it is a
 * session, a chat or a task, because "what is happening" is a question about
 * time and the kind is a detail of the answer.
 *
 * COLOUR CARRIES THE KIND, LIGHTLY. Each card takes a soft tint of its kind's
 * tone — the tokens the rest of the app already uses for run/wait/info — so
 * three kinds are legible in one list without a second row of labels. The tint
 * is the SOFT variant, never the full tone: a full-strength ground behind body
 * text is a badge, not a card, and this list is read rather than scanned for
 * alarm. Status still carries its WORD; the colour never stands alone (C8/L10).
 */
function ActiveStrip({
  rows,
  lens,
  onLens,
  liveLabel,
  onOpen,
  linkedPullRequestsOf,
}: {
  rows: readonly (HomeRow & { lens: ActiveLens })[];
  lens: ActiveLens;
  onLens(next: ActiveLens): void;
  liveLabel: string;
  onOpen(id: string): void;
  linkedPullRequestsOf?: ((id: string) => readonly LinkedPullRequestFacts[]) | undefined;
}) {
  /* THE READER'S OWN TREE STATE, and only the reader's: `expanded` holds the
     parents they have TOUCHED, so a parent they have not is free to follow the
     default (open iff something under it is running). Storing a boolean for
     every parent instead would freeze the default at first render and a child
     that started running later would stay behind a closed control.

     VIEWER-LOCAL AND NOT PERSISTED, deliberately. Which branches are open is a
     property of this sitting, not a preference: a session tree that was worth
     opening yesterday is usually finished today, and restoring it would put a
     dead branch in front of a live one. */
  const [tree, setTree] = useState<{
    expanded: Record<string, boolean>;
    pages: Record<string, number>;
  }>({ expanded: {}, pages: {} });
  const toggle = (id: string, open: boolean) =>
    setTree((state) => ({ ...state, expanded: { ...state.expanded, [id]: open } }));
  const pageIn = (id: string) =>
    setTree((state) => ({ ...state, pages: { ...state.pages, [id]: (state.pages[id] ?? 1) + 1 } }));

  /* THE LINEAGE IS RESOLVED FROM THE ROWS ALREADY ON SCREEN — one map over the
     set this render was handed, no second read and no graph query. A parent
     outside the set is unresolvable, which `lineageOf` says in words. */
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  const tallies = childTallies(rows);
  const shown = visibleTree(rows, {
    expandedOf: (id) => tree.expanded[id],
    pagesOf: (id) => tree.pages[id] ?? 1,
  });
  return (
    <section className="hp-active" aria-label="Active work">
      <div className="hp-active__bar">
        <h2 className="hp-active__label k-label">Active</h2>
        {/* A GROUP OF TOGGLES, NOT A TAB STRIP. These were `role="tablist"` /
            `role="tab"`, which is a claim that each chip reveals its own panel
            — there is no tabpanel here, only one list being filtered in place.
            The dashboard's own gate caught it: that route is "exactly two
            panes", and a third tablist appearing on it was this mislabel, not
            a third pane. Toggle buttons with `aria-pressed` say what these
            actually do and need no roving tabindex to be correct. */}
        <div className="hp-active__lenses" role="group" aria-label="Filter active work">
          {LENSES.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={l.id === lens}
              className={`hp-lens${l.id === lens ? ' hp-lens--on' : ''}`}
              onClick={() => onLens(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <span className="hp-active__live">{liveLabel}</span>
      </div>
      {rows.length === 0 ? (
        /* A LENS THAT MATCHES NOTHING SAYS SO. This is not the "absence is not
           a claim" case — the reader chose this lens, so silence would read as
           a broken filter rather than an empty one. */
        <p className="hp-active__none" role="status">
          Nothing active {lens === 'all' ? 'right now' : `in ${lens}`}.
        </p>
      ) : (
        <div className="hp-active__grid">
          {shown.map((node) => {
            if (node.type === 'more') {
              /* THE PAGINATION ROW (owner: "just show 'other 3 sessions are
                 running'"). It stands in the CHILD position, at the child's
                 depth, so it reads as part of the branch rather than as a
                 footer under the list — and pressing it pages the next N in
                 WITHOUT closing anything already open. Nothing above it changes
                 height, so the reader's scroll does not move.

                 IT STATES RUNNING SPECIFICALLY when any of them are. "3 more"
                 and "3 more running" are different facts and only the second is
                 worth interrupting a reader for; when none of the hidden ones
                 are running it says so plainly instead of borrowing the word. */
              const label = node.running > 0
                ? `${node.running} more running${node.running < node.hidden ? ` · ${node.hidden - node.running} idle` : ''}`
                : `${node.hidden} more`;
              return (
                <div key={node.key} className="hp-acard hp-acard--more" data-depth={node.depth}
                  style={{ '--hp-acard-depth': Math.min(node.depth, ACTIVE_INDENT_MAX_DEPTH) } as React.CSSProperties}>
                  <div className="hp-acard__main">
                    <button
                      type="button"
                      className="hp-acard__more k-press"
                      onClick={() => pageIn(node.parentId)}
                    >
                      {label}
                    </button>
                  </div>
                </div>
              );
            }
            const row = node.row;
            /* THE CARD IS NO LONGER THE BUTTON, and it had to stop being one.
               `LinkedPullRequestChips` renders an `<a>` per PR — an anchor
               inside a button is invalid HTML and the nested interactive eats
               its own clicks. So the card is a container, the OPEN gesture is
               an inner button that fills it, and the chips are its sibling. */
            const allPrs = row.lens === 'chats' ? [] : linkedPullRequestsOf?.(row.id) ?? [];
            /* THREE CHIPS AND A COUNT, so every card is the same height.
               A session with eight pull requests wrapped its chips onto three
               lines and grew to 156px beside 87px neighbours — which is why the
               grid could not come to rest on a row boundary and cut the second
               row through the middle of its cards. Uniform rows are what make a
               bounded grid read as a grid instead of a broken box; the rest
               of the pull requests are one click away on the session itself,
               and the count says how many there are rather than hiding them. */
            const prs = allPrs.slice(0, 3);
            const morePrs = allPrs.length - prs.length;
            /* THE CAP IS IN THE PAGE, NOT IN CSS. A CSS-only cap still hands
               the browser eight chips and hopes; slicing here is what makes
               "three and a count" a fact rather than an appearance — and it is
               the SAME slice both bands read, so a card and a row can never
               show a different number. */
            const hasLinks = allPrs.length > 0 || (row.counters ? hasTileCounts(row.counters) : false);
            const lineage = lineageOf(row, (id) => titles.get(id));
            const tally = tallies.get(row.id) ?? null;
            /* A PARENT'S OPEN STATE, resolved the same way `visibleTree`
               resolves it — the reader's override where they gave one, the
               running-child default where they did not. Two answers to one
               question would be a control whose caret disagrees with the rows
               under it. */
            const open = tally
              ? (tree.expanded[row.id] ?? tally.running > 0)
              : false;
            return (
              <div
                key={`${row.lens}-${row.id}`}
                className={`hp-acard hp-acard--${row.lens}`}
                /* THE DEPTH IS PUBLISHED, NOT APPLIED. In the CARD band it is
                   read by nothing: a grid is a wrapped flow and an indent in it
                   reads as a misalignment, not as a hierarchy. In the ROW band
                   the container query turns it into padding, because a list is
                   the one shape that nests legibly. Same DOM, same order, two
                   readings. */
                style={{
                  /* CAPPED FOR THE INDENT, uncapped in the model. 16px a level
                     walks a depth-6 subtree off the right edge of a 480px pane,
                     and the rows that suffer are the deepest — exactly
                     backwards. Past the cap the row stops moving right and
                     states its lineage in words instead (`data-deep`). */
                  '--hp-acard-depth': Math.min(node.depth, ACTIVE_INDENT_MAX_DEPTH),
                } as React.CSSProperties}
                data-depth={node.depth}
                data-deep={node.depth > ACTIVE_INDENT_MAX_DEPTH ? 'true' : undefined}
              >
                <div className="hp-acard__main">
                <button
                  type="button"
                  className="hp-acard__open k-press"
                  title={row.detail ?? row.title}
                  onClick={() => onOpen(row.id)}
                >
                  <span className="hp-acard__top">
                    <span className="hp-acard__kind">{row.lens.replace(/s$/, '')}</span>
                    {row.word ? (
                      <span className={`hp-card__word hp-card__word--${row.tone}`}>
                        {row.dot ? (
                          <span
                            className={`hp-card__dot hp-card__dot--${row.dot}`}
                            aria-hidden="true"
                          />
                        ) : null}
                        {row.word}
                      </span>
                    ) : null}
                  </span>
                  <span className="hp-acard__title">{row.title}</span>
                  {/* WHERE IT CAME FROM. Drawn only when there IS a parent, and
                      it never invents a name for one it cannot resolve — see
                      `lineageOf`. Clipped like any other name: a truncated
                      title is still the right title. */}
                  {lineage ? (
                    <span className="hp-acard__lineage" title={lineage}>{lineage}</span>
                  ) : null}
                  <span className="hp-acard__facts">
                    {row.turns !== undefined ? (
                      <span>{row.turns} {row.turns === 1 ? 'turn' : 'turns'}</span>
                    ) : null}
                    {/* AND WHAT IT SPAWNED, in the facts line rather than on a
                        line of its own: the card is a fixed 96px row and a
                        fourth line is what pushes the facts off it. The count
                        is only ever what is ON SCREEN — sessions this strip is
                        holding — so it can never claim a subtree it has not
                        seen. */}
                    {tally ? (
                      /* WHAT IT SPAWNED, on the parent's own row, so a COLLAPSED
                         branch never silently swallows running work — the count
                         is there whether the branch is open or shut. Counted
                         from the DATA (`childTallies`), never from the visible
                         rows: a tally that shrank as you revealed would be
                         measuring the wrong thing. */
                      <span className="hp-acard__kids">
                        {tally.total} {tally.total === 1 ? 'sub-session' : 'sub-sessions'}
                        {tally.running > 0 ? ` · ${tally.running} running` : ''}
                      </span>
                    ) : null}
                    {row.activityAt ? (
                      <time dateTime={row.activityAt}>{sinceLabel(row.activityAt)}</time>
                    ) : null}
                  </span>
                </button>
                {/* THE FOLD — a parent's own control, and a SIBLING of the open
                    gesture rather than a child of it: a button inside a button
                    is invalid HTML whose nested interactive swallows its own
                    clicks, which is the defect this card already paid for once
                    with the pull-request anchors.

                    NO `aria-controls`. The children are sibling grid items, not
                    a container this could name — and a handle naming an element
                    that is not there is the render gate's `controls-nothing`.
                    `aria-expanded` plus a name that says what will happen is
                    the whole of what this control has to state. */}
                {tally ? (
                  <button
                    type="button"
                    className="hp-acard__fold"
                    aria-expanded={open}
                    aria-label={
                      open
                        ? `Hide ${tally.total} sub-sessions of ${row.title}`
                        : `Show ${tally.total} sub-sessions of ${row.title}`
                    }
                    title={open ? 'Collapse' : 'Expand'}
                    onClick={() => toggle(row.id, !open)}
                  >
                    <span aria-hidden>{open ? '⌄' : '›'}</span>
                  </button>
                ) : null}
                </div>
                {/* A CHAT NEVER GETS THIS ROW, and not because it is tidier.
                    A chat is keyed by its root message and carries no PR edges
                    at all, so the index can only ever answer "none" for one —
                    and an empty row labelled with pull requests would be
                    stating "this conversation has none", which is a claim
                    about the world rather than about our read. Absence states
                    nothing; that is the correct thing to state here. */}
                {/* ═══ THE LINKS LINE ═══ (owner, 2026-08-31, on the mobile
                    task list: "ee links line add it, we can know the edges for
                    each of the entity — gives more information at one glance")

                    IT IS NOT PULL REQUESTS ONLY, and it is not new. This is the
                    SAME pair `EntityListPanel` composes for every tile — PR and
                    commit chips, then the count badges for what the entity
                    carries (docs, memories, people, messages) — in the same
                    ORDER, so a task reads identically on Home and in the list.
                    Two compositions of one fact set is how they drift.

                    THE HONESTY RULES ARE THE COMPONENTS' AND ARE NOT RESTATED:
                    a ZERO renders nothing, and an ABSENT counter renders
                    nothing either, because "this server never counted" is not
                    "there are none". Which means the line is often empty — and
                    when it is, `hasLinks` is false and nothing is drawn at all:
                    no slot, no placeholder, no reserved width. A chat has no
                    pull requests and must not carry a gap where a session's
                    chips would be.

                    THE BADGES ARE READ-ONLY HERE. `onToggleKind` is deliberately
                    not passed: the list panel's badges are DOORS onto a relation
                    group rendered under the tile, and this strip has no such
                    group to open. A badge wired to nothing would be a control
                    that renders and does nothing, which is the thing the owner
                    asked to have removed rather than left drawn. */}
                {hasLinks ? (
                  <div className="hp-acard__prs">
                    {/* THE COUNT CHIP — the narrow band's answer, rendered
                        beside the chips and shown instead of them by the
                        container query. THE NAME BEATS THE COUNT is the house
                        ruling, so when the pane cannot hold both a readable
                        title and three chips, it is the CHIPS that give way to
                        a number, never the title that clips. Rendered here
                        rather than swapped in by JS because both bands are one
                        DOM: a card and a row are two presentations of one row
                        model, and a fact may not exist in one and vanish in the
                        other. */}
                    {allPrs.length > 0 ? (
                      <span className="hp-acard__prcount" title={`${allPrs.length} linked pull requests`}>
                        <span aria-hidden>⑃ </span>{allPrs.length}
                      </span>
                    ) : null}
                    {prs.length > 0 ? (
                      <LinkedPullRequestChips pullRequests={prs} placement="tile" />
                    ) : null}
                    {morePrs > 0 ? (
                      /* THE COUNT NAMES WHAT IT IS HIDING. A bare "+5" says
                         only that something was withheld; the tooltip lists
                         the numbers, so the card can stay one line tall
                         without the rest becoming unreachable knowledge. The
                         card itself opens the session, where all of them are
                         listed in full — this is a signpost, not the only
                         road. */
                      <span
                        className="hp-acard__prmore"
                        title={`${morePrs} more: ${allPrs
                          .slice(3)
                          .map((pr) => `#${pr.number}`)
                          .join(' ')}`}
                      >
                        +{morePrs}
                      </span>
                    ) : null}
                    {row.counters ? (
                      <TileCountBadges
                        counters={row.counters}
                        humanAuthors={row.badges?.humanMessageAuthors}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AttentionCard({
  section,
  onOpen,
  count,
  showKind = false,
}: {
  section: HomeSection;
  onOpen(id: string): void;
  /** A live tally, when the section has one. Absent ⇒ no number is claimed. */
  count?: string | undefined;
  /** Only where the strip MIXES kinds. A heading that names the kind already
      said it, and saying it twice is the repetition this screen is for. */
  showKind?: boolean;
}) {
  return (
    <article className="hp-attention" aria-label={section.label} data-testid="hp-needs-you">
      <div className="hp-attention__head">
        <h2 className="hp-attention__eyebrow k-label">{section.label}</h2>
        {count ? <span className="hp-attention__count">{count}</span> : null}
      </div>
      <div className="hp-attention__rows">
        {section.rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`hp-attention__row k-press hp-attention__row--${row.tone}`}
            title={row.detail ?? row.title}
            onClick={() => onOpen(row.id)}
          >
            <span className="hp-attention__status">
              {row.word ? (
                <span className={`hp-card__word hp-card__word--${row.tone}`}>
                  {row.dot ? (
                    <span className={`hp-card__dot hp-card__dot--${row.dot}`} aria-hidden="true" />
                  ) : null}
                  {row.word}
                </span>
              ) : null}
            </span>
            <span className="hp-attention__title">{row.title}</span>
            {/* PROGRESS AND ACTIVITY (owner, 2026-08-30) — the two facts the
                node actually stamps. Each renders only when present: a card
                that draws "0 turns" or "never" states something false about a
                session whose counters have not arrived yet. */}
            {row.turns !== undefined || row.activityAt ? (
              <span className="hp-attention__facts">
                {row.turns !== undefined ? (
                  <span className="hp-attention__turns">
                    {/* One turn is a turn. The plural bug was visible in the
                        first render of this card and nowhere in 4,974 tests —
                        no assertion reads the rendered string. */}
                    {row.turns} {row.turns === 1 ? 'turn' : 'turns'}
                  </span>
                ) : null}
                {row.activityAt ? (
                  <time className="hp-attention__when" dateTime={row.activityAt}>
                    {sinceLabel(row.activityAt)}
                  </time>
                ) : null}
              </span>
            ) : null}
            {/* THE KIND LINE IS GONE FROM THE STRIPS THAT NAME THEIR KIND.
                "Session" under a heading reading MY LIVE SESSIONS, on all five
                rows, is the repetition the owner has objected to four times —
                and it was five lines of it in the first render.

                `showKind` keeps it for NEEDS YOU, which genuinely mixes kinds:
                a row there can be a task, a session or a pull request, and
                without the mark the reader cannot tell which. One heading, one
                statement of the kind — either the heading says it or the row
                does, never both. */}
            {showKind && row.kind ? (
              <span className="hp-attention__ref">
                <span className="hp-attention__ref-mark" aria-hidden>
                  <KindIcon kind={row.kind} />
                </span>
                {getKind(row.kind).label}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </article>
  );
}


export function HomePage(props: HomePageProps) {
  const { data } = props;
  const home = useHomeData(data);

  /* THE COMPOSITION WAS ALWAYS COMPLETE; HOME THREW THREE QUARTERS OF IT AWAY.
   *
   * `composeMyWork` returns four sections — NEEDS YOU, MY LIVE SESSIONS, MY
   * TASKS, MENTIONS & ASSIGNMENTS. This memo used to `.find()` the needs-you
   * one and discard the rest on every render, under a comment saying the
   * others "render as rails below". That stopped being true at R4
   * (2026-08-15), when the rails retired to the Work tab — the comment
   * outlived the code by a fortnight.
   *
   * So "current running things" (owner, 2026-08-30) is not a new capability
   * here. MY LIVE SESSIONS was already composed from the seam VERDICT rather
   * than the record — a session whose row claims running while the node holds
   * no PTY reads `stale`, which is the honest word — and then dropped on the
   * floor. It is wired below.
   */
  const work = useMemo(() => {
    const work = composeMyWork({
      sessionPool: home.sessionPool,
      myTasks: home.myTasks,
      myReview: home.myReview,
      livenessOf: data.livenessOf,
      activity: data.activity,
      notifications: home.notifications,
      notificationsError: home.notificationsError,
      viewerKnown: home.viewer !== null,
      viewerError: home.viewerError,
    });
    const byId = (id: string) => work.sections.find((section) => section.id === id) ?? null;
    return {
      needsYou: work.sections.find((section) => section.emphasis === 'needs-you') ?? null,
      /* "i just need chats taks and session srunning in the dashboard" —
         these two were composed and discarded on every render. */
      live: byId('live'),
      tasks: byId('tasks'),
      liveCount: work.liveCount,
      liveCountLabel: work.liveCountLabel,
    };
  }, [home, data.livenessOf, data.activity]);

  /* THREE STATES, AND THIS ONE RENDERS ONLY THE THIRD.
   *
   * `rowsFor` returns [] while a kind is still hydrating, so an empty array
   * here means "pending" and "genuinely empty" indistinguishably. A strip that
   * drew `MY LIVE SESSIONS · 0` off that array would assert the workspace is
   * empty during the window where the screen knows nothing — the same defect
   * as "No agent teammate is available in this space" in a space that has 34,
   * and on a demo it lands in the first second of the screen.
   *
   * So a strip with no rows renders NOTHING. Absence is not a claim; "nothing
   * here yet" is, and it may only be made after a read that came back empty.
   * NEEDS YOU keeps its note because its emptiness is derived from resolved
   * facts (`viewerKnown`, `notificationsError`) rather than from an array. */
  const withRows = (section: HomeSection | null) =>
    section && section.rows.length > 0 ? section : null;
  const [lens, setLens] = useState<ActiveLens>('all');
  const needsYouStrip = withRows(work.needsYou);

  /* R4 (2026-08-15): Home IS the chat view. The chat surface — with its
     merged conversation column — fills the canvas and triage rides above it.
     The glance rails, the presence row and the per-kind counts strip retired
     to the Work tab, where the inventory framing lives. */
  return (
    <div
      className="hp-root hp-root--chat"
      data-testid="home-page"
      data-aside={props.aside ? 'open' : undefined}
      /* THE RAIL'S SELECTION, ON THE PAGE. Hiding the list column
         unconditionally made "select Tasks in the rail" a no-op: the rail lit
         up and nothing appeared, because the panel it renders into is
         `.tch-sidebar` and this page had switched it off. The kind rides on
         the root now, so the column can come back exactly when there is a kind
         to list, and stay away on the dashboard where it duplicated the rail. */
      data-kind={props.activeKind ?? undefined}
      data-focus={props.focus ? 'true' : undefined}
    >
      {props.rail ?? null}
      <div className="hp-page">
      {/* TWO MODES, NEVER BOTH. No kind selected → the dashboard: the three
          verbs, what is active, and the chat. A kind selected → that kind's
          list, full width. The dashboard does not shrink into a corner and the
          list does not become a third column; each is the whole working area
          while it is the answer to what the reader asked for. */}
      {props.activeKind && props.list ? (
        <div className="hp-listmain" data-testid="hp-list-main">{props.list}</div>
      ) : (
      <div
        className="hp-home"
        data-split={props.splitAxis ?? 'vertical'}
        data-side-collapsed={props.sideCollapsed ? 'true' : undefined}
        data-testid="hp-home"
      >
      {/* THE LEFT THIRD. START, then WHAT NEEDS YOU. Nothing else.
       *
       * WHAT WAS HERE AND WHY IT IS GONE (owner, 2026-08-30, on the deployed
       * build): a hero line, a 19-kind census, and WORK / LIBRARY / PEOPLE
       * cards carrying 2358 · 2154 new · 5 live · 458 new · 508 new · 812 new
       * … — nineteen rows of counts for things that merely EXIST.
       *
       *   "why cant it be simplified why are you complicating it … i dont need
       *    make home dashboard clean have one create new chat, New SESSIONS
       *    AND New Task first and their screens while running"
       *
       * THE RAIL IS THE BROWSE. It was restored an hour before this, on the
       * owner's own instruction — "because workspace is already there here" —
       * and the cards were left in place, so the screen stated the same
       * taxonomy TWICE and the duplication the owner had complained about
       * three times got worse rather than better. That was the defect; this
       * removes the half that should have gone with the rail's return.
       *
       * A COUNT OF THINGS THAT EXIST IS NOT PROGRESS. "812 Docs" tells you the
       * database is not empty. Home answers "what is happening and what can I
       * start", and the rail answers "what is there" — one question per
       * surface, which is the whole of the complaint. */}
      {/* NAMED, because the separator beside it has to say what it moves. The
          render gate fails a handle whose `aria-controls` points at nothing —
          it was written after a drag handle outlived its panel and painted a
          9px x 901px hairline over the cards. This is the element whose width
          (side by side) or height (stacked) the drag actually changes. */}
      <div className="hp-side" id="hp-side" data-testid="hp-side">
      <HomeStart
        onNewChat={props.onNewChat}
        onCreateKind={props.onCreateKind}
        createKindUnavailable={props.createKindUnavailable}
      />
      {/* THE ACTIVE STRIP — sessions, chats and tasks in ONE list, with a lens.
          Owner, 2026-08-30, choosing a mix of layouts 3 and 4: the work reads
          as wide cards, and the conversation keeps a permanent home beneath
          them. That mix is better than either alone — 03 had nowhere for a
          conversation to live, so opening one covered the dashboard. */}
      <ActiveStrip
        rows={activeRows(work.live, work.tasks, home.chatThreads, lens)}
        lens={lens}
        onLens={setLens}
        liveLabel={work.liveCountLabel}
        onOpen={props.onOpenEntity}
        linkedPullRequestsOf={props.linkedPullRequestsOf}
      />
      {/* NEEDS YOUR ATTENTION follows the verbs: you start something, or you
          deal with what is asking for you. It renders only when it HAS rows —
          `rowsFor` returns [] while a kind is still hydrating, so an empty
          array cannot tell "pending" from "genuinely empty", and a card that
          drew "nothing needs you" off it would assert calm during the window
          where the screen knows nothing. Absence is not a claim; "nothing
          here" is one, and it may only be made after a read that came back
          empty. */}
      {needsYouStrip ? (
        <AttentionCard section={needsYouStrip} onOpen={props.onOpenEntity} showKind />
      ) : work.needsYou && (home.viewerError || home.notificationsError) ? (
        <p className="hp-note" role="status">{work.needsYou.emptyNote}</p>
      ) : null}
      {/* MY LIVE SESSIONS and MY TASKS USED TO BE DRAWN HERE, AND THEY WERE THE
          SAME ROWS AGAIN.
          Measured on the live build: the five running sessions appeared twice
          on one screen — as cards in the strip above, then as full-width rows
          immediately below. The strip did not exist when those two sections
          were added; now that it carries sessions, chats and tasks in one
          list, with a cap and a tail, restating two of the three underneath is
          the duplication the owner has objected to three times ("why cant it
          be simplified why are you complicating it remove all this shit").
          NEEDS YOU stays: it answers a different question — what is waiting on
          YOU — and is not a subset of what the strip draws. */}
      </div>

      {/* THE SEAM. Between the panes in the DOM as well as on screen, in both
          arrangements — the grid decides whether that means "to the right of"
          or "below", and the markup never changes. */}
      {props.splitter ?? null}

      {/* THE OTHER PANE: what is happening now — the conversation, or the
          entity a card opened (`centerOverride`, routed through the chat
          surface's centre berth). The session list, the create verbs and the
          embedded terminal are the host's (lane H2); this pane only makes room
          for them, exactly as the page makes room for the aside. */}
      <section className="hp-live" aria-label="Chat">
        {props.chat}
      </section>
      </div>
      )}
      </div>

      {props.aside ?? null}
    </div>
  );
}
