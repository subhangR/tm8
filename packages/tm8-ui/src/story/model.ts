/**
 * The story page's view model — ONE object the whole page renders from.
 *
 * PROVISIONAL (frontend lane, 2026-10-02). It mirrors the data block of design
 * artifact 01a0fc3e rev 4, normalised to ids instead of the artifact's letter
 * shorthand. When the backend lane publishes the API shape, `seam.ts` maps the
 * real read onto this type and nothing below the seam changes. Every number on
 * the page is computed from this object; nothing on the page stores a figure.
 *
 * Kind names are DATA here (`kind: string`), never `case 'task':` branches in
 * components — §15.2's scanner forbids kind literals in components, so every
 * kind-keyed table lives in this file.
 */

/** tm8 modes a teammate can run in on a story. */
export type StoryMode =
  | 'coordinator'
  | 'coordinated-coordinator'
  | 'coordinated-worker'
  | 'worker'
  | 'dispatcher';

/** The page's four progress tones. `cancelled` rows are not work and are never counted. */
export type StoryTone = 'done' | 'working' | 'blocked' | 'todo';

/** Edge types the follow walks (plus the two block types the graph draws). */
export type StoryEdgeType =
  | 'parent'
  | 'contains'
  | 'about'
  | 'working_on'
  | 'assigned_to'
  | 'attached_to'
  | 'produces'
  | 'remembers'
  | 'tracks'
  | 'created_in'
  | 'has_member'
  | 'dispatched_by'
  | 'blocks'
  | 'depends_on'
  | 'coordinates'
  | 'dispatched';

/** The six edge families + team amber. */
export type StoryEdgeFamily = 'structure' | 'story' | 'runs' | 'made' | 'code' | 'blocks' | 'team';

/** The graph's view switcher. */
export type StoryGraphView = 'all' | 'tasks' | 'sessions' | 'made' | 'code' | 'memories' | 'team';

export interface StoryTally {
  done: number;
  working: number;
  blocked: number;
  todo: number;
  /** done + working + blocked + todo (cancelled excluded). */
  total: number;
}

export interface StoryPerson {
  id: string;
  name: string;
  /** Short avatar text (initial). */
  initials: string;
  agent: boolean;
  /** Set for agents: the tm8 mode their teammate runs in. */
  mode?: StoryMode | null;
}

export interface StoryTask {
  id: string;
  /** Usually 'task'; any kind with a status may sit here. */
  kind: string;
  title: string;
  tone: StoryTone;
  /** The raw status slug (`working`, `in_review`, …) for display and patching. */
  status: string;
  /** Person id of the assignee, if any. */
  assigneeId?: string | null;
  /** ISO time of the last activity; within the hour draws a halo. */
  activityAt?: string | null;
}

export interface StoryTrailItem {
  id: string;
  kind: string;
  title: string;
  /** The edge that brought it into the trail. */
  edge: StoryEdgeType;
  /** The root or child it hangs off. */
  toId: string;
  direction: 'in' | 'out';
  /** Kind-specific status (`merged`, `open`, …). */
  status?: string | null;
  /** A session that has exited. */
  exited?: boolean;
  /** A pending attention request. */
  waiting?: boolean;
  activityAt?: string | null;
}

export interface StoryRoot extends StoryTask {
  /** Children of the root (same-kind subtree, flattened to depth 1 for display). */
  children: StoryTask[];
  /** Everything that followed from this root along the follow edges. */
  trail: StoryTrailItem[];
  /** Root + children tally. */
  progress: StoryTally;
}

export interface StorySession {
  id: string;
  title: string;
  personId: string;
  live: boolean;
  exited: boolean;
  createdAt: string;
  /** Call sign: Ash, Birch, … by created_at order. Computed by the read path. */
  sign: string;
  /** Task ids this session is working_on. A live one collapses into its task as one capsule. */
  taskIds: string[];
  /** True when the session works on the story itself rather than a task. */
  onStory: boolean;
}

export interface StoryDispatch {
  taskId: string;
  toPersonId: string | null;
  /** Plain words: "picked up by Forge", "waiting for a worker". */
  state: string;
}

export interface StoryTeammate {
  /** team_member entity id. */
  id: string;
  personId: string;
  /** Parent teammate id (the existing team_member hierarchy). */
  parentId: string | null;
  live: boolean;
  /** Free text: "coordinating the story · 3 reports". */
  note?: string | null;
  runs: string[];
  assigned: string[];
  dispatched: StoryDispatch[];
}

export interface StoryChild {
  id: string;
  title: string;
  status: string;
  tone: StoryTone;
  progress: StoryTally;
  liveCount: number;
  peopleIds: string[];
  lastActivityAt: string | null;
  thingCount: number;
}

/** An edge the graph draws that is not root→child or a trail edge. */
export interface StoryLink {
  fromId: string;
  toId: string;
  edge: StoryEdgeType;
  /** Reaches across roots: drawn as a dashed arc. */
  cross?: boolean;
}

/** One message on any anchor in the story — the live feed's row. */
export interface StoryFeedItem {
  id: string;
  authorId: string;
  anchorId: string;
  anchorKind: string;
  anchorTitle: string;
  body: string;
  at: string;
  system?: boolean;
}

/** One line of "What's happening", newest first. */
export interface StoryActivity {
  id: string;
  at: string;
  /** Kind of the thing it happened to (for the glyph). */
  kind: string;
  /** Plain words: "Forge marked Projector mirrors the facade done". */
  what: string;
  /** Plain words for the path: "via root 2". */
  via?: string | null;
  byId?: string | null;
  entityId?: string | null;
}

export interface StoryView {
  id: string;
  version: number;
  title: string;
  description: string;
  status: string;
  tone: StoryTone;
  parent: { id: string; title: string } | null;
  /** Overall tally across every root's subtree. */
  progress: StoryTally;
  /** Overall + every child story, rolled up. */
  rollup: StoryTally;
  liveSessionCount: number;
  pendingAttentionCount: number;
  lastActivityAt: string | null;
  people: StoryPerson[];
  roots: StoryRoot[];
  sessions: StorySession[];
  team: StoryTeammate[];
  children: StoryChild[];
  /** Things hanging off the story itself (e.g. the design chat, `about`). */
  storyTrail: StoryTrailItem[];
  links: StoryLink[];
  feed: StoryFeedItem[];
  activity: StoryActivity[];
  /** True when the follow hit its 500-row bound — the page says so. */
  truncated: boolean;
}

/* ------------------------------------------------------------------------- */
/* Kind- and edge-keyed tables. Data, not branches.                          */
/* ------------------------------------------------------------------------- */

export const EDGE_FAMILY: Record<StoryEdgeType, StoryEdgeFamily> = {
  parent: 'structure',
  contains: 'story',
  about: 'story',
  working_on: 'runs',
  assigned_to: 'runs',
  attached_to: 'made',
  produces: 'made',
  remembers: 'made',
  created_in: 'made',
  tracks: 'code',
  has_member: 'team',
  dispatched_by: 'team',
  blocks: 'blocks',
  depends_on: 'blocks',
  coordinates: 'team',
  dispatched: 'team',
};

/** Which view a kind belongs to; unknown kinds show only under Everything. */
export const VIEW_OF_KIND: Record<string, StoryGraphView> = {
  task: 'tasks',
  attention: 'tasks',
  work_session: 'sessions',
  team_member: 'team',
  doc: 'made',
  drawing: 'made',
  artifact: 'made',
  file: 'made',
  memory: 'memories',
  pull_request: 'code',
  commit: 'code',
};

export const GRAPH_VIEWS: ReadonlyArray<{ view: StoryGraphView; label: string }> = [
  { view: 'all', label: 'Everything' },
  { view: 'tasks', label: 'Tasks' },
  { view: 'sessions', label: 'Sessions' },
  { view: 'made', label: 'Documents' },
  { view: 'code', label: 'Code' },
  { view: 'memories', label: 'Memories' },
  { view: 'team', label: 'Team' },
];

export const MODE_WORD: Record<StoryMode, string> = {
  coordinator: 'coordinator',
  'coordinated-coordinator': 'sub-coordinator',
  'coordinated-worker': 'worker',
  worker: 'worker',
  dispatcher: 'dispatcher',
};

export const TONE_WORD: Record<StoryTone, string> = {
  done: 'done',
  working: 'working',
  blocked: 'blocked',
  todo: 'to do',
};

/* ------------------------------------------------------------------------- */
/* Pure derivations shared by every block.                                   */
/* ------------------------------------------------------------------------- */

export const CALL_SIGNS = [
  'Ash', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Grove', 'Hazel', 'Iris', 'Juniper', 'Kelp', 'Laurel', 'Moss',
  'Nettle', 'Oak', 'Pine', 'Quill', 'Reed', 'Sage', 'Thorn', 'Umber', 'Vale', 'Willow', 'Xylem', 'Yarrow', 'Zinnia',
] as const;

/** The i-th call sign by created_at order: Ash … Zinnia, then Ash 2 … */
export function callSign(i: number): string {
  const n = CALL_SIGNS.length;
  return CALL_SIGNS[i % n] + (i >= n ? ` ${Math.floor(i / n) + 1}` : '');
}

export const EMPTY_TALLY: StoryTally = { done: 0, working: 0, blocked: 0, todo: 0, total: 0 };

export function addTally(a: StoryTally, b: StoryTally): StoryTally {
  return {
    done: a.done + b.done,
    working: a.working + b.working,
    blocked: a.blocked + b.blocked,
    todo: a.todo + b.todo,
    total: a.total + b.total,
  };
}

export function pct(t: StoryTally): number {
  return t.total ? Math.round((100 * t.done) / t.total) : 0;
}

/** Task id → the live session running it (the capsule rule). */
export function liveOn(view: StoryView): Map<string, StorySession> {
  const m = new Map<string, StorySession>();
  for (const s of view.sessions) if (s.live) for (const t of s.taskIds) m.set(t, s);
  return m;
}

export function personOf(view: StoryView, id: string | null | undefined): StoryPerson | null {
  return id ? view.people.find((p) => p.id === id) ?? null : null;
}

/** Every task in the story (roots + children), by id. */
export function tasksById(view: StoryView): Map<string, StoryTask> {
  const m = new Map<string, StoryTask>();
  for (const r of view.roots) {
    m.set(r.id, r);
    for (const c of r.children) m.set(c.id, c);
  }
  return m;
}

/** Within the last hour — draws an activity halo. */
export function isRecent(at: string | null | undefined, now: number = Date.now()): boolean {
  return !!at && now - Date.parse(at) < 3_600_000;
}
