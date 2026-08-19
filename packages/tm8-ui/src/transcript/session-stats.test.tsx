// @vitest-environment jsdom
/**
 * THE ONE THING THIS SURFACE CAN GET WRONG, pinned from both sides.
 *
 * `—` and `0` are DIFFERENT CLAIMS. The first says the provider never reported;
 * the second says it reported nothing spent. A Codex session renders the first
 * on cache fields it structurally cannot know; a session that genuinely called
 * no tools renders the second. Collapse them and the panel confidently states a
 * measurement nobody took — which is exactly what the prior art does at
 * `SubagentCard.tsx:86` by writing `{value && …}`.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE. jsdom loads no stylesheets, so the
 * dimmed ink on a hollow figure is invisible here and is NOT what is asserted.
 * What is asserted is the pair that survives into the DOM: the em-dash TEXT and
 * the `data-hollow` ATTRIBUTE. A renderer that showed both states identically
 * would fail on the text; one that dropped the distinction structurally would
 * fail on the attribute.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionTranscriptPage, SessionTranscriptStats } from '@tm8/contract';
import { SessionStatsPanel } from './SessionStatsPanel';
import {
  HOLLOW,
  exitFactsLine,
  formatDuration,
  formatTokens,
  outcomeTitle,
  sessionDurationMs,
  tokenShares,
  tokenTotal,
} from './session-stats';

const NO_STATS: SessionTranscriptStats = {
  partial: false,
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  tools: [],
  models: [],
};

function page(over: Partial<SessionTranscriptPage> = {}): SessionTranscriptPage {
  return {
    sessionId: 'ws-1' as SessionTranscriptPage['sessionId'],
    available: true,
    unavailableReason: null,
    searchedPaths: [],
    agentTool: 'claude-code',
    entries: [],
    stats: NO_STATS,
    stuck: null,
    lastActivityAt: null,
    malformed: 0,
    ...over,
  };
}

function ready(over: Partial<SessionTranscriptPage> = {}) {
  return render(<SessionStatsPanel state={{ phase: 'ready', page: page(over) }} />);
}

/**
 * Several tests below render TWO panels to compare them, and testing-library
 * scopes its queries to `document.body` — which the second render joins rather
 * than replaces. Without this, `getByTestId` sees both panels and the
 * comparison silently becomes an assertion about whichever came first.
 */
afterEach(cleanup);

/**
 * EVERY BARE NUMBER THAT LEAKED INTO THE MARKUP RATHER THAN INTO A FIELD.
 *
 * `{count && <X/>}` evaluates to `0` when count is 0, and React renders that
 * `0` as a text node — a naked digit sitting between elements, next to nothing
 * that says what it counts. It is the single most-repeated defect in the prior
 * art (`SubagentCard.tsx:86` and `:115`) and it is INVISIBLE to every other
 * assertion in this file: the section still renders, the empty state still
 * renders, the queries still resolve. Only the stray node itself gives it away.
 *
 * The rule: a text node that is purely digits is legitimate ONLY inside a leaf
 * — `<dd>4</dd>`. A digit sitting in an element that also contains elements is
 * a leak, because nothing in this panel composes a number that way.
 */
function strayNumbers(root: HTMLElement): string[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const stray: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (!/^\d+$/.test(text)) continue;
    const parent = node.parentElement;
    if (parent !== null && parent.children.length > 0) stray.push(`${parent.className}: ${text}`);
  }
  return stray;
}

describe('hollow is not zero — the rule the whole panel turns on', () => {
  it('renders a dash for null and the digit for a real zero, in the same row of cells', () => {
    // ONE render holding BOTH states, deliberately: two separate renders could
    // each be right about their own case while the component still had no way
    // to tell them apart.
    const { getByTestId } = ready({
      stats: { ...NO_STATS, inputTokens: 0, outputTokens: 4, cacheReadTokens: null },
    });

    const measuredZero = getByTestId('session-stats-token-input');
    expect(measuredZero.textContent).toContain('0');
    expect(measuredZero.textContent).not.toContain(HOLLOW);
    expect(measuredZero.dataset.hollow).toBe('false');

    const unreported = getByTestId('session-stats-token-cache-read');
    expect(unreported.textContent).toContain(HOLLOW);
    expect(unreported.dataset.hollow).toBe('true');
    // The dash carries WHY. A bare glyph is indistinguishable from a layout
    // character, and this one is making a claim.
    expect(unreported.querySelector('.sst__cell-value')?.getAttribute('title')).toMatch(
      /did not report/i,
    );
  });

  it('never lets a genuine zero decide whether a section renders', () => {
    // The truthiness bug's exact shape: `{stats.toolCalls && <X/>}` renders a
    // bare `0` and `{tools.length && …}` puts one in the DOM as a text node.
    const { getByTestId, queryByTestId } = ready({
      stats: { ...NO_STATS, toolCalls: 0, userMessages: 0, assistantMessages: 0 },
    });
    expect(getByTestId('session-stats-tool-calls').textContent).toContain('0');
    expect(getByTestId('session-stats-user-messages').textContent).toContain('0');
    // With no tools the list is REPLACED by a sentence, not by a stray digit.
    expect(queryByTestId('session-stats-tools')).toBeNull();
    expect(getByTestId('session-stats-tools-empty').textContent).toMatch(/no tool calls/i);
    // …and no `0` leaked into the markup on the way. This is the assertion the
    // three above cannot make: every one of them still passes when the gate is
    // written `{tools.length && …}`.
    expect(strayNumbers(getByTestId('session-stats'))).toEqual([]);
  });

  it('leaks no bare digit anywhere, in any of the states that carry a zero', () => {
    // Swept across the panel rather than at one gate, because the defect is a
    // HABIT: it recurs at whichever count is next written, and a per-gate
    // assertion only ever guards the gate that already had it.
    const zeroed = ready({
      stats: { ...NO_STATS, toolCalls: 0, models: [], tools: [], inputTokens: 0 },
      malformed: 0,
    });
    expect(strayNumbers(zeroed.getByTestId('session-stats'))).toEqual([]);
    zeroed.unmount();

    const populated = ready({
      stats: { ...NO_STATS, toolCalls: 2, tools: [{ name: 'Read', count: 2 }], models: ['m'] },
      malformed: 1,
    });
    expect(strayNumbers(populated.getByTestId('session-stats'))).toEqual([]);
  });

  it('keeps loading distinct from hollow — a spinner claims nothing at all', () => {
    const loading = render(<SessionStatsPanel state={{ phase: 'loading' }} />);
    expect(loading.getByTestId('session-stats').dataset.phase).toBe('loading');
    expect(loading.getByTestId('session-stats-loading').textContent).toMatch(/reading/i);
    // The third state must not be reachable from the first: a loading panel
    // that rendered dashes would say "the provider reported nothing" while the
    // read was still in flight.
    expect(loading.queryByTestId('session-stats-token-input')).toBeNull();
    loading.unmount();

    const hollow = ready();
    expect(hollow.getByTestId('session-stats').dataset.phase).toBe('ready');
    expect(hollow.getByTestId('session-stats-token-input').dataset.hollow).toBe('true');
  });
});

describe('the derived total tells you when it is only a floor', () => {
  it('is null when nothing was reported — not zero', () => {
    expect(tokenTotal(NO_STATS)).toBeNull();
    expect(formatTokens(null)).toBe(HOLLOW);
    expect(formatTokens(0)).toBe('0');
  });

  it('sums what WAS reported and marks the sum incomplete', () => {
    const partial = tokenTotal({
      ...NO_STATS,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(partial).toEqual({ value: 120, complete: false });

    const whole = tokenTotal({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    });
    expect(whole).toEqual({ value: 10, complete: true });
  });

  it('says so on screen when the total is a floor, and stays quiet when it is not', () => {
    const floor = ready({ stats: { ...NO_STATS, inputTokens: 100, outputTokens: 20 } });
    expect(floor.getByTestId('session-stats-total').textContent).toBe('120');
    expect(floor.getByTestId('session-stats-total-partial').textContent).toMatch(/floor, not a spend/i);
    floor.unmount();

    const complete = ready({
      stats: {
        ...NO_STATS,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
    });
    expect(complete.queryByTestId('session-stats-total-partial')).toBeNull();
  });

  it('gives a hollow field NO bar segment, rather than a zero-width one', () => {
    const shares = tokenShares({ ...NO_STATS, inputTokens: 60, outputTokens: 40 });
    expect(shares.map((s) => s.key)).toEqual(['inputTokens', 'outputTokens']);
    expect(shares.map((s) => s.pct)).toEqual([60, 40]);
    // Nothing reported ⇒ no bar at all. An empty track would read as a
    // measured zero spend.
    expect(tokenShares(NO_STATS)).toEqual([]);
  });
});

describe('the caveats that stop a count reading as a total', () => {
  it('marks a tail read and a malformed count independently', () => {
    const both = ready({ stats: { ...NO_STATS, partial: true }, malformed: 3 });
    expect(both.getByTestId('session-stats-partial').textContent).toMatch(/newest part/i);
    expect(both.getByTestId('session-stats-malformed').textContent).toMatch(/3 lines/);
    both.unmount();

    const neither = ready({ malformed: 0 });
    expect(neither.queryByTestId('session-stats-partial')).toBeNull();
    // `malformed: 0` must not render "0 lines could not be parsed" — the
    // truthiness-vs-comparison distinction again, on a count rather than a token.
    expect(neither.queryByTestId('session-stats-malformed')).toBeNull();
  });
});

describe('unavailable says WHICH kind of unavailable', () => {
  // The contract's four reasons are four different situations for the reader —
  // one is unrecoverable, one resolves itself, one is a permissions problem.
  // A single "no data" banner throws that away.
  const REASONS = [
    ['no_native_session_id', /cannot be identified/i],
    ['unsupported_agent_tool', /no transcript tm8 can read/i],
    ['no_transcript_file', /no transcript file exists/i],
    ['unreadable', /could not be read/i],
  ] as const;

  it.each(REASONS)('%s gets its own sentence', (reason, matcher) => {
    const { getByTestId } = ready({ available: false, unavailableReason: reason, stats: null });
    expect(getByTestId('session-stats-unavailable').textContent).toMatch(matcher);
  });

  it('proves the four sentences are actually different from each other', () => {
    // Guards the assertions above against a change that made every arm return
    // the same string: each would still match its own regex if the shared text
    // happened to contain all four phrases.
    const rendered = REASONS.map(([reason]) => {
      const { getByTestId, unmount } = ready({
        available: false,
        unavailableReason: reason,
        stats: null,
      });
      const text = getByTestId('session-stats-unavailable').textContent;
      unmount();
      return text;
    });
    expect(new Set(rendered).size).toBe(REASONS.length);
  });

  it('treats a page that is available but carries no stats as unavailable, not as zeroes', () => {
    const { getByTestId, queryByTestId } = ready({ stats: null });
    expect(getByTestId('session-stats').dataset.phase).toBe('unavailable');
    expect(queryByTestId('session-stats-token-input')).toBeNull();
  });
});

describe('files touched — hollow when the dialect cannot know', () => {
  it('explains the absence instead of rendering an empty list', () => {
    const { getByTestId } = ready({ agentTool: 'codex' });
    const note = getByTestId('session-stats-files-hollow');
    expect(note.textContent).toContain(HOLLOW);
    expect(note.textContent).toMatch(/only the claude-code transcript records/i);
    expect(note.textContent).toMatch(/this session ran codex/i);
  });

  it('labels a present accounting as observed tool calls, never as a git diff', () => {
    const { getByTestId } = ready({
      fileChanges: {
        files: [{ path: 'a/b.ts', edits: 1, linesAdded: 4, linesRemoved: 1, hunks: [], hunksTruncated: false }],
        totalAdded: 4,
        totalRemoved: 1,
        filesTruncated: false,
        source: 'transcript',
      },
    });
    const note = getByTestId('session-stats-files-provenance');
    expect(note.textContent).toMatch(/not a git diff/i);
    expect(note.textContent).toContain('+4');
  });
});

describe('models seen', () => {
  it('names each model once, and says so when the transcript names none', () => {
    const named = ready({ stats: { ...NO_STATS, models: ['claude-opus-4-6', 'claude-haiku-4-5'] } });
    expect(named.getByTestId('session-stats-models').textContent).toContain('claude-opus-4-6');
    expect(named.getByTestId('session-stats-models').textContent).toContain('claude-haiku-4-5');
    named.unmount();

    // Hollow, not vanished: an empty list on a transcript that WAS read is a
    // fact about the records, and a missing section reads as a missing feature.
    const none = ready();
    expect(none.getByTestId('session-stats-models-empty').textContent).toContain(HOLLOW);
  });
});

describe('the exit facts line — D1, which had never rendered', () => {
  const START = '2026-01-02T10:00:00.000Z';
  const END = '2026-01-02T10:41:00.000Z';
  const NOW = Date.parse('2026-01-02T12:41:00.000Z');

  it('states the duration and the ending, from two recorded timestamps', () => {
    expect(exitFactsLine({ startedAt: START, exitedAt: END, now: NOW })).toBe('ran 41m 0s · ended 2h ago');
  });

  it('refuses to invent an ending it does not have', () => {
    const line = exitFactsLine({ startedAt: START, exitedAt: null, now: NOW });
    expect(line).toMatch(/duration not recorded/);
    expect(line).toMatch(/no end recorded/);
    // Never a fabricated span from `now` — that would claim the session ran
    // until this render.
    expect(line).not.toMatch(/ran /);
  });

  it('will not turn a broken record into a measurement', () => {
    // End before start is a corrupt row, not a 0s session.
    expect(sessionDurationMs(END, START)).toBeNull();
    expect(sessionDurationMs(null, END)).toBeNull();
    expect(sessionDurationMs('not a date', END)).toBeNull();
    expect(sessionDurationMs(START, END)).toBe(41 * 60 * 1000);
  });

  it('formats a span across all three tiers', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});

describe('a failed session does not call itself exited — D3', () => {
  it('gives each ending its own word', () => {
    expect(outcomeTitle('failed')).toBe('Session failed');
    expect(outcomeTitle('exited')).toBe('Session exited');
    // And they are not the same string, which is the entire defect.
    expect(outcomeTitle('failed')).not.toBe(outcomeTitle('exited'));
  });
});
