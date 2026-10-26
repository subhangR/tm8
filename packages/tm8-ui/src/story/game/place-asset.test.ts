import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { UNMAPPED_ASSET_KINDS } from '../model';
import { ASSET_OF_KIND, ASSET_SPECS, UNRESOLVED_KINDS } from './assets/registry';
import { assetMetrics } from './assets/prototypes';
import { HALF_BUILT_ENABLED, ROOT_SCALE, badgeText, badgesOf, placeAsset, placeState, roleOf, stateSubjectOf } from './place-asset';
import { buildWorld, type Place } from './world';

const world = buildWorld(STORY_FIXTURE);
const unresolved = new Set<string>(UNRESOLVED_KINDS);
const stress = buildWorld({ ...STORY_FIXTURE, page: { ...STORY_FIXTURE.page, nodes: [...STORY_FIXTURE.page.nodes, ...Array.from({ length: 120 }, (_, i) => ({ ...STORY_FIXTURE.page.nodes[1]!, id: `stress-${i}`, title: `Place ${i}` }))] } });

describe('place → asset', () => {
  it('maps every place of the fixture and of a 125-place world to a kit type or the unknown cairn', () => {
    for (const w of [world, stress]) {
      expect(w.places.length).toBeGreaterThan(0);
      for (const place of w.places) {
        const asset = placeAsset(place, w);
        expect(asset.type in ASSET_SPECS, `${place.id} → ${asset.type}`).toBe(true);
        if (asset.type === 'unknown-cairn') expect(place.kind in ASSET_OF_KIND).toBe(false);
        expect(ASSET_SPECS[asset.type].states).toContain(asset.state);
      }
    }
    expect(stress.places.length).toBeGreaterThanOrEqual(125);
  });
  it('falls back to the cairn only for kinds the registry does not map (its eight listed ones, plus any kind it never names)', () => {
    expect([...UNRESOLVED_KINDS].sort()).toEqual([...UNMAPPED_ASSET_KINDS].sort());
    for (const kind of UNRESOLVED_KINDS) expect(kind in ASSET_OF_KIND).toBe(false);
    const cairns = world.places.filter((p) => placeAsset(p, world).type === 'unknown-cairn');
    for (const p of cairns) expect(p.kind in ASSET_OF_KIND).toBe(false);
    // COVERAGE GAP (reported to the registry owner): the fixture's chat kind is neither mapped nor listed as unresolved.
    expect(cairns.map((p) => p.kind).filter((k) => !unresolved.has(k))).toEqual(cairns.map((p) => p.kind).filter((k) => !(k in ASSET_OF_KIND) && !unresolved.has(k)));
  });
  it('reads roles from the layout: hub, portal, landmarks by id, else node', () => {
    const hub = world.byId.get(world.hubId)!;
    expect(roleOf(hub, world)).toBe('hub');
    expect(placeAsset(hub, world).type).toBe('story-keep');
    const landmarks = world.places.filter((p) => p.members.length > 0);
    expect(landmarks.length).toBeGreaterThan(0);
    for (const l of landmarks) {
      expect(['library', 'codeFactory']).toContain(roleOf(l, world));
      const asset = placeAsset(l, world);
      expect(['story-library', 'story-code-factory']).toContain(asset.type);
      expect(asset.count).toBe(l.members.length);
      expect(asset.state).toBe(l.live ? 'working' : 'done');
    }
    const portal = world.places.find((p) => p.portal);
    if (portal) expect(placeAsset(portal, world).type).toBe('story-gate');
  });
  it('keeps W1\'s tone/live reading of status when building the registry subject', () => {
    const base = { tone: null, status: null, pendingAttention: null, hasWorker: false, live: false } as const;
    expect(stateSubjectOf({ ...base, tone: 'done' }).statusCategory).toBe('done');
    expect(stateSubjectOf({ ...base, tone: 'working' }).statusCategory).toBe('in_progress');
    expect(stateSubjectOf({ ...base, tone: 'todo' }).statusCategory).toBe('to_do');
    expect(stateSubjectOf({ ...base, tone: 'blocked' })).toMatchObject({ statusCategory: 'to_do', blocked: true });
    expect(stateSubjectOf({ ...base, status: 'cancelled' }).statusCategory).toBe('cancelled');
    expect(stateSubjectOf(base).statusCategory).toBeNull();
    expect(stateSubjectOf({ ...base, pendingAttention: 2 }).waiting).toBe(true);
    expect(stateSubjectOf({ ...base, live: true }).hasWorker).toBe(true);
  });
  it('holds the half-built variant off until the owner decides, drawing planned work as built', () => {
    expect(HALF_BUILT_ENABLED).toBe(false);
    const planned = { statusCategory: 'to_do', blocked: false, waiting: false, hasWorker: false } as const;
    expect(placeState('task-workshop', planned)).toBe('working');
    expect(placeState('story-keep', planned)).toBe('working');
    expect(placeState('task-workshop', { ...planned, statusCategory: 'done' })).toBe('done');
    expect(placeState('task-workshop', { ...planned, blocked: true })).toBe('blocked');
    expect(placeState('task-workshop', { ...planned, waiting: true })).toBe('waiting');
  });
  it('sizes roots up and gives a live session an empty plot while a finished one stands a stele', () => {
    const root = world.places.find((p) => p.root && p.ring > 0);
    if (root) expect(placeAsset(root, world).scale).toBe(ROOT_SCALE);
    const sessions = world.places.filter((p) => placeAsset(p, world).type === 'session-robot' || placeAsset(p, world).type === 'session-stele');
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(placeAsset(s, world).type).toBe(s.live ? 'session-robot' : 'session-stele');
  });
});

describe('count badges', () => {
  it('places a task\'s Library and Mailbox counts at the attachments\' own anchors, and ≈ for bounded counts', () => {
    const task = world.places.find((p) => p.attachments !== null)!;
    const loaded: Place = { ...task, attachments: { library: { count: 3, memberIds: ['a', 'b', 'c'] }, mailbox: { count: 7, approx: true } }, pendingAttention: 0 };
    const badges = badgesOf({ ...world, places: [loaded] });
    const lib = badges.find((b) => b.kind === 'library')!, mail = badges.find((b) => b.kind === 'mailbox')!;
    const m = assetMetrics('task-workshop'), s = placeAsset(loaded, world).scale;
    expect(badgeText(lib)).toBe('3');
    expect(badgeText(mail)).toBe('≈7');
    expect(lib.x).toBeCloseTo(task.x + (m.attachments.taskLibrary!.x + assetMetrics('task-library').badgeAnchor!.x) * s);
    expect(mail.z).toBeCloseTo(task.z + (m.attachments.mailbox!.z + assetMetrics('task-mailbox').badgeAnchor!.z) * s);
    expect(mail.y).toBeGreaterThan(0);
    expect(badges.map((b) => b.id)).toEqual([`${task.id}/library`, `${task.id}/mailbox`]);
  });
  it('invents nothing: zero counts and null attachments yield no badge', () => {
    const task = world.places.find((p) => p.attachments !== null)!;
    expect(badgesOf({ ...world, places: [{ ...task, attachments: { library: { count: 0, memberIds: [] }, mailbox: { count: 0, approx: false } }, pendingAttention: null }] })).toEqual([]);
    expect(badgesOf({ ...world, places: [{ ...task, attachments: null, pendingAttention: 0 }] })).toEqual([]);
  });
  it('shows member counts on the landmarks and pending attention above the asset', () => {
    const badges = badgesOf(world);
    const members = badges.filter((b) => b.kind === 'members');
    expect(members.length).toBe(world.places.filter((p) => p.members.length > 0).length);
    for (const b of members) expect(b.count).toBe(world.byId.get(b.placeId)!.members.length);
    const waiting = world.places.find((p) => (p.pendingAttention ?? 0) > 0);
    if (waiting) {
      const b = badges.find((x) => x.kind === 'attention' && x.placeId === waiting.id)!;
      expect(b.count).toBe(waiting.pendingAttention);
      expect(b.y).toBeGreaterThan(1);
    }
    for (const b of badges) expect([b.x, b.y, b.z].every(Number.isFinite)).toBe(true);
  });
});
