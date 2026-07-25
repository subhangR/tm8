/**
 * KindRegistry completeness — the L1 law materialized as a test: every one of
 * the 11 kinds has a full entry (icon, tint, chip label, Z2 fields, Z3
 * content, Z4 variant, status, actions, creation schema or reason), and every
 * renderer actually renders against the seeded world.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  KIND_ORDER, KIND_REGISTRY, TOMBSTONE, creatableKinds, isTombstoned, kindCan,
  kindsWhere, paletteCreatableKinds, registryFor,
} from '../../registry';
import { REGISTRY_CTX } from '../../entity';
import type { EntityDetail, EntityKind } from '../../types/contract';
import { ALL_KINDS, createFacade, loadKindDetails, renderWith, resetStores } from './helpers';
import type { MockFacade } from '../../mock';

const FULL_LAYOUTS = ['reader', 'hub', 'subtree', 'profile', 'generic'];

let facade: MockFacade;
let details: Record<EntityKind, EntityDetail>;

beforeAll(async () => {
  facade = createFacade();
  details = await loadKindDetails(facade);
});

describe('KindRegistry completeness', () => {
  it('has exactly the 11 contract kinds, in a stable order', () => {
    expect(KIND_ORDER).toEqual(ALL_KINDS);
    expect(Object.keys(KIND_REGISTRY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it.each(ALL_KINDS)('%s: entry is fully populated and renders from seed', (kind) => {
    resetStores();
    const entry = registryFor(kind);
    const detail = details[kind];

    expect(entry.kind).toBe(kind);
    expect(entry.glyph.length).toBeGreaterThan(0);
    expect(entry.label.length).toBeGreaterThan(0);
    expect(entry.labelPlural.length).toBeGreaterThan(0);

    // tint + chip label functions produce usable values for the seeded entity
    expect(entry.tint(detail)).toMatch(/var\(|#|rgb/);
    expect(entry.chipLabel(detail).length).toBeGreaterThan(0);
    expect(typeof entry.chipPulse(detail)).toBe('boolean');
    // chipMeta is present (may return null)
    expect(entry.chipMeta(detail) === null || typeof entry.chipMeta(detail) === 'string').toBe(true);

    // Z2 + Z3 renderers mount without throwing
    const fields = renderWith(facade, <entry.SummaryFields entity={detail} ctx={REGISTRY_CTX} />);
    fields.unmount();
    const content = renderWith(facade, <entry.Content detail={detail} ctx={REGISTRY_CTX} />);
    content.unmount();

    // Z4 variant + status + actions + creation
    expect(FULL_LAYOUTS).toContain(entry.fullLayout);
    const status = entry.status.current(detail);
    if (status) {
      expect(status.label.length).toBeGreaterThan(0);
      expect(typeof status.tone).toBe('string');
    }
    expect(Array.isArray(entry.primaryActions(detail))).toBe(true);
    if (entry.creation) {
      expect(entry.creation.titleLabel.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.creation.fields)).toBe(true);
    } else {
      expect(entry.creationDisabledReason).toBeTruthy();
    }
  });

  it('task status options forbid direct done (completion goes through completeTask)', () => {
    const entry = registryFor('task');
    const options = entry.status.options!(details.task);
    const done = options.find((o) => o.value === 'done');
    expect(done?.disabled).toBe(true);
    expect(entry.status.set).toBeDefined();
  });

  it('tracked kinds (pull_request, commit) have no title editing; others that edit do', () => {
    expect(registryFor('pull_request').patchTitle).toBeNull();
    expect(registryFor('commit').patchTitle).toBeNull();
    expect(registryFor('task').patchTitle).toBeTruthy();
    expect(registryFor('doc').patchTitle).toBeTruthy();
  });

  it('capability flags answer the questions consumers used to branch on (DEF-7..11)', () => {
    // board drag = workStatus-bearing state (DEF-7/8)
    expect(kindsWhere('workStatusBearing')).toEqual(['task']);
    // mark-read anchors — the palette's old hardcoded allowlist, as data (DEF-11)
    expect(kindsWhere('markReadAnchor')).toEqual(['channel', 'task', 'doc']);
    // tree drag re-parenting (DEF-9)
    expect(kindsWhere('treeReparentable')).toEqual(['channel', 'task', 'doc', 'file', 'spell', 'skill']);
    expect(kindCan('message', 'treeReparentable')).toBe(false);
    // presence actor semantics
    expect(registryFor('member').capabilities.actor).toBe('human');
    expect(registryFor('team_member').capabilities.actor).toBe('agent');
    for (const kind of ALL_KINDS.filter((k) => k !== 'member' && k !== 'team_member')) {
      expect(registryFor(kind).capabilities.actor).toBeNull();
    }
  });

  it('create dispatch is registry data: createVia ⟺ creation, palette rows ⊆ creatable (DEF-10)', () => {
    for (const kind of ALL_KINDS) {
      const entry = registryFor(kind);
      expect(entry.createVia != null, `${kind}: createVia iff creation`).toBe(entry.creation != null);
      if (entry.paletteCreate) {
        expect(entry.createVia, `${kind}: paletteCreate requires createVia`).toBeTruthy();
        expect(entry.paletteCreate.keywords.length).toBeGreaterThan(0);
      }
    }
    expect(creatableKinds().map((e) => e.kind))
      .toEqual(['channel', 'task', 'team_member', 'doc', 'file', 'spell', 'skill', 'pull_request']);
    // matches the palette's quick-create rows today (no agents/PRs — required fields)
    expect(paletteCreatableKinds().map((e) => e.kind))
      .toEqual(['channel', 'task', 'doc', 'file', 'spell', 'skill']);
  });

  it('createVia actually creates through the canonical seam', async () => {
    const taskEntry = registryFor('task');
    const res = await taskEntry.createVia!(facade, {
      spaceId: facade.ids.space, title: 'created via registry dispatch',
    });
    expect(res.entity?.kind).toBe('task');
    expect(res.entity?.title).toBe('created via registry dispatch');

    const docEntry = registryFor('doc');
    const attached = await docEntry.createVia!(facade, {
      spaceId: facade.ids.space, title: 'registry doc',
      attachTo: { entityId: res.entity!.id, edgeType: 'attached_to' },
    });
    expect(attached.entity?.kind).toBe('doc');
  });

  it('collection empty hints exist for the kinds with teaching copy', () => {
    for (const kind of ['channel', 'task', 'member', 'team_member', 'doc', 'pull_request'] as const) {
      expect(registryFor(kind).collectionEmptyHint, `${kind} hint`).toBeTruthy();
    }
    expect(registryFor('message').collectionEmptyHint).toBeNull();
  });

  it('tombstone spec labels every kind', () => {
    for (const kind of ALL_KINDS) {
      expect(TOMBSTONE.label(kind)).toContain('deleted');
    }
    expect(isTombstoned({ ...details.task, deletedAt: '2026-07-25T12:00:00.000Z' })).toBe(true);
    expect(isTombstoned(details.task)).toBe(false);
  });
});
