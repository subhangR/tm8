/**
 * `canComplete` IS KEYED ON THE ROW'S COMPLETION SURFACE, NOT ON ITS KIND.
 *
 * It read `row.kind === 'task'` for as long as it had existed. That is a NAME
 * check standing in for a structural fact — "does this row carry a work status
 * to move to done" — and the name is the part that rots: a kind renamed, a kind
 * added, a kind whose completion arrives later all have to remember to edit
 * this one expression, and nothing says so when they do not.
 *
 * `work_status` is `public.tasks.work_status`, LEFT JOINed into `EntityRow`. It
 * is non-null exactly for rows that carry a work-status record, so the set is
 * unchanged today and the derivation is no longer a label. These tests hold BOTH
 * halves: the same answers as before, from the new key.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is widen completion to sessions or to any
 * other kind — a session row has no `tasks` row, so it has no work status and
 * the flag stays false. Category-based completion is a later phase.
 */
import { describe, expect, it } from 'vitest';
import { capabilitiesOf, entityCapabilities, type EntityRow } from '../../src/facade/entity-read.js';

const NOW = new Date('2026-08-18T00:00:00.000Z');

/**
 * The three fields the capability rule reads, and honestly only those: kind,
 * `deleted_at`, `work_status`. The cast is what a hundred-column row costs; the
 * alternative is transcribing every join's null into every case below, which
 * hides the three that matter.
 */
function row(overrides: Partial<EntityRow>): EntityRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    space_id: '00000000-0000-4000-8000-0000000000ff',
    kind: 'task',
    version: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    activity_at: NOW,
    work_status: 'open',
    ...overrides,
  } as EntityRow;
}

describe('canComplete asks what the row carries, not what it is called', () => {
  it('is true for a row with an unfinished work status', () => {
    expect(capabilitiesOf(row({ work_status: 'open' })).canComplete).toBe(true);
    expect(capabilitiesOf(row({ work_status: 'working' })).canComplete).toBe(true);
    expect(capabilitiesOf(row({ work_status: 'blocked' })).canComplete).toBe(true);
  });

  it('is false once the row is already done', () => {
    expect(capabilitiesOf(row({ work_status: 'done' })).canComplete).toBe(false);
  });

  /**
   * STILL FALSE FOR EVERY KIND WITH NO DOOR. Each of these LEFT JOINs to a null
   * work status and has nothing else to complete, so the flag stays false —
   * a capability is a promise that a door will answer, and inventing one for a
   * doc would be a promise nothing keeps.
   *
   * `work_session` LEFT THIS LIST on 2026-08-19. It was here for the right
   * reason at the time (the phase-8 design named it as the case the surface
   * check did not widen to), and it leaves for the same reason it was here:
   * the flag follows the door, and migration 156 gave sessions one.
   */
  it('is false for every kind that carries no work status and has no door', () => {
    for (const kind of ['doc', 'channel', 'collection', 'member', 'message']) {
      expect({ kind, can: entityCapabilities(row({ kind, work_status: null })).canComplete })
        .toEqual({ kind, can: false });
    }
  });

  /**
   * THE ONE WIDENING (user ruling 2026-08-19). A session has no `tasks` row and
   * never will — what it has is `public.set_session_done`, which files it under
   * Done without stopping the process.
   *
   * NO `!== 'done'` HERE, unlike the task arm: the session tick is a TOGGLE, so
   * the affordance has to be as available for un-ticking as for ticking. This
   * is the assertion that would fail if someone "tidied" the two arms into one
   * `status_category !== 'done'` test — which would also silently grant the
   * flag to every doc in the space.
   */
  it('is true for a work_session in EITHER direction — the tick toggles', () => {
    expect(
      entityCapabilities(row({ kind: 'work_session', work_status: null, status_category: 'in_progress' }))
        .canComplete,
    ).toBe(true);
    expect(
      entityCapabilities(row({ kind: 'work_session', work_status: null, status_category: 'done' }))
        .canComplete,
    ).toBe(true);
  });

  it('but not on an archived session — a tombstone completes nothing', () => {
    expect(
      entityCapabilities(row({ kind: 'work_session', work_status: null, deleted_at: NOW }))
        .canComplete,
    ).toBe(false);
  });

  /**
   * A ROW FIXTURE THAT OMITS THE COLUMN must not claim the affordance. This is
   * why the check is `typeof === 'string'` and not `!== null`: `undefined` slips
   * past a null check, and the caller most likely to omit it is a hand-built
   * row for a kind that has no work status in the first place.
   */
  it('is false when the column is absent rather than null', () => {
    const bare = row({ kind: 'doc' });
    delete (bare as { work_status?: unknown }).work_status;
    expect(capabilitiesOf(bare).canComplete).toBe(false);
  });

  it('is false on a tombstone, whatever its work status says', () => {
    expect(capabilitiesOf(row({ work_status: 'open', deleted_at: NOW })).canComplete).toBe(false);
  });
});
