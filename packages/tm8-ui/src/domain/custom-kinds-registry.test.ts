/**
 * A space's custom kinds join the registry at runtime (`registerCustomKinds`),
 * so every list built from `collectionKinds()` — the Home and Work rails, the
 * kind switchers, the mobile drawer — names them. Before this, a `c:*` kind
 * was reachable only by a hand-typed `k/c-{name}` address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectionKinds,
  customKindsVersion,
  getKind,
  kindBySlug,
  registerCustomKinds,
  subscribeCustomKinds,
} from './registry';
import { homeRailGroups, homeRootKinds, isHomeRootKind } from './home-rail';
import { CUSTOM_KIND_FALLBACK } from './types';

const NOW = '2026-10-14T00:00:00.000Z';
const def = (kind: string, icon: string | null = null) => ({
  id: kind, kind, origin: kind.startsWith('c:') ? 'custom' : 'core', spaceId: null,
  icon, fieldSchema: [], capabilities: {}, createdAt: NOW,
});

afterEach(() => registerCustomKinds([]));

describe('registerCustomKinds', () => {
  it('lists a registered custom kind in collectionKinds and on the Home rail', () => {
    expect(collectionKinds().some((k) => k.kind === 'c:instinct')).toBe(false);
    registerCustomKinds([def('c:instinct')]);
    const row = collectionKinds().find((k) => k.kind === 'c:instinct');
    expect(row).toMatchObject({ label: 'Instinct', labelPlural: 'Instincts', slug: 'c-instinct', strategy: 'collection' });
    expect(homeRootKinds().map((k) => k.kind)).toContain('c:instinct');
    expect(homeRailGroups().flatMap((g) => g.kinds.map((k) => k.kind))).toContain('c:instinct');
    expect(isHomeRootKind('c:instinct')).toBe(true);
  });

  it('resolves the custom row by kind and by slug, keeping the generic archetype', () => {
    registerCustomKinds([def('c:incident_report', '🚨')]);
    const row = getKind('c:incident_report');
    expect(row.kind).toBe('c:incident_report');
    expect(row.label).toBe('Incident report');
    expect(row.icon).toBe('🚨');
    expect(row.panel.archetype).toBe(getKind(CUSTOM_KIND_FALLBACK).panel.archetype);
    expect(kindBySlug('c-incident_report')?.kind).toBe('c:incident_report');
    // An unregistered custom kind still lands on the fallback row.
    expect(getKind('c:unknown').kind).toBe(CUSTOM_KIND_FALLBACK);
  });

  it('ignores core rows, the c:* sentinel and malformed names', () => {
    const before = collectionKinds().length;
    registerCustomKinds([def('task'), def(CUSTOM_KIND_FALLBACK), def('c:')]);
    expect(collectionKinds().length).toBe(before);
  });

  it('notifies subscribers only when the set changes', () => {
    let calls = 0;
    const off = subscribeCustomKinds(() => { calls += 1; });
    const v0 = customKindsVersion();
    registerCustomKinds([def('c:instinct')]);
    registerCustomKinds([def('c:instinct')]);
    expect(calls).toBe(1);
    expect(customKindsVersion()).toBe(v0 + 1);
    registerCustomKinds([]);
    expect(calls).toBe(2);
    off();
  });
});
