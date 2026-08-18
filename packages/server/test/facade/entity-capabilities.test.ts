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
   * THE SET IS UNCHANGED. Every kind without a `tasks` row LEFT JOINs to a null
   * work status, which is the same answer the kind check gave — arrived at from
   * the row's own surface. A session is the case the phase-8 design named.
   */
  it('is false for every kind that carries no work status', () => {
    for (const kind of ['work_session', 'doc', 'channel', 'collection', 'member', 'message']) {
      expect({ kind, can: entityCapabilities(row({ kind, work_status: null })).canComplete })
        .toEqual({ kind, can: false });
    }
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
