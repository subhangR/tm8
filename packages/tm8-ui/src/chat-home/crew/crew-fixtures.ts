/**
 * THE FIXTURES — the only producers of a `CrewView` that exist today.
 *
 * These are not test scaffolding that happens to be exported: they ARE the
 * data source for both components until DESIGN 2 (task 01a028e1) defines
 * where live status text comes from. The dev harness mounts them, the
 * component tests assert against them, and a reviewer looking at the
 * components in a browser is looking at these.
 *
 * THE KEYS ARE REAL UUIDS ON PURPOSE. `key` is where an entity id will live
 * once a host produces these for real, and the leak guard
 * (`no-machine-words.test.tsx`) renders every fixture and fails if a
 * uuid-shaped string reaches the DOM. A fixture with keys like 'a' / 'b'
 * would make that guard pass for free and prove nothing.
 *
 * SO ARE THE STATUS TOKENS. `awaiting_input`, `no_heartbeat` and the rest are
 * spelled here exactly as a server would spell them, so the same guard can
 * assert that none of them reaches the screen.
 */
import type { CrewView, HelperView } from './crew-model';

const key = (n: number): string => `01a028f6-5b26-77d6-bf6d-2260000000${String(n).padStart(2, '0')}`;

/**
 * A FROZEN CLOCK. Both `startedAt` and `now` are fixed instants so the
 * fixtures render the same words in a test, in the dev harness and in a
 * screenshot — a fixture that drifted with the wall clock would make the
 * elapsed line untestable and the harness unreviewable.
 */
const NOW = Date.parse('2026-08-22T10:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

const helper = (n: number, over: Omit<HelperView, 'key'>): HelperView => ({ key: key(n), ...over });

/** Three helpers, all in flight, nobody waiting on a person. */
export const CREW_ALL_WORKING: CrewView = {
  headline: 'Cleaning up the checkout page',
  startedAt: minutesAgo(2),
  now: NOW,
  estimate: 'about 6 min left',
  helpers: [
    helper(1, {
      role: 'Drafter',
      state: 'running',
      activity: 'Rewriting the checkout page layout',
      progress: 0.72,
    }),
    helper(2, { role: 'Tester', state: 'spawning', progress: null }),
    helper(3, { role: 'Reviewer', state: 'queued', progress: 0 }),
  ],
};

/**
 * The prototype's own section-A crew, verbatim: one working, one waiting, one
 * asking a question. "1 needs you · 1 working · 1 waiting" is the footer this
 * produces, and the artifact's card is the picture of it.
 */
export const CREW_ONE_NEEDS_YOU: CrewView = {
  headline: 'Cleaning up the checkout page',
  startedAt: minutesAgo(2),
  now: NOW,
  estimate: 'about 6 min left',
  helpers: [
    helper(1, {
      role: 'Drafter',
      state: 'running',
      activity: 'Rewriting the checkout page layout',
      progress: 0.72,
    }),
    helper(2, {
      role: 'Tester',
      state: 'queued',
      activity: 'Waiting for the Drafter to finish',
      progress: 0,
    }),
    helper(3, {
      role: 'Reviewer',
      state: 'awaiting_input',
      activity: 'Should I also update the old mobile page?',
      progress: 0.4,
    }),
  ],
};

/** A dead end that offers a next move — the shape P5 requires. */
export const CREW_ONE_STUCK: CrewView = {
  headline: 'Fixing the contact form',
  startedAt: minutesAgo(9),
  now: NOW,
  helpers: [
    helper(1, { role: 'Investigator', state: 'completed' }),
    helper(2, {
      role: 'Tester',
      state: 'failed',
      detail: "the test file it needed doesn't exist yet",
      action: { label: 'Create it', intent: 'create-test-file' },
    }),
    helper(3, { role: 'Styler', state: 'no_heartbeat', quietForMinutes: 5 }),
  ],
};

/** Everything over. The dock collapses to one line against this. */
export const CREW_ALL_DONE: CrewView = {
  headline: 'Fixing the contact form',
  startedAt: minutesAgo(14),
  now: NOW,
  helpers: [
    helper(1, { role: 'Investigator', state: 'completed', detail: '3 files changed', progress: 1 }),
    helper(2, { role: 'Checker', state: 'completed', detail: 'all tests pass', progress: 1 }),
  ],
};

/** Nothing was ever handed off. Both components render nothing. */
export const CREW_EMPTY: CrewView = { helpers: [] };

/**
 * Above the collapse threshold, with the urgent helper DELIBERATELY LAST —
 * so the collapsed card has to report it in the hidden summary rather than
 * getting away with showing the first six.
 */
export const CREW_CROWDED: CrewView = {
  headline: 'Migrating the settings screens',
  startedAt: minutesAgo(31),
  now: NOW,
  helpers: [
    helper(1, { role: 'Drafter', state: 'running', activity: 'Rewriting the account page', progress: 0.6 }),
    helper(2, { role: 'Tester', state: 'running', activity: 'Re-checking the settings tests', progress: 0.3 }),
    helper(3, { role: 'Reviewer', state: 'running', activity: 'Reading the diff so far', progress: 0.1 }),
    helper(4, { role: 'Scribe', state: 'running', activity: 'Updating the help text', progress: 0.5 }),
    helper(5, { role: 'Packer', state: 'queued' }),
    helper(6, { role: 'Publisher', state: 'queued' }),
    helper(7, { role: 'Checker', state: 'completed', progress: 1 }),
    helper(8, {
      role: 'Sorter',
      state: 'awaiting_input',
      activity: 'Two of these need a decision — shall I guess?',
      action: { label: 'Decide', intent: 'answer' },
    }),
  ],
};

/**
 * A status nobody in the vocabulary recognises. Kept as a fixture rather than
 * only a unit test, because the FALLBACK has to be looked at: an unknown
 * status is the one case where a reviewer's eye is the only check that the
 * card still reads like a card.
 */
export const CREW_UNKNOWN_STATUS: CrewView = {
  headline: 'Something new',
  startedAt: minutesAgo(1),
  now: NOW,
  helpers: [helper(1, { role: 'Drafter', state: 'reticulating_splines' })],
};

export const CREW_FIXTURES: readonly { name: string; crew: CrewView }[] = [
  { name: 'All working', crew: CREW_ALL_WORKING },
  { name: 'One needs you', crew: CREW_ONE_NEEDS_YOU },
  { name: 'One stuck', crew: CREW_ONE_STUCK },
  { name: 'All done', crew: CREW_ALL_DONE },
  { name: 'Crowded (collapses)', crew: CREW_CROWDED },
  { name: 'Unknown status', crew: CREW_UNKNOWN_STATUS },
  { name: 'Empty', crew: CREW_EMPTY },
];

/** Every uuid a fixture holds, for the leak guard to hunt for. */
export const FIXTURE_KEYS: readonly string[] = CREW_FIXTURES.flatMap((entry) =>
  entry.crew.helpers.map((h) => h.key),
);
