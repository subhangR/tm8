/**
 * THE FOLD BOTH SURFACES SHARE.
 *
 * The card and the dock describe the same crew, so a disagreement between
 * them is a bug that no per-component test can see. Everything they could
 * disagree about — the counts, the order of the summary line, whether the
 * crew is settled, what the header pill leads with — is computed here, and
 * this file is where those answers are pinned.
 */
import { describe, expect, it } from 'vitest';
import {
  collapseCrewRows,
  crewRowOf,
  crewSummaryOf,
  monogramOf,
  CREW_VISIBLE_ROWS,
  type CrewView,
  type HelperView,
} from './crew-model';
import {
  CREW_ALL_DONE,
  CREW_ALL_WORKING,
  CREW_CROWDED,
  CREW_EMPTY,
  CREW_ONE_NEEDS_YOU,
  CREW_ONE_STUCK,
} from './crew-fixtures';

const helper = (over: Partial<HelperView> & { role: string; state: string }): HelperView => ({
  key: `k-${over.role}`,
  ...over,
});

const crew = (helpers: readonly HelperView[], over: Partial<CrewView> = {}): CrewView => ({
  helpers,
  ...over,
});

describe('the summary line', () => {
  it('is the prototype line for the prototype crew', () => {
    expect(crewSummaryOf(CREW_ONE_NEEDS_YOU).summaryLine).toBe('1 needs you · 1 working · 1 waiting');
  });

  it('leads with what needs a person, whatever order the helpers arrive in', () => {
    const summary = crewSummaryOf(
      crew([
        helper({ role: 'A', state: 'completed' }),
        helper({ role: 'B', state: 'running' }),
        helper({ role: 'C', state: 'awaiting_input' }),
        helper({ role: 'D', state: 'failed' }),
      ]),
    );
    expect(summary.summaryLine).toBe('1 needs you · 1 stuck · 1 working · 1 finished');
  });

  it('drops the facets nobody is in', () => {
    expect(crewSummaryOf(CREW_ALL_DONE).summaryLine).toBe('2 finished');
  });

  it('is empty for an empty crew rather than "0 working"', () => {
    expect(crewSummaryOf(CREW_EMPTY).summaryLine).toBe('');
    expect(crewSummaryOf(CREW_EMPTY).rows).toHaveLength(0);
  });

  it('tells a stopped helper apart from a waiting one', () => {
    const summary = crewSummaryOf(
      crew([helper({ role: 'A', state: 'cancelled' }), helper({ role: 'B', state: 'queued' })]),
    );
    expect(summary.summaryLine).toBe('1 waiting · 1 stopped');
  });
});

describe('settledness', () => {
  it('is true only when nothing is outstanding', () => {
    expect(crewSummaryOf(CREW_ALL_DONE).allSettled).toBe(true);
    expect(crewSummaryOf(CREW_ALL_WORKING).allSettled).toBe(false);
  });

  it('a stuck helper keeps the crew unsettled', () => {
    // The failure this pins: "nothing is running" read as "everything is done",
    // which would collapse the dock over a helper that needs a person.
    const summary = crewSummaryOf(
      crew([helper({ role: 'A', state: 'completed' }), helper({ role: 'B', state: 'blocked' })]),
    );
    expect(summary.allSettled).toBe(false);
    expect(summary.allDoneLine).toBeNull();
  });

  it('a silent helper keeps the crew unsettled', () => {
    expect(crewSummaryOf(CREW_ONE_STUCK).allSettled).toBe(false);
  });

  it('an empty crew is not "settled" — it never started', () => {
    expect(crewSummaryOf(CREW_EMPTY).allSettled).toBe(false);
    expect(crewSummaryOf(CREW_EMPTY).allDoneLine).toBeNull();
  });

  it('the all-done line reports what actually happened', () => {
    expect(crewSummaryOf(CREW_ALL_DONE).allDoneLine).toBe('All done — 2 helpers finished.');
    expect(
      crewSummaryOf(crew([helper({ role: 'A', state: 'cancelled' })])).allDoneLine,
    ).toBe('Nothing left — 1 helper stopped.');
    expect(
      crewSummaryOf(
        crew([helper({ role: 'A', state: 'completed' }), helper({ role: 'B', state: 'cancelled' })]),
      ).allDoneLine,
    ).toBe('All done — 1 finished · 1 stopped.');
  });
});

describe('the header pill', () => {
  it('leads with needs-you above everything', () => {
    const summary = crewSummaryOf(CREW_ONE_NEEDS_YOU);
    expect(summary.headline).toEqual({ tone: 'needs-you', text: '1 needs you' });
    expect(summary.needsYou).toBe(1);
  });

  it('falls to stuck, then working, then waiting, then done', () => {
    expect(
      crewSummaryOf(crew([helper({ role: 'A', state: 'failed' }), helper({ role: 'B', state: 'running' })]))
        .headline,
    ).toEqual({ tone: 'stuck', text: '1 stuck' });
    expect(crewSummaryOf(CREW_ALL_WORKING).headline).toEqual({ tone: 'working', text: '2 working' });
    expect(
      crewSummaryOf(crew([helper({ role: 'A', state: 'queued' })])).headline,
    ).toEqual({ tone: 'idle', text: '1 waiting' });
    expect(crewSummaryOf(CREW_ALL_DONE).headline).toEqual({ tone: 'done', text: 'All done' });
  });
});

describe('a row', () => {
  it('takes its sentence from the vocabulary, never from the state token', () => {
    const row = crewRowOf(helper({ role: 'Drafter', state: 'awaiting_input' }));
    expect(row.words.label).toBe('Needs a word from you');
    expect(row.words.pill).toBe('Your turn');
  });

  it('lets a live line win only where the vocabulary allows', () => {
    expect(crewRowOf(helper({ role: 'A', state: 'running', activity: 'Reading your files' })).words.label)
      .toBe('Reading your files');
    expect(crewRowOf(helper({ role: 'A', state: 'completed', activity: 'Reading your files' })).words.label)
      .toBe('Finished');
  });

  it('clamps a progress number instead of drawing past the end of the track', () => {
    expect(crewRowOf(helper({ role: 'A', state: 'running', progress: 1.8 })).progress).toBe(1);
    expect(crewRowOf(helper({ role: 'A', state: 'running', progress: -3 })).progress).toBe(0);
    expect(crewRowOf(helper({ role: 'A', state: 'running', progress: Number.NaN })).progress).toBeNull();
  });

  it('draws a moving track only for a helper that is actually moving', () => {
    expect(crewRowOf(helper({ role: 'A', state: 'running' })).track).toBe('indeterminate');
    expect(crewRowOf(helper({ role: 'A', state: 'running', progress: 0.5 })).track).toBe('determinate');
    // A moving track under a stopped helper would claim motion that ended.
    expect(crewRowOf(helper({ role: 'A', state: 'cancelled' })).track).toBe('none');
    expect(crewRowOf(helper({ role: 'A', state: 'queued' })).track).toBe('none');
  });

  it('flags a helper that owes an action and arrived without one', () => {
    // P5 covers both states that need a person, not just the stuck one.
    expect(crewRowOf(helper({ role: 'A', state: 'failed' })).actionGap).toBe(true);
    expect(crewRowOf(helper({ role: 'A', state: 'awaiting_input' })).actionGap).toBe(true);
    expect(
      crewRowOf(helper({ role: 'A', state: 'failed', action: { label: 'Make it' } })).actionGap,
    ).toBe(false);
    // A queued helper owes nobody a button.
    expect(crewRowOf(helper({ role: 'A', state: 'queued' })).actionGap).toBe(false);
  });

  it('ends a finished or stuck sentence on the detail, per design §3', () => {
    expect(
      crewRowOf(helper({ role: 'A', state: 'completed', detail: '4 files changed' })).words.label,
    ).toBe('Finished — 4 files changed');
    expect(
      crewRowOf(helper({ role: 'A', state: 'blocked', detail: 'the file does not exist' })).words.label,
    ).toBe('Hit a wall — the file does not exist');
    // P7: a bare "Hit a wall" tells nobody anything, so the gap is admitted.
    expect(crewRowOf(helper({ role: 'A', state: 'failed' })).words.label).toBe(
      'Hit a wall — no reason came back with this one',
    );
    // A detail on a state that does not end on one is not smuggled in.
    expect(crewRowOf(helper({ role: 'A', state: 'queued', detail: 'nope' })).words.label).toBe(
      'Waiting its turn',
    );
  });

  it('takes its monogram from the role, never from the key', () => {
    expect(monogramOf('Drafter')).toBe('DR');
    expect(monogramOf('Live Checker')).toBe('LC');
    expect(monogramOf('  spacing  test ')).toBe('ST');
    expect(monogramOf('')).toBe('?');
    expect(crewRowOf(helper({ role: 'Reviewer', state: 'queued' })).monogram).toBe('RE');
  });
});

describe('elapsed phrasing', () => {
  /* A frozen clock, passed in. The fold never calls `Date.now()`. */
  const NOW = Date.parse('2026-08-22T10:00:00.000Z');
  const ago = (minutes: number): CrewView => crew([], { startedAt: NOW - minutes * 60_000, now: NOW });

  it('speaks the package one time vocabulary, not its own', () => {
    // Formatted by `kit/time.ts` — the same words every other tm8 surface
    // uses for the same fact. A second formatter here is what
    // `kit/timestamp.test.tsx` bans, and what this originally did wrong.
    expect(crewSummaryOf(ago(4)).startedLabel).toBe('Started 4m ago');
    expect(crewSummaryOf(ago(130)).startedLabel).toBe('Started 2h ago');
    expect(crewSummaryOf(ago(0)).startedLabel).toBe('Started just now');
  });

  it('says nothing when the host named no start', () => {
    expect(crewSummaryOf(crew([])).startedLabel).toBeNull();
    expect(crewSummaryOf(crew([], { startedAt: null })).elapsedShort).toBeNull();
    expect(crewSummaryOf(crew([], { startedAt: 'not an instant', now: NOW })).startedLabel).toBeNull();
  });

  it('has a terser, direction-free form for the strip', () => {
    expect(crewSummaryOf(ago(3)).elapsedShort).toBe('3m so far');
    expect(crewSummaryOf(ago(130)).elapsedShort).toBe('2h so far');
    expect(crewSummaryOf(ago(0)).elapsedShort).toBe('<1m so far');
  });
});

describe('collapsing above six', () => {
  const rows = crewSummaryOf(CREW_CROWDED).rows;

  it('shows six and says how many are hidden', () => {
    const collapse = collapseCrewRows(rows, false);
    expect(rows).toHaveLength(8);
    expect(collapse.shown).toHaveLength(CREW_VISIBLE_ROWS);
    expect(collapse.hiddenCount).toBe(2);
  });

  it('SAYS WHAT IS HIDDEN, so an urgent helper below the fold is still counted', () => {
    // The crowded fixture puts the awaiting_input helper LAST on purpose.
    expect(collapseCrewRows(rows, false).hiddenSummary).toBe('1 needs you · 1 finished');
  });

  it('keeps the host order rather than sorting urgency to the top', () => {
    // A card that re-sorted on status change would move rows under a cursor.
    expect(collapseCrewRows(rows, false).shown.map((row) => row.role)).toEqual([
      'Drafter', 'Tester', 'Reviewer', 'Scribe', 'Packer', 'Publisher',
    ]);
  });

  it('hides nothing when expanded, and nothing when there is nothing to hide', () => {
    expect(collapseCrewRows(rows, true).hiddenCount).toBe(0);
    expect(collapseCrewRows(rows, true).hiddenSummary).toBeNull();
    const small = crewSummaryOf(CREW_ONE_NEEDS_YOU).rows;
    expect(collapseCrewRows(small, false).shown).toHaveLength(3);
    expect(collapseCrewRows(small, false).hiddenSummary).toBeNull();
  });
});
