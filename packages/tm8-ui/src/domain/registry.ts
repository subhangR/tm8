/**
 * THE KIND REGISTRY — the spine (LLD §2).
 *
 * One module drives routes, origin validation, palette entries, menu-ref
 * validation, both universal primitives, and the Z4 layouts. Totality over
 * `CoreEntityKindSchema` (15 kinds) is asserted by `registry.test.ts` — the
 * WLT §2.1 law — plus the single `c:*` fallback row that makes every custom
 * kind land on the generic archetype for free.
 *
 * Slugs, reserved words and route strategies follow WLT §2.1 exactly.
 *
 * D13 (2026-07-28): per-kind `defaultMode`/`hiddenModes` values are authored
 * here from kind semantics — neither WLT nor TM8-UI-SPEC-FINAL supplies any
 * per-kind registry DATA; both stop at the shape. `'graph'` is NEVER a member
 * of `hiddenModes` for any kind: R7 requires it visible-and-disabled in the
 * switcher, which is a different state from hidden-by-config.
 *
 * Chip glyphs are text placeholders in the canvases' own idiom; replacing them
 * with the canvas-extracted set at reference capture is a DATA edit here and
 * touches no component.
 */
import type { CoreEntityKind, EntityKind } from '@tm8/contract';
import type {
  CollectionMode,
  FilterSpec,
  KindConfig,
  ListConfig,
  LifecycleTier,
  ListRowFacts,
  LiveTreatment,
  QueryFilter,
  SortSpec,
} from './types';
import { CUSTOM_KIND_FALLBACK } from './types';
import type { SessionLiveness } from '../data/seam';

/** WLT §2.1 reserved words — never a kind slug. */
export const RESERVED_SLUGS: readonly string[] = [
  'home',
  'feed',
  'inbox',
  'workspace',
  'settings',
  'channel',
  'e',
  'k',
];

export const ALL_MODES: readonly CollectionMode[] = ['list', 'board', 'tree', 'feed', 'gallery', 'graph'];

// ---------------------------------------------------------------------------
// Shared filter / sort vocabulary (contract-shaped — the seam executes these
// without translation)
// ---------------------------------------------------------------------------

const NOT_DELETED: QueryFilter = { deleted: 'exclude' };

const TASK_OPEN_STATUSES = ['open', 'pulled', 'working', 'in_review', 'blocked'] as const;
const TASK_CLOSED_STATUSES = ['done', 'cancelled'] as const;

const statusFilter: FilterSpec = {
  id: 'status',
  label: 'Status',
  multi: true,
  options: [
    { id: 'open', label: 'Open', filter: { workStatus: ['open'] } },
    { id: 'pulled', label: 'Pulled', filter: { workStatus: ['pulled'] } },
    { id: 'working', label: 'Working', filter: { workStatus: ['working'] } },
    { id: 'in_review', label: 'In review', filter: { workStatus: ['in_review'] } },
    { id: 'blocked', label: 'Blocked', filter: { workStatus: ['blocked'] } },
    { id: 'done', label: 'Done', filter: { workStatus: ['done'] } },
    { id: 'cancelled', label: 'Cancelled', filter: { workStatus: ['cancelled'] } },
  ],
};

const readyToPullFilter: FilterSpec = {
  id: 'ready-to-pull',
  label: 'Ready to pull',
  options: [{ id: 'ready', label: 'Ready to pull', filter: { readyToPull: true } }],
};

const deletedFilter: FilterSpec = {
  id: 'deleted',
  label: 'Deleted',
  options: [
    { id: 'exclude', label: 'Hide deleted', filter: { deleted: 'exclude' } },
    { id: 'only', label: 'Deleted only', filter: { deleted: 'only' } },
  ],
};

const BY_ACTIVITY: SortSpec = { key: 'activityAt_desc', label: 'Recent activity', default: true };
const BY_CREATED: SortSpec = { key: 'createdAt_desc', label: 'Newest' };
const BY_POSITION: SortSpec = { key: 'position', label: 'Manual order' };
const BY_DUE: SortSpec = { key: 'dueDate', label: 'Due date' };
const BY_PRIORITY: SortSpec = { key: 'priority', label: 'Priority' };

const DEFAULT_SORT: readonly SortSpec[] = [BY_ACTIVITY, BY_CREATED];

/** The shape every kind gets before its own divergence is layered on. */
function baseList(overrides: Partial<ListConfig> & Pick<ListConfig, 'tile'>): ListConfig {
  return {
    quickCreate: true,
    filters: [deletedFilter],
    sort: DEFAULT_SORT,
    // Universal by DEFAULT (D41): a kind opts into a richer partition, never
    // out of having tiers at all. A row that forgot them would silently lose
    // its tabs, so absence is not an available state.
    lifecycle: statelessTiers(),
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// Lifecycle tiers (D41) — Open / Done / Archived, universal on collection kinds
// ---------------------------------------------------------------------------

/**
 * `archived` is the honest one: `deleted: 'only'` is a real `CollectionQuery`
 * member, so the archive tier is a genuine query for EVERY kind rather than an
 * invention. `open`/`done` are only expressible where the kind carries a state
 * axis the contract knows — task via `workStatus`, work_session via
 * `sessionStatus` (D56). Everywhere else `done` is declared UNSUPPORTED with its
 * reason: the tab renders, its count is honestly zero, and nothing fabricates
 * a completion concept the backend cannot answer for.
 */
const ARCHIVED_TIER: LifecycleTier = {
  id: 'archived',
  label: 'Archived',
  filter: { deleted: 'only' },
};

const NO_DONE_REASON =
  'This kind has no completion state on this node — the contract records no done/closed concept for it, so nothing can honestly land here.';

/** The default tiers for a kind with no state axis: open, an honest-empty done, archived. */
function statelessTiers(): readonly LifecycleTier[] {
  return [
    { id: 'open', label: 'Open', filter: NOT_DELETED },
    { id: 'done', label: 'Done', filter: NOT_DELETED, unsupported: NO_DONE_REASON },
    ARCHIVED_TIER,
  ];
}

const TASK_TIERS: readonly LifecycleTier[] = [
  { id: 'open', label: 'Open', filter: { workStatus: [...TASK_OPEN_STATUSES], deleted: 'exclude' } },
  { id: 'done', label: 'Done', filter: { workStatus: [...TASK_CLOSED_STATUSES], deleted: 'exclude' } },
  ARCHIVED_TIER,
];

// D56 — the D20 workaround is GONE. `CollectionQuery.filters.sessionStatus`
// exists now (contract dd41e89), so these are ordinary contract filters the
// seam executes untranslated, exactly like the task tiers beside them. No
// client-side partition, no structural read on the row, nothing to remember.
const SESSION_TIERS: readonly LifecycleTier[] = [
  {
    id: 'open',
    label: 'Open',
    filter: { sessionStatus: ['spawning', 'running', 'idle'], deleted: 'exclude' },
  },
  { id: 'done', label: 'Done', filter: { sessionStatus: ['exited', 'failed'], deleted: 'exclude' } },
  ARCHIVED_TIER,
];

// ---------------------------------------------------------------------------
// work_session liveness presentation (R-UI-5: PRESENTS the seam verdict,
// never computes it)
// ---------------------------------------------------------------------------

const sessionLiveTreatment = (live: SessionLiveness): LiveTreatment => {
  switch (live) {
    case 'live':
      // T0-3 Sessions panel + T0-2 chrome strip: a live row reads `running`,
      // and `streaming` only while bytes are actually moving. `live` is the
      // live-session bar's count word (`● N live`), not a row's.
      return {
        label: 'running',
        tone: 'run',
        dot: 'solid',
        attachable: true,
        streamingLabel: 'streaming',
      };
    case 'stale':
      return {
        label: 'stale — node restarted',
        // T0-3 frame 4 rules this word at the 220px floor, verbatim.
        shortLabel: 'stale',
        tone: 'wait',
        dot: null,
        attachable: false,
        reason:
          'The record says this session is running, but the node has no live PTY for it — the node restarted since it started. Its terminal cannot be reattached.',
      };
    case 'not-running':
      return {
        // No shortLabel, deliberately: 11 chars already fits the compact
        // budget, and the tempting abbreviation `exited` would be a LIE —
        // `exited` is a WorkSessionStatus value, while `not-running` is a
        // liveness verdict. A session can be not-running without ever having
        // exited (never spawned, failed to start). Do not "shorten" this one.
        label: 'not running',
        tone: 'idle',
        dot: null,
        attachable: false,
        reason: 'This session is not running — there is no terminal to attach to.',
      };
    case 'unknown':
    default:
      return {
        label: 'running per record · unverified',
        // D27: the 9.5px chrome-strip pill cannot take the sentence. NOT
        // 'running' — the compact form must still refuse to claim life.
        shortLabel: 'unverified',
        tone: 'idle',
        dot: null,
        attachable: false,
        reason:
          'No fresh liveness snapshot from this node: the record claims running, and that claim is unverified. Unverified is never shown as live.',
      };
  }
};

/**
 * 'NEEDS YOU' grouping — designed-but-dormant per R8. The predicate is real
 * and the group renders whenever it fires; no server detection exists in this
 * program, so on real data it stays quiet. It consumes the seam verdict and
 * the row's own recorded status — it derives neither.
 */
const sessionNeedsAttention = (row: ListRowFacts, live: SessionLiveness): boolean =>
  live === 'live' && row.status === 'idle';

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

const ROWS: readonly KindConfig[] = [
  // -- task -----------------------------------------------------------------
  {
    kind: 'task',
    label: 'Task',
    labelPlural: 'Tasks',
    icon: '◻',
    slug: 'tasks',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: [],
    chip: {
      glyph: '◻',
      tintBy: 'workStatus',
      tones: {
        open: 'idle',
        pulled: 'info',
        working: 'run',
        in_review: 'wait',
        blocked: 'block',
        done: 'idle',
        cancelled: 'idle',
      },
    },
    card: { fields: ['workStatus', 'priority', 'assignees', 'acceptance'] },
    list: baseList({
      sections: [
        {
          id: 'current',
          label: 'Current',
          filter: { workStatus: [...TASK_OPEN_STATUSES], deleted: 'exclude' },
        },
        {
          id: 'completed',
          label: 'Completed',
          filter: { workStatus: [...TASK_CLOSED_STATUSES], deleted: 'exclude' },
          collapsedByDefault: true,
        },
      ],
      tree: { by: 'hierarchy', guideLines: true },
      tile: {
        badges: [
          { source: 'workStatus' },
          { source: 'priority' },
          { source: 'assignees' },
          { source: 'acceptance' },
          { source: 'blocked' },
          { source: 'pulls' },
          { source: 'workingActors' },
        ],
      },
      lifecycle: TASK_TIERS,
      primaryActions: ['run', 'coordinate'],
      filters: [statusFilter, readyToPullFilter, deletedFilter],
      sort: [BY_ACTIVITY, BY_PRIORITY, BY_DUE, BY_POSITION, BY_CREATED],
      inlineEdit: { status: true, title: true },
      // D44: every task ROW gets Run, not just the panel primary. It resolves
      // to the same ActionRef the panel and palette use, and its `flow:'launch'`
      // marker means the row opens the launch config rather than bare-spawning.
      rowActions: ['run', 'complete'],
    }),
    panel: {
      archetype: 'subtree',
      primaries: ['run', 'coordinate', 'complete'],
      statusPill: {
        source: 'workStatus',
        tones: {
          open: 'idle',
          pulled: 'info',
          working: 'run',
          in_review: 'wait',
          blocked: 'block',
          done: 'idle',
          cancelled: 'idle',
        },
        labels: { in_review: 'in review' },
      },
    },
    palette: { createLabel: 'New task', primaryAction: 'run' },
  },

  // -- work_session ---------------------------------------------------------
  {
    kind: 'work_session',
    label: 'Session',
    labelPlural: 'Sessions',
    icon: '▸',
    slug: 'sessions',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['gallery'],
    chip: {
      glyph: '▸',
      tintBy: 'sessionStatus',
      tones: { spawning: 'wait', running: 'run', idle: 'info', exited: 'idle', failed: 'block' },
    },
    card: { fields: ['sessionStatus', 'agentTool', 'model', 'activityAt'] },
    list: baseList({
      lifecycle: SESSION_TIERS,
      tree: { by: 'hierarchy', guideLines: true },
      tile: {
        badges: [
          { source: 'sessionStatus' },
          { source: 'agentTool' },
          { source: 'model' },
          { source: 'shareMode' },
          { source: 'workingActors' },
        ],
        pulse: { signal: 'terminal-activity', gate: 'live' },
      },
      liveCount: { filter: NOT_DELETED, label: (n) => `● ${n} live` },
      quickLaunch: 'launch-session',
      filters: [deletedFilter],
      sort: [BY_ACTIVITY, BY_CREATED],
      needsAttentionGroup: sessionNeedsAttention,
      liveTreatment: sessionLiveTreatment,
      inlineEdit: { title: true },
      rowActions: ['complete', 'terminate'],
    }),
    panel: {
      archetype: 'terminal',
      // T0-4's work_session block draws "Complete  Terminate" as the kind
      // primaries and annotates it in words ("Complete / Terminate primaries").
      // LLD §3.1 names the same pair ("Terminate cascades with blast-radius
      // confirm; complete is intent-only"), and this row's own `rowActions`
      // already said ['complete','terminate'] four lines above. Three
      // independent sources agreed; the previous value here — 'prompt-session'
      // — agreed with none of them and was authored from kind semantics by me,
      // under no ruling. `prompt-session` remains a valid ActionRef for the
      // terminal's own prompt affordance and the palette; it is simply not a
      // PANEL PRIMARY.
      primaries: ['complete', 'terminate'],
      statusPill: {
        source: 'sessionStatus',
        tones: { spawning: 'wait', running: 'run', idle: 'info', exited: 'idle', failed: 'block' },
      },
      // Phase 1 ships ['terminal'] — the field IS the RULING-K seam (D12).
      contentSurfaces: ['terminal'],
      z4: { immersive: true },
    },
    palette: { createLabel: 'Launch session', primaryAction: 'launch-session' },
  },

  // -- doc ------------------------------------------------------------------
  {
    kind: 'doc',
    label: 'Doc',
    labelPlural: 'Docs',
    icon: '▤',
    slug: 'docs',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board'],
    chip: { glyph: '▤', tintBy: 'none' },
    card: { fields: ['docFormat', 'childCount', 'activityAt'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'docFormat' }, { source: 'childCount' }, { source: 'messages' }] },
      sort: [BY_ACTIVITY, BY_POSITION, BY_CREATED],
      inlineEdit: { title: true },
    }),
    panel: { archetype: 'reader', primaries: ['add-child'] },
    palette: { createLabel: 'New doc' },
  },

  // -- channel (special strategy — reserved word, no k/ route) --------------
  {
    kind: 'channel',
    label: 'Channel',
    labelPlural: 'Channels',
    icon: '#',
    slug: null,
    strategy: 'special',
    routeBuilder: (spaceId, id) => `#/s/${spaceId}/channel/${id}`,
    defaultMode: 'list',
    hiddenModes: ['board', 'gallery'],
    chip: { glyph: '#', tintBy: 'none' },
    card: { fields: ['channelTopic', 'unread', 'workingAgents'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'unread' }, { source: 'workingAgents' }, { source: 'messages' }] },
      inlineEdit: { title: true },
    }),
    panel: { archetype: 'hub', primaries: ['add-child'] },
    palette: { createLabel: 'New channel' },
  },

  // -- message (anchored strategy — no k/ view) -----------------------------
  {
    kind: 'message',
    label: 'Message',
    labelPlural: 'Messages',
    icon: '✉',
    slug: null,
    strategy: 'anchored',
    // Canonical route = the containing channel + ?msg=. Parent missing ⇒
    // e/{messageId} with a tombstone banner and NO companion (WLT §2.1).
    defaultMode: 'feed',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '✉', tintBy: 'none' },
    card: { fields: ['messageAuthor', 'excerpt', 'activityAt'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'messageAuthor' }, { source: 'points' }] },
      sort: [BY_CREATED, BY_ACTIVITY],
    }),
    panel: { archetype: 'generic', blocks: [{ block: 'fields', label: 'MESSAGE' }] },
  },

  // -- member ---------------------------------------------------------------
  {
    kind: 'member',
    label: 'Member',
    labelPlural: 'Members',
    icon: '◍',
    slug: 'members',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: {
      glyph: '◍',
      tintBy: 'memberRole',
      tones: { owner: 'brand', admin: 'info', member: 'idle' },
    },
    card: { fields: ['memberRole', 'score', 'taskDoneCount'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'memberRole' }, { source: 'score' }, { source: 'taskDoneCount' }] },
    }),
    panel: {
      archetype: 'profile',
      statusPill: { source: 'memberRole', tones: { owner: 'brand', admin: 'info', member: 'idle' } },
    },
  },

  // -- team_member ----------------------------------------------------------
  {
    kind: 'team_member',
    label: 'Teammate',
    labelPlural: 'Teammates',
    icon: '◆',
    slug: 'teammates',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: { glyph: '◆', tintBy: 'none' },
    card: { fields: ['owner', 'model', 'liveWork'] },
    list: baseList({
      tile: { badges: [{ source: 'owner' }, { source: 'agentTool' }, { source: 'model' }, { source: 'liveWork' }] },
      inlineEdit: { title: true },
    }),
    panel: { archetype: 'profile', primaries: ['coordinate'] },
    palette: { createLabel: 'New teammate' },
  },

  // -- pull_request ---------------------------------------------------------
  {
    kind: 'pull_request',
    label: 'Pull request',
    labelPlural: 'Pull requests',
    icon: '⑂',
    slug: 'pulls',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['tree', 'gallery'],
    chip: {
      glyph: '⑂',
      tintBy: 'prState',
      tones: { open: 'run', draft: 'idle', merged: 'brand', closed: 'idle' },
    },
    card: { fields: ['prState', 'repository', 'activityAt'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'prState' }, { source: 'repository' }, { source: 'messages' }] },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'link-summary', label: 'PULL REQUEST' },
        { block: 'fields', label: 'DETAILS' },
      ],
      statusPill: {
        source: 'prState',
        tones: { open: 'run', draft: 'idle', merged: 'brand', closed: 'idle' },
      },
    },
  },

  // -- commit ---------------------------------------------------------------
  {
    kind: 'commit',
    label: 'Commit',
    labelPlural: 'Commits',
    icon: '◉',
    slug: 'commits',
    strategy: 'collection',
    defaultMode: 'feed',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '◉', tintBy: 'none' },
    card: { fields: ['repository', 'sha', 'createdBy'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'repository' }, { source: 'sha' }] },
      sort: [BY_CREATED, BY_ACTIVITY],
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'link-summary', label: 'COMMIT' },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
  },

  // -- file -----------------------------------------------------------------
  {
    kind: 'file',
    label: 'File',
    labelPlural: 'Files',
    icon: '▣',
    slug: 'files',
    strategy: 'collection',
    defaultMode: 'gallery',
    hiddenModes: ['board'],
    chip: { glyph: '▣', tintBy: 'none' },
    card: { fields: ['mimeType', 'sizeBytes', 'createdBy'] },
    list: baseList({
      tree: { by: 'hierarchy', guideLines: true },
      tile: { badges: [{ source: 'mimeType' }, { source: 'sizeBytes' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'file-preview', label: 'PREVIEW' },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
    palette: { createLabel: 'Upload file' },
  },

  // -- spell ----------------------------------------------------------------
  {
    kind: 'spell',
    label: 'Spell',
    labelPlural: 'Spells',
    icon: '✧',
    slug: 'spells',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: { glyph: '✧', tintBy: 'equipped', tones: { true: 'run', false: 'idle' } },
    card: { fields: ['equipped', 'excerpt', 'activityAt'] },
    list: baseList({
      tile: { badges: [{ source: 'equipped' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'fields', label: 'DEFINITION' },
        { block: 'items', label: 'EQUIPPED BY' },
      ],
    },
    palette: { createLabel: 'New spell' },
  },

  // -- skill ----------------------------------------------------------------
  {
    kind: 'skill',
    label: 'Skill',
    labelPlural: 'Skills',
    icon: '✦',
    slug: 'skills',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree'],
    chip: { glyph: '✦', tintBy: 'equipped', tones: { true: 'run', false: 'idle' } },
    card: { fields: ['equipped', 'excerpt', 'activityAt'] },
    list: baseList({
      tile: { badges: [{ source: 'equipped' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'fields', label: 'DEFINITION' },
        { block: 'items', label: 'EQUIPPED BY' },
      ],
    },
    palette: { createLabel: 'New skill' },
  },

  // -- collection -----------------------------------------------------------
  {
    kind: 'collection',
    label: 'Collection',
    labelPlural: 'Collections',
    icon: '▦',
    slug: 'collections',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board'],
    chip: { glyph: '▦', tintBy: 'none' },
    card: { fields: ['collectionType', 'itemCount', 'activityAt'] },
    list: baseList({
      tile: { badges: [{ source: 'collectionType' }, { source: 'itemCount' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [
        { block: 'items', label: 'ITEMS' },
        { block: 'fields', label: 'DETAILS' },
      ],
    },
    palette: { createLabel: 'New collection' },
  },

  // -- project (restricted: generic create/patch/delete/move refused) -------
  {
    kind: 'project',
    label: 'Project',
    labelPlural: 'Projects',
    icon: '⬢',
    slug: 'projects',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: { glyph: '⬢', tintBy: 'none' },
    card: { fields: ['projectVersion', 'activityAt', 'createdBy'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'projectVersion' }] },
    }),
    panel: {
      /* kind-bodies-2 handover, applied verbatim: the GOVERNED body. */
      archetype: 'governed',
      blocks: [
        { block: 'path-row' },
        { block: 'trust-card', params: { action: 'untrust' } },
        { block: 'live-sessions' },
        { block: 'unlink-footer', params: { action: 'unlink' } },
        {
          block: 'notice',
          params: {
            text: 'Projects are a materialized per-space projection of node-level registry rows. Editing, deleting and moving them here is refused by design — manage them in node settings.',
          },
        },
      ],
      capabilityReasons: {
        canEdit: 'Projects are materialized from the node registry — they cannot be edited from a space.',
        canDelete: 'Projects are materialized from the node registry — unlink instead of deleting.',
      },
    },
  },

  // -- interaction_profile (restricted lifecycle family) -------------------
  {
    kind: 'interaction_profile',
    label: 'Interaction profile',
    labelPlural: 'Interaction profiles',
    icon: '⌬',
    slug: 'interaction-profiles',
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: ['board', 'tree', 'gallery'],
    chip: {
      glyph: '⌬',
      tintBy: 'profileStatus',
      tones: { draft: 'idle', active: 'run', retired: 'idle' },
    },
    card: { fields: ['profileStatus', 'profileVersions', 'activityAt'] },
    list: baseList({
      quickCreate: false,
      tile: { badges: [{ source: 'profileStatus' }, { source: 'profileVersions' }] },
    }),
    panel: {
      /* kind-bodies-2 handover, applied verbatim: the RESTRICTED body. */
      archetype: 'restricted',
      blocks: [
        { block: 'status-banner', params: {
            source: 'status',
            draft: 'preview only — activate to offer it at launch.',
            retired: 'sessions pinned to it keep running — new launches can’t pick it.',
          } },
        { block: 'preview', label: 'PREVIEW' },
        { block: 'field-rows', params: { fields: 'voice=VOICE,risk=RISK,tools=TOOLS' } },
        { block: 'items', label: 'DEFAULT FOR', params: { source: 'defaultFor' } },
        { block: 'restrictions' },
        { block: 'pin-provenance', params: { countSource: 'pinnedBy' } },
      ],
      statusPill: {
        source: 'profileStatus',
        tones: { draft: 'idle', active: 'run', retired: 'idle' },
      },
      capabilityReasons: {
        canEdit:
          'Interaction profiles change through their own lifecycle operations (draft → activate → retire), not through generic edits.',
        canDelete: 'Interaction profiles are retired, never deleted — the version history is the record.',
      },
    },
  },

  // -- the single custom-kind fallback row ----------------------------------
  {
    kind: CUSTOM_KIND_FALLBACK,
    label: 'Item',
    labelPlural: 'Items',
    icon: '◇',
    // Slug is computed per custom kind (`c:{name}` → `c-{name}`); the fallback
    // row itself has none.
    slug: null,
    strategy: 'collection',
    defaultMode: 'list',
    hiddenModes: [],
    chip: { glyph: '◇', tintBy: 'none' },
    card: { fields: ['customFields', 'activityAt', 'createdBy'] },
    list: baseList({
      tile: { badges: [{ source: 'customFields' }] },
      inlineEdit: { title: true },
    }),
    panel: {
      archetype: 'generic',
      blocks: [{ block: 'fields', label: 'FIELDS' }],
    },
  },
];

const BY_KIND: ReadonlyMap<string, KindConfig> = new Map(ROWS.map((row) => [row.kind, row]));

const FALLBACK = BY_KIND.get(CUSTOM_KIND_FALLBACK) as KindConfig;

/**
 * Registry lookup. Takes a plain string so unvalidated URL/server values can be
 * passed directly; a MISS falls back to the `c:*` row and never throws — that
 * is how custom kinds land on the generic archetype for free (LLD §2.3).
 */
export function getKind(kind: string): KindConfig {
  return BY_KIND.get(kind) ?? FALLBACK;
}

/** Every row, fallback included. */
export function allKinds(): KindConfig[] {
  return [...ROWS];
}

/** Rows the list-panel kind selector offers: `strategy === 'collection'`. */
export function collectionKinds(): KindConfig[] {
  return ROWS.filter((row) => row.strategy === 'collection' && row.kind !== CUSTOM_KIND_FALLBACK);
}

/** Slug → row, for the `k/{slug}` route and `origin` validation. */
export function kindBySlug(slug: string): KindConfig | null {
  return ROWS.find((row) => row.slug === slug) ?? null;
}

/** The `c:{name}` → `c-{name}` slug for a custom kind, collision-checked by callers. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.includes(slug);
}

/** The kind a slug addresses, custom kinds included. */
export function kindOfSlug(slug: string): EntityKind | null {
  const row = kindBySlug(slug);
  if (row) return row.kind as CoreEntityKind;
  if (slug.startsWith('c-') && slug.length > 2) return `c:${slug.slice(2)}` as EntityKind;
  return null;
}

/** The slug that addresses a kind (custom kinds computed), or null when it has none. */
export function slugOfKind(kind: string): string | null {
  if (kind.startsWith('c:') && kind.length > 2) return `c-${kind.slice(2)}`;
  return BY_KIND.get(kind)?.slug ?? null;
}
