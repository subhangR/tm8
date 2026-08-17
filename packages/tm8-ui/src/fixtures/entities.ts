import type {
  ActorSummary,
  EntityCapabilities,
  EntityCounters,
  EntityDetail,
  EntitySummary,
  Hierarchy,
  Connections,
  Page,
} from '@tm8/contract';
import { ada, noor, forge, scout } from './actors';

/**
 * Contract-shaped fixture dataset (A0). Shaped by EntitySummary/EntityDetail
 * from @tm8/contract — THE LAW — and zod-validated in fixtures.test.ts.
 *
 * Coverage requirements (fe-coordinator brief):
 * - all 15 core kinds + one custom (`c:*`) kind for the generic archetype;
 * - worst-case content: UUID-length titles, long excerpts, large counters;
 * - every honesty state:
 *     · stale session — status 'running' on the record but activity long
 *       past; whether a live PTY backs it is UNKNOWN until the liveness
 *       read lands (charter R3), and the UI must say so, not guess;
 *     · NEEDS YOU — in_review + a pull held by the viewer's actor;
 *     · delivery facets — PullState contentStale / discussionMoved in every
 *       combination;
 *     · tombstone — deletedAt set.
 */

export const FIXTURE_SPACE_ID = 'sp-atelier';

/** Stable "now" for fixtures — keep deterministic, never Date.now(). */
export const FIXTURE_NOW = '2026-07-28T12:00:00.000Z';

const T = {
  older: '2026-07-20T09:00:00.000Z',
  old: '2026-07-27T18:30:00.000Z',
  morning: '2026-07-28T09:15:00.000Z',
  staleEdge: '2026-07-28T11:05:00.000Z',
  recent: '2026-07-28T11:58:20.000Z',
};

function counters(over: Partial<EntityCounters> = {}): EntityCounters {
  return { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null, ...over };
}

const CAPS_FULL: EntityCapabilities = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
};

const CAPS_READONLY: EntityCapabilities = {
  canEdit: false, canDelete: false, canAddChild: false, canLink: false,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

function page<Item>(items: Item[], total = items.length): Page<Item> {
  return { items, nextCursor: null, total };
}

const NO_CONNECTIONS: Connections = { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 };

function hierarchy(parent: EntitySummary | null = null, children: EntitySummary[] = [], path: EntitySummary[] = []): Hierarchy {
  return { parent, children: page(children), path };
}

type SummaryOver = Partial<Omit<EntitySummary, 'state' | 'kind'>> & Pick<EntitySummary, 'id' | 'kind' | 'title' | 'state'>;

function summary(over: SummaryOver): EntitySummary {
  return {
    spaceId: FIXTURE_SPACE_ID,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: T.morning,
    createdAt: T.older,
    updatedAt: T.morning,
    deletedAt: null,
    createdBy: ada,
    counters: counters(),
    badges: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// channel — the container most summaries hang off
// ---------------------------------------------------------------------------

export const channelDesign = summary({
  id: 'ch-design',
  kind: 'channel',
  title: 'design',
  excerpt: 'Where the tm8-ui build coordinates.',
  // A HUMAN AND AN AGENT, deliberately. `has_member` (migration 080) admits
  // both, and a roster fixture with only people would let a members row that
  // silently drops agents look correct here.
  state: {
    kind: 'channel', topic: 'tm8-ui build', members: [ada, forge],
    unreadCount: 12, workingAgentCount: 2,
  },
  counters: counters({ messages: 148 }),
});

// ---------------------------------------------------------------------------
// voice_channel — the rail's dynamic Voice group needs something to show
// ---------------------------------------------------------------------------

/**
 * TWO rooms on purpose, covering both halves of the `live` treatment: the rail
 * renders the green "● n" only when `participantCount > 0`, and a fixture set
 * with occupied rooms only would make the empty case unobservable.
 */
export const voiceStandup = summary({
  id: 'vc-standup',
  kind: 'voice_channel',
  title: 'standup',
  state: { kind: 'voice_channel', participantCount: 3 },
});

export const voiceLounge = summary({
  id: 'vc-lounge',
  kind: 'voice_channel',
  title: 'lounge',
  state: { kind: 'voice_channel', participantCount: 0 },
});

// ---------------------------------------------------------------------------
// tasks — worst case, NEEDS YOU, live work, blocked, tombstone
// ---------------------------------------------------------------------------

/**
 * Worst-case row: UUID-length title (36 chars, no spaces — must ellipsize,
 * never wrap panels apart), long excerpt, big counters, and the full
 * delivery-facet spread: three pulls covering contentStale-only,
 * discussionMoved-only, and both. Viewer = ada, whose pull has both facets
 * AND workStatus in_review → this row is the NEEDS YOU fixture.
 */
export const taskUuidTitle = summary({
  id: 'task-4f8c2a9e',
  kind: 'task',
  title: '4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7',
  excerpt:
    'Imported by an agent from a crash report; the title is the raw incident UUID. ' +
    'Long excerpt on purpose: list rows and Z2 cards must clamp this to their line ' +
    'budget without pushing siblings around, in both themes, at every panel width ' +
    'down to the 320px floor.',
  parentId: channelDesign.id,
  position: 1,
  version: 7,
  activityAt: T.recent,
  updatedAt: T.recent,
  createdBy: forge,
  counters: counters({ likes: 41, dislikes: 3, stars: 12, points: 120, messages: 87, viewerReaction: 'star' }),
  state: {
    kind: 'task',
    workStatus: 'in_review',
    priority: 'urgent',
    axes: { area: 'ui', wave: 'w5' },
    dueDate: '2026-07-30',
    assignees: [ada, forge],
    /*
     * THE SUMMARY OF THE DETAIL'S OWN CRITERIA, and it has to be: this row's
     * `fixtureDetails` entry carries four criteria of which two are done. It
     * said 6/4 while the detail said 2/4, which nothing could see until the
     * ACCEPTANCE region was drawn — and then the list tile read "4/6 criteria"
     * beside a panel reading "ACCEPTANCE · 2/4" ON ONE SCREEN. One screen,
     * one story: change the criteria below and change this with them.
     */
    acceptance: { total: 4, completed: 2 },
    // 082's opt-in gate, ON for this task: with PR #212 open, `complete`
    // would refuse — the detail's git section states that before the click.
    completionGate: 'pr_merged',
  },
  badges: {
    pulls: [
      // both facets — the viewer's own pull; with in_review this is NEEDS YOU
      { actor: ada, localId: 'wt-ada-1', pinnedVersion: 5, contentStale: true, discussionMoved: true, workStatus: 'in_review', pulledAt: T.old },
      // contentStale only
      { actor: forge, localId: null, pinnedVersion: 6, contentStale: true, discussionMoved: false, workStatus: 'working', pulledAt: T.morning },
      // discussionMoved only
      { actor: scout, localId: null, pinnedVersion: 7, contentStale: false, discussionMoved: true, workStatus: null, pulledAt: T.staleEdge },
    ],
  },
});

export const taskGuideLines = summary({
  id: 'task-guide-lines',
  kind: 'task',
  title: 'Session tree guide lines',
  excerpt: 'Depth × 14px x-offsets, hairline in line-2, solid vs pulsing dots per streaming state.',
  parentId: channelDesign.id,
  position: 2,
  version: 3,
  activityAt: T.recent,
  createdBy: noor,
  counters: counters({ messages: 9, points: 12 }),
  state: {
    kind: 'task',
    workStatus: 'working',
    priority: 'medium',
    axes: { area: 'ui' },
    dueDate: null,
    assignees: [forge],
    acceptance: { total: 3, completed: 1 },
  },
  // workingActors is filled after sessionLive exists (LiveWork references a task summary).
});

export const taskBlocked = summary({
  id: 'task-blocked',
  kind: 'task',
  title: 'Wire palette to real command registry',
  parentId: channelDesign.id,
  position: 3,
  state: {
    kind: 'task',
    workStatus: 'blocked',
    priority: 'high',
    axes: {},
    assignees: [],
    acceptance: { total: 0, completed: 0 },
  },
  badges: { blocked: { unresolvedHardDependencyCount: 1, waitingOn: [taskGuideLines] } },
});

/** Tombstone: deletedAt set. Honest UI keeps the corpse addressable. */
export const taskTombstone = summary({
  id: 'task-tombstone',
  kind: 'task',
  title: 'Spike: CRDT for doc bodies',
  parentId: channelDesign.id,
  position: 4,
  deletedAt: T.old,
  activityAt: T.old,
  updatedAt: T.old,
  state: {
    kind: 'task',
    workStatus: 'cancelled',
    priority: 'low',
    axes: {},
    assignees: [],
    acceptance: { total: 2, completed: 0 },
  },
});

// ---------------------------------------------------------------------------
// work sessions — live, STALE (running-but-unproven), exited, failed
// ---------------------------------------------------------------------------

export const sessionLive = summary({
  id: 'ws-forge-live',
  kind: 'work_session',
  title: 'forge · tm8-ui kit',
  parentId: taskGuideLines.id,
  activityAt: T.recent,
  updatedAt: T.recent,
  createdBy: forge,
  state: {
    kind: 'work_session',
    status: 'running',
    agentTool: 'claude-code',
    model: 'claude-fable-5',
    shareMode: 'space',
    startedAt: T.morning,
    exitedAt: null,
    /* The persona behind the run. Its neighbours below deliberately carry
       none, on the same reasoning as `sessionKind`: absence is a shape the
       server really produces, and a roster where every session is attributed
       would let a renderer that assumes one pass the whole suite. */
    teammate: forge,
  },
});

/**
 * THE stale-session honesty fixture: the record says 'running' but nothing
 * has been heard since 11:05. Until the liveness read exists (charter R3)
 * the UI must render "running per record · unverified", never a live dot.
 */
export const sessionStale = summary({
  id: 'ws-scout-stale',
  kind: 'work_session',
  title: 'scout · fixture sweep',
  parentId: taskUuidTitle.id,
  activityAt: T.staleEdge,
  updatedAt: T.staleEdge,
  createdBy: scout,
  state: {
    kind: 'work_session',
    status: 'running',
    agentTool: 'claude-code',
    model: 'claude-sonnet-5',
    shareMode: 'space',
    startedAt: T.morning,
    exitedAt: null,
  },
});

export const sessionExited = summary({
  id: 'ws-forge-exited',
  kind: 'work_session',
  title: 'forge · tokens transplant',
  parentId: taskGuideLines.id,
  activityAt: T.old,
  updatedAt: T.old,
  createdBy: forge,
  state: {
    kind: 'work_session',
    status: 'exited',
    agentTool: 'claude-code',
    model: 'claude-fable-5',
    shareMode: 'none',
    startedAt: T.older,
    exitedAt: T.old,
  },
});

/**
 * A CREDENTIAL LOGIN TERMINAL — the session that must never appear in a
 * session list (082, architect Ruling 16).
 *
 * It is in `fixtureSummaries` ON PURPOSE, and that placement is the test. Every
 * surface that lists work sessions draws from this roster, so if any of them
 * stops filtering, this row appears and that surface's own count assertion goes
 * red — including surfaces written by lanes that never heard of credentials.
 * A fixture kept out of the roster would have proven only that a helper works.
 *
 * Its neighbours above deliberately carry NO `sessionKind` at all: they are the
 * pre-082 shape, and their continued visibility is what proves absence means
 * `agent` rather than "not an agent".
 */
export const sessionCredentialLogin = summary({
  id: 'ws-credential-login',
  kind: 'work_session',
  title: 'anthropic · login',
  activityAt: T.recent,
  updatedAt: T.recent,
  // `ada` the ACTOR, not `memberAda` the entity — the latter is declared far
  // below and reaching it from here is a temporal dead zone, which fails as a
  // module-load error across ~50 unrelated files rather than as a bad fixture.
  createdBy: ada,
  state: {
    kind: 'work_session',
    status: 'running',
    agentTool: 'claude-code',
    model: null,
    shareMode: 'none',
    startedAt: T.recent,
    exitedAt: null,
    sessionKind: 'credential',
  },
});

export const sessionFailed = summary({
  id: 'ws-scout-failed',
  kind: 'work_session',
  title: 'scout · doomed spike',
  parentId: taskTombstone.id,
  activityAt: T.old,
  state: {
    kind: 'work_session',
    status: 'failed',
    agentTool: 'claude-code',
    model: null,
    shareMode: 'explicit',
    startedAt: T.old,
    exitedAt: T.old,
  },
});

// Live-work badge now that both sides exist. The nested task ref is a plain
// serialized snapshot — wire data is JSON and can never be cyclic — so the
// ref must NOT carry the badge that points back at its carrier (a real
// reference cycle here sent zod into infinite recursion; caught by vitest).
const taskGuideLinesRef: EntitySummary = { ...taskGuideLines, badges: {} };
taskGuideLines.badges = {
  // `via.sessionId` names the session the work runs IN — the same claim the
  // `ge-working-live` graph edge makes from the session's side. The task's
  // side is the one that survives a bounded graph page, which is why a session
  // tile reads its PR chips through here.
  workingActors: [{
    actor: { ...forge, via: { sessionId: sessionLive.id } },
    task: taskGuideLinesRef,
    startedAt: T.morning,
    note: 'porting guide lines',
  }],
};

// ---------------------------------------------------------------------------
// remaining core kinds
// ---------------------------------------------------------------------------

export const docLayoutSpec = summary({
  id: 'doc-layout-spec',
  kind: 'doc',
  title: 'Layout spec',
  excerpt: 'C_min formula, floors, route grammar.',
  parentId: channelDesign.id,
  counters: counters({ stars: 5, messages: 22 }),
  state: { kind: 'doc', format: 'markdown', childCount: 4 },
  badges: { restricted: true },
});

/* The Layout spec's four chapters — the ORACLE'S OWN outline (T0-4 reader
   frame: Shell regions, C_min formula, Floors, Responsive). They exist so
   the reader body's TOC chips render POPULATED on the live screen; the
   honest count-without-children absence state stays visible on any doc
   whose detail carries no children (ReaderBody handover, fixture need 2). */
export const docChapterShell = summary({
  id: 'doc-chapter-shell',
  kind: 'doc',
  title: 'Shell regions',
  excerpt: 'Tab bar, rail, three columns.',
  parentId: docLayoutSpec.id,
  counters: counters({}),
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
});
export const docChapterCmin = summary({
  id: 'doc-chapter-cmin',
  kind: 'doc',
  title: 'C_min formula',
  excerpt: 'The floor arithmetic.',
  parentId: docLayoutSpec.id,
  counters: counters({}),
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
});
export const docChapterFloors = summary({
  id: 'doc-chapter-floors',
  kind: 'doc',
  title: 'Floors',
  excerpt: 'Refuse the pin, keep the reason.',
  parentId: docLayoutSpec.id,
  counters: counters({}),
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
});
export const docChapterResponsive = summary({
  id: 'doc-chapter-responsive',
  kind: 'doc',
  title: 'Responsive',
  excerpt: 'What compacts, in order.',
  parentId: docLayoutSpec.id,
  counters: counters({}),
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
});

export const messageInThread = summary({
  id: 'msg-standup',
  kind: 'message',
  title: 'Ada: kit gallery is up on 4612',
  parentId: channelDesign.id,
  activityAt: T.recent,
  createdBy: ada,
  state: {
    kind: 'message',
    anchorId: taskGuideLines.id,
    rootMessageId: null,
    author: ada,
    messageBatchId: null,
    editedAt: T.recent,
  },
});

/**
 * C-5: NULL-PROVENANCE message — authored by an AGENT, exactly where a
 * "from this session" chip is expected, but authored_from is null (backend
 * gap G2, D7.3). The gate screen proves the hollow chip on this row.
 */
export const messageAgentNullProvenance = summary({
  id: 'msg-forge-report',
  kind: 'message',
  title: 'forge: kit primitives extracted, byte-equality test green',
  parentId: channelDesign.id,
  activityAt: T.recent,
  createdBy: forge,
  state: {
    kind: 'message',
    anchorId: taskGuideLines.id,
    rootMessageId: null,
    author: forge,
    messageBatchId: 'batch-forge-7',
  },
});

/**
 * THREADS (slice 2) — a CHANNEL-anchored root with a real branch, plus an
 * unreplied root, so the fixture seam exercises both footer states and the
 * thread pane. Before these, no fixture message was anchored on a channel at
 * all (HANDOVER GAP-3's first evidence), so the roots-only channel read and
 * the branch read had nothing real to return.
 */
export const channelThreadRoot = summary({
  id: 'msg-chan-root',
  kind: 'message',
  title: 'Do we ship the thread pane behind the registry flag first?',
  parentId: channelDesign.id,
  createdAt: T.morning,
  activityAt: T.recent,
  createdBy: ada,
  state: {
    kind: 'message',
    anchorId: channelDesign.id,
    rootMessageId: null,
    author: ada,
    messageBatchId: null,
  },
});

export const channelThreadReply1 = summary({
  id: 'msg-chan-reply-1',
  kind: 'message',
  title: 'Yes — registry row only, the surface never asks the kind.',
  parentId: channelDesign.id,
  createdAt: T.staleEdge,
  activityAt: T.staleEdge,
  createdBy: forge,
  state: {
    kind: 'message',
    anchorId: channelDesign.id,
    rootMessageId: channelThreadRoot.id,
    author: forge,
    messageBatchId: null,
  },
});

export const channelThreadReply2 = summary({
  id: 'msg-chan-reply-2',
  kind: 'message',
  title: 'Agreed. Footer stays persistent — an unseen thread is a lost thread.',
  parentId: channelDesign.id,
  createdAt: T.recent,
  activityAt: T.recent,
  createdBy: ada,
  state: {
    kind: 'message',
    anchorId: channelDesign.id,
    rootMessageId: channelThreadRoot.id,
    author: ada,
    messageBatchId: null,
  },
});

/** A root with NO replies — the no-footer state, beside the footered one. */
export const channelThreadQuietRoot = summary({
  id: 'msg-chan-quiet',
  kind: 'message',
  title: 'Standup moves to 09:30 tomorrow.',
  parentId: channelDesign.id,
  createdAt: T.recent,
  activityAt: T.recent,
  createdBy: forge,
  state: {
    kind: 'message',
    anchorId: channelDesign.id,
    rootMessageId: null,
    author: forge,
    messageBatchId: null,
  },
});

export const memberAda = summary({
  id: 'ent-member-ada',
  kind: 'member',
  title: 'Ada',
  state: { kind: 'member', role: 'owner', score: 340, taskDoneCount: 27 },
});

/**
 * A SECOND human, at the least-privileged role.
 *
 * Added with 114 (the membership verbs). Before it, the fixture dataset had
 * exactly one member — the owner — so a members table drawn against it could
 * only ever show a locked row, and the role control had nothing to act on that
 * the rules would allow. One owner plus one member is the smallest population
 * in which promote, demote, the owner lock and the last-owner floor are all
 * observable.
 */
export const memberNoor = summary({
  id: 'ent-member-noor',
  kind: 'member',
  title: 'Noor',
  state: { kind: 'member', role: 'member', score: 90, taskDoneCount: 6 },
});

export const teamMemberForge = summary({
  id: 'ent-tm-forge',
  kind: 'team_member',
  title: 'forge',
  excerpt: 'A0 foundation engineer for packages/tm8-ui.',
  createdBy: ada,
  state: {
    kind: 'team_member',
    owner: ada,
    model: 'claude-fable-5',
    agentTool: 'claude-code',
    liveWork: { actor: forge, task: { ...taskGuideLines, badges: {} }, startedAt: T.morning, note: null },
  },
});

// ---------------------------------------------------------------------------
// memory — the 056 working set (084 moved it off jsonb, 085 widened the holder)
// ---------------------------------------------------------------------------

/**
 * THREE MEMORIES, chosen to cover the three states a working set can be in,
 * because the honest rendering of this surface is entirely about which state a
 * row is in and a one-memory fixture proves none of it:
 *
 *   · CLEAN — no `staleness` badge. Which, per `contract.ts:174`, means
 *     UNFLAGGED and specifically NOT verified: a verified-clean memory ships
 *     exactly this same empty badge bag (`entity-read.ts:1326` drops the whole
 *     badge when `reasons` is empty), so this row is also the fixture for "the
 *     UI cannot tell verified from unexamined".
 *   · DISPUTED — still injected at spawn, carrying its marker.
 *   · SUPERSEDED — the one that matters. It is REMEMBERED and it is NOT
 *     INJECTED (`execution-handlers.ts:162` skips it), and without this row
 *     nothing in the suite can catch a working-set list that draws all rows
 *     alike and thereby overstates the teammate's context.
 *
 * The scope fields live in `state` and not `content` on purpose — that is where
 * the contract puts them (`contract.ts:141`) so they arrive with every summary.
 */
export const memoryTokens = summary({
  id: 'ent-mem-tokens',
  kind: 'memory',
  title: 'tokens.css is verbatim — a byte-equality test guards it',
  excerpt: 'tokens.css is verbatim — a byte-equality test guards it',
  createdBy: forge,
  state: {
    kind: 'memory',
    mechanism: 'Ran the tokens-verbatim suite and diffed the emitted file against the source bytes.',
    subjectScope: 'packages/tm8-ui/src/styles/tokens.css on this branch',
    doesNotEstablish: 'that the token VALUES are correct — only that nothing rewrites the file.',
    measuredAt: T.old,
  },
});

export const memoryDisputed = summary({
  id: 'ent-mem-disputed',
  kind: 'memory',
  title: 'The fixture seam drops fields it does not know',
  excerpt: 'The fixture seam drops fields it does not know',
  createdBy: scout,
  state: {
    kind: 'memory',
    mechanism: 'Traced groupBy from a component prop to the fixture seam and found no carrier.',
    subjectScope: 'data/fixtures/seam-fixture.ts as of this revision',
    doesNotEstablish: 'that the REAL seam drops them — it does not.',
    measuredAt: T.old,
  },
  badges: {
    staleness: {
      reasons: ['disputed'],
      disputed: { openCount: 2, latestAt: T.staleEdge },
    },
  },
});

export const memorySuperseded = summary({
  id: 'ent-mem-superseded',
  kind: 'memory',
  title: 'Panels have a border-box reset',
  excerpt: 'Panels have a border-box reset',
  createdBy: forge,
  state: {
    kind: 'memory',
    mechanism: 'Read panels.css and assumed the reset from the layout behaving.',
    subjectScope: 'the panel stack as of an earlier revision',
    doesNotEstablish: 'anything about the shell, which was never measured.',
    measuredAt: T.older,
  },
  badges: {
    staleness: {
      reasons: ['superseded'],
      superseded: { byId: memoryTokens.id, headId: memoryTokens.id, depthTruncated: false },
    },
  },
});

// ---------------------------------------------------------------------------
// loop — a schedule plus a spawn config (086); run history IS its edges
// ---------------------------------------------------------------------------

/**
 * The seeded Dreamer loop (P5) and a BROKEN one, because a fixture set where
 * every loop is healthy renders a panel in which none of the honesty states
 * can be seen.
 *
 * `teamMemberId: null` is MEANINGFUL and not merely absent — the contract says
 * so: it means firings route through the dispatcher rather than naming a
 * runner. `lastError` on the second is the state a scheduler leaves behind
 * when a firing fails WITHOUT disabling the loop, which is the case a panel
 * that only draws `enabled` would render as perfectly fine.
 */
export const loopDreamer = summary({
  id: 'ent-loop-dreamer',
  kind: 'loop',
  title: 'Dreamer sweep',
  excerpt: 'Walk every teammate\u2019s memories and mark what has gone stale.',
  createdBy: ada,
  state: {
    kind: 'loop',
    schedule: 'every 1d',
    enabled: true,
    teamMemberId: null,
    subjectId: null,
    nextRunAt: '2026-07-29T09:00:00.000Z',
    lastRunAt: T.old,
    lastError: null,
  },
});

export const loopFailing = summary({
  id: 'ent-loop-failing',
  kind: 'loop',
  title: 'Nightly conformance',
  excerpt: 'Run the conformance suite against the node.',
  createdBy: ada,
  state: {
    kind: 'loop',
    schedule: 'every 12h',
    enabled: true,
    teamMemberId: teamMemberForge.id,
    subjectId: null,
    nextRunAt: '2026-07-28T21:00:00.000Z',
    lastRunAt: T.staleEdge,
    // Enabled AND failing — the scheduler records the error without disabling,
    // so "enabled" alone is not a health claim.
    lastError: 'spawn refused: no session slots free',
  },
});

/**
 * scout's persona entity. Needed as the SUBJECT of the T5-5 capacity line
 * ("scout — 1 live session already"): a capacity statement needs a teammate
 * to be about, and forge alone cannot exercise the has-sessions/has-none
 * split.
 */
export const teamMemberScout = summary({
  id: 'ent-tm-scout',
  kind: 'team_member',
  title: 'scout',
  excerpt: 'Fixture sweep and review agent.',
  createdBy: noor,
  state: {
    kind: 'team_member',
    owner: noor,
    model: 'claude-sonnet-5',
    agentTool: 'claude-code',
    liveWork: null,
  },
});

/** PR marked stale by the connector — its own honesty flag, distinct from delivery facets. */
export const prTransplant = summary({
  id: 'pr-212',
  kind: 'pull_request',
  title: 'PR #212 · feat(ui): tokens + kit foundation',
  createdBy: forge,
  state: {
    kind: 'pull_request',
    repository: 'subhang/tm8',
    number: 212,
    state: 'open',
    url: 'https://github.com/subhang/tm8/pull/212',
    fetchedAt: T.old,
    stale: true,
  },
});

// The SAME link the `ge-tracks-pr` graph edge states, restated on the tracking
// task's own row — which is what the server's `badges.pullRequests` projection
// does on every read. Assigned here rather than beside the other badges above
// because `prTransplant` is declared further down the file, and a fixture that
// duplicated its facts instead of referencing it would drift.
//
// This is the fact a tile renders after a hard reload, when the bounded graph
// page has not seated the PR node or its edge.
taskGuideLines.badges.pullRequests = [{
  entityId: prTransplant.id,
  repository: 'subhang/tm8',
  number: 212,
  title: prTransplant.title,
  state: 'open',
  // Nothing has observed this PR's checks or mergeability — `null`, never a
  // green verdict. See `LinkedPullRequestBadge`.
  ciStatus: null,
  mergeState: null,
  url: 'https://github.com/subhang/tm8/pull/212',
  headRef: null,
}];

export const commitFoundation = summary({
  id: 'commit-a0',
  kind: 'commit',
  title: 'feat(tm8-ui): A0 foundation',
  createdBy: forge,
  state: {
    kind: 'commit',
    repository: 'subhang/tm8',
    sha: '9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c',
    message: 'feat(tm8-ui): A0 foundation — tokens verbatim, kit, fixtures',
    committedAt: T.morning,
  },
});

export const fileScreenshot = summary({
  id: 'file-gate-shot',
  kind: 'file',
  title: 'gate-screen-side-by-side.png',
  createdBy: ada,
  state: { kind: 'file', name: 'gate-screen-side-by-side.png', mimeType: 'image/png', sizeBytes: 4_812_339 },
});

export const spellDeploy = summary({
  id: 'spell-deploy',
  kind: 'spell',
  title: 'deploy-preview',
  state: { kind: 'spell', description: 'Builds and serves a preview of the current branch.', equipped: true },
});

export const skillReview = summary({
  id: 'skill-review',
  kind: 'skill',
  title: 'code-review',
  state: { kind: 'skill', description: 'Adversarial review checklist.', equipped: false },
});

export const collectionInbox = summary({
  id: 'coll-triage',
  kind: 'collection',
  title: 'Triage',
  state: { kind: 'collection', collectionType: 'manual', itemCount: 3 },
});

/** C-5: EMPTY collection — the empty-state rendering must be designed, not accidental. */
export const collectionEmpty = summary({
  id: 'coll-empty',
  kind: 'collection',
  title: 'Parked for later',
  state: { kind: 'collection', collectionType: 'manual', itemCount: 0 },
});

export const projectTm8Ui = summary({
  id: 'ent-proj-tm8ui',
  kind: 'project',
  title: 'tm8-ui',
  state: { kind: 'project', projectId: 'proj-tm8ui', materializedVersion: 12 },
});

export const profileHouseStyle = summary({
  id: 'ip-house-style',
  kind: 'interaction_profile',
  title: 'House style',
  state: {
    kind: 'interaction_profile',
    status: 'active',
    currentDraftVersion: 4,
    activeVersion: 3,
    activeHash: 'sha256:2f7c1a9e',
    retiredAt: null,
  },
});

/** Custom kind — lands on the generic archetype with zero special-casing. */
export const customRitual = summary({
  id: 'c-ritual-standup',
  kind: 'c:ritual',
  title: 'Morning standup',
  state: { kind: 'c:ritual', fields: { cadence: 'daily', hour: 9, active: true, notes: null } },
});

/**
 * Artifact — a versioned static-web bundle. Revision 3, not 1, so the
 * revision switcher has a real history to list; published by an AGENT so the
 * viewer's publisher chrome exercises the agent wording rather than only the
 * human one.
 */
export const artifactPulseBoard = summary({
  id: 'artifact-pulse-board',
  kind: 'artifact',
  title: 'Pulse board',
  excerpt: 'Single-file status dashboard published from the forge lane.',
  createdBy: forge,
  state: { kind: 'artifact', revisionNumber: 3 },
});

// ---------------------------------------------------------------------------
// roster
// ---------------------------------------------------------------------------

export const fixtureSummaries: EntitySummary[] = [
  channelDesign, voiceStandup, voiceLounge,
  taskUuidTitle, taskGuideLines, taskBlocked, taskTombstone,
  sessionLive, sessionStale, sessionExited, sessionFailed, sessionCredentialLogin,
  docLayoutSpec, docChapterShell, docChapterCmin, docChapterFloors, docChapterResponsive,
  messageInThread, messageAgentNullProvenance,
  channelThreadRoot, channelThreadReply1, channelThreadReply2, channelThreadQuietRoot,
  memberAda, memberNoor, teamMemberForge,
  teamMemberScout,
  memoryTokens, memoryDisputed, memorySuperseded,
  loopDreamer, loopFailing,
  prTransplant, commitFoundation, fileScreenshot,
  spellDeploy, skillReview, collectionInbox, collectionEmpty, projectTm8Ui,
  profileHouseStyle, customRitual, artifactPulseBoard,
];

// ---------------------------------------------------------------------------
// details — one representative EntityDetail per core kind (+ custom)
// ---------------------------------------------------------------------------

function edge(id: string, type: string, source: EntitySummary, target: EntitySummary, createdBy: ActorSummary, extra: { resolved?: boolean; hard?: boolean } = {}) {
  return { id, type, source, target, props: {}, createdBy, createdAt: T.older, updatedAt: T.morning, ...extra };
}

function detail(base: EntitySummary, rest: Pick<EntityDetail, 'content'> & Partial<Pick<EntityDetail, 'hierarchy' | 'connections' | 'capabilities'>>): EntityDetail {
  return {
    ...base,
    hierarchy: hierarchy(),
    connections: NO_CONNECTIONS,
    capabilities: CAPS_FULL,
    ...rest,
  };
}

/**
 * SESSION → TEAM_MEMBER `relates_to` edges — the capacity source.
 *
 * Per bridge: launch capacity derives from these EDGES, not from
 * `createdBy` (which the contract never states records the persona rather
 * than the initiating human — so joining on it would be a guess). An edge is
 * an explicit statement of the relationship, which is why capacity reads it.
 *
 * Deliberately covering BOTH halves of the honest split: forge's edge points
 * at a session the liveness snapshot lists as LIVE, scout's at one that is
 * STALE. A capacity line that counted record-running sessions would report
 * scout busy; counting the liveness intersection reports it free. The fixture
 * exists so that difference is observable rather than assumed — same law as
 * the '● N live' count.
 *
 * D9: endpoints are serialized SNAPSHOTS with badges stripped, never
 * back-references into the graph.
 */
const snap = (e: EntitySummary): EntitySummary => ({ ...e, badges: {} });

export const sessionTeammateEdges = {
  forge: edge('edge-ran-forge', 'relates_to', snap(sessionLive), snap(teamMemberForge), ada),
  scout: edge('edge-ran-scout', 'relates_to', snap(sessionStale), snap(teamMemberScout), noor),
};

export const fixtureDetails: Record<string, EntityDetail> = {
  [channelDesign.id]: detail(channelDesign, {
    content: {
      kind: 'channel',
      topic: 'tm8-ui build',
      pinned: [docLayoutSpec],
      autoTabs: [
        { key: 'feed', label: 'Feed', count: 148, query: { spaceId: FIXTURE_SPACE_ID, parentId: 'ch-design', layout: 'feed' } },
        { key: 'tasks', label: 'Tasks', count: 4, query: { spaceId: FIXTURE_SPACE_ID, kinds: ['task'], subtreeOf: 'ch-design', layout: 'list' } },
        { key: 'docs', label: 'Docs', count: 1, query: { spaceId: FIXTURE_SPACE_ID, kinds: ['doc'], subtreeOf: 'ch-design', layout: 'list' } },
      ],
    },
    hierarchy: hierarchy(null, [taskUuidTitle, taskGuideLines, taskBlocked, docLayoutSpec]),
  }),

  [taskUuidTitle.id]: detail(taskUuidTitle, {
    content: {
      kind: 'task',
      description:
        'Reproduce and fix the crash captured by incident 4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7. ' +
        'The description is deliberately long enough to exercise the reader column measure and ' +
        'prove the detail panel scrolls its own body rather than the whole stack.',
      acceptanceCriteria: [
        { id: 'ac-1', text: 'Crash reproduced under fixture data', done: true, doneBy: forge.id, doneAt: T.morning },
        { id: 'ac-2', text: 'Root cause written up in the doc', done: true, doneBy: forge.id, doneAt: T.morning },
        { id: 'ac-3', text: 'Fix behind a test', done: false },
        { id: 'ac-4', text: 'Reviewed by a human', done: false },
      ],
      pointsEstimate: 8,
    },
    hierarchy: hierarchy(channelDesign, [sessionStale], [channelDesign]),
    connections: {
      outgoing: [
        { type: 'blocks', direction: 'outgoing', label: 'blocks', edges: [edge('edge-blocks-1', 'blocks', taskUuidTitle, taskBlocked, ada, { hard: true, resolved: false })] },
        // The git trail: the task tracks a PR and a commit (mirrors graph.ts).
        { type: 'tracks', direction: 'outgoing', label: 'tracks', edges: [
          edge('edge-tracks-pr', 'tracks', snap(taskUuidTitle), snap(prTransplant), forge),
          edge('edge-tracks-commit', 'tracks', snap(taskUuidTitle), snap(commitFoundation), forge),
        ] },
      ],
      incoming: [{ type: 'references', direction: 'incoming', label: 'referenced by', edges: [edge('edge-ref-1', 'references', docLayoutSpec, taskUuidTitle, noor)] }],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [docLayoutSpec.id]: detail(docLayoutSpec, {
    content: {
      kind: 'doc',
      body: '# Layout spec\n\nC_min = max(320, V·320 + max(0, V−1)·8).\n\n> Floors are law — 02 §6. A panel below its floor is a bug, not a compromise.\n\nFloors are floors: refuse the pin, keep the reason visible.',
      format: 'markdown',
    },
    hierarchy: hierarchy(
      channelDesign,
      [docChapterShell, docChapterCmin, docChapterFloors, docChapterResponsive],
      [channelDesign],
    ),
    capabilities: CAPS_READONLY, // restricted doc: viewer can look (summary-level), not touch
  }),

  [messageInThread.id]: detail(messageInThread, {
    content: {
      kind: 'message',
      body: 'kit gallery is up on **4612** — both themes, all primitives. @forge take a look before you wire the shell.',
      mentions: [{ entityId: teamMemberForge.id, kind: 'team_member', display: 'forge' }],
      attachments: [{ fileEntityId: fileScreenshot.id, name: 'gate-screen-side-by-side.png', mime: 'image/png' }],
    },
    hierarchy: hierarchy(channelDesign, [], [channelDesign]),
  }),

  [memberAda.id]: detail(memberAda, {
    content: { kind: 'member', teamMembers: [teamMemberForge], work: [taskUuidTitle] },
  }),

  [memberNoor.id]: detail(memberNoor, {
    content: { kind: 'member', teamMembers: [], work: [] },
  }),

  [teamMemberForge.id]: detail(teamMemberForge, {
    content: {
      kind: 'team_member',
      identity: 'You are the A0 foundation engineer for packages/tm8-ui.',
      // EMPTY, and that is the fixture's point: migration 084 moved every
      // entry into the graph and emptied this column on every real row. A
      // fixture that kept a string here would let a jsonb reader look correct
      // in jsdom forever. The working set is the `remembers` edges below.
      memories: [],
      capabilities: { canSpawnSessions: true },
      commandPermissions: { bash: 'allow' },
      equipped: [spellDeploy, skillReview],
      work: [taskGuideLines],
    },
    connections: {
      incoming: [
        { type: 'relates_to', direction: 'incoming', label: 'sessions', edges: [sessionTeammateEdges.forge] },
      ],
      // The working set, holder-side: `remembers` is OUTGOING from whoever
      // holds it (056 registers src member|team_member|work_session → memory;
      // 085 widened src to the wildcard). Three edges, three epistemic states
      // — including one superseded memory that is remembered and will NOT be
      // injected, which is the case the surface exists to tell apart.
      outgoing: [
        {
          type: 'remembers',
          direction: 'outgoing',
          label: 'remembers',
          edges: [
            edge('edge-remembers-1', 'remembers', teamMemberForge, memoryTokens, forge),
            edge('edge-remembers-2', 'remembers', teamMemberForge, memoryDisputed, forge),
            edge('edge-remembers-3', 'remembers', teamMemberForge, memorySuperseded, forge),
          ],
        },
      ],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [loopDreamer.id]: detail(loopDreamer, {
    content: {
      kind: 'loop',
      schedule: 'every 1d',
      enabled: true,
      teamMemberId: null,
      subjectId: null,
      prompt: 'Walk every teammate\u2019s remembers set and mark what has gone stale.',
      config: {},
      nextRunAt: '2026-07-29T09:00:00.000Z',
      lastRunAt: T.old,
      lastError: null,
    },
    connections: {
      // RUN HISTORY: inbound triggered_by is the only record 086 keeps.
      incoming: [
        {
          type: 'triggered_by',
          direction: 'incoming',
          label: 'runs',
          edges: [edge('edge-triggered-1', 'triggered_by', taskGuideLines, loopDreamer, ada)],
        },
      ],
      outgoing: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [loopFailing.id]: detail(loopFailing, {
    content: {
      kind: 'loop',
      schedule: 'every 12h',
      enabled: true,
      teamMemberId: teamMemberForge.id,
      subjectId: null,
      prompt: 'Run the conformance suite and report on the anchor.',
      config: {},
      nextRunAt: '2026-07-28T21:00:00.000Z',
      lastRunAt: T.staleEdge,
      lastError: 'spawn refused: no session slots free',
    },
  }),

  [memoryTokens.id]: detail(memoryTokens, {
    content: {
      kind: 'memory',
      statement: memoryTokens.title,
      mechanism: memoryTokens.state.kind === 'memory' ? memoryTokens.state.mechanism : '',
      subjectScope: memoryTokens.state.kind === 'memory' ? memoryTokens.state.subjectScope : '',
      doesNotEstablish: memoryTokens.state.kind === 'memory' ? memoryTokens.state.doesNotEstablish : '',
      measuredAt: T.old,
    },
    connections: {
      // Holder-side edges arrive INCOMING on the memory: this is the "who
      // remembers this" list the detail surface draws.
      incoming: [
        {
          type: 'remembers',
          direction: 'incoming',
          label: 'remembered by',
          edges: [edge('edge-remembers-1', 'remembers', teamMemberForge, memoryTokens, forge)],
        },
      ],
      outgoing: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [memoryDisputed.id]: detail(memoryDisputed, {
    content: {
      kind: 'memory',
      statement: memoryDisputed.title,
      mechanism: memoryDisputed.state.kind === 'memory' ? memoryDisputed.state.mechanism : '',
      subjectScope: memoryDisputed.state.kind === 'memory' ? memoryDisputed.state.subjectScope : '',
      doesNotEstablish: memoryDisputed.state.kind === 'memory' ? memoryDisputed.state.doesNotEstablish : '',
      measuredAt: T.old,
    },
    connections: {
      incoming: [
        {
          type: 'remembers',
          direction: 'incoming',
          label: 'remembered by',
          edges: [edge('edge-remembers-2', 'remembers', teamMemberForge, memoryDisputed, forge)],
        },
      ],
      outgoing: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [memorySuperseded.id]: detail(memorySuperseded, {
    content: {
      kind: 'memory',
      statement: memorySuperseded.title,
      mechanism: memorySuperseded.state.kind === 'memory' ? memorySuperseded.state.mechanism : '',
      subjectScope: memorySuperseded.state.kind === 'memory' ? memorySuperseded.state.subjectScope : '',
      doesNotEstablish: memorySuperseded.state.kind === 'memory' ? memorySuperseded.state.doesNotEstablish : '',
      measuredAt: T.older,
    },
    connections: {
      incoming: [
        {
          type: 'remembers',
          direction: 'incoming',
          label: 'remembered by',
          edges: [edge('edge-remembers-3', 'remembers', teamMemberForge, memorySuperseded, forge)],
        },
        // The mark that makes it superseded, from the successor's side.
        {
          type: 'supersedes',
          direction: 'incoming',
          label: 'superseded by',
          edges: [edge('edge-supersedes-1', 'supersedes', memoryTokens, memorySuperseded, forge)],
        },
      ],
      outgoing: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [prTransplant.id]: detail(prTransplant, {
    content: { kind: 'pull_request', diffStat: { additions: 1240, deletions: 86 }, checks: 'green' },
  }),

  [commitFoundation.id]: detail(commitFoundation, {
    content: { kind: 'commit', filesChanged: 21 },
    connections: {
      // 082 provenance: the commit was produced IN the live session.
      outgoing: [{ type: 'created_in', direction: 'outgoing', label: 'created in', edges: [
        edge('edge-created-in-1', 'created_in', snap(commitFoundation), snap(sessionLive), forge),
      ] }],
      incoming: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [fileScreenshot.id]: detail(fileScreenshot, {
    content: { kind: 'file', downloadUrl: '/v2/files/file-gate-shot' },
  }),

  [spellDeploy.id]: detail(spellDeploy, {
    content: { kind: 'spell', body: 'bun run build && bun run preview' },
  }),

  [skillReview.id]: detail(skillReview, {
    content: { kind: 'skill', body: 'Attack the diff for duplication, kind-branching, floor violations.' },
  }),

  [sessionStale.id]: detail(sessionStale, {
    content: {
      kind: 'work_session',
      nodeId: 'node-local',
      launchProjectId: 'proj-tm8ui',
      workingOn: [taskUuidTitle],
      transcriptDoc: null,
    },
    hierarchy: hierarchy(taskUuidTitle, [], [channelDesign, taskUuidTitle]),
    connections: {
      outgoing: [
        { type: 'relates_to', direction: 'outgoing', label: 'ran as', edges: [sessionTeammateEdges.scout] },
      ],
      incoming: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [teamMemberScout.id]: detail(teamMemberScout, {
    content: {
      kind: 'team_member',
      identity: 'You sweep fixtures and review diffs.',
      memories: [],
      capabilities: { canSpawnSessions: true },
      commandPermissions: { bash: 'ask' },
      equipped: [skillReview],
      work: [],
    },
    connections: {
      // The capacity read from the teammate's side: which sessions ran as it.
      incoming: [
        { type: 'relates_to', direction: 'incoming', label: 'sessions', edges: [sessionTeammateEdges.scout] },
      ],
      outgoing: [],
      unresolvedHardDependencyCount: 0,
    },
  }),

  [messageAgentNullProvenance.id]: detail(messageAgentNullProvenance, {
    content: {
      kind: 'message',
      body: 'Kit primitives extracted from T0-1/T0-3/T0-4; tokens byte-equality test guards the transplant.',
      mentions: [],
      attachments: [],
    },
    hierarchy: hierarchy(channelDesign, [], [channelDesign]),
  }),

  [collectionInbox.id]: detail(collectionInbox, {
    content: { kind: 'collection', description: 'Hand-picked triage queue.', items: [taskBlocked, prTransplant, messageInThread] },
  }),

  [collectionEmpty.id]: detail(collectionEmpty, {
    content: { kind: 'collection', description: 'Nothing parked right now.', items: [] },
  }),

  [projectTm8Ui.id]: detail(projectTm8Ui, {
    content: { kind: 'project', projectId: 'proj-tm8ui', repoUrl: 'https://github.com/subhang/tm8', materializedVersion: 12 },
  }),

  [profileHouseStyle.id]: detail(profileHouseStyle, {
    content: {
      kind: 'interaction_profile',
      status: 'active',
      templateKey: 'house-style',
      templateVersion: 2,
      resolvedHash: 'sha256:2f7c1a9e',
      generatedByTeamMemberId: teamMemberForge.id,
    },
  }),

  [customRitual.id]: detail(customRitual, {
    content: { kind: 'c:ritual', fields: { cadence: 'daily', hour: 9, active: true, notes: null } },
  }),

  [artifactPulseBoard.id]: detail(artifactPulseBoard, {
    content: {
      kind: 'artifact',
      description: 'A one-page dashboard: build state, open lanes and the merge queue at a glance.',
      currentRevisionNumber: 3,
      entrypoint: 'index.html',
      manifestSha256: '9b3f2a10c4d5e6f7a8b9c0d1e2f30415263748596a7b8c9d0e1f2a3b4c5d6e7f',
      fileCount: 1,
      totalSizeBytes: 4096,
    },
  }),
};
