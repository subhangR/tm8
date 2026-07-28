/**
 * THE SHIPPED DEFAULT MENU (LLD §4.1, RULING H).
 *
 * The constant lives in `domain/` — not in `shell/` — because it is the one
 * piece of menu data that NAMES KINDS. §15.2 makes a kind literal outside
 * `domain/` and `fixtures/` a build failure, and that rule stays strict with
 * no new exceptions: the menu is registry-adjacent DATA (fe-coordinator
 * ruling, 2026-07-28; A1b ledgers it as D18). The rail's rendering, the
 * fail-closed resolver, and the view-ref presentation table stay in `shell/`,
 * which is where they belong — they name no kinds.
 *
 * Content is A1b's `src/shell/menu-default.ts` VERBATIM; only its home moved.
 *
 * The constant encodes the WLT §2 diagram, which that spec names as the
 * shipped default config ("The §2 diagram is the shipped default config, not
 * chrome"). Activity and Leaderboard are deliberately ABSENT: R7-5 keeps
 * deferred features out of the shipped MenuConfig — they surface only as
 * disabled palette-discovery rows (§4.2).
 */
import type { MenuConfig } from '@tm8/contract';
import { getKind } from './registry';
import { CUSTOM_KIND_FALLBACK } from './types';

/**
 * Bumped whenever the constant below changes, so a viewer's rendered menu is
 * attributable to a specific shipped default. It is NOT a server revision:
 * `SHIPPED_DEFAULT_MENU` never round-trips through `spaces.menu.update`
 * (that command is a §10.7 deferred seam amendment).
 */
export const SHIPPED_DEFAULT_MENU_REVISION = 2;

/**
 * WLT §2, encoded literally:
 *
 *   Home        → Dashboard · Feed · Inbox
 *   Workspace ▾ → (row click = the composed view; caret expands — RULING E)
 *                 Tasks · Sessions · Docs · Teammates
 *   Tracking    → Projects · Pull requests
 *   Collab      → Members
 *   Channels    → channel list
 *   Settings    → Space settings
 *
 * Workspace is the one caret VIEW item (RULING E) — it is a `type:'view'`
 * MenuItem carrying `children`, visually distinct from a group header, which
 * is a label and nothing else. Every other row is a plain item.
 */
export const SHIPPED_DEFAULT_MENU: MenuConfig = {
  schemaVersion: 1,
  revision: SHIPPED_DEFAULT_MENU_REVISION,
  groups: [
    {
      id: 'home',
      label: 'Home',
      items: [
        { type: 'view', ref: 'dashboard' },
        { type: 'view', ref: 'feed' },
        { type: 'view', ref: 'inbox' },
      ],
    },
    {
      id: 'workspace',
      label: 'Workspace',
      items: [
        {
          type: 'view',
          ref: 'workspace',
          children: [
            { type: 'kind', ref: 'task' },
            { type: 'kind', ref: 'work_session' },
            { type: 'kind', ref: 'doc' },
            { type: 'kind', ref: 'team_member' },
          ],
        },
        // Revision 2 (2026-07-29): the ◉ Graph view — no longer deferred, the
        // prototype ships on fixtures (GRAPH-VIEW-PLAN §2).
        { type: 'view', ref: 'graph' },
      ],
    },
    {
      id: 'tracking',
      label: 'Tracking',
      items: [
        { type: 'kind', ref: 'project' },
        { type: 'kind', ref: 'pull_request' },
      ],
    },
    { id: 'collab', label: 'Collab', items: [{ type: 'kind', ref: 'member' }] },
    { id: 'channels', label: 'Channels', items: [{ type: 'view', ref: 'channels' }] },
    { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
  ],
};

/**
 * Menu-ref validation against the registry (WLT §2.3): a `kind` ref is
 * renderable only when a registry row answers to it AND that row is
 * `strategy: 'collection'` — `channel` is a reserved word with its own route
 * and `message` has no `k/` view, so neither can be a menu row.
 *
 * `getKind` never throws (a miss falls back to `c:*`), so the identity check
 * is what makes this a real validation rather than a lookup.
 */
export function isMenuEligibleKind(ref: string): boolean {
  // The `c:*` sentinel is the fallback ROW, not an addressable kind — it has
  // no slug, so it can never be a menu destination. A real custom kind can:
  // it is collection-strategy and its slug is computed (`c:{name}` → `c-{name}`).
  if (ref === CUSTOM_KIND_FALLBACK) return false;
  if (ref.startsWith('c:') && ref.length > 2) return true;
  const row = getKind(ref);
  return row.kind === ref && row.strategy === 'collection' && row.slug !== null;
}

/** Every `kind` ref reachable in a config, groups and caret children alike. */
export function menuKindRefs(config: MenuConfig): string[] {
  const refs: string[] = [];
  for (const group of config.groups) {
    for (const item of group.items) {
      if (item.type === 'kind') refs.push(item.ref);
      const children = item.type === 'view' ? (item.children ?? []) : [];
      for (const child of children) if (child.type === 'kind') refs.push(child.ref);
    }
  }
  return refs;
}

/**
 * The kind refs a config names that the registry cannot render. A non-empty
 * result is a fail-closed trigger for the rail (LLD §4.1), never a silently
 * dropped row — a viewer must not lose navigation without being told why.
 */
export function unrenderableKindRefs(config: MenuConfig): string[] {
  return menuKindRefs(config).filter((ref) => !isMenuEligibleKind(ref));
}
