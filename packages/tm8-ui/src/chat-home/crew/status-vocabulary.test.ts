/**
 * THE WORDS ARE THE CONTRACT.
 *
 * Section 0 of the prototypes artifact is a design decision written as eight
 * exact sentences, and this file is where those sentences stop being a
 * screenshot and become something a diff has to argue with. Every assertion
 * here pins a way the vocabulary could quietly stop being the one the design
 * approved — a paraphrased label, a second state that decided it could
 * interrupt, a fallback that invented progress for a status nobody knows.
 */
import { describe, expect, it } from 'vitest';
import {
  facetWord,
  helperCountWords,
  helperWordsOf,
  pillToneOf,
  CREW_FACET_ORDER,
  HELPER_WORDS,
  UNKNOWN_HELPER_WORDS,
  type HelperStatus,
} from './status-vocabulary';

const STATUSES = Object.keys(HELPER_WORDS) as HelperStatus[];

describe('the eight states say exactly what section 0 says', () => {
  it.each([
    ['queued', 'Waiting its turn'],
    ['spawning', 'Getting set up'],
    ['running', 'Working on it'],
    ['awaiting_input', 'Needs a word from you'],
    ['completed', 'Finished'],
    ['cancelled', 'You stopped this'],
  ] as const)('%s reads "%s"', (status, label) => {
    expect(helperWordsOf(status).label).toBe(label);
  });

  it('stuck reads "Hit a wall", and ends on the cause', () => {
    // Design §3 spells this state "Hit a wall — <one plain sentence>", so the
    // two words are the STEM of the label rather than the whole of it.
    expect(helperWordsOf('blocked', { detail: 'the file does not exist' }).label).toBe(
      'Hit a wall — the file does not exist',
    );
    expect(helperWordsOf('failed', { detail: 'the file does not exist' }).label).toBe(
      'Hit a wall — the file does not exist',
    );
    // P7: with no cause, admit it rather than shipping a bare label that
    // looks identical to a healthy one.
    expect(helperWordsOf('blocked').label).toBe('Hit a wall — no reason came back with this one');
    expect(helperWordsOf('blocked').pill).toBe('Stuck');
  });

  it('finished ends on the result, not on the word', () => {
    expect(helperWordsOf('completed', { detail: '4 files changed' }).label).toBe(
      'Finished — 4 files changed',
    );
    // No result is not a hole worth admitting — "Finished" is already a
    // complete piece of news, which is why only the stuck side gets a
    // fallback sentence.
    expect(helperWordsOf('completed').label).toBe('Finished');
  });

  it('a detail is not smuggled onto a state that does not end on one', () => {
    expect(helperWordsOf('running', { detail: 'nope' }).label).toBe('Working on it');
    expect(helperWordsOf('queued', { detail: 'nope' }).label).toBe('Waiting its turn');
    expect(helperWordsOf('awaiting_input', { detail: 'nope' }).label).toBe('Needs a word from you');
  });

  it('no-heartbeat counts the minutes when it has them', () => {
    expect(helperWordsOf('no_heartbeat', { quietForMinutes: 5 }).label).toBe(
      'Nothing heard for 5 min',
    );
  });

  it('no-heartbeat does not invent a number it was not given', () => {
    // A default of "5 min" would be a measurement nobody made.
    expect(helperWordsOf('no_heartbeat').label).toBe('Nothing heard for a while');
    expect(helperWordsOf('no_heartbeat', { quietForMinutes: 0 }).label).toBe(
      'Nothing heard for a while',
    );
    expect(helperWordsOf('no_heartbeat', { quietForMinutes: Number.NaN }).label).toBe(
      'Nothing heard for a while',
    );
  });

  it('blocked and failed are one presentation, deliberately', () => {
    expect(helperWordsOf('blocked')).toEqual(helperWordsOf('failed'));
    expect(HELPER_WORDS.blocked).toEqual({ ...HELPER_WORDS.failed });
  });
});

describe('the rules the table encodes', () => {
  it('ONLY awaiting_input may interrupt', () => {
    const interrupters = STATUSES.filter((status) => HELPER_WORDS[status].mayInterrupt);
    expect(interrupters).toEqual(['awaiting_input']);
    expect(UNKNOWN_HELPER_WORDS.mayInterrupt).toBe(false);
  });

  it('only running yields its sentence to a live activity line', () => {
    expect(helperWordsOf('running', { activity: 'Reading your files…' }).label).toBe(
      'Reading your files…',
    );
    // An activity line under a finished helper is a stale sentence sold as news.
    expect(helperWordsOf('completed', { activity: 'Reading your files…' }).label).toBe('Finished');
    expect(helperWordsOf('awaiting_input', { activity: 'Reading your files…' }).label).toBe(
      'Needs a word from you',
    );
  });

  it('a blank activity line does not blank the sentence', () => {
    expect(helperWordsOf('running', { activity: '   ' }).label).toBe('Working on it');
    expect(helperWordsOf('running', { activity: null }).label).toBe('Working on it');
  });

  it('cancelled and no-heartbeat are told apart from queued in a count', () => {
    // All three are `idle` in tone; a summary line that merged them would say
    // "3 waiting" about a crew where one is stopped and one has gone silent.
    expect(HELPER_WORDS.queued.tone).toBe('idle');
    expect(HELPER_WORDS.cancelled.tone).toBe('idle');
    expect(HELPER_WORDS.no_heartbeat.tone).toBe('idle');
    expect(new Set([HELPER_WORDS.queued.facet, HELPER_WORDS.cancelled.facet, HELPER_WORDS.no_heartbeat.facet]).size).toBe(3);
  });

  it('outstanding is decided per state, not derived from tone', () => {
    // The dock's "All done" collapse is exactly this column.
    expect(HELPER_WORDS.completed.outstanding).toBe(false);
    expect(HELPER_WORDS.cancelled.outstanding).toBe(false);
    // Stuck is waiting on a PERSON — it is not over.
    expect(HELPER_WORDS.blocked.outstanding).toBe(true);
    expect(HELPER_WORDS.failed.outstanding).toBe(true);
    // Silence is not an ending either.
    expect(HELPER_WORDS.no_heartbeat.outstanding).toBe(true);
    expect(HELPER_WORDS.queued.outstanding).toBe(true);
  });

  it('every facet has a word and the summary order covers all of them', () => {
    expect(new Set(CREW_FACET_ORDER).size).toBe(CREW_FACET_ORDER.length);
    for (const facet of CREW_FACET_ORDER) {
      // A word, and never a machine token — several facets are NAMED for the
      // ordinary English word a person would use ('stuck', 'working'), so
      // "differs from the facet" would be the wrong assertion here.
      expect(facetWord(facet).length).toBeGreaterThan(0);
      expect(STATUSES).not.toContain(facetWord(facet));
    }
    for (const status of STATUSES) expect(CREW_FACET_ORDER).toContain(HELPER_WORDS[status].facet);
    expect(CREW_FACET_ORDER).toContain(UNKNOWN_HELPER_WORDS.facet);
    // Most urgent first: a crew's worst news must not be third in the line.
    expect(CREW_FACET_ORDER[0]).toBe('needs-you');
    expect(CREW_FACET_ORDER[1]).toBe('stuck');
  });

  it('tone resolves to a kit pill, so no surface picks a colour itself', () => {
    expect(pillToneOf('working')).toBe('run');
    expect(pillToneOf('needs-you')).toBe('wait');
    expect(pillToneOf('stuck')).toBe('block');
    expect(pillToneOf('done')).toBe('info');
    expect(pillToneOf('idle')).toBe('idle');
  });
});

describe('the fallback claims nothing', () => {
  it('an unknown status resolves rather than throwing or leaking', () => {
    const words = helperWordsOf('reticulating_splines');
    expect(words).toEqual(UNKNOWN_HELPER_WORDS);
    expect(words.label).toBe('Checking on this one');
  });

  it('the fallback invents neither progress nor a failure', () => {
    expect(UNKNOWN_HELPER_WORDS.tone).not.toBe('working');
    expect(UNKNOWN_HELPER_WORDS.tone).not.toBe('stuck');
    expect(UNKNOWN_HELPER_WORDS.tone).not.toBe('done');
    // Nor does it claim the work is over.
    expect(UNKNOWN_HELPER_WORDS.outstanding).toBe(true);
  });

  it('the empty string and a near-miss both fall back', () => {
    expect(helperWordsOf('').label).toBe(UNKNOWN_HELPER_WORDS.label);
    expect(helperWordsOf('RUNNING').label).toBe(UNKNOWN_HELPER_WORDS.label);
    expect(helperWordsOf('awaiting-input').label).toBe(UNKNOWN_HELPER_WORDS.label);
  });

  it('an inherited Object key is not mistaken for a status', () => {
    // `'toString' in HELPER_WORDS` is true; a naive lookup would return a
    // function here and the card would render whatever that stringifies to.
    expect(helperWordsOf('toString')).toEqual(UNKNOWN_HELPER_WORDS);
    expect(helperWordsOf('constructor')).toEqual(UNKNOWN_HELPER_WORDS);
  });
});

describe('no label or pill is ever the machine word', () => {
  it.each(STATUSES)('%s renders neither its own token nor any other', (status) => {
    const words = HELPER_WORDS[status];
    for (const token of STATUSES) {
      expect(words.label.toLowerCase()).not.toContain(token);
      expect(words.pill.toLowerCase()).not.toContain(token);
    }
  });
});

describe('the plural is decided once', () => {
  it('counts helpers in one voice', () => {
    expect(helperCountWords(1)).toBe('1 helper');
    expect(helperCountWords(2)).toBe('2 helpers');
    expect(helperCountWords(0)).toBe('0 helpers');
  });
});
