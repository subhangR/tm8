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
import {
  DEFAULT_MENU_CHANNELS_SPINE,
  DEFAULT_MENU_WORK_ITEM_SPINE,
  type MenuConfig,
} from '@tm8/contract';
import { getKind } from './registry';
import { CUSTOM_KIND_FALLBACK } from './types';

/**
 * Bumped whenever the constant below changes, so a viewer's rendered menu is
 * attributable to a specific shipped default. It is NOT a server revision:
 * `SHIPPED_DEFAULT_MENU` never round-trips through `spaces.menu.update`
 * (that command is a §10.7 deferred seam amendment).
 */
// Revision 9 (2026-08-12, Git UI landing): the Git view row leads Tracking.
// Revision 10 (2026-08-13): Messages (new view ref) and Inbox (an existing ref
// whose finished screen was never mounted) join Dashboard under Home.
// Revision 11 (2026-08-14, single-home ruling): the rail reorganized around
// intents — Home / Chats / Workspace / Code / Graph / Settings, ~8 visible
// rows.
// Revision 12 (2026-08-15, five-tab ruling R2/R3/R4): the groups ARE the
// top-level tabs — Home / Work / Graph / Channels / Settings. `code` retired
// into Work (its three kinds become ordinary rows; the git view stays a plain
// Work row, D1); `chats` renamed Channels. See `DEFAULT_MENU_GROUP_SPINE` for
// the full account; nothing was deleted, only re-shelved.
export const SHIPPED_DEFAULT_MENU_REVISION = 12;

/**
 * The five-tab shell (revision 12, user rulings R2/R3/R4, 2026-08-15),
 * encoded literally — the GROUPS are the top-row TABS and the rail renders
 * only the active group's contents:
 *
 *   Home     → the chat-first landing (view ref `dashboard`)
 *   Work     → Workspace ▾ (caret: Tasks · Sessions · Docs · Teammates ·
 *              Memories · Artifacts · Loops · Files) ·
 *              Projects · Pull requests · Worktrees · Code (the git view)
 *   Graph    → the space picture (no rail)
 *   Channels → the channel collection · Messages, plus live voice rooms
 *              injected beneath (the dynamic group)
 *   Files    → the File browser view, its own tab (user amendment 2026-08-15)
 *   Settings → Space settings (no rail)
 *
 * R3: the `code` GROUP is retired — "code is just part of the workspace" —
 * so its three kind collections become ordinary Work rows and the git
 * topology view survives as a plain Work row (reversible default D1: that
 * surface shipped in #167-#175 and is distinct from the three collections;
 * it is not deleted). R4: `chats` is renamed Channels — Home is the chat
 * view, Channels is the channel kind's own tab; `messages` rides with it
 * (reversible default D2). Nothing was deleted, only re-shelved: every ref
 * keeps its route, its chord and its menu-editor eligibility.
 *
 * MESSAGES stays a VIEW and not a kind row for two independent reasons: the
 * `message` registry row is `strategy: 'anchored'` with `slug: null`, so
 * `isMenuEligibleKind` refuses it and the rail would fail closed; and the
 * DB's own twin (`internal.w2_normalize_menu_payload`) rejects a kind ref of
 * `message` outright. There is exactly one door and this is it.
 */
export const SHIPPED_DEFAULT_MENU: MenuConfig = {
  schemaVersion: 1,
  revision: SHIPPED_DEFAULT_MENU_REVISION,
  groups: [
    {
      id: 'home',
      label: 'Home',
      items: [{ type: 'view', ref: 'dashboard' }],
    },
    {
      id: 'workspace',
      label: 'Work',
      // The whole group comes from ONE spine so the server seeder (migration
      // 125) and this fallback prove the same list — items, order and the
      // caret's children alike.
      items: [...DEFAULT_MENU_WORK_ITEM_SPINE],
    },
    { id: 'graph', label: 'Graph', items: [{ type: 'view', ref: 'graph' }] },
    {
      id: 'channels',
      label: 'Channels',
      items: [...DEFAULT_MENU_CHANNELS_SPINE],
    },
    // The File browser TAB (user amendment, 2026-08-15). The view left the
    // Work group — menu refs are globally unique — while the `file` KIND
    // stays in the Workspace caret: R9's two file doors, now on two tabs.
    { id: 'files', label: 'Files', items: [{ type: 'view', ref: 'files' }] },
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
