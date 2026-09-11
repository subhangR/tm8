/**
 * The join, examined as a table: real session facts in, `HelperView` out.
 *
 * Two things are being asserted here and they are different in kind. One is the
 * MAPPING — that a `running` row with no live terminal does not read "Working
 * on it". The other is the SILENCE — that fields with no honest source are
 * omitted rather than filled, which is a claim about what is NOT in the output
 * and therefore needs its own tests.
 */
import { describe, expect, it } from 'vitest';
import type { EntityDetail } from '@tm8/contract';

import { crewViewFrom, roleFromTitle, type CrewEntityRead } from './crew-source';
import { crewSummaryOf } from './crew-model';
import { helperWordsOf, UNKNOWN_HELPER_WORDS } from './status-vocabulary';
import type { SessionLiveness } from '../../data/seam';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

function sessionId(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function session(id: string, status: string | null, title = 'Fixing the contact form'): CrewEntityRead {
  return {
    state: 'loaded',
    detail: {
      id,
      title,
      kind: 'work_session',
      state: { kind: 'work_session', status },
    } as unknown as EntityDetail,
  };
}

function fold(
  entries: readonly [string, CrewEntityRead][],
  liveness: Record<string, SessionLiveness>,
  confidence?: Record<string, 'reported' | 'guessed'>,
): ReturnType<typeof crewViewFrom> {
  return crewViewFrom({
    sessionIds: entries.map(([id]) => id),
    reads: new Map(entries),
    livenessOf: (s) => liveness[s.id] ?? 'unknown',
    ...(confidence ? { confidenceOf: (id: string) => confidence[id] ?? null } : {}),
    now: NOW,
  });
}

describe('crew-source: recorded status x liveness -> what a person is told', () => {
  it('running WITH a live terminal is the only thing that reads as working', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'running')]], { [id]: 'live' });
    expect(view.helpers[0]?.state).toBe('running');
    expect(helperWordsOf('running').label).toBe('Working on it');
  });

  it('running with NO live terminal does not claim work is happening', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'running')]], { [id]: 'stale' });
    // The ghost. `no_heartbeat` reports the observation ("nothing heard")
    // rather than the conclusion ("it failed"), and stays outstanding — a ghost
    // is someone's problem, not a finished job.
    expect(view.helpers[0]?.state).toBe('no_heartbeat');
    const words = helperWordsOf('no_heartbeat');
    expect(words.outstanding).toBe(true);
    expect(words.mayInterrupt).toBe(false);
  });

  it('running with liveness we cannot establish says exactly that', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'running')]], { [id]: 'unknown' });
    expect(helperWordsOf(view.helpers[0]?.state ?? '')).toBe(UNKNOWN_HELPER_WORDS);
    expect(UNKNOWN_HELPER_WORDS.label).toBe('Checking on this one');
  });

  it('idle NEVER becomes awaiting_input — the state that may interrupt', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'idle')]], { [id]: 'live' });
    const state = view.helpers[0]?.state ?? '';
    expect(state).not.toBe('awaiting_input');
    expect(state).toBe('no_heartbeat');
    // P4, restated as an assertion: nothing this fold produces may badge, nudge
    // or pull focus. `idle` is a silence timer, not a question — SpawnService's
    // own docstring says so, and a fold that read it as a question would
    // interrupt a person every time an agent paused to think.
    expect(helperWordsOf(state).mayInterrupt).toBe(false);
  });

  it('no state this fold can produce is allowed to interrupt', () => {
    const cases: [string, SessionLiveness][] = [
      ['spawning', 'live'], ['running', 'live'], ['running', 'stale'], ['running', 'unknown'],
      ['idle', 'live'], ['idle', 'stale'], ['idle', 'unknown'],
      ['exited', 'not-running'], ['failed', 'not-running'], ['something_new', 'unknown'],
    ];
    for (const [status, liveness] of cases) {
      const id = sessionId(1);
      const { view } = fold([[id, session(id, status)]], { [id]: liveness });
      expect(helperWordsOf(view.helpers[0]?.state ?? '').mayInterrupt).toBe(false);
    }
  });

  it('exited finishes, failed is stuck, an unknown status claims nothing', () => {
    const cases: [string | null, string][] = [
      ['spawning', 'spawning'],
      ['exited', 'completed'],
      ['failed', 'failed'],
      ['a_status_from_the_future', 'unknown'],
      [null, 'unknown'],
    ];
    for (const [status, expected] of cases) {
      const id = sessionId(1);
      const { view } = fold([[id, session(id, status)]], { [id]: 'not-running' });
      expect(view.helpers[0]?.state).toBe(expected);
    }
  });

  it('spawning does not consult liveness — there is nothing to be stale about', () => {
    for (const liveness of ['live', 'stale', 'unknown'] as SessionLiveness[]) {
      const id = sessionId(1);
      const { view } = fold([[id, session(id, 'spawning')]], { [id]: liveness });
      expect(view.helpers[0]?.state).toBe('spawning');
    }
  });
});

describe('crew-source: the fields with no source stay empty', () => {
  it('omits activity, progress, estimate and quietForMinutes entirely', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'running')]], { [id]: 'live' });
    const helper = view.helpers[0];
    // NOT `toBeNull` — absent, because an explicit null would suggest a source
    // exists and returned nothing. None does. #507 settled `progress`/
    // `estimate` permanently ("no, and there will not be one") and `activity`
    // waits on a tier nothing produces yet.
    expect(helper && 'activity' in helper).toBe(false);
    expect(helper && 'progress' in helper).toBe(false);
    expect(helper && 'quietForMinutes' in helper).toBe(false);
    expect('estimate' in view).toBe(false);
  });

  it('a quiet helper reads the vocabulary fallback, not a fabricated minute count', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'idle')]], { [id]: 'live' });
    const words = helperWordsOf(view.helpers[0]?.state ?? '', {
      quietForMinutes: view.helpers[0]?.quietForMinutes ?? null,
    });
    // The design's own absent-value rendering, reached by not supplying N —
    // rather than a plausible number invented at this layer.
    expect(words.label).toBe('Nothing heard for a while');
  });

  it('no progress track is drawn for a helper we have no number for', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'running')]], { [id]: 'live' });
    const summary = crewSummaryOf(view);
    // `indeterminate` — motion without an amount. Not `determinate`, which
    // would draw a bar at a position nothing established.
    expect(summary.rows[0]?.track).toBe('indeterminate');
    expect(summary.rows[0]?.progress).toBeNull();
  });
});

describe('crew-source: P1 is enforced here, not merely asserted downstream', () => {
  it('refuses a uuid-shaped title', () => {
    expect(roleFromTitle('01a028f6-5b26-77d6-bf6d-22cdca62a60b')).toBe('Helper');
    expect(roleFromTitle('session 01a028f6-5b26-77d6-bf6d-22cdca62a60b')).toBe('Helper');
  });

  it('refuses identifier-shaped and opaque-token titles', () => {
    // #509's self-critique named exactly this hole: "nothing stops a HOST from
    // passing role: 'session 01a028f6…', which would sail through every
    // assertion here". This file is that host.
    expect(roleFromTitle('awaiting_input')).toBe('Helper');
    expect(roleFromTitle('claude-code')).toBe('Helper');
    expect(roleFromTitle('deadbeefcafe1234')).toBe('Helper');
  });

  it('keeps a title a person wrote', () => {
    expect(roleFromTitle('Fixing the contact form')).toBe('Fixing the contact form');
    expect(roleFromTitle('  Drafter  ')).toBe('Drafter');
  });

  it('falls back to a neutral noun rather than to an id', () => {
    expect(roleFromTitle('')).toBe('Helper');
    expect(roleFromTitle(null)).toBe('Helper');
    // The rule the seam states: "there is no fallback to an id, because a
    // fallback to an id is how ids reach screens."
    expect(roleFromTitle(undefined)).not.toContain('0000');
  });

  it('truncates a long title on a word boundary', () => {
    const long = 'Wire the chat to live session state so that nobody waits thirty seconds';
    const role = roleFromTitle(long);
    expect(role.length).toBeLessThanOrEqual(48);
    expect(role.endsWith(' ')).toBe(false);
    expect(long.startsWith(role)).toBe(true);
  });

  it('no rendered field of a folded helper contains its session id', () => {
    const id = sessionId(1);
    const { view } = fold([[id, session(id, 'running')]], { [id]: 'live' });
    const summary = crewSummaryOf(view);
    const row = summary.rows[0];
    // `key` legitimately holds the id — it is the React key and the host's
    // correlation handle. Everything a person READS must not.
    expect(row?.key).toBe(id);
    expect(row?.role).not.toContain(id);
    expect(row?.monogram).not.toContain(id);
    expect(JSON.stringify(row?.words)).not.toContain(id);
    expect(summary.summaryLine).not.toContain(id);
    expect(summary.headline.text).not.toContain(id);
  });
});

describe('crew-source: what it reports rather than papers over', () => {
  it('names the sessions owed a next move (#509 P5)', () => {
    const stuck = sessionId(1);
    const fine = sessionId(2);
    const out = fold(
      [[stuck, session(stuck, 'failed')], [fine, session(fine, 'running')]],
      { [stuck]: 'not-running', [fine]: 'live' },
    );
    // #509: "the model computes actionGap ... and nothing ever shows it to
    // anyone. The UI quietly papers over a host that broke the rule." It no
    // longer happens invisibly.
    expect(out.actionGaps).toEqual([stuck]);
    expect(crewSummaryOf(out.view).rows[0]?.actionGap).toBe(true);
  });

  it('names the sessions whose state rests on no push at all (#507)', () => {
    const told = sessionId(1);
    const guessedAt = sessionId(2);
    const out = fold(
      [[told, session(told, 'running')], [guessedAt, session(guessedAt, 'running')]],
      { [told]: 'live', [guessedAt]: 'live' },
      { [told]: 'reported' },
    );
    // Both read "Working on it". Only one of them is a fact the node reported;
    // the other is a poll result up to 90 seconds old. A surface can now tell.
    expect(out.unverified).toEqual([guessedAt]);
  });

  it('treats every session as unverified when no confidence source is wired', () => {
    const id = sessionId(1);
    const out = fold([[id, session(id, 'running')]], { [id]: 'live' });
    // Absence of the seam is not evidence of provenance. Defaulting the other
    // way would let a host that never wired it claim everything was reported.
    expect(out.unverified).toEqual([id]);
  });
});

describe('crew-source: what it drops', () => {
  it('drops a session that has not loaded, failed, or is not a work_session', () => {
    const pending = sessionId(1);
    const failed = sessionId(2);
    const task = sessionId(3);
    const real = sessionId(4);
    const out = crewViewFrom({
      sessionIds: [pending, failed, task, real],
      reads: new Map<string, CrewEntityRead>([
        [pending, { state: 'pending' }],
        [failed, { state: 'failed' }],
        [task, { state: 'loaded', detail: { id: task, title: 'A task', kind: 'task', state: { kind: 'task', status: 'open' } } as unknown as EntityDetail }],
        [real, session(real, 'running')],
      ]),
      livenessOf: () => 'live',
      now: NOW,
    });
    // A row that appears and then vanishes when a 404 settles is worse than one
    // that arrives a moment late. `foldFleet` renders unreadable ids honestly
    // in the pane beside this one, which is where that belongs.
    expect(out.view.helpers.map((h) => h.key)).toEqual([real]);
  });

  it('preserves the caller\'s order', () => {
    const ids = [sessionId(3), sessionId(1), sessionId(2)];
    const out = crewViewFrom({
      sessionIds: ids,
      reads: new Map(ids.map((id) => [id, session(id, 'running')] as const)),
      livenessOf: () => 'live',
      now: NOW,
    });
    // Re-sorting would move rows under a reader's cursor on every status
    // change, which is the thing `collapseCrewRows`' ordering note exists to
    // stop.
    expect(out.view.helpers.map((h) => h.key)).toEqual(ids);
  });

  it('an empty crew produces a view the dock hides rather than an error', () => {
    const out = crewViewFrom({ sessionIds: [], reads: new Map(), livenessOf: () => 'live', now: NOW });
    const summary = crewSummaryOf(out.view);
    expect(out.view.helpers).toEqual([]);
    expect(summary.allSettled).toBe(false);
    expect(summary.allDoneLine).toBeNull();
  });
});
