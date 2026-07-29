/**
 * THE TEST THAT LIVES IN THE GAP (brief §4.3).
 *
 * Four links — declaration, data, implementation, CALL — can each verify green
 * while the feature is dead, because nobody asserted the caller passes the
 * argument. Four sessions rendered as twelve through four green suites. So
 * this file drives `settingsPortFromSeam` against a REAL `createFixtureSeam()`
 * and asserts on what comes BACK. No mocks, no spies on the seam: a spy would
 * prove the call shape and prove nothing about the data reaching the panel.
 *
 * It also pins the two facts the whole surface rests on, both of which are
 * easy to believe wrongly:
 *   1. members are ENTITIES with the role on `state` — not a members DTO;
 *   2. `menu()` resolving null is the NORMAL path on fixtures, and the editor
 *      is therefore usually editing the shipped default.
 */
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data';
import { SHIPPED_DEFAULT_MENU } from '../domain';
import { memberKindRef, roleOf, settingsPortFromSeam } from './port';
import { draftConfig, isDirty, startDraft } from './menu-edit';

/** The fixture dataset's space id, read from the seam rather than assumed. */
async function firstSpaceId(seam: ReturnType<typeof createFixtureSeam>) {
  const spaces = await seam.spaces();
  expect(spaces.length, 'the fixture seam must expose at least one space').toBeGreaterThan(0);
  return spaces[0].id;
}

describe('the port reaches real data through a real seam', () => {
  it('resolves the space it was constructed for', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = settingsPortFromSeam(seam, spaceId);

    const space = await port.loadSpace();
    expect(space).not.toBeNull();
    expect(space!.id).toBe(spaceId);
    // The Profile section renders these four and nothing invented.
    expect(typeof space!.name).toBe('string');
    expect(typeof space!.memberCount).toBe('number');
    expect(typeof space!.createdAt).toBe('string');
  });

  it('resolves null — not a crash and not a fabricated space — for an unknown id', async () => {
    const seam = createFixtureSeam();
    const port = settingsPortFromSeam(seam, 'space-that-does-not-exist' as never);
    expect(await port.loadSpace()).toBeNull();
  });

  it('the members query returns MEMBER ENTITIES whose role rides on state', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const members = await settingsPortFromSeam(seam, spaceId).loadMembers();

    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(m.kind).toBe(memberKindRef());
      // THE assertion this file exists for: the caller passed the kind through
      // and the role survived the trip. A green `loadMembers` that returned
      // tasks would satisfy a length check and nothing here.
      expect(roleOf(m)).toBeTypeOf('string');
    }
  });

  it('resolves the viewer identity with its memberships', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const identity = await settingsPortFromSeam(seam, spaceId).loadIdentity();
    expect(identity.identityId).toBeTruthy();
    expect(Array.isArray(identity.memberships)).toBe(true);
  });

  it('resolves a menu the rail would render, and says where it came from', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const resolved = await settingsPortFromSeam(seam, spaceId).loadMenu();

    // Whatever the source, the editor must never open on a config the rail
    // would refuse — that is the state where every subsequent edit is moot.
    expect(['server', 'default']).toContain(resolved.origin.source);
    expect(resolved.config.schemaVersion).toBe(1);

    // And a freshly opened draft is CLEAN. An editor that reads dirty on open
    // would offer Save before the user did anything.
    const draft = startDraft(resolved.config);
    expect(isDirty(draft)).toBe(false);
    expect(draftConfig(draft).revision).toBe(resolved.config.revision);
  });

  it('on fixtures the menu is ABSENT, so the editor edits the shipped default', async () => {
    // Stated as an assertion rather than a comment, because it is the actual
    // Phase-1 experience of this screen and a reader would otherwise assume
    // the space has a stored menu. If the fixtures ever ship one, this goes
    // red and the handover sentence about it becomes wrong out loud.
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const resolved = await settingsPortFromSeam(seam, spaceId).loadMenu();
    expect(resolved.origin.source).toBe('default');
    expect(resolved.config).toEqual(SHIPPED_DEFAULT_MENU);
  });

  it('the member kind is resolved from registry DATA, and is unique', () => {
    // If a second member-role-tinted row is ever added, `memberKindRef` throws
    // rather than picking one. Asserted because a silently-wrong members list
    // is the failure mode this design chose loudness over.
    expect(() => memberKindRef()).not.toThrow();
    expect(memberKindRef()).toBeTypeOf('string');
  });
});
