// Story as an Entity (migration 283, task 01a0fbf9, 2026-10-02).
//
// A story is one entity with a title, a description and the status every kind
// has (152). Things are put in BY HAND as `contains` edges from the story —
// those are its ROOTS — and everything connected to a root FOLLOWS along a
// fixed set of edge types, to a fixed depth, under a fixed row bound. Progress,
// the graph, the team, call signs and what is happening are all COMPUTED at
// read time from that trail; nothing here is ever stored.
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
import type { ActorSummary, StatusCategory, TeamMemberMode } from './contract.js';
import { z } from 'zod';

/**
 * The edge types a story's trail follows, in both directions, from each root
 * (Subhang, 2026-10-02). `parent` is not an edge row: it is the envelope's
 * `parent_id`, followed parent -> child only. Rows of a hub kind
 * (team_member, member, project, interaction_profile, skill) and stories are
 * LEAVES: reached, never walked out of (lead ruling 2026-10-02). NOT followed, on purpose:
 * `likes`, `stars`, `pulled`, `visible_to` — reactions and access are not
 * part of the work.
 */
export const STORY_FOLLOWED_EDGE_TYPES = [
  'parent', 'attached_to', 'tracks', 'working_on', 'about', 'created_in',
  'assigned_to', 'has_member', 'produces', 'remembers', 'dispatched_by',
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
  created_in: 'story',
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
 * A progress tally over a set of followed rows. `work` = rows whose status
 * category is not `cancelled`; `done` = rows at category `done`. `blocked` =
 * work rows not done that hold an unresolved hard `depends_on`. The bands are
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
}

/**
 * The story's summary, carried as `state` on both read paths.
 *
 * `progress` is the ruled figure over EVERY followed row (all kinds carry a
 * status since 152). `taskProgress` is the same tally restricted to tasks —
 * what the page labels "N of M tasks done". `rollup` is `taskProgress` plus
 * every descendant story's `taskProgress` (child stories via same-kind
 * `parent_id`).
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
  /** Holds an unresolved hard `depends_on`. */
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
}

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
  /** The root plus its followed rows. */
  progress: StoryProgress;
  taskProgress: StoryProgress;
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
  teamMemberId: string | null;
  mode: TeamMemberMode | null;
  /** Tasks it is `working_on` that are in the story. */
  taskIds: string[];
  rootIds: string[];
  /** The session that dispatched or spawned it, when known. */
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
}).passthrough();

/**
 * The `story` card on `tm8 entity context <story>` (v2 kindFields): the page
 * projected small for an agent. Every list is capped at 50; a cut list adds
 * an `omitted[]` entry on the view.
 */
export interface EntityContextStory {
  state: StoryState;
  roots: Array<{
    id: string; kind: string; title: string; status: string | null; statusCategory: StatusCategory | null;
    blocked: boolean; taskProgress: StoryProgress; progress: StoryProgress; childCount: number; trailCount: number;
  }>;
  /** Counts over every followed row (depth >= 0), by kind. */
  byKind: Record<string, number>;
  blocked: Array<{ id: string; kind: string; title: string; status: string | null }>;
  sessions: Array<{ id: string; callSign: string; title: string; live: boolean; mode: TeamMemberMode | null;
    teamMemberId: string | null; taskIds: string[] }>;
  team: Array<{ id: string; kind: 'team_member' | 'member'; name: string; mode: TeamMemberMode | null;
    parentId: string | null; live: boolean; sessionIds: string[] }>;
  childStories: Array<{ id: string; title: string; status: string | null; taskProgress: StoryProgress;
    rollup: StoryProgress; liveSessionCount: number }>;
  truncated: boolean;
}

/** Loose on purpose: server-assembled, typed by `EntityContextStory`. */
export const EntityContextStorySchema: z.ZodType<EntityContextStory> = z.object({
  state: StoryStateSchema,
  roots: z.array(z.record(z.unknown())),
  byKind: z.record(z.number().int().nonnegative()),
  blocked: z.array(z.record(z.unknown())),
  sessions: z.array(z.record(z.unknown())),
  team: z.array(z.record(z.unknown())),
  childStories: z.array(z.record(z.unknown())),
  truncated: z.boolean(),
}).strict() as unknown as z.ZodType<EntityContextStory>;
