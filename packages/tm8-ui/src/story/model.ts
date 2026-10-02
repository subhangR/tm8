/**
 * The story page's view model — ONE object the whole page renders from.
 *
 * It IS the backend's read, not a re-shaping of it: `state` is the contract's
 * `StoryState` (both read paths), `page` is the contract's `StoryPage` (detail
 * hydration), exactly as `packages/contract/src/story.ts` publishes them. The
 * only UI-side additions are the live feed (backlog merged with live message
 * events, owned by `data/useStoryLive`) and a `people` map that names the
 * actors the page ids point at. Every number on the page is computed by the
 * server; the UI never recomputes progress, it only reads it.
 *
 * Kind names are DATA here (`kind: string`), never `case 'task':` branches in
 * components — §15.2's scanner forbids kind literals in components, so every
 * kind-keyed table lives in this file.
 */
import {
  storyCallSign,
  storyEdgeFamily,
  type StatusCategory,
  type StoryChild,
  type StoryEdgeFamily,
  type StoryFeedMessage,
  type StoryNode,
  type StoryPage,
  type StoryProgress,
  type StorySession,
  type StoryState,
  type TeamMemberMode,
} from '@tm8/contract';

export type {
  StoryActivityItem,
  StoryChild,
  StoryDispatch,
  StoryEdgeFamily,
  StoryFeedMessage,
  StoryGraphEdge,
  StoryNode,
  StoryPage,
  StoryProgress,
  StoryRoot,
  StorySession,
  StoryState,
  StoryTeammate,
  StoryTrailItem,
} from '@tm8/contract';
export { storyCallSign, storyEdgeFamily };

/** Who an id on the page is: an author, an actor, an assignee, a teammate. */
export interface StoryPerson {
  id: string;
  name: string;
  /** Short avatar text (one or two letters). */
  initials: string;
  agent: boolean;
  mode?: TeamMemberMode | null;
}

/** A feed row: a backlog message, or one that arrived live (`incoming`). */
export interface StoryFeedRow extends StoryFeedMessage {
  incoming?: boolean;
}

export interface StoryView {
  id: string;
  version: number;
  title: string;
  description: string;
  /** The story's own workflow status (152) and its category. */
  status: string;
  statusCategory: StatusCategory | null;
  state: StoryState;
  /** Never null here: the host hands an empty page when the read carried none. */
  page: StoryPage;
  /** Newest first: page.recentMessages merged with live message events. */
  feed: StoryFeedRow[];
  /** actor / author / teammate id → display. Unknown ids render as "someone". */
  people: Readonly<Record<string, StoryPerson>>;
}

/* ------------------------------------------------------------------------- */
/* Kind- and edge-keyed tables. Data, not branches.                          */
/* ------------------------------------------------------------------------- */

/** The graph's view switcher. */
export type StoryGraphView = 'all' | 'tasks' | 'sessions' | 'made' | 'code' | 'memories' | 'team';

/** Which view a kind belongs to; unknown kinds show only under Everything. */
export const VIEW_OF_KIND: Readonly<Record<string, StoryGraphView>> = {
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

/** Kind names the page needs as values (capsule, anchors), kept here so components hold no kind literal. */
export const TASK_KIND = 'task';
export const SESSION_KIND = 'work_session';
export const STORY_KIND = 'story';

export const GRAPH_VIEWS: ReadonlyArray<{ view: StoryGraphView; label: string }> = [
  { view: 'all', label: 'Everything' },
  { view: 'tasks', label: 'Tasks' },
  { view: 'sessions', label: 'Sessions' },
  { view: 'made', label: 'Documents' },
  { view: 'code', label: 'Code' },
  { view: 'memories', label: 'Memories' },
  { view: 'team', label: 'Team' },
];

export const MODE_WORD: Readonly<Record<TeamMemberMode, string>> = {
  coordinator: 'coordinator',
  'coordinated-coordinator': 'sub-coordinator',
  'coordinated-worker': 'worker',
  worker: 'worker',
  dispatcher: 'dispatcher',
};

/** The page's four progress tones (cancelled is not work and has none). */
export type StoryTone = 'done' | 'working' | 'blocked' | 'todo';

export const TONE_WORD: Readonly<Record<StoryTone, string>> = {
  done: 'done',
  working: 'working',
  blocked: 'blocked',
  todo: 'to do',
};

/** CSS custom property per edge family (graph strokes, trail chips). */
export const FAMILY_TOKEN: Readonly<Record<StoryEdgeFamily, string>> = {
  parent: 'var(--pn-line-2)',
  story: 'var(--pn-brand)',
  runs: 'var(--pn-run)',
  made: 'var(--pn-pr-merged)',
  code: 'var(--pn-info)',
  blocks: 'var(--pn-block)',
  team: 'var(--pn-wait)',
};

/* ------------------------------------------------------------------------- */
/* Pure derivations shared by every block. Display only — never a figure.    */
/* ------------------------------------------------------------------------- */

/** The tone a row draws in. Null for cancelled (not work). */
export function toneOf(row: { statusCategory: StatusCategory | null; blocked?: boolean }): StoryTone | null {
  if (row.statusCategory === 'cancelled') return null;
  if (row.statusCategory === 'done') return 'done';
  if (row.blocked) return 'blocked';
  if (row.statusCategory === 'in_progress') return 'working';
  return 'todo';
}

/**
 * A progress tally split into the meter's four disjoint segments. The server's
 * `blocked` overlaps in-progress / to-do; for the meter it is taken out of
 * to-do first, then in-progress, so the segments sum to `work`.
 */
export function segments(p: StoryProgress): Record<StoryTone, number> & { total: number } {
  const fromTodo = Math.min(p.blocked, p.toDo);
  const fromWorking = Math.min(p.blocked - fromTodo, p.inProgress);
  return {
    done: p.done,
    working: p.inProgress - fromWorking,
    blocked: fromTodo + fromWorking,
    todo: p.toDo - fromTodo,
    total: p.work,
  };
}

export function pct(p: StoryProgress): number {
  return p.work ? Math.round((100 * p.done) / p.work) : 0;
}

export const EMPTY_PROGRESS: StoryProgress = { work: 0, done: 0, inProgress: 0, toDo: 0, blocked: 0, cancelled: 0 };

export function emptyPage(asOf: string = new Date(0).toISOString()): StoryPage {
  return {
    asOf,
    follow: { depth: 3, limit: 500, truncated: false, edgeTypes: [] },
    parent: null,
    roots: [],
    nodes: [],
    edges: [],
    sessions: [],
    team: [],
    childStories: [],
    activity: [],
    feedAnchorIds: [],
    recentMessages: [],
  };
}

export function nodesById(view: StoryView): Map<string, StoryNode> {
  return new Map(view.page.nodes.map((n) => [n.id, n]));
}

/** Task id → the live session running it (the capsule rule: one node holds task, session and teammate). */
export function liveOn(view: StoryView): Map<string, StorySession> {
  const m = new Map<string, StorySession>();
  for (const s of view.page.sessions) if (s.live) for (const t of s.taskIds) if (!m.has(t)) m.set(t, s);
  return m;
}

export function personOf(view: StoryView, id: string | null | undefined): StoryPerson | null {
  return id ? view.people[id] ?? null : null;
}

export function nameOf(view: StoryView, id: string | null | undefined): string {
  return personOf(view, id)?.name ?? 'someone';
}

/** 1-based root number by `position` order (the page says "root 3"). */
export function rootNumber(view: StoryView, rootId: string): number {
  return view.page.roots.findIndex((r) => r.id === rootId) + 1;
}

export function childStoryProgress(c: StoryChild): StoryProgress {
  return c.taskProgress;
}

/** Within the last hour — draws an activity halo. */
export function isRecent(at: string | null | undefined, now: number = Date.now()): boolean {
  return !!at && now - Date.parse(at) < 3_600_000;
}

/** "now", "4 min", "2 h", "Oct 1". */
export function since(at: string | null | undefined, now: number = Date.now()): string {
  if (!at) return '—';
  const min = Math.round((now - Date.parse(at)) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
