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
import { type MenuConfig } from '@tm8/contract';
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
// Revision 13 (2026-08-15, conversation-axis ruling): the `home` GROUP is
// retired. Home stopped being a destination and became the CONTAINER — the
// conversation surface the shell falls back to — so a tab for it, and a rail
// row inside that tab repeating its own name, were two more doors to the
// place you are already standing in. The `dashboard` ref itself is untouched:
// same route, same palette row, same menu-editor eligibility, and it is still
// where a viewer with no remembered place lands. Only its menu HOME is gone.
// Revision 14 (2026-08-15, user ruling — 13 is reversed): the group leads
// again, named CHATS. 13 read the redundancy right and cut the wrong thing:
// the repeated door was the RAIL ROW, not the tab, and removing the group
// took the tab with it — leaving the brand mark as the only way back to
// conversations, a door with no label that you find by guessing. The tab
// returns; the rail is what stays gone (`dashboard` is a railless view ref
// now), so the surface is two panes and the conversation LIST is its
// navigation.
// Revision 15 (2026-08-16, user ruling): the tab is renamed COLLAB. A label
// change only — the group id stays `chats` (ids are wire-stable; every
// resolver, voice-room fallback and upgrade guard keys on the id), the single
// railless `dashboard` item stays, and the two-pane guarantee is untouched.
// Revision 16 (2026-08-16, Board tab wave): a BOARD group joins beside Work —
// the task kanban as its own full-bleed tab (railless: one childless `board`
// view item, the graph/files posture). It PRESENTS the task collection; the
// `task` kind row stays in the Workspace caret, so this is a second door to
// tasks, not a move.
// Revision 17 (2026-08-16, unified Home — task 01a00932, migration 134): the
// WORK and CHANNELS groups retire and the conversation tab is renamed HOME —
//   Home | Board | Graph | Files | Settings.
// Home's screen now lists chat threads OR any collection kind (the root
// column + registry-driven icon rail, `domain/home-rail.ts`), so a Work tab
// beside it would be a second door to every list Home already owns, and
// Channels' contents await the redesigned Collab surface (R2: a later
// feature). Nothing was deleted: `workspace`, `git`, `messages` and every
// retired kind ref keep their routes, their chords and their menu-editor
// eligibility — the 125/126/127 rail-edit posture.
// 17 → 18 (2026-08-16, Craft P1 / migration 137): the CRAFT group joins
// between Board and Graph.
// 18 → 19 (2026-08-16, user ruling / migration 140): a WORK group returns,
// second in the row —
//   Home | Work | Board | Craft | Graph | Files | Settings.
// 17 retired Work because its rail of rows (the Workspace caret plus the dev
// kinds and git) was a second door to lists Home's root column already owns.
// That reasoning was about the ROWS, and this group has none: it holds the
// single childless `workspace` view, so the tab IS the three-panel workspace
// — side panel, center entity, side panel. Home offers no such layout, so
// this is a new arrangement rather than a repeated door, and it is railless
// by the same shape rule as Home/Board/Craft.
// 19 → 20 (2026-08-20, Help library ruling / migration 164): Help joins as
// the final tab. Files and the legacy Board group leave the shipped tab spine
// but keep their refs, routes and menu-editor eligibility. Board v2 occupies
// the visible Board seat client-side because it is a route-only screen rather
// than a MenuViewRef.
export const SHIPPED_DEFAULT_MENU_REVISION = 20;

/**
 * The menu half of the revision-20 tab shell. These GROUPS become top-row
 * tabs, and GateApp inserts the route-only Board v2 seat after Work, yielding:
 *
 *   Home | Work | Board | Craft | Graph | Settings | Help
 *
 * Revision 17's earlier shell is retained below as design history for the
 * routes and railless shapes that still survive:
 *
 *   Home     → the unified surface (view ref `dashboard`): the root column
 *              (chat threads OR any collection kind's list, picked through
 *              the [Chats ＋][Kind ＋ ▾] header and the screen's own icon
 *              rail), the center (conversation or entity), the optional
 *              right panel. No MENU rail — see below.
 *              (Group id `chats`; 15 renamed the label to Collab, 17 to
 *              Home. Ids are wire-stable; labels move.)
 *   Board    → the legacy task kanban, now retained off the shipped spine
 *   Graph    → the space picture (no rail)
 *   Files    → the File browser view, now retained off the shipped spine
 *   Settings → Space settings (no rail)
 *
 * WORK AND CHANNELS RETIRED HERE (revision 17). Home's root column lists
 * every collection kind the registry offers, so a Work tab beside it was a
 * second door to every one of its lists; Channels' contents (channel
 * collection, Messages, voice rooms) await the redesigned Collab surface,
 * which ships later as its own feature (R2). Nothing was deleted:
 * `workspace`, `git`, `messages` and every retired kind ref keep their
 * routes, their chords and their menu-editor eligibility — the same
 * rail-edit-not-feature-removal posture as 125/126/127.
 *
 * THE HOME TAB DRAWS NO MENU RAIL, still: the group owns exactly one
 * childless view item, so `isRaillessGroup` answers true and the shell
 * renders the screen full-bleed beside the tab row. The ICON RAIL a viewer
 * sees on Home is part of the SCREEN (`views/HomeRail.tsx`, fed by
 * `domain/home-rail.ts`) — registry-derived, entities only — because the
 * frozen menu DTO caps a group at 12 items and cannot carry every kind,
 * and because the rail must equal the kind switcher by construction.
 *
 * `HOME_TARGET` in `views/GateApp.tsx` is unchanged: the unified surface
 * is still where a viewer with no remembered place lands.
 *
 * MESSAGES stays a VIEW and not a kind row for two independent reasons: the
 * `message` registry row is `strategy: 'anchored'` with `slug: null`, so
 * `isMenuEligibleKind` refuses it and the rail would fail closed; and the
 * DB's own twin (`internal.w2_normalize_menu_payload`) rejects a kind ref of
 * `message` outright. It keeps its route and palette row; its menu seat
 * returns with Collab.
 */
export const SHIPPED_DEFAULT_MENU: MenuConfig = {
  schemaVersion: 1,
  revision: SHIPPED_DEFAULT_MENU_REVISION,
  groups: [
    // HOME leads (revision 14 restored the tab; 15 and 17 renamed the label
    // — the id stays `chats`). One childless view item is what makes the
    // group railless — add a second row here and the surface grows a third
    // pane, which is the arrangement this revision exists to prevent.
    { id: 'chats', label: 'Home', items: [{ type: 'view', ref: 'dashboard' }] },
    // WORK returns (revision 19), and it is the THREE-PANEL WORKSPACE — one
    // childless `workspace` view item, so the group is railless by the same
    // shape rule as Home and Board and the surface is exactly the split
    // pane: side panel · center stage · side panel, nothing else beside it.
    //
    // Adding caret children here (the eight kinds the pre-134 Work group
    // carried) would give the item children, `isRaillessGroup` would answer
    // false, and a menu rail would appear left of the split — a fourth
    // column, which is the arrangement this revision exists to prevent.
    { id: 'work', label: 'Work', items: [{ type: 'view', ref: 'workspace' }] },
    // RETIRED FROM THE SHIPPED TAB SPINE (revision 20). The legacy Board view
    // remains registered, routable and menu-editor eligible; Board v2 now owns
    // the visible Board tab through GateApp's route-only seat.
    // { id: 'board', label: 'Board', items: [{ type: 'view', ref: 'board' }] },
    // The blueprint studio (revision 18). Railless like Board and Home: one
    // childless view item — the chat and the canvas are the navigation.
    { id: 'craft', label: 'Craft', items: [{ type: 'view', ref: 'craft' }] },
    { id: 'graph', label: 'Graph', items: [{ type: 'view', ref: 'graph' }] },
    // RETIRED FROM THE SHIPPED TAB SPINE (revision 20). The Files explorer,
    // route, palette row and menu-editor eligibility remain intact.
    // { id: 'files', label: 'Files', items: [{ type: 'view', ref: 'files' }] },
    { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
    { id: 'help', label: 'Help', items: [{ type: 'view', ref: 'help' }] },
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
