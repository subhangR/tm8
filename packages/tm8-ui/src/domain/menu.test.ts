/**
 * The shipped default menu, validated against the registry (LLD §4.1, WLT §2.3).
 *
 * The constant is a fail-closed floor: if IT is wrong, every broken-config path
 * lands on a broken menu, which is the one failure the fallback exists to
 * prevent.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MENU_GROUP_SPINE, MenuConfigSchema, type MenuConfig } from '@tm8/contract';
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
    // seeder (db/migrations/061, tested by
    // packages/server/test/db/menu-seeder-parity.pg.test.ts) are both pinned
    // to. Before the spine existed the two carried unjoined hand-copies, and
    // migration 059 dropped the voice group with every suite green — the
    // stable deployment caught it. A group change now edits the spine, where
    // BOTH parity tests see it.
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).toEqual(
      DEFAULT_MENU_GROUP_SPINE.map((g) => g.clientId),
    );
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toEqual([
      'task',
      'work_session',
      'doc',
      // Revision 6 (2026-08-01): Channels joins the collection rows. The
      // contract's MenuKindRef un-excluded `channel` in the same change — it is
      // a collection kind with a real list now, so the rail can name it.
      'channel',
      'team_member',
      // Revision 4 (2026-07-31): Memories and Artifacts under the Workspace
      // caret, Worktrees beside the git-adjacent Tracking rows. All three
      // shipped with registry rows but no menu named them — unreachable
      // features, not deferred ones.
      'memory',
      'artifact',
      'project',
      'pull_request',
      'worktree',
      'member',
    ]);
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
  it('puts Home at Dashboard alone and keeps NO Channels group', () => {
    const home = SHIPPED_DEFAULT_MENU.groups.find((group) => group.id === 'home');
    expect(home?.items).toEqual([{ type: 'view', ref: 'dashboard' }]);
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).not.toContain('channels');
  });

  it('drops feed, inbox and channels from the RAIL, not from the union', () => {
    // The distinction this test exists to hold: the three are unrouted from
    // the rail, not deleted. `MenuViewRef` still carries all three, so the menu
    // editor can offer them and a deep link still resolves. Channels moved to
    // the Entity List Panel — see the registry row's `strategy: 'collection'`.
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    // The VIEW refs are gone; `channels` the view ref is not the same thing as
    // `channel` the kind ref, which revision 6 put under the Workspace caret.
    for (const gone of ['feed', 'inbox', 'channels']) expect(refs).not.toContain(gone);
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toContain('channel');
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
