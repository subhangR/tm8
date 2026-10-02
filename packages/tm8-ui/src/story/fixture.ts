/**
 * The story fixture: artifact 01a0fc3e rev 4's data block as a `StoryView`.
 *
 * Ids are fixture ids (`fx-story-…`), times are relative to module load so the
 * "last hour" halos and "2 h" labels behave like the live page. Tallies are
 * COMPUTED from the rows below with the same rule the read paths use, never
 * typed in, so the fixture cannot disagree with itself.
 */
import {
  addTally,
  callSign,
  EMPTY_TALLY,
  type StoryActivity,
  type StoryChild,
  type StoryFeedItem,
  type StoryPerson,
  type StoryRoot,
  type StorySession,
  type StoryTally,
  type StoryTask,
  type StoryTeammate,
  type StoryTone,
  type StoryTrailItem,
  type StoryView,
} from './model';

const NOW = Date.now();
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

const P = (id: string, name: string, agent: boolean, mode: StoryPerson['mode'] = null): StoryPerson => ({
  id: `fx-person-${id}`,
  name,
  initials: name[0]!,
  agent,
  mode,
});

export const STORY_FIXTURE_PEOPLE: StoryPerson[] = [
  P('S', 'Subhang', false),
  P('N', 'Noor', false),
  P('W', 'Worker', true, 'coordinated-worker'),
  P('F', 'Forge', true, 'coordinated-worker'),
  P('M', 'Maestro', true, 'coordinator'),
  P('C', 'Scout', true, 'coordinated-coordinator'),
  P('D', 'Dreamer', true, 'dispatcher'),
];
const who = (k: string): string => `fx-person-${k}`;
const id = (k: string): string => `fx-story-${k}`;

const STATUS_OF: Record<StoryTone, string> = { done: 'done', working: 'working', blocked: 'blocked', todo: 'open' };
const T = (k: string, title: string, tone: StoryTone, assignee?: string, activityMin?: number): StoryTask => ({
  id: id(k),
  kind: 'task',
  title,
  tone,
  status: STATUS_OF[tone],
  assigneeId: assignee ? who(assignee) : null,
  activityAt: activityMin === undefined ? ago(60 * 20) : ago(activityMin),
});
const tr = (
  k: string,
  kind: string,
  title: string,
  edge: StoryTrailItem['edge'],
  to: string,
  direction: 'in' | 'out',
  extra: Partial<StoryTrailItem> = {},
): StoryTrailItem => ({ id: id(k), kind, title, edge, toId: id(to), direction, activityAt: ago(60 * 20), ...extra });

function tally(tasks: StoryTask[]): StoryTally {
  const t = { ...EMPTY_TALLY };
  for (const x of tasks) {
    t[x.tone] += 1;
    t.total += 1;
  }
  return t;
}
function root(task: StoryTask, children: StoryTask[], trail: StoryTrailItem[]): StoryRoot {
  return { ...task, children, trail, progress: tally([task, ...children]) };
}

const ROOTS: StoryRoot[] = [
  root(
    T('r1', 'The story kind in the database', 'done', 'W'),
    [
      T('c11', 'Migration 277: detail row and doors', 'done', 'W'),
      T('c12', 'contains and attached_to accept a story', 'done', 'W'),
      T('c13', 'entity_content arm and the db suite', 'done', 'W'),
    ],
    [
      tr('s1', 'work_session', 'Ash · Worker', 'working_on', 'r1', 'in', { exited: true }),
      tr('d1', 'doc', 'How a core kind is added', 'attached_to', 'r1', 'in'),
      tr('pr1', 'pull_request', '#990 · merged', 'tracks', 'c11', 'out', { status: 'merged' }),
      tr('cm1', 'commit', '5672919 · wip(story)', 'tracks', 'c11', 'out'),
      tr('m1', 'memory', 'Migration numbers: the union', 'remembers', 's1', 'in'),
    ],
  ),
  root(
    T('r2', 'Progress on both read paths', 'working', 'F', 12),
    [
      T('c21', 'Facade: contains closure and counts', 'done', 'F'),
      T('c22', 'Projector mirrors the facade', 'done', 'F', 18),
      T('c23', 'Pinned-era pg fixtures apply 277', 'todo'),
    ],
    [
      tr('pr2', 'pull_request', '#993 · open', 'tracks', 'r2', 'out', { status: 'open', activityAt: ago(9) }),
      tr('m2', 'memory', 'Read paths are twins', 'remembers', 'r2', 'in', { activityAt: ago(25) }),
    ],
  ),
  root(
    T('r3', 'The story page', 'working', 'W', 3),
    [
      T('c31', 'Hero, status and progress', 'done', 'S'),
      T('c32', 'One graph of the story', 'done', 'W', 30),
      T('c33', 'Roots with their trails', 'working', 'W', 2),
      T('c34', 'Thread and what’s happening', 'todo'),
    ],
    [
      tr('dr1', 'drawing', 'Story panel sketch', 'attached_to', 'r3', 'in'),
      tr('a1', 'artifact', 'This page · rev 3', 'produces', 'r3', 'out', { activityAt: ago(40) }),
      tr('f1', 'file', 'story-glyph.svg', 'attached_to', 'c32', 'in'),
    ],
  ),
  root(
    T('r4', 'Stories everywhere: filter, Home, tiles', 'todo'),
    [T('c41', 'Story filter on every list', 'todo'), T('c42', 'Home seat and tiles', 'todo')],
    [tr('d2', 'doc', 'Home rail seating ruling', 'attached_to', 'r4', 'in')],
  ),
  root(
    T('r5', 'Agents on stories', 'blocked', 'F'),
    [T('c51', 'entity context for a story', 'blocked'), T('c52', 'Spawn on a story passes the trail', 'blocked')],
    [
      tr('at1', 'attention', 'follow depth?', 'blocks', 'c51', 'out', { waiting: true }),
      tr('m3', 'memory', 'Context stays bounded', 'remembers', 'c51', 'in'),
    ],
  ),
];

const S = (k: string, w: string, live: boolean, createdMin: number, taskKeys: string[], onStory = false): Omit<StorySession, 'sign'> => ({
  id: id(k),
  title: `${STORY_FIXTURE_PEOPLE.find((p) => p.id === who(w))!.name}’s session`,
  personId: who(w),
  live,
  exited: !live,
  createdAt: ago(createdMin),
  taskIds: taskKeys.map(id),
  onStory,
});
const SESSIONS: StorySession[] = [
  S('s1', 'W', false, 60 * 26, ['r1']),
  S('s4', 'M', true, 120, [], true),
  S('s2', 'F', true, 12, ['r2']),
  S('s3', 'W', true, 1, ['r3', 'c33']),
]
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  .map((s, i) => ({ ...s, sign: callSign(i) }));

const TEAM: StoryTeammate[] = [
  { id: id('tmM'), personId: who('M'), parentId: null, live: true, note: 'coordinating the story · 3 reports', runs: [], assigned: [], dispatched: [] },
  { id: id('tmC'), personId: who('C'), parentId: id('tmM'), live: false, note: 'coordinating roots 4 and 5', runs: [], assigned: [], dispatched: [] },
  { id: id('tmW'), personId: who('W'), parentId: id('tmM'), live: true, runs: [id('r3'), id('c33')], assigned: [], dispatched: [] },
  { id: id('tmF'), personId: who('F'), parentId: id('tmC'), live: true, runs: [id('r2')], assigned: [id('r5')], dispatched: [] },
  {
    id: id('tmD'),
    personId: who('D'),
    parentId: null,
    live: false,
    runs: [],
    assigned: [],
    dispatched: [
      { taskId: id('c23'), toPersonId: who('F'), state: 'picked up by Forge' },
      { taskId: id('c41'), toPersonId: null, state: 'waiting for a worker' },
    ],
  },
];

const CHILDREN: StoryChild[] = [
  {
    id: id('cs1'),
    title: 'Story so far: the daily recap',
    status: 'working',
    tone: 'working',
    progress: { done: 2, working: 2, blocked: 0, todo: 1, total: 5 },
    liveCount: 1,
    peopleIds: [who('C'), who('W')],
    lastActivityAt: ago(60),
    thingCount: 14,
  },
  {
    id: id('cs2'),
    title: 'Scrub time',
    status: 'open',
    tone: 'todo',
    progress: { done: 0, working: 0, blocked: 0, todo: 4, total: 4 },
    liveCount: 0,
    peopleIds: [],
    lastActivityAt: ago(60 * 30),
    thingCount: 5,
  },
];

const F = (k: string, w: string, on: string, body: string, min: number, system = false): StoryFeedItem => {
  const anchor =
    on === 'story'
      ? { anchorId: id('story'), anchorKind: 'story', anchorTitle: 'the story' }
      : on.startsWith('s')
        ? { anchorId: id(on), anchorKind: 'work_session', anchorTitle: `${SESSIONS.find((s) => s.id === id(on))!.sign} · ${SESSIONS.find((s) => s.id === id(on))!.title}` }
        : { anchorId: id(on), anchorKind: 'task', anchorTitle: ROOTS.find((r) => r.id === id(on))!.title };
  return { id: id(k), authorId: who(w), ...anchor, body, at: ago(min), system };
};
const FEED: StoryFeedItem[] = [
  F('f1', 'S', 'story', 'I’m thinking we add a new higher-level entity called a story. A place where we separate different ideas.', 60 * 30),
  F('f2', 'W', 'r1', 'Migration 277 applied clean through the full chain on a scratch cluster. Numbered against the union of every remote ref.', 60 * 22),
  F('f3', 'S', 'r1', 'Merged #990. Root 1 is done.', 60 * 21),
  F('f4', 'M', 'story', 'Roots 2 and 3 are in flight. Scout holds 4 and 5 until the follow-depth ruling.', 120),
  F('f5', 'F', 's2', 'Facade and projector agree on the counts for every root; running the pinned-era fixtures now.', 40),
  F('f6', 'S', 'story', 'Live updates on the story items, man. Messages live, messages from all the activity on the story.', 4),
];

const A = (k: string, kind: string, what: string, via: string, min: number, by: string, on?: string): StoryActivity => ({
  id: id(k),
  kind,
  what,
  via,
  at: ago(min),
  byId: who(by),
  entityId: on ? id(on) : null,
});
const ACTIVITY: StoryActivity[] = [
  A('e1', 'task', 'Worker started Roots with their trails', 'root 3 · working_on', 2, 'W', 'c33'),
  A('e2', 'pull_request', 'Forge opened #993', 'root 2 · tracks', 9, 'F', 'pr2'),
  A('e3', 'task', 'Forge marked Projector mirrors the facade done', 'root 2 · parent → child', 18, 'F', 'c22'),
  A('e4', 'memory', 'Forge remembered Read paths are twins', 'root 2 · remembers', 25, 'F', 'm2'),
  A('e5', 'artifact', 'Worker published This page · rev 3', 'root 3 · produces', 40, 'W', 'a1'),
  A('e6', 'attention', 'Scout asked: follow depth?', 'root 5 · blocks', 60 * 3, 'C', 'at1'),
];

const progress = ROOTS.reduce((a, r) => addTally(a, r.progress), EMPTY_TALLY);

export const STORY_FIXTURE: StoryView = {
  id: id('story'),
  version: 7,
  title: 'Story as an Entity',
  description:
    'A story is one entity you put things in by hand. Everything connected to what you put in follows along, and the page computes progress, who is on it and what is blocked from what is in it.',
  status: 'working',
  tone: 'working',
  parent: { id: id('parent'), title: 'Q4: tm8 as a team space' },
  progress,
  rollup: CHILDREN.reduce((a, c) => addTally(a, c.progress), progress),
  liveSessionCount: SESSIONS.filter((s) => s.live).length,
  pendingAttentionCount: 1,
  lastActivityAt: ago(2),
  people: STORY_FIXTURE_PEOPLE,
  roots: ROOTS,
  sessions: SESSIONS,
  team: TEAM,
  children: CHILDREN,
  storyTrail: [{ id: id('ch1'), kind: 'chat', title: 'Design session', edge: 'about', toId: id('story'), direction: 'in', activityAt: ago(60 * 30) }],
  links: [
    { fromId: id('d1'), toId: id('c33'), edge: 'attached_to', cross: true },
    { fromId: id('r3'), toId: id('m3'), edge: 'remembers', cross: true },
    { fromId: id('r2'), toId: id('r5'), edge: 'assigned_to', cross: true },
    { fromId: id('c51'), toId: id('c52'), edge: 'depends_on' },
  ],
  feed: FEED,
  activity: ACTIVITY,
  truncated: false,
};

/** An empty story: the page's empty states. */
export const STORY_FIXTURE_EMPTY: StoryView = {
  ...STORY_FIXTURE,
  id: id('empty'),
  title: 'Untitled story',
  description: '',
  status: 'open',
  tone: 'todo',
  parent: null,
  progress: EMPTY_TALLY,
  rollup: EMPTY_TALLY,
  liveSessionCount: 0,
  pendingAttentionCount: 0,
  lastActivityAt: null,
  people: [],
  roots: [],
  sessions: [],
  team: [],
  children: [],
  storyTrail: [],
  links: [],
  feed: [],
  activity: [],
};
