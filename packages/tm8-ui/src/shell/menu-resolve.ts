/**
 * The FAIL-CLOSED menu resolver + view presentation (LLD §4.1, RULING H).
 *
 * When the server has no usable opinion — missing row, `not_implemented`,
 * malformed payload, or a schemaVersion from a future client — the rail renders
 * the shipped default rather than nothing. "Fail-closed" here means *closed
 * onto a known-good menu*: a viewer never loses navigation because a config row
 * is broken.
 *
 * The shipped default CONSTANT itself lives in `src/domain/menu.ts`, not here:
 * it is the one piece of menu data that names kinds, and §15.2 makes a kind
 * literal outside `domain/`/`fixtures/` a build failure (D18 — the rule stayed
 * strict rather than gaining a second exception). What stays in shell is what
 * names no kinds: this resolver, and the view-ref presentation table. The split
 * is data vs. rail behavior.
 */
import type { MenuConfig, MenuGroup, MenuViewRef } from '@tm8/contract';
import { SHIPPED_DEFAULT_MENU, VIEW_ART, unrenderableKindRefs, type KindArt } from '../domain';
import type { MenuTarget } from './MenuRail';

// ---------------------------------------------------------------------------
// Fail-closed resolution
// ---------------------------------------------------------------------------

/** Why the rail is rendering what it is rendering. Surfaced for the notice/debug path. */
export type MenuSource =
  | { source: 'server'; revision: number }
  | { source: 'default'; because: MenuFallbackReason; detail?: string };

export type MenuFallbackReason =
  /** `menu()` resolved null — C-4's soft exception covers BOTH 501 and a missing row. */
  | 'absent'
  /** schemaVersion 1, but the payload does not satisfy the frozen DTO. */
  | 'malformed'
  /** A schemaVersion this client does not know how to render. */
  | 'future-version'
  /** The op rejected (any other `CollabError`). */
  | 'unavailable'
  /**
   * Structurally valid, but it names kind refs the REGISTRY cannot render —
   * a typo'd or retired ref, or `c:*` itself (the fallback row, not an
   * addressable kind). Distinct from `malformed` because the payload is
   * well-formed; what is wrong is what it points AT.
   */
  | 'unrenderable-refs';

export interface ResolvedMenu {
  config: MenuConfig;
  origin: MenuSource;
}

/**
 * Structural validation, deliberately independent of the contract's zod
 * schemas. The seam already returns contract DTOs verbatim, but "the server
 * said it was a MenuConfig" is exactly the claim fail-closed exists to distrust
 * — a config that crashes the rail takes the whole shell down with it, so the
 * rail checks the shape it is about to walk.
 *
 * Mirrors the frozen DTO (WLT §2.3): ≤8 groups, ≤12 items, ≤8 children, depth
 * EXACTLY ≤1, unique group ids, unique refs, and `settings` always present.
 */
function isRenderableMenu(value: unknown): value is MenuConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MenuConfig>;
  if (candidate.schemaVersion !== 1) return false;
  if (!Array.isArray(candidate.groups) || candidate.groups.length > 8) return false;

  const groupIds = new Set<string>();
  const refs = new Set<string>();
  let sawSettings = false;

  for (const group of candidate.groups) {
    if (typeof group?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(group.id)) return false;
    if (typeof group.label !== 'string' || group.label.length < 1 || group.label.length > 32) return false;
    if (groupIds.has(group.id)) return false;
    groupIds.add(group.id);

    if (!Array.isArray(group.items) || group.items.length > 12) return false;
    for (const item of group.items) {
      if (item?.type !== 'view' && item?.type !== 'kind') return false;
      if (typeof item.ref !== 'string' || refs.has(item.ref)) return false;
      refs.add(item.ref);
      if (item.ref === 'settings') sawSettings = true;

      if (item.type === 'kind') {
        // R8-2: children live on VIEW items only.
        if ('children' in item) return false;
        continue;
      }
      const children = item.children;
      if (children === undefined) continue;
      if (!Array.isArray(children) || children.length > 8) return false;
      for (const child of children) {
        if (child?.type !== 'view' && child?.type !== 'kind') return false;
        if (typeof child.ref !== 'string' || refs.has(child.ref)) return false;
        refs.add(child.ref);
        if (child.ref === 'settings') sawSettings = true;
        // Depth is EXACTLY ≤1 — a leaf carrying children is not a menu we render.
        if ('children' in child) return false;
      }
    }
  }

  return sawSettings;
}

/**
 * The single entry point the rail uses. Every failure mode named in LLD §4.1
 * lands on the shipped default, and each one is DISTINGUISHED — the rail can
 * render silently for `absent` (the normal Phase-1 path, since the fixture
 * dataset ships no menu row) while a `malformed` config is worth surfacing.
 *
 * @param raw   what `seam.menu(spaceId)` resolved with, or null.
 * @param error a rejection from the same call, if it rejected.
 */
export function resolveMenu(raw: MenuConfig | null | undefined, error?: unknown): ResolvedMenu {
  if (error !== undefined) {
    return {
      config: SHIPPED_DEFAULT_MENU,
      origin: { source: 'default', because: 'unavailable', detail: describeError(error) },
    };
  }
  if (raw === null || raw === undefined) {
    return { config: SHIPPED_DEFAULT_MENU, origin: { source: 'default', because: 'absent' } };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === 'number' && version > 1) {
    return {
      config: SHIPPED_DEFAULT_MENU,
      origin: {
        source: 'default',
        because: 'future-version',
        detail: `menu schemaVersion ${version} is newer than this client renders`,
      },
    };
  }
  if (!isRenderableMenu(raw)) {
    return { config: SHIPPED_DEFAULT_MENU, origin: { source: 'default', because: 'malformed' } };
  }

  // A config can be perfectly well-formed and still name kinds the registry
  // cannot render. Dropping those rows silently is the failure mode L6 exists
  // to prevent: the viewer loses navigation and is never told. `getKind` never
  // throws (a miss falls back to the `c:*` row), so this is an IDENTITY check
  // in `domain/`, not a lookup — otherwise every typo would look valid.
  const unrenderable = unrenderableKindRefs(raw);
  if (unrenderable.length > 0) {
    return {
      config: SHIPPED_DEFAULT_MENU,
      origin: {
        source: 'default',
        because: 'unrenderable-refs',
        detail: `menu names ${unrenderable.length} unrenderable kind ref(s): ${unrenderable.join(', ')}`,
      },
    };
  }

  return { config: raw, origin: { source: 'server', revision: raw.revision } };
}

// ---------------------------------------------------------------------------
// Tab derivation (five-tab ruling R2, 2026-08-15): the menu's GROUPS are the
// top-level tabs, and the rail renders only the active group's contents.
// Structural walks over the config — no view or kind literal appears here.
// ---------------------------------------------------------------------------

/**
 * The group that owns a target: its items (and caret children) name the
 * target's ref. Entity targets match through the entity's KIND — a channel
 * entity belongs to the group carrying the channel collection row. Null when
 * no group claims the target (e.g. the Inbox view, whose door is the bell,
 * not a tab) — the honest answer is "no tab is current", never a guess.
 */
export function groupIdOfTarget(config: MenuConfig, target: MenuTarget | null | undefined): string | null {
  if (!target) return null;
  const wanted =
    target.type === 'entity' ? { type: 'kind' as const, ref: target.kind } : { type: target.type, ref: target.ref };
  for (const group of config.groups) {
    for (const item of group.items) {
      if (item.type === wanted.type && item.ref === wanted.ref) return group.id;
      const children = item.type === 'view' ? (item.children ?? []) : [];
      for (const child of children) {
        if (child.type === wanted.type && child.ref === wanted.ref) return group.id;
      }
    }
  }
  return null;
}

/** Where clicking a tab lands: the group's FIRST item, as a nav target. */
export function primaryTargetOfGroup(group: MenuGroup): MenuTarget | null {
  const first = group.items[0];
  return first ? ({ type: first.type, ref: first.ref } as MenuTarget) : null;
}

/**
 * The full-bleed screens: a tab landing on one of these draws NO rail (R2:
 * "Graph and Settings have no rail"; the Files explorer has the same
 * full-screen posture). View refs are shell's own territory — the same
 * jurisdiction VIEW_PRESENTATION claims.
 *
 * `dashboard` JOINED THEM on 2026-08-15 (revision 14). It was deliberately
 * excluded before, on the reasoning that "its rail is the conversation list" —
 * but the conversation list is drawn by the SCREEN, inside its own left pane,
 * and never by the rail. So the shell drew a rail anyway and put a single row
 * in it repeating the tab's own name, one column left of the list that is the
 * real navigation: three panes where the design calls for two. Excluding it
 * here is what made the Chats tab look redundant enough to retire in 126;
 * including it is what lets the tab come back (127) without the third column.
 */
const RAILLESS_VIEW_REFS: ReadonlySet<MenuViewRef> = new Set<MenuViewRef>([
  'graph',
  'settings',
  'files',
  'dashboard',
  // 2026-08-16 (Board tab): the kanban is full-bleed — its columns ARE the
  // navigation, so a rail beside it could only repeat the tab's own name.
  'board',
  // 2026-08-16 (Craft P1): the blueprint studio is full-bleed — the chat
  // thread and the canvas are the navigation, same posture as board.
  'craft',
  // 2026-08-16 (Work tab returns, revision 19): the workspace is the split
  // pane ITSELF — its own side panels are the navigation, and a menu rail
  // beside them would be a fourth column repeating the tab's own name.
  //
  // THIS DOES NOT DISTURB THE PRE-134 WORK GROUP. `isRaillessGroup` keys on
  // the SHAPE first: that group's `workspace` item carries eight caret
  // children, so it fails the childless test before this set is consulted
  // and keeps drawing its rail — correctly, because an operator with rows
  // in a group must see them. Only a group whose whole content is a lone
  // childless `workspace` goes full-bleed, which is exactly the new default.
  'workspace',
  // 2026-08-19 (Help): the shelf carries its OWN contents column, so a menu
  // rail beside it would be a second list of the same pages.
  'help',
  // 2026-09-01 (CodeBrain): the module draws its OWN phase spine, so a menu
  // rail beside it would be a second list of the same phases. Listed even
  // though this snapshot has no CodeBrain screen — the group is in the shipped
  // spine, and a spine group that is not railless draws an empty rail column
  // beside an unbuilt notice, which is two wrongs where one is enough.
  'codebrain',
]);

/**
 * A group draws no rail when its whole content is a single childless
 * full-bleed view — a rail there could only repeat its own tab. A group with
 * real rows (Work, Channels) always draws one.
 */
export function isRaillessGroup(group: MenuGroup): boolean {
  if (group.items.length !== 1) return false;
  const only = group.items[0]!;
  return (
    only.type === 'view' &&
    (only.children?.length ?? 0) === 0 &&
    RAILLESS_VIEW_REFS.has(only.ref)
  );
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const shaped = error as { code?: unknown; message?: unknown };
    if (typeof shaped.code === 'string') return shaped.code;
    if (typeof shaped.message === 'string') return shaped.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// View presentation (shell's own territory — NOT kind data)
// ---------------------------------------------------------------------------

/**
 * Labels and glyphs for the CLOSED v1 `ViewRef` union. Views are shell's own
 * concern, so this table lives here; KIND refs resolve through the domain
 * registry instead (§15.2 makes a kind literal outside `domain/` a build
 * failure, which is why `MenuRail` takes a kind resolver rather than a map).
 *
 * Glyphs come from the T1-1 legend, which is the canvases' definitional glyph
 * vocabulary. Where T0-1 draws a different glyph for the same view the legend
 * wins — see the DECISIONS entry; the divergence is listed for the R5 pixel
 * reviewer rather than silently reconciled.
 */
/**
 * `icon` is the TEXT fallback; `art` is what the rail draws.
 *
 * Two of these text glyphs were outright collisions with KIND glyphs —
 * `graph: ◉` was the commit mark and `channels: #` the channel mark — so a
 * collapsed rail could show the same character for a view and for an entity
 * kind. `art` comes from the same table the kinds draw from, which is what
 * keeps one column in one idiom.
 */
export const VIEW_PRESENTATION: Record<MenuViewRef, { label: string; icon: string; art: KindArt }> = {
  // Revision 11 (single-home ruling): the row reads "Home" — it IS the landing
  // page now, and "Dashboard" promised a stats screen this row never was. The
  // ref stays `dashboard` (closed union; the route already says `/home`).
  dashboard: { label: 'Home', icon: '⌂', art: VIEW_ART.dashboard },
  feed: { label: 'Feed', icon: '≋', art: VIEW_ART.feed },
  inbox: { label: 'Inbox', icon: '◹', art: VIEW_ART.inbox },
  // 2026-08-13: the cross-entity conversation browser. Label "Messages"
  // (plural) rather than "Chat" or "Conversations" because the rail's job is
  // to name the CONTENT the row reaches, and the content is every message in
  // the space regardless of which entity it was posted on.
  messages: { label: 'Messages', icon: '✉', art: VIEW_ART.messages },
  workspace: { label: 'Workspace', icon: '⌗', art: VIEW_ART.workspace },
  graph: { label: 'Graph', icon: '◉', art: VIEW_ART.graph },
  channels: { label: 'Channels', icon: '#', art: VIEW_ART.channels },
  // 2026-08-10: the Files EXPLORER view. Label "File browser" rather than
  // "Files" because the `file` KIND row in the same Library group already
  // reads "Files" — two identical labels in one rail would read as a
  // duplicate (the R9 follow-up recorded on task 019fe5d6).
  files: { label: 'File browser', icon: '▤', art: VIEW_ART.files },
  settings: { label: 'Settings', icon: '⛭', art: VIEW_ART.settings },
  // Git UI wave: the project git screen — its glyph is a branch fork, an
  // idiom no kind row uses (the commit mark is a bare ring; this one forks).
  // Revision 11: the rail row reads "Code" — it leads the dev cluster
  // (projects, PRs, worktrees ride its caret), and "Git" named the tool
  // rather than the intent. The ref stays `git`.
  git: { label: 'Code', icon: '⎇', art: VIEW_ART.git },
  // Board tab wave (2026-08-16): the task kanban. Label "Board" — it names
  // the SURFACE (columns you move cards across), not the kind it presents;
  // the task collection row in Work already reads "Tasks".
  board: { label: 'Board', icon: '⫼', art: VIEW_ART.board },
  // Craft P1 (2026-08-16): the blueprint studio. Label "Craft" — it names the
  // ACTIVITY (sketching a flow with a teammate), not the graph kind it edits.
  craft: { label: 'Craft', icon: '✎', art: VIEW_ART.craft },
  /* CodeBrain entered the contract after this snapshot was frozen. It is
     listed so the record stays total over `MenuViewRef` and so an operator can
     PLACE it in a menu; `view-ref-screens.ts` marks it unbuilt here, which is
     what makes the row say so instead of rendering an empty screen. */
  codebrain: { label: 'CodeBrain', icon: '◈', art: VIEW_ART.codebrain },
  // Help (2026-08-19): the curated shelf of Help pages. Label "Help" — the
  // word a reader looks for; "Docs" would promise API reference this is not.
  // Present here so an operator can PLACE Help in their own menu even though
  // it is not in the shipped default spine (`availableViewRefs` reads this
  // table): a ref the editor could not offer would be unreachable by choice.
  help: { label: 'Help', icon: '?', art: VIEW_ART.help },
};
