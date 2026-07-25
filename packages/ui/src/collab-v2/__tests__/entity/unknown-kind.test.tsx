/**
 * An unknown kind must DEGRADE, not crash.
 *
 * `registryFor` was a bare object index typed `=> KindEntry` that actually
 * returned `undefined`, and ~20 call sites dereference the result immediately.
 * So one unrecognised kind threw during render and — with no error boundary
 * anywhere — took the entire app to a white page.
 *
 * This is not hypothetical. The contract supports `c:*` CUSTOM kinds, which are
 * unknown to this registry BY DESIGN and can be created at runtime; it also bit
 * us with the core kinds tm8 added after the snapshot (`work_session`,
 * `collection`). Those two were patched by mutating the registry at boot, which
 * only works for kinds you can enumerate ahead of time. Custom kinds cannot be.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { registryFor, KIND_REGISTRY } from '../../registry';
import { EntityChip, EntityCard } from '../../entity';
import type { EntityKind, EntitySummary } from '../../types/contract';
import { createFacade, renderWith } from './helpers';

function summary(kind: string): EntitySummary {
  return {
    id: 'e_unknown',
    spaceId: 'spc',
    kind: kind as EntityKind,
    title: 'A thing of an unknown kind',
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-25T00:00:00.000Z',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Owner', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind } as unknown as EntitySummary['state'],
    badges: {},
  };
}

describe('registryFor — unknown kinds', () => {
  it('never returns undefined, for any string', () => {
    for (const kind of ['c:invoice', 'work_session', 'totally_made_up', '']) {
      const entry = registryFor(kind);
      expect(entry).toBeTruthy();
      // The fields the ~20 call sites dereference without checking.
      expect(typeof entry.glyph).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.tint).toBe('function');
      expect(typeof entry.status.current).toBe('function');
    }
  });

  it('still returns the REAL entry for a known kind', () => {
    expect(registryFor('task')).toBe(KIND_REGISTRY.task);
  });

  it('strips the c: namespace for the human label', () => {
    expect(registryFor('c:invoice').label).toBe('invoice');
  });

  it('claims no capabilities it cannot back up', () => {
    const entry = registryFor('c:invoice');
    // Guessing here would be worse than admitting ignorance: a fallback that
    // claimed `treeReparentable` would offer a drag that cannot work.
    expect(entry.capabilities).toEqual({
      workStatusBearing: false, treeReparentable: false, markReadAnchor: false, actor: null,
    });
    expect(entry.createVia).toBeNull();
    expect(entry.creation).toBeNull();
    expect(entry.status.current(summary('c:invoice'))).toBeNull();
    expect(entry.primaryActions({} as never)).toEqual([]);
  });
});

describe('a custom-kind entity renders instead of white-screening', () => {
  it('renders a chip', () => {
    renderWith(createFacade(), <EntityChip entity={summary('c:invoice')} />);
    expect(screen.getByText('A thing of an unknown kind')).toBeTruthy();
  });

  it('renders a card', () => {
    renderWith(createFacade(), <EntityCard entity={summary('c:invoice')} />);
    expect(screen.getByText('A thing of an unknown kind')).toBeTruthy();
  });
});
