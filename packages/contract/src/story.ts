// Story as an Entity (migration 283, task 01a0fbf9, 2026-10-02).
//
// A story is one entity with a title, a description and the status every kind
// has (152). Things are put in BY HAND as `contains` edges from the story —
// those are its ROOTS — and everything connected to a root FOLLOWS along a
// fixed set of edge types, to a fixed depth, under a fixed row bound. The
// graph, team, call signs and activity are computed from that trail. Progress
// is computed from contained work (see StoryState); story status is manual.
//
// Where each piece is read from (no new catalog rows):
//   * `StoryState`   — the entity's `state` on BOTH read paths (entities.get /
//                      list rows via the facade, and every `entity.upsert`
//                      event via the projector). Both select the same SQL
//                      function, `internal.story_summary(id)`, so the twins
//                      cannot drift.
//   * `StoryContent` — the entity's `content` on a DETAIL read (entities.get).
//                      `page` is filled by the detail hydration
//                      (server `loadStoryPage`, over `internal.story_trail`);
//                      it is `null` on every
//                      surface that does not hydrate detail (command results,
//                      version snapshots).
//   * the live feed  — `page.feedAnchorIds` names every anchor in the story;
//                      the client filters the ordinary event feed's message
//                      events by those anchors, and seeds the backlog from
//                      `page.recentMessages`.
//   * agents         — `tm8 entity context <story>` renders the same page as
//                      a bounded text section.
import type { ActorSummary, EntityContextV2View, StatusCategory, TeamMemberMode } from './contract.js';
import { z } from 'zod';

/**
 * The edge types a story's trail follows, in both directions, from each root
 * (Subhang, 2026-10-02). `parent` is not an edge row: it is the envelope's
 * `parent_id`, followed parent -> child only. Rows of a hub kind
 * (team_member, member, project, interaction_profile, skill) and stories are
 * LEAVES: reached, never walked out of (lead ruling 2026-10-02). NOT followed, on purpose:
 * `likes`, `stars`, `pulled`, `visible_to` — reactions and access are not
 * part of the work; `relates_to`, `depends_on`, `participates_in` and
 * `follows_up` (Design Rules §2.3, P0b). `authored_from` is followed except from
 * a message or form source (`internal.story_walk_skips`, 308), so a session's
 * messages never flood a story. `created_in` was merged into `authored_from`
 * (308) and `dispatched_by` is deprecated (303). The SQL twin is `internal.story_followed_edge_types()`;
 * db/test/canonical_edges.test.mjs asserts the two agree.
 */
export const STORY_FOLLOWED_EDGE_TYPES = [
  'parent', 'attached_to', 'tracks', 'working_on', 'about', 'authored_from',
  'assigned_to', 'has_member', 'produces', 'remembers',
] as const;
export type StoryFollowedEdgeType = (typeof STORY_FOLLOWED_EDGE_TYPES)[number];

/** How far the trail reaches from a root (a root is depth 0). */
export const STORY_FOLLOW_DEPTH = 3;
/** The row bound on the whole trail, roots included. Past it `truncated` is true. */
export const STORY_FOLLOW_LIMIT = 500;

/**
 * The colour family an edge draws in on the story graph. `story` is the
 * story's own `contains` (brass); `blocks` carries an arrowhead.
 */
export type StoryEdgeFamily = 'parent' | 'story' | 'runs' | 'made' | 'code' | 'blocks' | 'team';

/** Edge type -> family. A type absent here draws as `parent` (grey). */
export const STORY_EDGE_FAMILY: Readonly<Record<string, StoryEdgeFamily>> = {
  parent: 'parent',
  contains: 'story',
  about: 'story',
  authored_from: 'story',
  has_member: 'team',
  working_on: 'runs',
  assigned_to: 'runs',
  attached_to: 'made',
  produces: 'made',
  remembers: 'made',
  tracks: 'code',
  depends_on: 'blocks',
  blocks: 'blocks',
  dispatched_by: 'team',
  coordinates: 'team',
};

export function storyEdgeFamily(edgeType: string): StoryEdgeFamily {
  return STORY_EDGE_FAMILY[edgeType] ?? 'parent';
}

/**
 * Call signs. Every session in the story takes one by `created_at` order
 * (ties by id) — created_at never changes, so a sign is stable and never
 * renumbered; a new session simply takes the next one. After Zinnia the list
 * wraps with a round: Ash 2, Birch 2, …
 */
export const STORY_CALL_SIGNS = [
  'Ash', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Grove', 'Hazel', 'Iris', 'Juniper', 'Kelp',
  'Laurel', 'Moss', 'Nettle', 'Oak', 'Pine', 'Quill', 'Reed', 'Sage', 'Thorn', 'Umber', 'Vale',
  'Willow', 'Xylem', 'Yarrow', 'Zinnia',
] as const;

export function storyCallSign(index: number): string {
  const n = STORY_CALL_SIGNS.length;
  const round = Math.floor(index / n);
  return STORY_CALL_SIGNS[index % n] + (round > 0 ? ` ${round + 1}` : '');
}

/**
 * A progress tally over contained work. `work` = rows whose status category
 * is to_do, in_progress or done; `done` = rows at category `done`. `blocked` =
 * unfinished rows explicitly blocked or holding an unresolved hard `depends_on`. The bands are
 * DISJOINT: `inProgress` and `toDo` exclude blocked rows, so
 * done + inProgress + toDo + blocked = work.
 */
export interface StoryProgress {
  work: number;
  done: number;
  inProgress: number;
  toDo: number;
  blocked: number;
  cancelled: number;
  /**
   * Subset of inProgress: tasks without a directly linked, nondeleted
   * spawning/running/idle work session (`working_on`, session -> task).
   * This is a visibility-scoped signal, not a status change or an age test.
   * Optional for older stored summaries; absence means unavailable, not zero.
   */
  staleInProgress?: number;
}

/**
 * The story's summary, carried as `state` on both read paths.
 *
 * The three tallies count what the story CONTAINS (migration 289), never the
 * trail: its roots, each root's hierarchy descendants (parent -> child only —
 * the rows `entity query --subtree <root>` returns), and its direct child
 * stories. A story is one item; its own tasks reach a parent only through
 * `rollup`. Rows the trail reaches sideways (sessions, their coordinators,
 * the coordinators' tasks in other stories) are shown but never counted.
 *
 * - `progress`: tasks AND stories the story contains (no docs, forms,
 *   sessions, team members, PRs).
 * - `taskProgress`: tasks the story contains — "N of M tasks done".
 * - `rollup`: `taskProgress` over this story's tasks united with every
 *   descendant story's (same-kind `parent_id`), each task once.
 *
 * `work` excludes cancelled rows, so `work + cancelled` is the row count.
 * `itemCount`, `liveSessionCount`, `pendingAttentionCount` and
 * `lastActivityAt` still read the whole trail.
 */
export interface StoryState {
  kind: 'story';
  /** Things put in by hand: live `contains` targets. */
  rootCount: number;
  /** Every followed row, roots included, the story itself excluded. */
  itemCount: number;
  /** True when the trail hit STORY_FOLLOW_LIMIT. */
  truncated: boolean;
  progress: StoryProgress;
  taskProgress: StoryProgress;
  rollup: StoryProgress;
  /** Followed work sessions whose runtime is live. */
  liveSessionCount: number;
  /** Unresolved attention requests on the story or any followed row. */
  pendingAttentionCount: number;
  /** Newest `activity_at` across the story and its followed rows. */
  lastActivityAt: string | null;
  /** Direct child stories. */
  childStoryCount: number;
}

/** One node of the story graph: the story, a root, or a followed row. */
export interface StoryNode {
  id: string;
  kind: string;
  title: string;
  /**
   * The status KEY, the same string `tm8 entity context` puts on a ref: a
   * task's work status (`open`, `working`, …), a session's runtime status, a
   * PR's state, a chat's runtime state, else the status category. Every
   * `status` in this module means this.
   */
  status: string | null;
  statusCategory: StatusCategory | null;
  /** Explicitly blocked or holds an unresolved hard `depends_on`. */
  blocked: boolean;
  /** 0 for a root, 1..STORY_FOLLOW_DEPTH for followed rows; -1 for the story. */
  depth: number;
  /** Every root this row was reached from (a cross-root row has several). */
  rootIds: string[];
  activityAt: string | null;
  createdAt: string;
  /** Work sessions only: the runtime is live. */
  live?: boolean;
  /** Work sessions only: the session's call sign. */
  callSign?: string;
  /**
   * Per-node tallies, set on every node of a page a server that computes
   * them returns; absent from pages older servers (and fixtures) hand out, so
   * readers treat `undefined` as "not known", never as 0.
   */
  counts?: StoryNodeCounts;
}

/**
 * What a node carries that the graph alone cannot show: its mailbox and
 * whether it is asking for a human. Both are computed at read time, set-based
 * over the page's node ids, never per node.
 */
export interface StoryNodeCounts {
  /**
   * Messages anchored on the node (`messages.anchor_id`), excluding redacted
   * messages and messages whose entity row is deleted — the same filter the
   * page's `recentMessages` window applies, with no window: the whole mailbox.
   */
  messages: number;
  /**
   * Unresolved attention requests whose target (`attention_requests.entity_id`)
   * is the node: status `open` or `acknowledged`, the ONE definition behind
   * `StoryState.pendingAttentionCount` (`internal.story_summary`, migration 289),
   * so the page's nodes sum to what the summary says.
   */
  pendingAttention: number;
}

export const StoryNodeCountsSchema: z.ZodType<StoryNodeCounts> = z.object({
  messages: z.number().int().nonnegative(),
  pendingAttention: z.number().int().nonnegative(),
}).strict();

/** One edge of the story graph, exactly as stored (or `parent` for hierarchy). */
export interface StoryGraphEdge {
  /** The edge row id; null for a `parent` (hierarchy) link and a child-story link. */
  id: string | null;
  fromId: string;
  toId: string;
  type: string;
  family: StoryEdgeFamily;
  /** Joins rows reached from different roots. */
  cross: boolean;
  rootIds: string[];
}

/** A row in a root's trail, with the edge it was followed along. */
export interface StoryTrailItem {
  id: string;
  kind: string;
  title: string;
  /** The edge type that reached it (`parent` for hierarchy). */
  edgeType: string;
  family: StoryEdgeFamily;
  /** The row it was reached FROM (the root or an earlier trail row). */
  viaId: string;
  /** `out`: via -> item as stored; `in`: item -> via as stored. */
  direction: 'out' | 'in';
  depth: number;
}

export interface StoryRoot {
  id: string;
  kind: string;
  title: string;
  status: string | null;
  statusCategory: StatusCategory | null;
  blocked: boolean;
  /** The `contains` edge position, which orders the roots. */
  position: number | null;
  /**
   * The root plus its hierarchy descendants, tasks and stories only (289) —
   * never rows the trail reached sideways. `taskProgress.work + cancelled` =
   * (root is a task ? 1 : 0) + `entity query --kind task --subtree <root>`.
   */
  progress: StoryProgress;
  taskProgress: StoryProgress;
  /**
   * Every hierarchy descendant of the root, any kind, unbounded by the
   * trail's depth — the count `entity query --subtree <root>` returns.
   */
  descendantCount: number;
  /** Descendants by hierarchy (`parent` edges) in the trail, nearest first. */
  childIds: string[];
  /** Everything else followed from this root (non-`parent` edges). */
  trail: StoryTrailItem[];
}

export interface StorySession {
  id: string;
  title: string;
  callSign: string;
  createdAt: string;
  live: boolean;
  /** The work session's runtime status as stored. */
  runtimeStatus: string | null;
  /** Model selected for this session; absent on older servers. */
  model?: string | null;
  teamMemberId: string | null;
  mode: TeamMemberMode | null;
  /** Tasks it is `working_on` that are in the story. */
  taskIds: string[];
  rootIds: string[];
  /** The session that spawned it: its parent session, when that is in the story (303: no longer `dispatched_by`). */
  dispatchedById: string | null;
}

export interface StoryDispatch {
  taskId: string;
  /** The session that picked it up; null while it waits for a worker. */
  sessionId: string | null;
}

export interface StoryTeammate {
  id: string;
  /** `member` = a human in the trail: no mode, no hierarchy, no sessions. */
  kind: 'team_member' | 'member';
  name: string;
  mode: TeamMemberMode | null;
  /** The teammate hierarchy tm8 already has (team_member `parent_id`). */
  parentId: string | null;
  live: boolean;
  sessionIds: string[];
  /** Tasks its sessions are `working_on`. */
  runs: string[];
  /** Tasks `assigned_to` it. */
  assigned: string[];
  dispatched: StoryDispatch[];
}

export interface StoryChild {
  id: string;
  title: string;
  status: string | null;
  statusCategory: StatusCategory | null;
  itemCount: number;
  taskProgress: StoryProgress;
  rollup: StoryProgress;
  liveSessionCount: number;
  lastActivityAt: string | null;
}

/** "What's happening": activity rows on the story and its followed rows. */
export interface StoryActivityItem {
  id: string;
  at: string;
  entityId: string;
  entityKind: string;
  entityTitle: string;
  /** The activity verb as stored (`created`, `updated`, `linked`, …). */
  verb: string;
  actorId: string | null;
  actor: ActorSummary | null;
}

/** A message on any anchor in the story — the live feed's backlog. */
export interface StoryFeedMessage {
  id: string;
  at: string;
  anchorId: string;
  anchorKind: string;
  anchorTitle: string;
  authorId: string | null;
  author: ActorSummary | null;
  excerpt: string;
}

/** The page, hydrated on a detail read. Every list is bounded. */
export interface StoryPage {
  asOf: string;
  follow: { depth: number; limit: number; truncated: boolean; edgeTypes: readonly string[] };
  /** The parent story, for the breadcrumb. */
  parent: { id: string; title: string } | null;
  roots: StoryRoot[];
  /** The story itself (depth -1), every root and every followed row. */
  nodes: StoryNode[];
  edges: StoryGraphEdge[];
  /** Every work session in the trail, in call-sign order. */
  sessions: StorySession[];
  /** Teammates behind those sessions, plus any teammate in the trail. */
  team: StoryTeammate[];
  childStories: StoryChild[];
  /** Newest first, at most 50. */
  activity: StoryActivityItem[];
  /** The story, every root and every followed row that can carry messages. */
  feedAnchorIds: string[];
  /** Newest first, at most 50. */
  recentMessages: StoryFeedMessage[];
}

/** The story's content arm: its prose, plus the page on a detail read. */
export interface StoryContent {
  kind: 'story';
  description: string;
  page: StoryPage | null;
  /** Bounded reader context with continuation pointers; absent on browser page reads. */
  context?: EntityContextV2View;
}

/**
 * The create/patch door's input. A patch carries only what changed; `null`
 * MERGES in the door. Title rides the envelope's `title`.
 *
 * `status` is PATCH-ONLY (migration 288): a workflow category (to_do |
 * in_progress | done | cancelled) or a state name of the story's workflow.
 * A story's status is MANUAL — never derived from its trail; `progress` /
 * `taskProgress` are the derived signal.
 */
export const StoryContentInputSchema = z.object({
  kind: z.literal('story').optional(),
  description: z.string().max(20000).optional(),
  status: z.string().trim().min(1).max(100).optional(),
}).strict();

const StoryProgressSchema = z.object({
  work: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  toDo: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  staleInProgress: z.number().int().nonnegative().optional(),
}).strict();

export const StoryStateSchema = z.object({
  kind: z.literal('story'),
  rootCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  progress: StoryProgressSchema,
  taskProgress: StoryProgressSchema,
  rollup: StoryProgressSchema,
  liveSessionCount: z.number().int().nonnegative(),
  pendingAttentionCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
  childStoryCount: z.number().int().nonnegative(),
}).strict();

/** The page is server-computed and large; its members are typed, not re-validated. */
export const StoryContentSchema = z.object({
  kind: z.literal('story'),
  description: z.string(),
  page: z.record(z.unknown()).nullable(),
  context: z.record(z.unknown()).optional(),
}).passthrough();

/**
 * The `story` card on `tm8 entity context <story>` (v2 kindFields): the page
 * projected small for an agent. Every list is capped at 50; a cut list adds
 * an `omitted[]` entry on the view.
 */
/**
 * The story card on `entity context` (283). Never-drop core, so every list is
 * one bounded page (#25): a cut list has an `omitted[]` entry (`story.roots`,
 * `story.sessions`, …) whose `--sections story --cursor` expand continues it.
 * A cursor page carries only the list it continues; the others are absent.
 */
export interface EntityContextStory {
  state: StoryState;
  roots?: Array<{
    id: string; kind: string; title: string; status: string | null; statusCategory: StatusCategory | null;
    blocked: boolean; taskProgress: StoryProgress; progress: StoryProgress;
    /** `StoryRoot.descendantCount`: matches `entity query --subtree <root>`. */
    childCount: number;
    /** Rows followed from the root by non-`parent` edges (shown, not counted). */
    trailCount: number;
  }>;
  /** Counts over every followed row (depth >= 0), by kind. */
  byKind: Record<string, number>;
  blocked?: Array<{ id: string; kind: string; title: string; status: string | null }>;
  /** `taskIds` is cut to the first few; `taskCount` is the full count, present only when cut. */
  sessions?: Array<{ id: string; callSign: string; title: string; live: boolean; mode: TeamMemberMode | null;
    teamMemberId: string | null; taskIds: string[]; taskCount?: number }>;
  /** `sessionIds` is cut to the first few; `sessionCount` is the full count, present only when cut. */
  team?: Array<{ id: string; kind: 'team_member' | 'member'; name: string; mode: TeamMemberMode | null;
    parentId: string | null; live: boolean; sessionIds: string[]; sessionCount?: number }>;
  childStories?: Array<{ id: string; title: string; status: string | null; taskProgress: StoryProgress;
    rollup: StoryProgress; liveSessionCount: number }>;
  truncated: boolean;
}

/** Loose on purpose: server-assembled, typed by `EntityContextStory`. */
export const EntityContextStorySchema: z.ZodType<EntityContextStory> = z.object({
  state: StoryStateSchema,
  roots: z.array(z.record(z.unknown())).optional(),
  byKind: z.record(z.number().int().nonnegative()),
  blocked: z.array(z.record(z.unknown())).optional(),
  sessions: z.array(z.record(z.unknown())).optional(),
  team: z.array(z.record(z.unknown())).optional(),
  childStories: z.array(z.record(z.unknown())).optional(),
  truncated: z.boolean(),
}).strict() as unknown as z.ZodType<EntityContextStory>;
