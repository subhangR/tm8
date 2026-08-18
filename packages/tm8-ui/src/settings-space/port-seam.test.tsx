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

/**
 * W2 — the axis registry, round-tripped through the same real fixture seam.
 * Every assertion is on what comes BACK, and the refusal cases are the
 * fixture's mirrors of the node's own SQL refusals (016), which is what lets
 * a component test believe the words it renders.
 */
describe('the axis registry round-trips through the port', () => {
  it('reads the seeded `type` axis off the settings round trip', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const axes = await settingsPortFromSeam(seam, spaceId).loadAxes();

    const seeded = axes.find((a) => a.kind === 'default');
    expect(seeded).toBeDefined();
    expect(seeded!.name).toBe('type');
    expect(seeded!.axisValues).toEqual(['default', 'code', 'design', 'review', 'test']);
  });

  it('creates, reshapes, and deletes a manual axis — each write visible on the next read', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = settingsPortFromSeam(seam, spaceId);

    const created = await port.createAxis({ name: 'size', axisValues: ['s', 'm', 'l'], kind: 'manual', position: 1 });
    expect((await port.loadAxes()).map((a) => a.name)).toContain('size');

    await port.updateAxis(created.id, { name: 'scale', axisValues: ['s', 'm', 'l', 'xl'], kind: 'manual', position: 1 });
    const renamed = (await port.loadAxes()).find((a) => a.id === created.id);
    expect(renamed?.name).toBe('scale');
    expect(renamed?.axisValues).toContain('xl');

    await port.deleteAxis(created.id);
    expect((await port.loadAxes()).find((a) => a.id === created.id)).toBeUndefined();
  });

  it('refuses to delete the seeded default axis, in the node\u2019s own words', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = settingsPortFromSeam(seam, spaceId);
    const seeded = (await port.loadAxes()).find((a) => a.kind === 'default')!;

    await expect(port.deleteAxis(seeded.id)).rejects.toThrow('the default task axis cannot be deleted');
    // And the row SURVIVED the refusal.
    expect((await port.loadAxes()).some((a) => a.id === seeded.id)).toBe(true);
  });

  it('refuses to demote the seeded default axis to manual', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = settingsPortFromSeam(seam, spaceId);
    const seeded = (await port.loadAxes()).find((a) => a.kind === 'default')!;

    await expect(
      port.updateAxis(seeded.id, { name: seeded.name, axisValues: [...seeded.axisValues], kind: 'manual', position: seeded.position }),
    ).rejects.toThrow('the default task axis cannot be demoted');
  });

  it('refuses in-use rename and value-removal once a task carries the value, and names the tasks', async () => {
    const seam = createFixtureSeam();
    const spaceId = await firstSpaceId(seam);
    const port = settingsPortFromSeam(seam, spaceId);
    const seeded = (await port.loadAxes()).find((a) => a.kind === 'default')!;

    // Put a real value on a real task through the ordinary content patch —
    // the same write W1's picker performs.
    const tasks = await seam.query({ spaceId, kinds: ['task'] as never });
    const task = tasks.page.items.find((t) => t.deletedAt == null)!;
    const detail = await seam.entity(task.id);
    await seam.commands.patchEntity(task.id, {
      expectedVersion: detail.version,
      content: { axes: { [seeded.name]: seeded.axisValues[0] } },
    });

    await expect(
      port.updateAxis(seeded.id, { name: 'category', axisValues: [...seeded.axisValues], kind: 'default', position: seeded.position }),
    ).rejects.toThrow('cannot rename a task axis that tasks still use');

    await expect(
      port.updateAxis(seeded.id, { name: seeded.name, axisValues: seeded.axisValues.slice(1), kind: 'default', position: seeded.position }),
    ).rejects.toThrow('cannot remove a task axis value that tasks still use');

    // The actionable half of the refusal: the port can NAME the tasks that
    // hold a value, viewer-scoped, via the filters.axes clause.
    const using = await port.tasksUsingAxis(seeded);
    expect(using.map((t) => t.id)).toContain(task.id);
  });
});

/*
 * A `describe('the workflow registry round-trips through the port')` block
 * STOOD HERE — five cases over `loadWorkflows`/`upsertWorkflow`/`deleteWorkflow`
 * and the fixture's mirror of 132's structural-status constraint, duplicate
 * check and `tasks_validate_workflow` trigger.
 *
 * Phase 6 (migration 155) retired all of it: `public.task_workflows` was
 * dropped whole, the catalog ops `spaces.taskWorkflows.*` left the contract,
 * and the port verbs those cases exercised no longer exist. The cases were
 * DELETED rather than weakened because their subject is gone — a test that
 * still passed after this change would only be asserting about the fixture.
 *
 * The task-AXIS cases above SURVIVE and are not affected: axes remain for
 * honest tags (team, quarter); only the axis NAMED `type` died, as data,
 * re-homed into custom entity kinds that `extend` task.
 */
