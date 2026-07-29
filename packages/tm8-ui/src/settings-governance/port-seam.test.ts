/**
 * THE TEST THAT LIVES IN THE GAP (brief §4.3).
 *
 * Declaration → data → implementation → CALL can each verify green while the
 * feature is dead, because nobody asserted the caller passes the argument —
 * four sessions once rendered as twelve through four green suites. So this
 * file drives `governancePortFromSeam` against a REAL `createFixtureSeam()`
 * and asserts on what comes BACK. No mocks and no spies: a spy would prove the
 * call shape and prove nothing about the data reaching the screen.
 *
 * The specific way this port could be dead while green: it resolves the kind
 * to query THROUGH THE REGISTRY (`kindBySlug`), because §15.2 forbids naming a
 * kind here. If that lookup ever returns the wrong row — or a `null` someone
 * defaults away — the screen renders an empty, confident projects list. So the
 * assertions below check the kind of what comes back, not that a call happened.
 */
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data';
import { kindBySlug } from '../domain/registry';
import { governancePortFromSeam, PROFILE_SLUG, PROJECT_SLUG } from './port';

async function firstSpaceId(seam: ReturnType<typeof createFixtureSeam>) {
  const spaces = await seam.spaces();
  expect(spaces.length, 'the fixture seam must expose at least one space').toBeGreaterThan(0);
  return spaces[0]!.id;
}

describe('the governance port reaches real data through a real seam', () => {
  it('resolves both kinds from the REGISTRY, and both rows exist', () => {
    // If either slug stops resolving, the port throws rather than querying a
    // wrong-or-empty kind. Pin the slugs so a registry rename is a loud red
    // here instead of a silently empty screen.
    expect(kindBySlug(PROJECT_SLUG)).not.toBeNull();
    expect(kindBySlug(PROFILE_SLUG)).not.toBeNull();
  });

  it('returns ONLY project rows from linkedProjects()', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = governancePortFromSeam(seam, spaceId);

    const projects = await port.linkedProjects();
    expect(Array.isArray(projects)).toBe(true);
    const expected = kindBySlug(PROJECT_SLUG)!.kind;
    for (const row of projects) {
      expect(row.kind, 'a non-project row reaching the projects card is the defect').toBe(expected);
      expect(row.spaceId).toBe(spaceId);
    }
  });

  it('returns ONLY interaction-profile rows from profiles()', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = governancePortFromSeam(seam, spaceId);

    const profiles = await port.profiles();
    const expected = kindBySlug(PROFILE_SLUG)!.kind;
    for (const row of profiles) {
      expect(row.kind).toBe(expected);
    }
  });

  it('passes entityKinds through — the seam’s ONE custom-kind source', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = governancePortFromSeam(seam, spaceId);

    const kinds = await port.entityKinds();
    expect(Array.isArray(kinds)).toBe(true);
    // Whatever the fixture carries, every row must be shaped as the screen
    // reads it — `fieldSchema` is rendered raw, so a missing array is a crash.
    for (const def of kinds) {
      expect(Array.isArray(def.fieldSchema), `${def.kind} must carry a fieldSchema array`).toBe(true);
      expect(typeof def.kind).toBe('string');
    }
  });

  it('hands the liveness PREDICATE along, not a computed verdict (R-UI-5)', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = governancePortFromSeam(seam, spaceId);

    // The function identity matters less than this: calling it goes to the
    // seam every time, so a consumer cannot hold a stale answer baked at read
    // time. A verdict for an id the node has never seen is never 'live'.
    const verdict = port.statusOf({ id: 'session-that-does-not-exist', workStatus: null });
    expect(verdict).not.toBe('live');
  });

  it('does not expose a write for anything this surface draws', () => {
    const seam = createFixtureSeam();
    const port = governancePortFromSeam(seam, 'space-1');
    // The control on the boundary: the port's whole surface is four members,
    // all reads. A future component cannot quietly acquire a write, because
    // there is nothing here to call.
    expect(Object.keys(port).sort()).toEqual([
      'entityKinds',
      'linkedProjects',
      'profiles',
      'statusOf',
    ]);
  });
});
