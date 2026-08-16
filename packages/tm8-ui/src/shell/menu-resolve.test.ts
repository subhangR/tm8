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

  it('encodes the shipped group spine — the revision-14 tab row', () => {
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.label)).toEqual([
      // Revision 12 (2026-08-15, five-tab ruling + Files amendment): the
      // groups are the top-level tabs. Code retired into Work (R3);
      // Chats renamed Channels (R4); the File browser became its own tab.
      //
      // Revision 13 (later the same day, conversation-axis ruling): HOME NO
      // LONGER LEADS — the group was removed entirely.
      //
      // Revision 14 (user ruling, same day): a group leads the conversation
      // surface again, named CHATS. 13 left the brand mark as the only way
      // back to it; what 13 was actually right about — the redundant RAIL ROW
      // — is handled by `isRaillessGroup` instead, proven below. Note the row
      // reads its own label while the ref's presentation label is still Home:
      // the GROUP names the tab, the ref names nothing here.
      //
      // Revision 15 (2026-08-16): the label is COLLAB — a rename only, the
      // group id stays `chats`.
      //
      // Revision 16 (2026-08-16, Board tab wave): BOARD joins beside Work —
      // the task kanban as its own railless tab.
      'Collab',
      'Work',
      'Board',
      'Graph',
      'Channels',
      'Files',
      'Settings',
    ]);
  });

  it('draws NO rail on Chats — the two-pane guarantee, at the seam that decides it', () => {
    // The surface is conversation LIST | conversation. The list is drawn by
    // the screen inside its own pane, so a rail here would be a THIRD column
    // holding one row that repeats the tab's own name — which is precisely
    // what made revision 13 retire the tab. The rule is what lets 14 restore
    // the tab without restoring that column.
    const chats = SHIPPED_DEFAULT_MENU.groups.find((g) => g.id === 'chats');
    expect(chats).toBeTruthy();
    expect(isRaillessGroup(chats!)).toBe(true);

    // The other full-bleed screens keep their posture, and the groups with
    // real rows keep theirs — this is a widening, not a change of rule.
    for (const id of ['graph', 'settings', 'files', 'board']) {
      expect(isRaillessGroup(SHIPPED_DEFAULT_MENU.groups.find((g) => g.id === id)!), id).toBe(true);
    }
    for (const id of ['workspace', 'channels']) {
      expect(isRaillessGroup(SHIPPED_DEFAULT_MENU.groups.find((g) => g.id === id)!), id).toBe(false);
    }
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

  it('keeps Workspace as a caret view item with its eight leaves (RULING E)', () => {
    const workspace = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .find((item) => item.ref === 'workspace');
    expect(workspace?.type).toBe('view');
    const children = workspace?.type === 'view' ? workspace.children ?? [] : [];
    // Revision 11: channel left for the Chats group; file takes the freed
    // eighth slot (the Library fold).
    expect(children.map((c) => c.ref)).toEqual(DEFAULT_MENU_WORKSPACE_KIND_SPINE);
    expect(children).toHaveLength(8);
  });

  it('carries exactly one caret item — Workspace — depth exactly ≤1', () => {
    // Revision 12: the Code caret retired with its group (R3); the git view
    // is a plain childless Work row now (D1).
    const withChildren = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .filter((item) => item.type === 'view' && (item.children?.length ?? 0) > 0);
    expect(withChildren.map((item) => item.ref)).toEqual(['workspace']);
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
    // (the task kanban tab), same posture.
    expect(Object.keys(VIEW_PRESENTATION).sort()).toEqual(
      ['board', 'channels', 'dashboard', 'feed', 'files', 'git', 'graph', 'inbox', 'messages', 'settings', 'workspace'].sort(),
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
