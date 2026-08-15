/**
 * The shipped default menu, validated against the registry (LLD §4.1, WLT §2.3).
 *
 * The constant is a fail-closed floor: if IT is wrong, every broken-config path
 * lands on a broken menu, which is the one failure the fallback exists to
 * prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU_CHANNELS_SPINE,
  DEFAULT_MENU_CODE_KIND_SPINE,
  DEFAULT_MENU_GROUP_SPINE,
  DEFAULT_MENU_WORKSPACE_KIND_SPINE,
  DEFAULT_MENU_WORK_ITEM_SPINE,
  MenuConfigSchema,
  type MenuConfig,
} from '@tm8/contract';
import {
  SHIPPED_DEFAULT_MENU,
  SHIPPED_DEFAULT_MENU_REVISION,
  getKind,
  isMenuEligibleKind,
  menuKindRefs,
  unrenderableKindRefs,
} from './index';

describe('SHIPPED_DEFAULT_MENU', () => {
  // Carried over verbatim with the constant (A1b's menu-default.test.ts): the
  // shipped default must satisfy the FROZEN DTO, or the fail-closed path lands
  // on a config the server would itself reject.
  it('satisfies the frozen contract MenuConfigSchema', () => {
    const parsed = MenuConfigSchema.safeParse(SHIPPED_DEFAULT_MENU);
    expect(parsed.success).toBe(true);
  });

  it('names only kinds this registry can actually render', () => {
    expect(unrenderableKindRefs(SHIPPED_DEFAULT_MENU)).toEqual([]);
  });

  it('encodes the WLT §2 diagram, pinned to the contract spine', () => {
    // DEFAULT_MENU_GROUP_SPINE is the ONE truth this default and the server
    // seeder (db/migrations/093, tested by
    // packages/server/test/db/menu-seeder-parity.pg.test.ts) are both pinned
    // to. Before the spine existed the two carried unjoined hand-copies, and
    // migration 059 dropped the voice group with every suite green — the
    // stable deployment caught it. A group change now edits the spine, where
    // BOTH parity tests see it.
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).toEqual(
      DEFAULT_MENU_GROUP_SPINE.map((g) => g.clientId),
    );
    // The ordered kind spines are the second shared parity pin: the client
    // fallback and SQL seeder each prove their hand-written copy against them.
    // Revision 12: Work precedes Channels, so the Workspace caret's kinds
    // lead, the retired Code caret's three collections follow as ordinary
    // Work rows (R3), and `channel` closes the list from the Channels group.
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toEqual([
      ...DEFAULT_MENU_WORKSPACE_KIND_SPINE,
      ...DEFAULT_MENU_CODE_KIND_SPINE,
      'channel',
    ]);
    expect(DEFAULT_MENU_WORKSPACE_KIND_SPINE).toHaveLength(8);
  });

  it('clusters the conversation surfaces in Channels, pinned to the contract spine', () => {
    const channels = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'channels');
    expect(channels).toEqual({
      id: 'channels',
      label: 'Channels',
      items: DEFAULT_MENU_CHANNELS_SPINE,
    });
  });

  it('folds the retired Code group into Work — R3, with the git view surviving as a plain row (D1)', () => {
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).not.toContain('code');
    const work = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'workspace');
    expect(work?.items).toEqual(DEFAULT_MENU_WORK_ITEM_SPINE);
    // The three dev collections are ORDINARY rows, not caret children…
    expect(
      work?.items.filter((i) => i.type === 'kind').map((i) => i.ref),
    ).toEqual([...DEFAULT_MENU_CODE_KIND_SPINE]);
    // …and the git view is a PLAIN row: childless, undeleted.
    const git = work?.items.find((i) => i.ref === 'git');
    expect(git).toEqual({ type: 'view', ref: 'git' });
  });

  it('keeps both file doors — the browser as its own tab, the kind in the Workspace caret', () => {
    // No Library group since revision 11. Revision 12 (user amendment): the
    // Files explorer VIEW is its own TAB — refs are globally unique, so it
    // left Work — while the `file` KIND keeps the caret's eighth slot (owner
    // ruling R9 keeps both doors). `spell` and `collection` stay palette-only.
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).not.toContain('library');
    const workspace = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'workspace');
    expect(workspace?.items.map((i) => i.ref)).toEqual([
      'workspace',
      'project',
      'pull_request',
      'worktree',
      'git',
    ]);
    const files = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'files');
    expect(files?.items).toEqual([{ type: 'view', ref: 'files' }]);
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toContain('file');
    for (const gone of ['spell', 'collection', 'member']) {
      expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).not.toContain(gone);
    }
  });

  it('always contains settings (the fail-closed floor)', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    expect(refs).toContain('settings');
  });

  /**
   * Revision 14 (user ruling, 2026-08-15): the conversation surface has a TAB
   * again, named Chats — 13's retirement of the `home` group is reversed.
   *
   * What 13 got right is kept, and this test pins the pair together because
   * they are only correct as a pair: the group exists AND it is railless. 13
   * objected to two doors to the room you were standing in, and the second
   * door was the RAIL ROW — one row repeating the tab's own name, drawn one
   * column left of the conversation list that is the real navigation. Removing
   * the group removed the tab as well, which is the part the user rejected;
   * the rail is what actually had to go, and `isRaillessGroup` is where that
   * now lives. A group with a second item here would draw one again, so the
   * single-item shape is load-bearing, not incidental — and it is asserted
   * here as a SHAPE. That the shape means "no rail" is `isRaillessGroup`'s
   * claim, proven next to it in shell/menu-resolve.test.ts; domain/ does not
   * reach into shell/ to borrow the predicate.
   */
  it('leads with a single-item Collab group — the tab is back, the rail row is not', () => {
    const ids = SHIPPED_DEFAULT_MENU.groups.map((g) => g.id);
    expect(ids[0]).toBe('chats');
    // `home` is NOT the id: 13 retired that group and 14 does not resurrect it,
    // it names the surface after what the surface holds.
    expect(ids).not.toContain('home');
    expect(ids).not.toContain('voice');

    const chats = SHIPPED_DEFAULT_MENU.groups.find((g) => g.id === 'chats');
    // Revision 15 renamed the LABEL to Collab; the id stays `chats` because
    // ids are the wire-stable half every resolver and upgrade guard keys on.
    expect(chats?.label).toBe('Collab');
    expect(chats?.items).toEqual([{ type: 'view', ref: 'dashboard' }]);
    // ONE item, and childless — the shape the railless rule keys on. A second
    // row here and the surface grows a third pane.
    expect(chats?.items).toHaveLength(1);
    expect(chats?.items[0]?.type === 'view' && chats.items[0].children).toBeUndefined();

    // Still a registered ref, and the FROZEN DTO still accepts the 12-era
    // arrangement — a space that wants its own Home group back can have one.
    expect(
      MenuConfigSchema.safeParse({
        schemaVersion: SHIPPED_DEFAULT_MENU.schemaVersion,
        revision: 1,
        groups: [
          { id: 'home', label: 'Home', items: [{ type: 'view', ref: 'dashboard' }] },
          { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
        ],
      }).success,
    ).toBe(true);
  });

  it('leaves feed, channels and inbox off the RAIL without dropping them from the union', () => {
    // The distinction this test exists to hold: a ref can be unrouted from the
    // rail without being deleted. `MenuViewRef` still carries all three, so the
    // menu editor can offer them and a deep link still resolves.
    //
    // INBOX re-left this list on 2026-08-14: its screen stays mounted and the
    // top-bar bell points at it — a rail row and a bell would be two doors in
    // the chrome for one destination.
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    // The VIEW refs are gone; `channels` the view ref is not the same thing as
    // `channel` the kind ref, which revision 11 put in the Chats group.
    for (const gone of ['feed', 'channels', 'inbox']) expect(refs).not.toContain(gone);
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toContain('channel');
  });

  it('names Messages as a VIEW ref, never as a kind row', () => {
    // Two independent mechanisms refuse `message` as a kind ref, and this test
    // pins BOTH the refusal and the alternative. The registry row is
    // `strategy: 'anchored'` with `slug: null`, so `isMenuEligibleKind` says no;
    // and the database's own twin (`internal.w2_normalize_menu_payload`)
    // rejects a `message` kind ref outright. A future edit that "simplifies"
    // Messages into a kind row would fail closed in the rail AND be refused at
    // the next menu write, so the view ref is not a preference — it is the only
    // door.
    expect(isMenuEligibleKind('message')).toBe(false);
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).not.toContain('message');
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    expect(refs).toContain('messages');
  });

  it('keeps depth at exactly ≤1 with Workspace as the one caret VIEW item', () => {
    // Revision 12: the Code caret retired with its group (R3) — the git view
    // is a plain Work row now, so Workspace is the only caret left.
    const carets = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .filter((item) => item.type === 'view' && (item.children?.length ?? 0) > 0);
    expect(carets.map((c) => c.ref)).toEqual(['workspace']);
    for (const caret of carets) {
      for (const child of caret.type === 'view' ? (caret.children ?? []) : []) {
        expect('children' in child).toBe(false);
      }
    }
  });

  it('gives every kind row an icon — the collapsed 48px rail needs one', () => {
    for (const ref of menuKindRefs(SHIPPED_DEFAULT_MENU)) {
      expect(getKind(ref).icon.length).toBeGreaterThan(0);
    }
  });

  it('omits R7-deferred features (they live in the palette, disabled)', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) =>
      g.items.flatMap((i) => [i.ref, ...(i.type === 'view' ? (i.children ?? []).map((c) => c.ref) : [])]),
    );
    // Graph left the deferred set 2026-07-29 (user ruling): the ◉ view ships
    // as a revision-2 menu row (GRAPH-VIEW-PLAN §2).
    for (const deferred of ['activity', 'leaderboard']) {
      expect(refs).not.toContain(deferred);
    }
    expect(refs).toContain('graph');
  });

  it('stamps a revision so a rendered menu is attributable', () => {
    expect(SHIPPED_DEFAULT_MENU_REVISION).toBe(15);
    expect(SHIPPED_DEFAULT_MENU.revision).toBe(SHIPPED_DEFAULT_MENU_REVISION);
  });
});

describe('menu-ref validation (WLT §2.3)', () => {
  it('accepts collection-strategy kinds only', () => {
    expect(isMenuEligibleKind('task')).toBe(true);
    expect(isMenuEligibleKind('work_session')).toBe(true);
    // channel became a collection kind on 2026-08-01, so it IS menu-eligible
    // now — the ruling put it in the Entity List Panel, and a kind the list can
    // show is a kind the menu could name. The shipped default does not name it
    // (the list panel is its home), which is a CONFIG choice, not a capability.
    expect(isMenuEligibleKind('channel')).toBe(true);
    // message stays ineligible: anchored, no k/ view, no slug.
    expect(isMenuEligibleKind('message')).toBe(false);
  });

  it('rejects an unknown ref instead of silently landing it on c:*', () => {
    // getKind() falls back so custom kinds work for free; menu validation must
    // NOT inherit that leniency, or a typo becomes an invisible Items row.
    expect(getKind('taskk').kind).toBe('c:*');
    expect(isMenuEligibleKind('taskk')).toBe(false);
    // The `c:*` sentinel is the fallback ROW, not an addressable destination.
    expect(isMenuEligibleKind('c:*')).toBe(false);
    // A REAL custom kind is eligible — its slug is computed, so it addresses.
    expect(isMenuEligibleKind('c:incident')).toBe(true);
  });

  it('reports every unrenderable ref, including caret children', () => {
    // The cast is the POINT of this test, not a shortcut around the types.
    // `MenuKindRef` cannot express "a ref the server sent that this registry
    // cannot render" — that value is only ever produced at runtime, by a node
    // whose menu row names a kind this client does not have. A fixture that
    // typechecked would be testing a case the validator never meets.
    const broken = {
      schemaVersion: 1 as const,
      revision: 1,
      groups: [
        {
          id: 'g',
          label: 'G',
          items: [
            { type: 'kind' as const, ref: 'nope' },
            {
              type: 'view' as const,
              ref: 'workspace',
              children: [{ type: 'kind' as const, ref: 'message' }],
            },
          ],
        },
      ],
    } as unknown as MenuConfig;
    expect(unrenderableKindRefs(broken)).toEqual(['nope', 'message']);
  });
});
