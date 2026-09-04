import { describe, expect, it } from 'vitest';

import type { EntitySummary } from '@tm8/contract';

import { deriveSpine, phaseState, runProgress, type CodeBrainPhase } from './spine.js';

function member(id: string, title: string, position: number): EntitySummary {
  /* `title` is the summary's display field — the first draft of this helper
     built `name`, which the sort silently read as undefined and rendered every
     row as "(unnamed)". These tests are what caught it. */
  return { id, title, kind: 'team_member', position } as unknown as EntitySummary;
}

function phase(over: Partial<CodeBrainPhase> = {}): CodeBrainPhase {
  return { id: 'p', name: 'P', live: 0, reported: false, ...over };
}

describe('phaseState', () => {
  it('ranks a REPORTED phase above a live one — the release race', () => {
    // The conductor releases a session AFTER the report lands, so a finished
    // phase is briefly both. If `live` won, the phase would flicker back to
    // "running" at the exact moment it completed. Inverting the two lines in
    // `phaseState` fails HERE and nowhere else, which is the point of the test.
    expect(phaseState(phase({ reported: true, live: 1 }))).toBe('reported');
  });

  it('is running only while a session is open and nothing has been reported', () => {
    expect(phaseState(phase({ live: 2 }))).toBe('running');
  });

  it('is idle with no session and no report', () => {
    expect(phaseState(phase())).toBe('idle');
  });
});

describe('deriveSpine', () => {
  it('orders by the graph position, NOT by the order the query returned', () => {
    // The query is handed back deliberately shuffled: a collection read is not
    // required to be stable, and a pipeline drawn in arrival order would lie
    // about which phase precedes which.
    const spine = deriveSpine(
      [member('c', 'REVIEW', 2), member('a', 'TRIAGE', 0), member('b', 'BUILD', 1)],
      new Map(),
      new Set(),
    );
    expect(spine.map((p) => p.name)).toEqual(['TRIAGE', 'BUILD', 'REVIEW']);
  });

  it('breaks a position TIE by title, so the order is total and not left to sort stability', () => {
    // Two members can share a position — nothing in the graph forbids it — and
    // `Array.prototype.sort` is only stable with respect to the INPUT order,
    // which a collection read does not guarantee. Without the tiebreak these
    // two would swap between reads for no reason a viewer could see.
    const spine = deriveSpine(
      [member('z', 'ZEBRA', 1), member('a', 'TRIAGE', 0), member('m', 'MOOSE', 1)],
      new Map(),
      new Set(),
    );
    expect(spine.map((p) => p.name)).toEqual(['TRIAGE', 'MOOSE', 'ZEBRA']);
  });

  it('attaches live counts and reports to the right member', () => {
    const spine = deriveSpine(
      [member('a', 'TRIAGE', 0), member('b', 'BUILD', 1)],
      new Map([['b', 3]]),
      new Set(['a']),
    );
    expect(spine).toEqual([
      { id: 'a', name: 'TRIAGE', live: 0, reported: true },
      { id: 'b', name: 'BUILD', live: 3, reported: false },
    ]);
  });

  it('survives a member with no title rather than rendering undefined', () => {
    const spine = deriveSpine([member('a', '' as unknown as string, 0)], new Map(), new Set());
    expect(spine[0]!.name).toBe('(unnamed)');
  });
});

describe('runProgress', () => {
  it('counts reported as done and open-and-unreported as running', () => {
    expect(
      runProgress([
        phase({ id: 'a', reported: true, live: 1 }),
        phase({ id: 'b', live: 2 }),
        phase({ id: 'c' }),
      ]),
    ).toEqual({ done: 1, total: 3, running: 1 });
  });

  it('is 0/0 for an empty roster instead of dividing by zero downstream', () => {
    expect(runProgress([])).toEqual({ done: 0, total: 0, running: 0 });
  });
});
