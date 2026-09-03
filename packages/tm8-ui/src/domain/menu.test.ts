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

  it('encodes the revision-20 tab row, pinned to the contract spine', () => {
    // DEFAULT_MENU_GROUP_SPINE is the ONE truth this default and the server
    // seeder (db/migrations/140, tested by
    // packages/server/test/db/menu-seeder-parity.pg.test.ts) are both pinned
    // to. Before the spine existed the two carried unjoined hand-copies, and
    // migration 059 dropped the voice group with every suite green — the
    // stable deployment caught it. A group change now edits the spine, where
    // BOTH parity tests see it.
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.id)).toEqual(
      DEFAULT_MENU_GROUP_SPINE.map((g) => g.clientId),
    );
  });

  it('names EXACTLY ONE kind row — `chat`, and only because of what its tab is', () => {
    // Revision 17: the Work and Channels groups retired, and with them every
    // kind row the menu carried. The kinds did not lose their door — Home's
    // root column and icon rail (domain/home-rail.ts) list every collection
    // kind the registry offers, which is strictly MORE than the menu's frozen
    // caps could ever name. A kind row reappearing here would be a second
    // door beside a complete one.
    /*
     * REVISION 22 AMENDS THIS RULE, AND THE AMENDMENT IS NARROW.
     *
     * 17's law was "no kind rows", on the reasoning that Home's root column
     * lists every collection kind the registry offers, so a menu row for one
     * of them was a second door to a list Home already owns. That reasoning is
     * intact and it is why this stays an exact-equality assertion rather than
     * being relaxed to a subset: a second kind row landing here is still the
     * defect 17 named.
     *
     * `chat` is admitted because the door it opens is NOT the one Home owns.
     * Home's chats root is the two-pane CONVERSATION surface — a thread column
     * and a transcript. This tab is the entity LIST: tiles with the queue's
     * status pill, the four lifecycle tabs, sort, in-panel search and the row
     * action cluster, opening a panel whose body is that same conversation.
     * That is a different arrangement over the same rows, which is exactly the
     * R9 two-doors posture the Board tab already sets against `task`.
     *
     * A VIEW REF WAS NOT AVAILABLE, and that is the other half of the reason.
     * The Board precedent is a `board` MenuViewRef, and there is no `chats`
     * view: adding one means widening the contract's closed `MenuViewRef`
     * union AND a `menu_view_registry` row AND its check constraint — three
     * server-side edits to reach a screen the kind list already renders.
     */
    expect(menuKindRefs(SHIPPED_DEFAULT_MENU)).toEqual(['chat']);
    // Revision 19 (migration 140): a WORK group returns, and the assertion
    // above is exactly why it can. What 17 retired was a rail of ROWS — the
    // Workspace caret with its eight kinds, the three dev kinds, git — and
    // every one of those was a kind door Home already owned. The group that
    // came back carries NO kind rows at all: one childless `workspace` VIEW,
    // which is the three-panel split pane, a layout Home does not offer.
    // So `work` and `workspace` leave the retired lists below while the
    // no-kind-rows rule that motivated 17 stays fully intact.
    const ids = SHIPPED_DEFAULT_MENU.groups.map((g) => g.id);
    for (const gone of ['workspace', 'channels', 'library', 'code', 'voice']) {
      expect(ids).not.toContain(gone);
    }
    // …and the retired VIEW refs are unrouted from the rail, not deleted:
    // the frozen DTO still accepts a space putting any of them back.
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    for (const gone of ['git', 'messages', 'feed', 'inbox', 'channels']) {
      expect(refs).not.toContain(gone);
    }
    expect(
      MenuConfigSchema.safeParse({
        schemaVersion: SHIPPED_DEFAULT_MENU.schemaVersion,
        revision: 1,
        groups: [
          {
            id: 'work',
            label: 'Work',
            items: [
              { type: 'view', ref: 'workspace', children: [{ type: 'kind', ref: 'task' }] },
              { type: 'view', ref: 'git' },
            ],
          },
          { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
        ],
      }).success,
    ).toBe(true);
  });

  it('always contains settings (the fail-closed floor)', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    expect(refs).toContain('settings');
  });

  it('retires Files and legacy Board from the default without deleting their menu capability', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((group) => group.items.map((item) => item.ref));
    expect(refs).not.toContain('files');
    expect(refs).not.toContain('board');
    expect(refs.at(-1)).toBe('help');
    expect(
      MenuConfigSchema.safeParse({
        schemaVersion: 1,
        revision: 7,
        groups: [
          { id: 'legacy-board', label: 'My board', items: [{ type: 'view', ref: 'board' }] },
          { id: 'files', label: 'Files', items: [{ type: 'view', ref: 'files' }] },
          { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
        ],
      }).success,
    ).toBe(true);
  });

  /**
   * Revision 17 (task 01a00932): the tab is named HOME and the pair 14 pinned
   * — the group exists AND it is railless — still holds, now for a stronger
   * reason. The Home SCREEN carries its own icon rail (registry-derived,
   * entities only, views/HomeRail.tsx); a menu rail beside it would be a
   * second rail. The single-item shape is what `isRaillessGroup` keys on, and
   * it is asserted here as a SHAPE; that the shape means "no rail" is proven
   * in shell/menu-resolve.test.ts — domain/ does not borrow shell's predicate.
   */
  it('leads with a single-item Home group — the tab, with the screen owning its rail', () => {
    const ids = SHIPPED_DEFAULT_MENU.groups.map((g) => g.id);
    expect(ids[0]).toBe('chats');
    // `home` is NOT the id: ids are the wire-stable half every resolver and
    // upgrade guard keys on — 15 renamed the label to Collab, 17 to Home, and
    // the id never moved.
    expect(ids).not.toContain('home');

    const chats = SHIPPED_DEFAULT_MENU.groups.find((g) => g.id === 'chats');
    expect(chats?.label).toBe('Home');
    expect(chats?.items).toEqual([{ type: 'view', ref: 'dashboard' }]);
    // ONE item, and childless — the shape the railless rule keys on. A second
    // row here and the surface grows a third pane.
    expect(chats?.items).toHaveLength(1);
    expect(chats?.items[0]?.type === 'view' && chats.items[0].children).toBeUndefined();
  });

  it('keeps every shipped menu group as a railless single-view tab', () => {
    for (const [id, ref] of [
      // Revision 19: Work is the three-panel workspace, and it holds the
      // `workspace` VIEW alone. The childless single-item shape is the whole
      // guarantee — give this item the eight caret children the pre-134 group
      // carried and `isRaillessGroup` answers false, a menu rail appears left
      // of the split, and the tab draws FOUR columns instead of three.
      ['work', 'workspace'],
      ['craft', 'craft'],
      ['graph', 'graph'],
      ['settings', 'settings'],
      ['help', 'help'],
    ] as const) {
      const group = SHIPPED_DEFAULT_MENU.groups.find((g) => g.id === id);
      expect(group?.items).toEqual([{ type: 'view', ref }]);
    }
  });

  it('carries no caret items — depth is zero everywhere (the carets retired with Work)', () => {
    const carets = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .filter((item) => item.type === 'view' && (item.children?.length ?? 0) > 0);
    expect(carets).toEqual([]);
  });

  it('omits R7-deferred features (they live in the palette, disabled)', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) =>
      g.items.flatMap((i) => [i.ref, ...(i.type === 'view' ? (i.children ?? []).map((c) => c.ref) : [])]),
    );
    for (const deferred of ['activity', 'leaderboard']) {
      expect(refs).not.toContain(deferred);
    }
    expect(refs).toContain('graph');
  });

  it('stamps a revision so a rendered menu is attributable', () => {
    expect(SHIPPED_DEFAULT_MENU_REVISION).toBe(22);
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
