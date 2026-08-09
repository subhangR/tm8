/**
 * The shipped default and the fail-closed resolver (LLD §4.1).
 *
 * The default is validated against the CONTRACT's own zod schema, not against a
 * hand-written expectation: a shipped constant that the server would reject is
 * not a default, it is a latent bug with a friendly name.
 */
import { describe, expect, it } from 'vitest';
import { MenuConfigSchema } from '@tm8/contract';
import type { MenuConfig } from '@tm8/contract';
import { SHIPPED_DEFAULT_MENU, SHIPPED_DEFAULT_MENU_REVISION } from '../domain';
import { VIEW_PRESENTATION, resolveMenu } from './menu-resolve';

describe('the shipped default menu', () => {
  it('satisfies the frozen MenuConfig DTO (contract zod, not a local guess)', () => {
    const parsed = MenuConfigSchema.safeParse(SHIPPED_DEFAULT_MENU);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.success).toBe(true);
  });

  it('encodes the WLT §2 diagram: Home · Workspace · Tracking · Collab · Voice · Settings', () => {
    expect(SHIPPED_DEFAULT_MENU.groups.map((g) => g.label)).toEqual([
      'Home',
      'Workspace',
      'Tracking',
      'Collab',
      // Revision 5 (2026-08-01) — the Channels label is GONE: channels moved
      // into Home, where the dynamic group now hangs their rows. Voice keeps
      // its own label because there is no `voice` MenuViewRef to move.
      'Voice',
      'Settings',
    ]);
  });

  it('makes Workspace the ONE caret view item, with its seven leaves (RULING E)', () => {
    const workspace = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .find((item) => item.ref === 'workspace');
    expect(workspace?.type).toBe('view');
    const children = workspace?.type === 'view' ? workspace.children ?? [] : [];
    // Revision 4 (2026-07-31): memory + artifact joined the caret.
    // Revision 6 (2026-08-01): channel joined it, beside doc — it became a
    // collection kind and was the only one the rail never named. Cap is 8.
    expect(children.map((c) => c.ref)).toEqual([
      'task', 'work_session', 'doc', 'channel', 'team_member', 'memory', 'artifact',
    ]);
  });

  it('is the only item with children — depth is exactly ≤1', () => {
    const withChildren = SHIPPED_DEFAULT_MENU.groups
      .flatMap((g) => g.items)
      .filter((item) => item.type === 'view' && (item.children?.length ?? 0) > 0);
    expect(withChildren).toHaveLength(1);
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
    // `git` joined the closed union with the Git UI wave (additive widening,
    // same R4 posture as `graph`).
    expect(Object.keys(VIEW_PRESENTATION).sort()).toEqual(
      ['channels', 'dashboard', 'feed', 'git', 'graph', 'inbox', 'settings', 'workspace'].sort(),
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
