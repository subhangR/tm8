/**
 * The shipped default menu, validated against the registry (LLD §4.1, WLT §2.3).
 *
 * The constant is a fail-closed floor: if IT is wrong, every broken-config path
 * lands on a broken menu, which is the one failure the fallback exists to
 * prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU_GROUP_SPINE,
  DEFAULT_MENU_LIBRARY_SPINE,
  DEFAULT_MENU_WORKSPACE_KIND_SPINE,
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
    // The ordered Workspace spine is the second shared parity pin: the client
    // fallback and SQL seeder each prove their hand-written copy against it.
    // Revisions 4 and 6 added memory/artifact and channel; revision 7 adds Loop.
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toEqual([
      ...DEFAULT_MENU_WORKSPACE_KIND_SPINE,
      'file',
      'spell',
      'collection',
      'project',
      'pull_request',
      'worktree',
      'member',
    ]);
    expect(DEFAULT_MENU_WORKSPACE_KIND_SPINE).toHaveLength(8);
  });

  it('ships Files, Spells and Collections as first-class Library rows', () => {
    const library = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'library');
    expect(library).toEqual({
      id: 'library',
      label: 'Library',
      items: DEFAULT_MENU_LIBRARY_SPINE,
    });
  });

  it('always contains settings (the fail-closed floor)', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    expect(refs).toContain('settings');
  });

  /**
   * Revision 5 (user ruling 2026-08-01): channels left the rail for the Entity
   * List Panel, and Feed and Inbox left it too, so Home is Dashboard alone.
   * Both halves are asserted — a surviving `channels` row would be a rail
   * destination competing with the list panel for the same kind, which is the
   * two-divergent-homes shape the voice row's docblock already warned about.
   */
  it('puts Dashboard, Messages and Inbox in Home and keeps NO Channels group', () => {
    // Revision 10 (2026-08-13): Home stopped being Dashboard alone. Messages
    // is a NEW view ref (the cross-entity conversation browser) and Inbox is an
    // OLD one whose finished screen had never been mounted — see the constant's
    // docblock for why both belong here and why neither is a kind row.
    const home = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'home');
    expect(home?.items).toEqual([
      { type: 'view', ref: 'dashboard' },
      { type: 'view', ref: 'messages' },
      { type: 'view', ref: 'inbox' },
    ]);
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).not.toContain('channels');
  });

  it('leaves feed and channels off the RAIL without dropping them from the union', () => {
    // The distinction this test exists to hold: a ref can be unrouted from the
    // rail without being deleted. `MenuViewRef` still carries both, so the menu
    // editor can offer them and a deep link still resolves. Channels moved to
    // the Entity List Panel — see the registry row's `strategy: 'collection'`.
    //
    // INBOX LEFT THIS LIST on 2026-08-13. It was never unbuilt — the screen sat
    // finished and unmounted in `src/inbox/` while the rail simply never named
    // it. Revision 10 points at it, so `feed` is now the only free view ref.
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    // The VIEW refs are gone; `channels` the view ref is not the same thing as
    // `channel` the kind ref, which revision 6 put under the Workspace caret.
    for (const gone of ['feed', 'channels']) expect(refs).not.toContain(gone);
    expect(refs).toContain('inbox');
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
    const carets = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .filter((item) => item.type === 'view' && (item.children?.length ?? 0) > 0);
    expect(carets).toHaveLength(1);
    expect(carets[0].ref).toBe('workspace');
    for (const child of carets[0].type === 'view' ? (carets[0].children ?? []) : []) {
      expect('children' in child).toBe(false);
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
    expect(SHIPPED_DEFAULT_MENU_REVISION).toBe(10);
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
