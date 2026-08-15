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
  DEFAULT_MENU_CHATS_SPINE,
  DEFAULT_MENU_CODE_KIND_SPINE,
  DEFAULT_MENU_WORKSPACE_KIND_SPINE,
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
// rows. See `DEFAULT_MENU_GROUP_SPINE` for the full account of what moved
// where; nothing was deleted, only re-shelved.
export const SHIPPED_DEFAULT_MENU_REVISION = 11;

/**
 * The single-home rail (revision 11, user ruling 2026-08-14), encoded literally:
 *
 *   Home        → the merged chat-first landing (view ref `dashboard`)
 *   Chats       → Channels · Messages, plus live voice rooms injected beneath
 *                 (the dynamic group moved here from the retired Voice group)
 *   Workspace ▾ → (row click = the composed view; caret expands — RULING E)
 *                 Tasks · Sessions · Docs · Teammates · Memories · Artifacts ·
 *                 Loops · Files — plus the File browser view as a sibling row
 *   Code ▾      → the git view; caret expands Projects · Pull requests ·
 *                 Worktrees
 *   Graph       → the space picture
 *   Settings    → Space settings
 *
 * WHAT LEFT THE RAIL, and where it went — nothing was deleted, only
 * re-shelved, and every ref keeps its route, its chord and its menu-editor
 * eligibility:
 *
 *   - INBOX → the top-bar bell (GateApp). Its rows also feed the Home page's
 *     NEEDS YOU / MENTIONS sections, so a rail row was a third door to the
 *     same fact.
 *   - `spell`, `collection`, `member` → the palette and the Entity List
 *     Panel's kind switcher. They are occasional destinations; the rail's
 *     scarce rows go to daily ones.
 *   - The VOICE group label: live rooms now hang beneath Chats, where the
 *     other conversation surfaces are, and an empty space no longer spends a
 *     group label promising rooms it does not have.
 *
 * Workspace and Code are the two caret VIEW items (RULING E) — `type:'view'`
 * MenuItems carrying `children`. Both carets ship CLOSED: the classification
 * is one click away rather than thirty rows tall.
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
      id: 'chats',
      label: 'Chats',
      // MESSAGES is a VIEW and not a kind row for two independent reasons: the
      // `message` registry row is `strategy: 'anchored'` with `slug: null`, so
      // `isMenuEligibleKind` refuses it and the rail would fail closed; and the
      // DB's own twin (`internal.w2_normalize_menu_payload`) rejects a kind ref
      // of `message` outright. There is exactly one door and this is it.
      items: [...DEFAULT_MENU_CHATS_SPINE],
    },
    {
      id: 'workspace',
      label: 'Workspace',
      items: [
        {
          type: 'view',
          ref: 'workspace',
          // The one entity browser. `channel` left this caret for Chats
          // (revision 11); `file` takes the freed eighth slot, which is what
          // let the Library group fold in without losing the file rows.
          children: DEFAULT_MENU_WORKSPACE_KIND_SPINE.map((ref) => ({
            type: 'kind' as const,
            ref,
          })),
        },
        // The Files EXPLORER view — browse roots, folders, uploads. Distinct
        // from the `file` KIND child above, which lists file ENTITIES; owner
        // ruling R9 keeps BOTH (labels differ: "File browser" vs "Files").
        { type: 'view', ref: 'files' },
      ],
    },
    {
      id: 'code',
      label: 'Code',
      items: [
        {
          // The project git screen — topology, worktree lanes, contention —
          // is the row; the dev-tracking collections ride its caret.
          type: 'view',
          ref: 'git',
          children: DEFAULT_MENU_CODE_KIND_SPINE.map((ref) => ({
            type: 'kind' as const,
            ref,
          })),
        },
      ],
    },
    { id: 'graph', label: 'Graph', items: [{ type: 'view', ref: 'graph' }] },
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
