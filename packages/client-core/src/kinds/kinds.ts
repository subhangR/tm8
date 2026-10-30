/**
 * KIND_CORE — the words and the mark every app draws a kind with (s-lld §2, §5).
 *
 * ONE SOURCE FOR BOTH APPS (L-A, "same words as the web"). tm8-ui's registry
 * (`src/domain/registry.ts`) and the phone app's (`apps/mobile/src/registry`)
 * each spread `KIND_CORE[kind]` into their rows and add what only they draw, so
 * a kind's label, plural, slug, route strategy, group and drawn mark are written
 * once, here. The table is total over the contract's `CoreEntityKind`: a 34th
 * core kind does not compile until it has a row, and both apps build on it.
 *
 * WHERE THE COLUMNS CAME FROM. `label`, `labelPlural`, `slug`, `strategy` and
 * `iconArt` were tm8-ui registry columns and moved here unchanged; tm8-ui's
 * `domain/kind-core.test.ts` compares every registry row with this table.
 * `group` is the contract's `CORE_KIND_INFO[kind].group`
 * (`packages/contract/src/kind-info.ts`), carried as data rather than read at
 * runtime: that table's only door is the contract's root barrel, and importing
 * it here would bundle the whole contract into every phone screen (probe F 5).
 * `kinds.test.ts` holds the two equal. The `c:*` fallback's group is `custom`,
 * the word `tm8 kind list` already files custom kinds under.
 *
 * THE REST OF THIS FILE MOVED VERBATIM out of tm8-ui's `src/domain`, because
 * the route codec reads it: the contract-derived vocabulary and the route
 * strategies (`domain/types.ts`), `ALL_MODES` (`domain/registry.ts`) and
 * `VIEW_REF_ROUTE` (`domain/nav-targets.ts`). tm8-ui's domain re-exports them.
 */
import type { CollectionQuery, CoreEntityKind, KindGroup, MenuViewRef } from '@tm8/contract';
import { KIND_ART, type KindArt } from './kind-art';

// ---------------------------------------------------------------------------
// Contract-derived vocabulary (cite the member, never an invented type)
// ---------------------------------------------------------------------------

/** The contract's anonymous `CollectionQuery['filters']` member. */
export type QueryFilter = NonNullable<CollectionQuery['filters']>;
/** The contract's `CollectionQuery['sort']` union. */
export type SortKey = NonNullable<CollectionQuery['sort']>;
/** The six collection layouts — the contract's `CollectionQuery['layout']` union. */
export type CollectionMode = NonNullable<CollectionQuery['layout']>;
/** The contract's `CollectionQuery['groupBy']` union (board axis picker, D2). */
export type GroupByKey = NonNullable<CollectionQuery['groupBy']>;

// ---------------------------------------------------------------------------
// The registry row (§2.1)
// ---------------------------------------------------------------------------

/** WLT §2.1 route strategies. */
export type RouteStrategy = 'collection' | 'special' | 'anchored';

/** The single custom-kind fallback row. */
export const CUSTOM_KIND_FALLBACK = 'c:*' as const;
export type CustomKindFallback = typeof CUSTOM_KIND_FALLBACK;

// ---------------------------------------------------------------------------
// The codec's vocabulary: layouts and the view-ref table
// ---------------------------------------------------------------------------

export const ALL_MODES: readonly CollectionMode[] = ['list', 'board', 'tree', 'feed', 'gallery', 'graph'];

/**
 * `MenuViewRef` → the `NavView` tag that addresses it.
 *
 * Total over the closed `MenuViewRef` enum by construction: `Record<MenuViewRef, …>`
 * makes a missing row a type error, which is the whole point of writing it as a
 * table instead of a switch.
 *
 * `channels` is deliberately absent from the value side — it is not a view of
 * its own but an alias for the channel collection, resolved in `landingOfRoute`
 * and `routeViewOf` so that both directions agree. Everything else is either a
 * one-to-one route line or one of the four refs that had no route until the
 * §2.1/§2.2 amendment.
 */
export const VIEW_REF_ROUTE = {
  dashboard: 'home',
  feed: 'feed',
  inbox: 'inbox',
  workspace: 'workspace',
  settings: 'settings',
  /* Added by the 2026-08-14 amendment. These four rendered from the rail with
     no route line, so their screens could not be reloaded, shared, or reached
     by the back button. The contract's `MenuViewRef` already carried all four;
     it was WLT §2.3's "CLOSED v1 union" of six that was stale. */
  graph: 'graph',
  files: 'files',
  git: 'git',
  messages: 'messages',
  /* The task Board tab (2026-08-16) — same flat-segment posture. */
  board: 'board',
  /* The Craft studio (2026-08-16) — same flat-segment posture. */
  craft: 'craft',
  /* The Help shelf (2026-08-19) — same flat-segment posture. Help has a route
     of its own even though it is not in the default spine: its door is a bar
     control, and a reference screen with no address could not be linked to. */
  help: 'help',
  /* Alias, not a view — see CHANNEL_KIND. Present so the record stays total
     over MenuViewRef; `routeViewOf` never emits it. */
  channels: 'channels',
} as const satisfies Record<MenuViewRef, string>;

// ---------------------------------------------------------------------------
// KIND_CORE
// ---------------------------------------------------------------------------

/** The contract's kind groups, plus `custom` for the `c:*` fallback row. */
export type KindCoreGroup = KindGroup | 'custom';

/**
 * What both registries share about one kind. Each app's `KindConfig` extends
 * it; nothing here draws, so nothing here is React or DOM.
 */
export interface KindCore {
  label: string;
  labelPlural: string;
  /** WLT §2.1; null for a kind with no `k/{slug}` list (voice channel, message) and for `c:*`. */
  slug: string | null;
  strategy: RouteStrategy;
  /** The contract's `CORE_KIND_INFO[kind].group`; `custom` for the fallback row. */
  group: KindCoreGroup;
  /** The drawn mark: SVG path data on the 16×16 grid (`kind-art.ts`). */
  iconArt: KindArt;
}

/** The 34 core kinds and the `c:*` fallback, in tm8-ui's registry order. */
export const KIND_CORE: Readonly<Record<CoreEntityKind | CustomKindFallback, KindCore>> = {
  task: {
    label: 'Task',
    labelPlural: 'Tasks',
    slug: 'tasks',
    strategy: 'collection',
    group: 'work',
    iconArt: KIND_ART.task,
  },
  work_session: {
    label: 'Session',
    labelPlural: 'Sessions',
    slug: 'sessions',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.work_session,
  },
  doc: {
    label: 'Doc',
    labelPlural: 'Docs',
    slug: 'docs',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.doc,
  },
  channel: {
    label: 'Channel',
    labelPlural: 'Channels',
    slug: 'channels',
    strategy: 'collection',
    group: 'talk',
    iconArt: KIND_ART.channel,
  },
  voice_channel: {
    label: 'Voice channel',
    labelPlural: 'Voice channels',
    slug: null,
    strategy: 'special',
    group: 'talk',
    iconArt: KIND_ART.voice_channel,
  },
  message: {
    label: 'Message',
    labelPlural: 'Messages',
    slug: null,
    strategy: 'anchored',
    group: 'talk',
    iconArt: KIND_ART.message,
  },
  member: {
    label: 'Member',
    labelPlural: 'Members',
    slug: 'members',
    strategy: 'collection',
    group: 'people',
    iconArt: KIND_ART.member,
  },
  team_member: {
    label: 'Teammate',
    labelPlural: 'Teammates',
    slug: 'teammates',
    strategy: 'collection',
    group: 'people',
    iconArt: KIND_ART.team_member,
  },
  pull_request: {
    label: 'Pull request',
    labelPlural: 'Pull requests',
    slug: 'pulls',
    strategy: 'collection',
    group: 'code',
    iconArt: KIND_ART.pull_request,
  },
  commit: {
    label: 'Commit',
    labelPlural: 'Commits',
    slug: 'commits',
    strategy: 'collection',
    group: 'code',
    iconArt: KIND_ART.commit,
  },
  file: {
    label: 'File',
    labelPlural: 'Files',
    slug: 'files',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.file,
  },
  spell: {
    label: 'Spell',
    labelPlural: 'Spells',
    slug: 'spells',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.spell,
  },
  skill: {
    label: 'Skill',
    labelPlural: 'Skills',
    slug: 'skills',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.skill,
  },
  collection: {
    label: 'Collection',
    labelPlural: 'Collections',
    slug: 'collections',
    strategy: 'collection',
    group: 'work',
    iconArt: KIND_ART.collection,
  },
  project: {
    label: 'Project',
    labelPlural: 'Projects',
    slug: 'projects',
    strategy: 'collection',
    group: 'work',
    iconArt: KIND_ART.project,
  },
  interaction_profile: {
    label: 'Interaction profile',
    labelPlural: 'Interaction profiles',
    slug: 'interaction-profiles',
    strategy: 'collection',
    group: 'people',
    iconArt: KIND_ART.interaction_profile,
  },
  memory: {
    label: 'Memory',
    labelPlural: 'Memories',
    slug: 'memories',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.memory,
  },
  graph: {
    label: 'Graph',
    labelPlural: 'Graphs',
    slug: 'graphs',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.graph,
  },
  drawing: {
    label: 'Drawing',
    labelPlural: 'Drawings',
    slug: 'drawings',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.drawing,
  },
  story: {
    label: 'Story',
    labelPlural: 'Stories',
    slug: 'stories',
    strategy: 'collection',
    group: 'work',
    iconArt: KIND_ART.story,
  },
  craft: {
    label: 'Craft',
    labelPlural: 'Crafts',
    slug: 'crafts',
    strategy: 'collection',
    group: 'work',
    iconArt: KIND_ART.craft,
  },
  form: {
    label: 'Form',
    labelPlural: 'Forms',
    slug: 'forms',
    strategy: 'collection',
    group: 'talk',
    iconArt: KIND_ART.form,
  },
  tool: {
    label: 'Tool',
    labelPlural: 'Tools',
    slug: 'tools',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.tool,
  },
  mcp_server: {
    label: 'Connector',
    labelPlural: 'Connectors',
    slug: 'connectors',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.mcp_server,
  },
  credential: {
    label: 'Credential',
    labelPlural: 'Credentials',
    slug: 'credentials',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.credential,
  },
  chat: {
    label: 'Chat',
    labelPlural: 'Chats',
    slug: 'chats',
    strategy: 'collection',
    group: 'talk',
    iconArt: KIND_ART.chat,
  },
  container: {
    label: 'Container',
    labelPlural: 'Containers',
    slug: 'containers',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.container,
  },
  loop: {
    label: 'Loop',
    labelPlural: 'Loops',
    slug: 'loops',
    strategy: 'collection',
    group: 'work',
    iconArt: KIND_ART.loop,
  },
  artifact: {
    label: 'Artifact',
    labelPlural: 'Artifacts',
    slug: 'artifacts',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.artifact,
  },
  worktree: {
    label: 'Worktree',
    labelPlural: 'Worktrees',
    slug: 'worktrees',
    strategy: 'collection',
    group: 'code',
    iconArt: KIND_ART.worktree,
  },
  bridge: {
    label: 'Bridge',
    labelPlural: 'Bridges',
    slug: 'bridges',
    strategy: 'collection',
    group: 'talk',
    iconArt: KIND_ART.bridge,
  },
  space_link: {
    label: 'Space link',
    labelPlural: 'Space links',
    slug: 'space-links',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.space_link,
  },
  server: {
    label: 'Server',
    labelPlural: 'Servers',
    slug: 'servers',
    strategy: 'collection',
    group: 'runtime',
    iconArt: KIND_ART.server,
  },
  style: {
    label: 'Style',
    labelPlural: 'Styles',
    slug: 'styles',
    strategy: 'collection',
    group: 'knowledge',
    iconArt: KIND_ART.style,
  },
  [CUSTOM_KIND_FALLBACK]: {
    label: 'Item',
    labelPlural: 'Items',
    // Slug is computed per custom kind (`c:{name}` → `c-{name}`); the fallback
    // row itself has none.
    slug: null,
    strategy: 'collection',
    group: 'custom',
    iconArt: KIND_ART.custom,
  },
};

/**
 * Slug → row, for the codec's `k/{slug}` route. The static rows only: a custom
 * kind's slug is always `c-{name}`, which the codec accepts on its own, so the
 * answer the codec gets is the one tm8-ui's registry gave it. tm8-ui keeps its
 * own `kindBySlug`, which also knows the custom kinds a space registered.
 */
export function kindBySlug(slug: string): KindCore | null {
  // An old `k/designs` link lands on crafts until KIND_ALIAS_UNTIL.
  const wanted = slug === 'designs' ? 'crafts' : slug;
  return Object.values(KIND_CORE).find((row) => row.slug === wanted) ?? null;
}
