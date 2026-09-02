/**
 * The shipped default and the fail-closed resolver (LLD §4.1).
 *
 * The default is validated against the CONTRACT's own zod schema, not against a
 * hand-written expectation: a shipped constant that the server would reject is
 * not a default, it is a latent bug with a friendly name.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MENU_WORKSPACE_KIND_SPINE, MenuConfigSchema } from '@tm8/contract';
import type { MenuConfig } from '@tm8/contract';
import { SHIPPED_DEFAULT_MENU, SHIPPED_DEFAULT_MENU_REVISION } from '../domain';
import { VIEW_PRESENTATION, isRaillessGroup, resolveMenu } from './menu-resolve';

describe('the shipped default menu', () => {
  it('satisfies the frozen MenuConfig DTO (contract zod, not a local guess)', () => {
    const parsed = MenuConfigSchema.safeParse(SHIPPED_DEFAULT_MENU);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.success).toBe(true);
  });

  it('encodes the shipped group spine — the revision-20 menu-backed tabs', () => {
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.label)).toEqual([
      // Revision 17 (2026-08-16, unified Home — task 01a00932): the Work and
      // Channels groups retired and the conversation tab is renamed HOME.
      // Home's screen lists chat threads OR any collection kind (the root
      // column + the screen's own icon rail), so a Work tab beside it was a
      // second door to every one of its lists, and Channels' contents await
      // the redesigned Collab surface (a later feature). The group id under
      // the Home label is still `chats` — ids are wire-stable, labels move.
      'Home',
      // Revision 19 (2026-08-16, migration 140 — task 01a00b46): WORK returns
      // second in the row, and it is the three-panel workspace itself. 17
      // retired a Work group that was a RAIL OF ROWS duplicating Home's
      // lists; this one holds the single childless `workspace` view, so what
      // the tab opens is a LAYOUT — side panel · center · side panel — that
      // Home has no equivalent for. The railless assertion below covers it.
      'Work',
      // Revision 18 (2026-08-16, Craft P1 — task 01a00a31): the blueprint
      // studio joins between Board and Graph, railless like both.
      'Craft',
      'Graph',
      // CodeBrain (2026-09-01, migration 173) — the first spine widening this
      // snapshot took after it was frozen. It is here because the shipped
      // default is pinned to the contract's DEFAULT_MENU_GROUP_SPINE, which
      // the server seeder answers to as well; a client default that omitted
      // the group would disagree with every seeded space.
      'CodeBrain',
      'Settings',
      'Help',
    ]);
  });

  it('draws NO rail on ANY shipped tab — every group is a railless single view', () => {
    // Home's surface draws its own icon rail inside the screen; the other
    // four are whole-centre views. A menu rail on any of them would be a
    // column holding one row repeating the tab's own name — what made
    // revision 13 retire the tab, solved by the shape rule instead.
    for (const group of SHIPPED_DEFAULT_MENU.groups) {
      expect(isRaillessGroup(group), group.id).toBe(true);
    }
    // The rule still answers false for a group with real rows — a
    // server-authored menu keeps its rail; this is a config, not a rule change.
    expect(
      isRaillessGroup({
        id: 'work',
        label: 'Work',
        items: [
          { type: 'view', ref: 'workspace', children: [{ type: 'kind', ref: 'task' }] },
          { type: 'kind', ref: 'project' },
        ],
      }),
    ).toBe(false);
  });

  it('keys railless on the SHAPE, so a Chats group with a second row draws a rail again', () => {
    // The guarantee is one childless view item, not the `dashboard` ref alone.
    // An operator who adds a row to this group has asked for a rail and gets
    // one, rather than silently losing the row they just added.
    expect(
      isRaillessGroup({
        id: 'chats',
        label: 'Chats',
        items: [
          { type: 'view', ref: 'dashboard' },
          { type: 'view', ref: 'feed' },
        ],
      }),
    ).toBe(false);
  });

  it('carries no caret items — the Workspace caret retired with the Work group', () => {
    const withChildren = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .filter((item) => item.type === 'view' && (item.children?.length ?? 0) > 0);
    expect(withChildren).toEqual([]);
    // RULING E's caret grammar survives for server-authored configs: a view
    // item with children still validates (the resolver walks it), so a space
    // that kept its Work group keeps its caret.
    expect(
      MenuConfigSchema.safeParse({
        schemaVersion: 1,
        revision: 1,
        groups: [
          {
            id: 'work',
            label: 'Work',
            items: [
              {
                type: 'view',
                ref: 'workspace',
                children: DEFAULT_MENU_WORKSPACE_KIND_SPINE.map((ref) => ({ type: 'kind', ref })),
              },
            ],
          },
          { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
        ],
      }).success,
    ).toBe(true);
  });

  it('omits deferred features entirely (R7-5: never rows in the shipped config)', () => {
    const refs = JSON.stringify(SHIPPED_DEFAULT_MENU);
    // Activity and Leaderboard surface as disabled PALETTE rows (§4.2), never
    // as menu rows — a menu row is a promise the app can navigate there.
    // Graph LEFT this list on 2026-07-29 (user ruling): the ◉ view ships
    // (GRAPH-VIEW-PLAN §2), so its row now keeps that promise.
    expect(refs).not.toContain('leaderboard');
    expect(refs).not.toContain('activity');
    expect(refs).toContain('"graph"');
  });

  it('always contains settings — the schema requires it and so does §4.1', () => {
    const refs = SHIPPED_DEFAULT_MENU.groups.flatMap((g) => g.items.map((i) => i.ref));
    expect(refs).toContain('settings');
  });

  it('gives every view ref in the closed union a label and a glyph (48px needs icons)', () => {
    for (const [ref, presentation] of Object.entries(VIEW_PRESENTATION)) {
      expect(presentation.label.length, ref).toBeGreaterThan(0);
      expect(presentation.icon.length, ref).toBeGreaterThan(0);
    }
    // 'files' added 2026-08-09 with the MenuViewRef widening (FILES-DESIGN
    // §5.3); `git` joined with the Git UI wave (additive widening, same R4
    // posture as `graph`). The union is closed, so this list is how a widening
    // announces itself rather than silently shipping a ref with no glyph.
    // `messages` joined 2026-08-13 (the cross-entity conversation browser),
    // same additive R4 widening as the two above. `board` joined 2026-08-16
    // (the task kanban tab), same posture; `craft` the same day (the
    // blueprint studio, Craft P1), same posture again. `help` joined
    // 2026-08-19 and entered the shipped spine in revision 20. `codebrain`
    // joined 2026-09-01 (migration 173) — the first widening this snapshot took
    // AFTER it was frozen as the 1.0 UI, and the one that proves the point of
    // gating it again: the union widened, four exhaustive tables here stopped
    // compiling, and nothing said so for three days because nothing looked.
    expect(Object.keys(VIEW_PRESENTATION).sort()).toEqual(
      ['board', 'channels', 'codebrain', 'craft', 'dashboard', 'feed', 'files', 'git', 'graph', 'help', 'inbox', 'messages', 'settings', 'workspace'].sort(),
    );
  });
});

describe('resolveMenu — fail-closed (LLD §4.1)', () => {
  const valid: MenuConfig = {
    schemaVersion: 1,
    revision: 7,
    groups: [{ id: 'only', label: 'Only', items: [{ type: 'view', ref: 'settings' }] }],
  };

  it('uses a valid server config as-is', () => {
    const resolved = resolveMenu(valid);
    expect(resolved.config).toBe(valid);
    expect(resolved.origin).toEqual({ source: 'server', revision: 7 });
  });

  it('falls back when menu() resolves null — C-4 covers BOTH 501 and a missing row', () => {
    const resolved = resolveMenu(null);
    expect(resolved.config).toBe(SHIPPED_DEFAULT_MENU);
    expect(resolved.origin).toEqual({ source: 'default', because: 'absent' });
  });

  it('falls back on a rejection, keeping the error code for the reason surface', () => {
    const resolved = resolveMenu(undefined, { code: 'not_implemented' });
    expect(resolved.config).toBe(SHIPPED_DEFAULT_MENU);
    expect(resolved.origin).toMatchObject({ because: 'unavailable', detail: 'not_implemented' });
  });

  it('falls back on an unsupported FUTURE schemaVersion, and says so', () => {
    const resolved = resolveMenu({ ...valid, schemaVersion: 2 } as unknown as MenuConfig);
    expect(resolved.config).toBe(SHIPPED_DEFAULT_MENU);
    expect(resolved.origin).toMatchObject({ because: 'future-version' });
  });

  it.each([
    ['no settings ref', { ...valid, groups: [{ id: 'g', label: 'G', items: [] }] }],
    ['duplicate group ids', {
      ...valid,
      groups: [
        { id: 'dup', label: 'A', items: [{ type: 'view', ref: 'settings' }] },
        { id: 'dup', label: 'B', items: [{ type: 'view', ref: 'feed' }] },
      ],
    }],
    ['duplicate refs', {
      ...valid,
      groups: [
        { id: 'a', label: 'A', items: [{ type: 'view', ref: 'settings' }] },
        { id: 'b', label: 'B', items: [{ type: 'view', ref: 'settings' }] },
      ],
    }],
    ['an illegal group id', {
      ...valid,
      groups: [{ id: 'Bad Id', label: 'B', items: [{ type: 'view', ref: 'settings' }] }],
    }],
    ['an empty label', {
      ...valid,
      groups: [{ id: 'g', label: '', items: [{ type: 'view', ref: 'settings' }] }],
    }],
    ['more than 8 groups', {
      ...valid,
      groups: Array.from({ length: 9 }, (_, i) => ({
        id: `g${i}`,
        label: `G${i}`,
        items: i === 0 ? [{ type: 'view', ref: 'settings' }] : [],
      })),
    }],
    ['children on a KIND item (R8-2: view items only)', {
      ...valid,
      groups: [{
        id: 'g',
        label: 'G',
        items: [
          { type: 'view', ref: 'settings' },
          { type: 'kind', ref: 'task', children: [{ type: 'kind', ref: 'doc' }] },
        ],
      }],
    }],
    ['nesting deeper than 1', {
      ...valid,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{
          type: 'view',
          ref: 'settings',
          children: [{ type: 'view', ref: 'feed', children: [{ type: 'kind', ref: 'task' }] }],
        }],
      }],
    }],
    ['more than 8 children', {
      ...valid,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{
          type: 'view',
          ref: 'settings',
          children: Array.from({ length: 9 }, (_, i) => ({ type: 'kind', ref: `k${i}` })),
        }],
      }],
    }],
    ['a non-object', 'not a menu'],
  ])('falls back on malformed-of-understood-version: %s', (_label, malformed) => {
    const resolved = resolveMenu(malformed as unknown as MenuConfig);
    expect(resolved.config).toBe(SHIPPED_DEFAULT_MENU);
    expect(resolved.origin).toMatchObject({ source: 'default' });
  });

  it('fails closed when a well-formed config names an UNRENDERABLE kind ref', () => {
    // The registry, not the rail, is the authority on what a kind ref means.
    // A typo is the dangerous case: `getKind` never throws, so without the
    // identity check in domain/ this config would render silently missing a row.
    const typo: MenuConfig = {
      schemaVersion: 1,
      revision: 3,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{ type: 'view', ref: 'settings' }, { type: 'kind', ref: 'taskk' } as never],
      }],
    };
    const resolved = resolveMenu(typo);
    expect(resolved.config).toBe(SHIPPED_DEFAULT_MENU);
    expect(resolved.origin).toMatchObject({ because: 'unrenderable-refs' });
    // The reason NAMES the offending ref — a fail-closed the operator can fix.
    expect((resolved.origin as { detail: string }).detail).toContain('taskk');
  });

  it('catches an unrenderable ref hiding in a CARET CHILD, not just a top-level item', () => {
    const buried: MenuConfig = {
      schemaVersion: 1,
      revision: 3,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{
          type: 'view',
          ref: 'settings',
          children: [{ type: 'kind', ref: 'not_a_kind' } as never],
        }],
      }],
    };
    expect(resolveMenu(buried).origin).toMatchObject({ because: 'unrenderable-refs' });
  });

  it('accepts a REAL custom kind while rejecting the c:* fallback row itself', () => {
    // `c:*` is the fallback ROW (slug null), not an addressable kind; a real
    // custom kind is collection-strategy and routes at `c-incident`.
    const withFallbackRow: MenuConfig = {
      schemaVersion: 1,
      revision: 3,
      groups: [{
        id: 'g',
        label: 'G',
        items: [{ type: 'view', ref: 'settings' }, { type: 'kind', ref: 'c:*' } as never],
      }],
    };
    expect(resolveMenu(withFallbackRow).origin).toMatchObject({ because: 'unrenderable-refs' });
  });

  it('THE SHIPPED DEFAULT ITSELF passes registry validation — no infinite fallback', () => {
    // If the default named an unrenderable kind, every fallback would produce a
    // config that itself fails the check. The floor has to stand on its own.
    const resolved = resolveMenu(SHIPPED_DEFAULT_MENU);
    expect(resolved.origin).toMatchObject({ source: 'server' });
  });

  it('never returns a config the rail cannot walk — the point of failing closed', () => {
    for (const input of [null, undefined, {}, { schemaVersion: 1 }, { schemaVersion: 99 }, 42]) {
      const resolved = resolveMenu(input as unknown as MenuConfig);
      expect(Array.isArray(resolved.config.groups)).toBe(true);
      expect(resolved.config.schemaVersion).toBe(1);
      expect(resolved.config.revision).toBeGreaterThan(0);
    }
    expect(SHIPPED_DEFAULT_MENU.revision).toBe(SHIPPED_DEFAULT_MENU_REVISION);
  });
});
