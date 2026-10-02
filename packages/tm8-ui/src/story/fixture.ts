/**
 * The story fixture: artifact 01a0fc3e rev 4's data block, in the PUBLISHED
 * contract shape (`StoryState` + `StoryPage` from packages/contract/src/story.ts).
 *
 * Ids are fixture ids (`fx-…`); times are relative to module load so the
 * "last hour" halos and "2 h" labels behave like the live page. Every tally is
 * COMPUTED from the node rows below with the server's rule (work = category
 * not cancelled, done = category done, bands disjoint), never typed in, so
 * the fixture cannot disagree with itself.
 */
import {
  storyCallSign,
  type ActorSummary,
  storyEdgeFamily,
  type StatusCategory,
  type StoryActivityItem,
  type StoryChild,
  type StoryFeedMessage,
  type StoryGraphEdge,
  type StoryNode,
  type StoryPage,
  type StoryProgress,
  type StoryRoot,
  type StorySession,
  type StoryState,
  type StoryTeammate,
  type StoryTrailItem,
  type TeamMemberMode,
} from '@tm8/contract';

import { EMPTY_PROGRESS, emptyPage, type StoryPerson, type StoryView } from './model';

const NOW = Date.now();
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const OLD = ago(60 * 20);

const fx = (k: string): string => `fx-${k}`;
const STORY_ID = fx('story');

/* ---- people: two humans (members) and five teammates (team_member ids) ---- */
const person = (k: string, name: string, agent: boolean, mode: TeamMemberMode | null = null): StoryPerson => ({
  id: fx(agent ? `tm${k}` : `member-${k}`),
  name,
  initials: name[0]!,
  agent,
  mode,
});
const PEOPLE_LIST: StoryPerson[] = [
  person('S', 'Subhang', false),
  person('N', 'Noor', false),
  person('M', 'Maestro', true, 'coordinator'),
  person('C', 'Scout', true, 'coordinated-coordinator'),
  person('W', 'Worker', true, 'coordinated-worker'),
  person('F', 'Forge', true, 'coordinated-worker'),
  person('D', 'Dreamer', true, 'dispatcher'),
];
const PEOPLE: Record<string, StoryPerson> = Object.fromEntries(PEOPLE_LIST.map((p) => [p.id, p]));
/** The ActorSummary the server attaches to a feed / activity row. */
const actorOf = (id: string): ActorSummary => {
  const p = PEOPLE[id]!;
  return { id, kind: p.agent ? 'team_member' : 'member', displayName: p.name, isAgent: p.agent };
};
const human = (k: string): string => fx(`member-${k}`);
const tm = (k: string): string => fx(`tm${k}`);

/* ---- nodes ---- */
type Tone = 'done' | 'working' | 'blocked' | 'todo';
const CAT: Record<Tone, { status: string; statusCategory: StatusCategory; blocked: boolean }> = {
  done: { status: 'done', statusCategory: 'done', blocked: false },
  working: { status: 'working', statusCategory: 'in_progress', blocked: false },
  blocked: { status: 'open', statusCategory: 'to_do', blocked: true },
  todo: { status: 'open', statusCategory: 'to_do', blocked: false },
};

const nodes: StoryNode[] = [];
const node = (n: Partial<StoryNode> & Pick<StoryNode, 'id' | 'kind' | 'title' | 'depth' | 'rootIds'>): StoryNode => {
  const full: StoryNode = { status: null, statusCategory: null, blocked: false, activityAt: OLD, createdAt: OLD, ...n };
  nodes.push(full);
  return full;
};
const task = (k: string, title: string, tone: Tone, root: string, depth: number, activityMin?: number): StoryNode =>
  node({ id: fx(k), kind: 'task', title, depth, rootIds: [fx(root)], ...CAT[tone], activityAt: activityMin === undefined ? OLD : ago(activityMin) });

node({ id: STORY_ID, kind: 'story', title: 'Story as an Entity', depth: -1, rootIds: [], status: 'working', statusCategory: 'in_progress', activityAt: ago(2) });

const edges: StoryGraphEdge[] = [];
const edge = (from: string, to: string, type: string, rootIds: string[], cross = false): void => {
  edges.push({ id: type === 'parent' ? null : fx(`e-${from}-${to}`), fromId: fx(from), toId: fx(to), type, family: storyEdgeFamily(type), cross, rootIds: rootIds.map(fx) });
};

/* ---- roots, children and trails (the artifact's ROOTS) ---- */
interface RootSpec {
  k: string;
  title: string;
  tone: Tone;
  activityMin?: number;
  children: Array<[k: string, title: string, tone: Tone, activityMin?: number]>;
  /** [k, kind, title, edgeType, via, direction, depth, extra] */
  trail: Array<[string, string, string, string, string, 'in' | 'out', number, Partial<StoryNode>?]>;
}
const ROOT_SPECS: RootSpec[] = [
  {
    k: 'r1', title: 'The story kind in the database', tone: 'done',
    children: [
      ['c11', 'Migration 283: detail row and doors', 'done'],
      ['c12', 'contains and attached_to accept a story', 'done'],
      ['c13', 'entity_content arm and the db suite', 'done'],
    ],
    trail: [
      ['s1', 'work_session', 'Worker’s session', 'working_on', 'r1', 'in', 1, { live: false }],
      ['d1', 'doc', 'How a core kind is added', 'attached_to', 'r1', 'in', 1],
      ['pr1', 'pull_request', '#990 · merged', 'tracks', 'c11', 'out', 2, { status: 'merged' }],
      ['cm1', 'commit', '5672919 · wip(story)', 'tracks', 'c11', 'out', 2],
      ['m1', 'memory', 'Migration numbers: the union', 'remembers', 's1', 'in', 2],
    ],
  },
  {
    k: 'r2', title: 'Progress on both read paths', tone: 'working', activityMin: 12,
    children: [
      ['c21', 'Facade: contains closure and counts', 'done'],
      ['c22', 'Projector mirrors the facade', 'done', 18],
      ['c23', 'Pinned-era pg fixtures apply 283', 'todo'],
    ],
    trail: [
      ['s2', 'work_session', 'Forge’s session', 'working_on', 'r2', 'in', 1, { live: true, activityAt: ago(1) }],
      ['pr2', 'pull_request', '#993 · open', 'tracks', 'r2', 'out', 1, { status: 'open', activityAt: ago(9) }],
      ['m2', 'memory', 'Read paths are twins', 'remembers', 'r2', 'in', 1, { activityAt: ago(25) }],
    ],
  },
  {
    k: 'r3', title: 'The story page', tone: 'working', activityMin: 3,
    children: [
      ['c31', 'Hero, status and progress', 'done'],
      ['c32', 'One graph of the story', 'done', 30],
      ['c33', 'Roots with their trails', 'working', 2],
      ['c34', 'Thread and what’s happening', 'todo'],
    ],
    trail: [
      ['s3', 'work_session', 'Worker’s session', 'working_on', 'r3', 'in', 1, { live: true, activityAt: ago(0) }],
      ['dr1', 'drawing', 'Story panel sketch', 'attached_to', 'r3', 'in', 1],
      ['a1', 'artifact', 'This page · rev 3', 'produces', 'r3', 'out', 1, { activityAt: ago(40) }],
      ['f1', 'file', 'story-glyph.svg', 'attached_to', 'c32', 'in', 2],
    ],
  },
  {
    k: 'r4', title: 'Stories everywhere: filter, Home, tiles', tone: 'todo',
    children: [
      ['c41', 'Story filter on every list', 'todo'],
      ['c42', 'Home seat and tiles', 'todo'],
    ],
    trail: [['d2', 'doc', 'Home rail seating ruling', 'attached_to', 'r4', 'in', 1]],
  },
  {
    k: 'r5', title: 'Agents on stories', tone: 'blocked',
    children: [
      ['c51', 'entity context for a story', 'blocked'],
      ['c52', 'Spawn on a story passes the trail', 'blocked'],
    ],
    trail: [
      ['at1', 'attention', 'follow depth?', 'about', 'c51', 'in', 2, { status: 'pending', statusCategory: 'to_do' }],
      ['m3', 'memory', 'Context stays bounded', 'remembers', 'c51', 'in', 2],
    ],
  },
];

function tally(rows: StoryNode[]): StoryProgress {
  const p = { ...EMPTY_PROGRESS };
  for (const r of rows) {
    if (!r.statusCategory) continue;
    if (r.statusCategory === 'cancelled') { p.cancelled += 1; continue; }
    p.work += 1;
    if (r.statusCategory === 'done') p.done += 1;
    else if (r.blocked) p.blocked += 1;
    else if (r.statusCategory === 'in_progress') p.inProgress += 1;
    else p.toDo += 1;
  }
  return p;
}
const onlyTasks = (rows: StoryNode[]): StoryNode[] => rows.filter((r) => r.kind === 'task');

const roots: StoryRoot[] = ROOT_SPECS.map((spec, i) => {
  const root = task(spec.k, spec.title, spec.tone, spec.k, 0, spec.activityMin);
  edge('story', spec.k, 'contains', [spec.k]);
  const kids = spec.children.map(([k, title, tone, min]) => {
    edge(spec.k, k, 'parent', [spec.k]);
    return task(k, title, tone, spec.k, 1, min);
  });
  const trail: StoryTrailItem[] = spec.trail.map(([k, kind, title, edgeType, via, direction, depth, extra]) => {
    node({ id: fx(k), kind, title, depth, rootIds: [fx(spec.k)], ...extra });
    if (direction === 'out') edge(via, k, edgeType, [spec.k]);
    else edge(k, via, edgeType, [spec.k]);
    return { id: fx(k), kind, title, edgeType, family: storyEdgeFamily(edgeType), viaId: fx(via), direction, depth };
  });
  const rows = [root, ...kids, ...trail.map((t) => nodes.find((n) => n.id === t.id)!)];
  return {
    id: root.id,
    kind: root.kind,
    title: root.title,
    status: root.status,
    statusCategory: root.statusCategory,
    blocked: root.blocked,
    position: i,
    progress: tally(rows),
    taskProgress: tally(onlyTasks(rows)),
    childIds: kids.map((c) => c.id),
    trail,
  };
});

/* The story's own trail and the cross-root links (the artifact's STORY_TRAIL + EXTRA). */
node({ id: fx('ch1'), kind: 'chat', title: 'Design session', depth: 1, rootIds: [], activityAt: ago(60 * 30) });
edges.push({ id: fx('e-ch1-story'), fromId: fx('ch1'), toId: STORY_ID, type: 'about', family: 'story', cross: false, rootIds: [] });
edge('d1', 'c33', 'attached_to', ['r1', 'r3'], true);
edge('r3', 'm3', 'remembers', ['r3', 'r5'], true);
edge('r2', 'r5', 'assigned_to', ['r2', 'r5'], true);
edge('c52', 'c51', 'depends_on', ['r5']);
/* Both cross-root rows are also reached from root 3. */
for (const id of ['d1', 'm3']) nodes.find((n) => n.id === fx(id))!.rootIds.push(fx('r3'));

/* ---- sessions, by created_at → call signs ---- */
const SESSION_SPECS: Array<[k: string, who: string, live: boolean, createdMin: number, tasks: string[], roots: string[]]> = [
  ['s1', 'W', false, 60 * 26, ['r1'], ['r1']],
  ['s4', 'M', true, 120, [], []],
  ['s2', 'F', true, 12, ['r2'], ['r2']],
  ['s3', 'W', true, 1, ['r3', 'c33'], ['r3']],
];
const sessions: StorySession[] = SESSION_SPECS.sort((a, b) => b[3] - a[3]).map(([k, w, live, createdMin, tasks, rs], i) => ({
  id: fx(k),
  title: `${PEOPLE[tm(w)]!.name}’s session`,
  callSign: storyCallSign(i),
  createdAt: ago(createdMin),
  live,
  runtimeStatus: live ? 'running' : 'exited',
  teamMemberId: tm(w),
  mode: PEOPLE[tm(w)]!.mode ?? null,
  taskIds: tasks.map(fx),
  rootIds: rs.map(fx),
  dispatchedById: w === 'M' ? null : fx('s4'),
}));
/* The coordinator's session sits on the story itself; it is a node too. */
node({ id: fx('s4'), kind: 'work_session', title: 'Maestro’s session', depth: 1, rootIds: [], live: true, activityAt: ago(5) });
for (const s of sessions) {
  const n = nodes.find((x) => x.id === s.id);
  if (n) {
    n.callSign = s.callSign;
    n.live = s.live;
    n.createdAt = s.createdAt;
    n.status = s.runtimeStatus;
  }
}

const team: StoryTeammate[] = [
  { kind: 'team_member', id: tm('M'), name: 'Maestro', mode: 'coordinator', parentId: null, live: true, sessionIds: [fx('s4')], runs: [], assigned: [], dispatched: [] },
  { kind: 'team_member', id: tm('C'), name: 'Scout', mode: 'coordinated-coordinator', parentId: tm('M'), live: false, sessionIds: [], runs: [], assigned: [], dispatched: [] },
  { kind: 'team_member', id: tm('W'), name: 'Worker', mode: 'coordinated-worker', parentId: tm('M'), live: true, sessionIds: [fx('s1'), fx('s3')], runs: [fx('r3'), fx('c33')], assigned: [], dispatched: [] },
  { kind: 'team_member', id: tm('F'), name: 'Forge', mode: 'coordinated-worker', parentId: tm('C'), live: true, sessionIds: [fx('s2')], runs: [fx('r2')], assigned: [fx('r5')], dispatched: [] },
  {
    kind: 'team_member', id: tm('D'), name: 'Dreamer', mode: 'dispatcher', parentId: null, live: false, sessionIds: [], runs: [], assigned: [],
    dispatched: [
      { taskId: fx('c23'), sessionId: fx('s2') },
      { taskId: fx('c41'), sessionId: null },
    ],
  },
];

/* Humans who touched the story sit on the team too, as members with no mode (283). */
team.push(
  { kind: 'member', id: human('S'), name: 'Subhang', mode: null, parentId: null, live: false, sessionIds: [], runs: [], assigned: [], dispatched: [] },
  { kind: 'member', id: human('N'), name: 'Noor', mode: null, parentId: null, live: false, sessionIds: [], runs: [], assigned: [], dispatched: [] },
);

const childStories: StoryChild[] = [
  {
    id: fx('cs1'), title: 'Story so far: the daily recap', status: 'working', statusCategory: 'in_progress', itemCount: 14,
    taskProgress: { work: 5, done: 2, inProgress: 2, toDo: 1, blocked: 0, cancelled: 0 },
    rollup: { work: 5, done: 2, inProgress: 2, toDo: 1, blocked: 0, cancelled: 0 },
    liveSessionCount: 1, lastActivityAt: ago(60),
  },
  {
    id: fx('cs2'), title: 'Scrub time', status: 'open', statusCategory: 'to_do', itemCount: 5,
    taskProgress: { work: 4, done: 0, inProgress: 0, toDo: 4, blocked: 0, cancelled: 0 },
    rollup: { work: 4, done: 0, inProgress: 0, toDo: 4, blocked: 0, cancelled: 0 },
    liveSessionCount: 0, lastActivityAt: ago(60 * 30),
  },
];

const title = (id: string): string => nodes.find((n) => n.id === id)?.title ?? id;
const kindOf = (id: string): string => nodes.find((n) => n.id === id)?.kind ?? 'task';
const activity: StoryActivityItem[] = (
  [
    ['e1', 2, 'c33', 'updated', tm('W')],
    ['e2', 9, 'pr2', 'linked', tm('F')],
    ['e3', 18, 'c22', 'updated', tm('F')],
    ['e4', 25, 'm2', 'created', tm('F')],
    ['e5', 40, 'a1', 'created', tm('W')],
    ['e6', 180, 'at1', 'created', tm('C')],
    ['e7', 60 * 21, 'r1', 'updated', human('S')],
  ] as Array<[string, number, string, string, string]>
).map(([k, min, on, verb, actorId]) => ({
  id: fx(k), at: ago(min), entityId: fx(on), entityKind: kindOf(fx(on)), entityTitle: title(fx(on)), verb, actorId, actor: actorOf(actorId),
}));

const msg = (k: string, authorId: string, on: string, excerpt: string, min: number): StoryFeedMessage => {
  const anchorId = on === 'story' ? STORY_ID : fx(on);
  const s = sessions.find((x) => x.id === anchorId);
  return {
    id: fx(k), at: ago(min), anchorId, anchorKind: kindOf(anchorId),
    anchorTitle: on === 'story' ? 'the story' : s ? `${s.callSign} · ${s.title}` : title(anchorId),
    authorId, author: actorOf(authorId), excerpt,
  };
};
/* Newest first, as the contract orders them. */
const recentMessages: StoryFeedMessage[] = [
  msg('f6', human('S'), 'story', 'Live updates on the story items, man. Messages live, messages from all the activity on the story.', 4),
  msg('f5', tm('F'), 's2', 'Facade and projector agree on the counts for every root; running the pinned-era fixtures now.', 40),
  msg('f4', tm('M'), 'story', 'Roots 2 and 3 are in flight. Scout holds 4 and 5 until the follow-depth ruling.', 120),
  msg('f3', human('S'), 'r1', 'Merged #990. Root 1 is done.', 60 * 21),
  msg('f2', tm('W'), 'r1', 'Migration 283 applied clean through the full chain on a scratch cluster. Numbered against the union of every remote ref.', 60 * 22),
  msg('f1', human('S'), 'story', 'I’m thinking we add a new higher-level entity called a story. A place where we separate different ideas.', 60 * 30),
];

const followed = nodes.filter((n) => n.depth >= 0);
const taskProgress = tally(onlyTasks(followed));
const add = (a: StoryProgress, b: StoryProgress): StoryProgress => ({
  work: a.work + b.work, done: a.done + b.done, inProgress: a.inProgress + b.inProgress,
  toDo: a.toDo + b.toDo, blocked: a.blocked + b.blocked, cancelled: a.cancelled + b.cancelled,
});

export const STORY_FIXTURE_STATE: StoryState = {
  kind: 'story',
  rootCount: roots.length,
  itemCount: followed.length,
  truncated: false,
  progress: tally(followed),
  taskProgress,
  rollup: childStories.reduce((a, c) => add(a, c.rollup), taskProgress),
  liveSessionCount: sessions.filter((s) => s.live).length,
  pendingAttentionCount: 1,
  lastActivityAt: ago(0),
  childStoryCount: childStories.length,
};

export const STORY_FIXTURE_PAGE: StoryPage = {
  asOf: ago(0),
  follow: { depth: 3, limit: 500, truncated: false, edgeTypes: ['parent', 'attached_to', 'tracks', 'working_on', 'about', 'created_in', 'assigned_to', 'has_member', 'produces', 'remembers', 'dispatched_by'] },
  parent: { id: fx('parent'), title: 'Q4: tm8 as a team space' },
  roots,
  nodes,
  edges,
  sessions,
  team,
  childStories,
  activity,
  feedAnchorIds: nodes.map((n) => n.id),
  recentMessages,
};

export const STORY_FIXTURE: StoryView = {
  id: STORY_ID,
  version: 7,
  title: 'Story as an Entity',
  description:
    'A story is one entity you put things in by hand. Everything connected to what you put in follows along, and the page computes progress, who is on it and what is blocked from what is in it.',
  status: 'working',
  statusCategory: 'in_progress',
  state: STORY_FIXTURE_STATE,
  page: STORY_FIXTURE_PAGE,
  feed: recentMessages,
  people: PEOPLE,
};

/** An empty story: the page's empty states. */
export const STORY_FIXTURE_EMPTY: StoryView = {
  id: fx('empty'),
  version: 1,
  title: 'Untitled story',
  description: '',
  status: 'open',
  statusCategory: 'to_do',
  state: {
    kind: 'story', rootCount: 0, itemCount: 0, truncated: false,
    progress: EMPTY_PROGRESS, taskProgress: EMPTY_PROGRESS, rollup: EMPTY_PROGRESS,
    liveSessionCount: 0, pendingAttentionCount: 0, lastActivityAt: null, childStoryCount: 0,
  },
  page: emptyPage(ago(0)),
  feed: [],
  people: {},
};
