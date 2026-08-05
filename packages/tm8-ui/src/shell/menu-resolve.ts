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
import type { MenuConfig, MenuViewRef } from '@tm8/contract';
import { SHIPPED_DEFAULT_MENU, VIEW_ART, unrenderableKindRefs, type KindArt } from '../domain';

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
  dashboard: { label: 'Dashboard', icon: '⌂', art: VIEW_ART.dashboard },
  feed: { label: 'Feed', icon: '≋', art: VIEW_ART.feed },
  inbox: { label: 'Inbox', icon: '◹', art: VIEW_ART.inbox },
  workspace: { label: 'Workspace', icon: '⌗', art: VIEW_ART.workspace },
  graph: { label: 'Graph', icon: '◉', art: VIEW_ART.graph },
  channels: { label: 'Channels', icon: '#', art: VIEW_ART.channels },
  settings: { label: 'Settings', icon: '⛭', art: VIEW_ART.settings },
};
