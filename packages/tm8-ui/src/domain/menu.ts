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
export const SHIPPED_DEFAULT_MENU_REVISION = 8;

/**
 * WLT §2, encoded literally:
 *
 *   Home        → Dashboard
 *   Workspace ▾ → (row click = the composed view; caret expands — RULING E)
 *                 Tasks · Sessions · Docs · Channels · Teammates · Memories ·
 *                 Artifacts · Loops
 *   Library     → Files · Spells · Collections
 *   Tracking    → Projects · Pull requests · Worktrees
 *   Collab      → Members
 *   Voice       → live per-space voice_channel rows injected beneath this label
 *   Settings    → Space settings
 *
 * Revision 5 (2026-08-01, user ruling): CHANNELS LEFT THE RAIL ENTIRELY. They
 * are entities, so they belong in the Entity List Panel with every other
 * collection — `channel` became `strategy: 'collection'` in the registry and
 * the panel's kind switcher now offers it. A rail section AND a collection
 * list would be two divergent homes for one kind, which is what the voice
 * row's docblock warned about; this resolves it by keeping the collection.
 * Feed and Inbox left the rail in the same ruling, so Home is Dashboard alone.
 *
 * NOTHING here was deleted from the app: `feed`, `inbox` and `channels` all
 * keep their routes, their `MenuViewRef` membership and their chords, and the
 * menu editor can put any of the three back — they are now the three FREE view
 * refs. This is a rail edit, not a feature removal.
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
      items: [{ type: 'view', ref: 'dashboard' }],
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
            // Revision 6 (2026-08-01, user ruling): Channels takes its place in
            // the collection list, one row like Docs.
            //
            // This is NOT the Channels SECTION revision 5 removed. That was a
            // group whose rows were the space's live #channel entities — a
            // second, divergent home for the kind. This is the same single row
            // every other collection kind has, opening the same list, and it
            // exists because `channel` became a collection kind and was then
            // the ONLY one the rail never named. The workspace has two docks
            // and three collections that want to be on screen; pointing a dock
            // at channels just took sessions off it, so visibility belongs
            // here, where it costs no dock at all.
            { type: 'kind', ref: 'channel' },
            { type: 'kind', ref: 'team_member' },
            // Revision 4 (2026-07-31): Memories and Artifacts — both shipped
            // features whose lists were unreachable from the rail. Caret
            // children cap is 8; revision 6 brought the count to 7.
            { type: 'kind', ref: 'memory' },
            { type: 'kind', ref: 'artifact' },
            // Revision 7 (2026-08-09): Loop fills the eighth and final caret
            // slot. The kind already has a collection route and registry row;
            // this makes the shipped scheduler surface reachable by default.
            { type: 'kind', ref: 'loop' },
          ],
        },
        // Revision 2 (2026-07-29): the ◉ Graph view — no longer deferred, the
        // prototype ships on fixtures (GRAPH-VIEW-PLAN §2).
        { type: 'view', ref: 'graph' },
      ],
    },
    {
      id: 'library',
      label: 'Library',
      items: [
        // Revision 8 (2026-08-10): the Files EXPLORER view — browse roots,
        // folders, uploads. Distinct from the `file` KIND row below, which
        // lists file ENTITIES; owner ruling R9 keeps BOTH (rail labels
        // differ: "File browser" vs "Files").
        { type: 'view', ref: 'files' },
        { type: 'kind', ref: 'file' },
        { type: 'kind', ref: 'spell' },
        { type: 'kind', ref: 'collection' },
      ],
    },
    {
      id: 'tracking',
      label: 'Tracking',
      items: [
        { type: 'kind', ref: 'project' },
        { type: 'kind', ref: 'pull_request' },
        // Revision 4 (2026-07-31): Worktrees live with the git-adjacent rows.
        // Menu-visible only — creation stays with the provisioning saga
        // (contract MenuKindRef note; registry row has quickCreate: false).
        { type: 'kind', ref: 'worktree' },
        /* Revision 7 (2026-08-09): ▤ Files — browse and view a linked project's
           working directory on the node (FILES-DESIGN §5.3). It sits HERE,
           beside Projects, because a project's folder is exactly what it reads.

           NOT under the Workspace caret: that caret lists ENTITY collections
           and this lists paths on disk. NOT its own group either — group ids
           are pinned to DEFAULT_MENU_GROUP_SPINE, which the server seeder
           (migration 061, menu-seeder-parity.pg.test.ts) derives from too, so
           a new group is a MIGRATION and a rail row does not justify one. */
        { type: 'view', ref: 'files' },
      ],
    },
    { id: 'collab', label: 'Collab', items: [{ type: 'kind', ref: 'member' }] },
    // Revision 5 (2026-08-01): the Channels GROUP is gone — its route ref and
    // its live rows both moved into Home. See the docblock.
    // Revision 3 (2026-07-31): the Voice group. Deliberately items-EMPTY —
    // there is no `voice` member of the closed `MenuViewRef` union to author,
    // and `voice_channel` is `strategy: 'special'` so it is not a menu-eligible
    // kind ref either. The group exists purely as the LABEL that GateApp's
    // dynamic group hangs the space's live voice rooms beneath, exactly as
    // Channels works once its authored item is replaced. With no rooms it
    // renders its header and the dynamic group's empty line — honest, not a
    // promise the app cannot keep.
    { id: 'voice', label: 'Voice', items: [] },
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
