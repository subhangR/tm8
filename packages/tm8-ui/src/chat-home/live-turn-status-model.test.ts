import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import {
  QUIET_LONG_MS,
  QUIET_SHOW_MS,
  announcementKey,
  formatClock,
  liveTurnView,
  type TurnInProgress,
} from './live-turn-status-model';
import type { ChatTurnPart } from './types';

/*
 * THE CLASSIFIER IS LANE 3's, AND ITS WORDS ARE ITS OWN TESTS' BUSINESS.
 * Mocked here so these cases pin what THIS module decides — which step is
 * "now", which tense, when steps count themselves, the clock — and would not
 * red on a wording change in `turn-steps.ts`. The unmocked seam is covered by
 * `live-turn-row.test.tsx`, through the real screen.
 */
vi.mock('./turn-steps', () => ({
  describeToolStep: (name: string, args: unknown) => {
    const op = (args as { operation?: string } | null)?.operation ?? name;
    return {
      category: op.split('.')[0],
      active: `Doing ${op}`,
      done: `Did ${op}`,
      counted: (n: number) => `Doing ${n} ${op}`,
    };
  },
  toolStepState: (part: { state: string; result?: unknown }, settled: boolean) =>
    part.result !== undefined || part.state !== 'running'
      ? part.state === 'error' ? 'error' : 'completed'
      : settled ? 'stopped' : 'running',
}));

const T0 = Date.parse('2026-09-26T07:00:00.000Z');
const S = 1000;

function turn(patch: Partial<TurnInProgress> = {}): TurnInProgress {
  return {
    phase: 'streaming',
    chatId: 'chat-1' as EntityId,
    messageId: 'msg-1' as EntityId,
    startedAt: T0,
    lastFrameAt: T0,
    ...patch,
  };
}

let seq = 0;
function call(id: string, operation: string, state: 'running' | 'completed' | 'error' = 'running'): ChatTurnPart[] {
  const parts: ChatTurnPart[] = [
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'mcp__tm8__tm8_read', args: { operation }, state: 'running' },
  ];
  if (state !== 'running') {
    parts.push({ seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'mcp__tm8__tm8_read', args: { operation }, state });
    parts.push({ seq: (seq += 1), kind: 'tool_result', toolCallId: id, content: { ok: true } });
  }
  return parts;
}
const text = (value: string): ChatTurnPart => ({ seq: (seq += 1), kind: 'text', text: value });
const thinking = (): ChatTurnPart => ({ seq: (seq += 1), kind: 'thinking', text: 'hmm' });

describe('formatClock (D3)', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [59_999, '59s'],
    [60_000, '1m 00s'],
    [72_000, '1m 12s'],
    [65 * 60_000 + 30_000, '1h 05m'],
    [-5_000, '0s'],
  ])('%i ms reads %s', (ms, expected) => {
    expect(formatClock(ms)).toBe(expected);
  });
});

describe('the phase copy (D2 as amended by D16)', () => {
  it('sending says so, and has nothing to time yet', () => {
    const view = liveTurnView(turn({ phase: 'sending', messageId: null, lastFrameAt: null }), null, T0 + 3 * S);
    expect(view.now).toBe('Sending your message…');
    expect(view.meta).toBe('');
    expect(view.glyph).toBe('spinner');
    expect(view.ticking).toBe(true);
  });

  it('waiting is Thinking…, timed from the send', () => {
    const view = liveTurnView(turn({ phase: 'waiting', lastFrameAt: null }), [], T0 + 12 * S);
    expect(view.now).toBe('Thinking…');
    expect(view.meta).toBe('12s');
    expect(view.aside).toBeNull();
  });

  it('a running step is the headline, in the present tense, with no aside', () => {
    const view = liveTurnView(turn(), [...call('a', 'entities.get')], T0 + 2 * S);
    expect(view.now).toBe('Doing entities.get…');
    expect(view.aside).toBeNull();
    expect(view.meta).toBe('step 1 · 2s');
  });

  it('parallel running steps of one category count themselves', () => {
    const parts = [...call('a', 'entities.get'), ...call('b', 'entities.context'), ...call('c', 'entities.get')];
    expect(liveTurnView(turn(), parts, T0).now).toBe('Doing 3 entities.get…');
  });

  it('a mixed running set names the newest and how many more', () => {
    const parts = [...call('a', 'entities.get'), ...call('b', 'execution.spawn')];
    expect(liveTurnView(turn(), parts, T0).now).toBe('Doing execution.spawn… +1 more');
  });

  /**
   * THE USUAL STATE OF A TURN (lane 1's measurement: ~0.4s tools, then 12s
   * average of model silence). Keeping the finished step in the present tense
   * would be false for most of the turn.
   */
  it('between blocks it is Thinking…, with the settled step muted beside it', () => {
    const parts = [...call('a', 'entities.get', 'completed')];
    const view = liveTurnView(turn({ lastFrameAt: T0 + 3 * S }), parts, T0 + 40 * S);
    expect(view.now).toBe('Thinking…');
    expect(view.aside).toBe('Did entities.get');
    expect(view.meta).toBe('step 1 · 40s · last step 37s ago');
  });

  it('after a text block it is Writing…', () => {
    const parts = [...call('a', 'entities.get', 'completed'), text('Here is the plan.')];
    const view = liveTurnView(turn(), parts, T0);
    expect(view.now).toBe('Writing…');
    expect(view.aside).toBe('Did entities.get');
  });

  it('stopping keeps the spinner and the settled step', () => {
    const parts = [...call('a', 'entities.patch', 'completed')];
    const view = liveTurnView(turn({ phase: 'stopping' }), parts, T0 + 2 * S);
    expect(view.now).toBe('Stopping…');
    expect(view.glyph).toBe('spinner');
    expect(view.aside).toBe('Did entities.patch');
    expect(view.ticking).toBe(true);
  });
});

describe('the ended phases are frozen', () => {
  it('stopped: ■, `after N steps · clock`, and no ticking clock', () => {
    const parts = [...call('a', 'entities.get', 'completed'), ...call('b', 'entities.get', 'completed'), ...call('c', 'execution.spawn')];
    const stopped = turn({ phase: 'stopped', lastFrameAt: T0 + 50 * S, endedAt: T0 + 72 * S });
    const early = liveTurnView(stopped, parts, T0 + 80 * S);
    const late = liveTurnView(stopped, parts, T0 + 900 * S);
    expect(early.now).toBe('Stopped');
    expect(early.aside).toBe('after 3 steps · 1m 12s');
    expect(early.glyph).toBe('stopped');
    expect(early.ticking).toBe(false);
    expect(early.meta).toBe('');
    // Frozen: a quarter of an hour later it says exactly the same thing.
    expect(late).toEqual(early);
  });

  it('stopped without endedAt freezes at the last frame, never at the ticker', () => {
    const view = liveTurnView(turn({ phase: 'stopped', lastFrameAt: T0 + 5 * S }), [], T0 + 600 * S);
    expect(view.aside).toBe('after 5s');
  });

  /** D16: the transcript already renders the error part as `role=alert`. */
  it('failed: ✕, the step count, and NOT the error text', () => {
    const parts = [...call('a', 'entities.get', 'completed')];
    const view = liveTurnView(
      turn({ phase: 'failed', error: 'Provider refused the request', endedAt: T0 + 5 * S }),
      parts,
      T0 + 60 * S,
    );
    expect(view.now).toBe('Turn failed');
    expect(view.aside).toBe('after 1 step · 5s');
    expect(view.glyph).toBe('failed');
    expect(JSON.stringify(view)).not.toContain('Provider refused');
  });
});

describe('the meta line and the silence clock (D3)', () => {
  it('omits `step N` while N is 0', () => {
    const view = liveTurnView(turn({ lastFrameAt: T0 + 2 * S }), [thinking()], T0 + 8 * S);
    expect(view.meta).toBe('8s · last step 6s ago');
  });

  it('omits the silence under 5s — a stream that is plainly alive', () => {
    const at = T0 + 20 * S;
    const view = liveTurnView(turn({ lastFrameAt: at - (QUIET_SHOW_MS - 1) }), [...call('a', 'x.y', 'completed')], at);
    expect(view.meta).toBe('step 1 · 20s');
    const shown = liveTurnView(turn({ lastFrameAt: at - QUIET_SHOW_MS }), [...call('a', 'x.y', 'completed')], at);
    expect(shown.meta).toBe('step 1 · 20s · last step 5s ago');
  });

  it('is calm under 90s of silence and escalates in TONE and wording past it', () => {
    const parts = [...call('a', 'x.y', 'completed')];
    const calm = liveTurnView(turn(), parts, T0 + QUIET_LONG_MS - 1);
    expect(calm.quiet).toBe('calm');
    const long = liveTurnView(turn(), parts, T0 + 100 * S);
    expect(long.quiet).toBe('long');
    expect(long.meta).toBe('step 1 · 1m 40s · still working · 1m 40s since last step');
  });

  it('a long wait with no part yet escalates too, without inventing a step', () => {
    const view = liveTurnView(turn({ phase: 'waiting', lastFrameAt: null }), [], T0 + 95 * S);
    expect(view.quiet).toBe('long');
    expect(view.meta).toBe('1m 35s · still working');
  });

  it('never escalates a frozen turn', () => {
    const view = liveTurnView(turn({ phase: 'stopped', endedAt: T0 + S }), [], T0 + 1000 * S);
    expect(view.quiet).toBe('calm');
  });
});

describe('the announcement (D16.5)', () => {
  it('is the now words — never the clock', () => {
    const view = liveTurnView(turn({ lastFrameAt: T0 }), [...call('a', 'x.y', 'completed')], T0 + 40 * S);
    expect(view.announcement).toBe('Thinking…');
    expect(view.announcement).not.toMatch(/\d+s/);
  });

  /** Constant for the whole silence, so the throttle says it exactly once. */
  it('the 90s escalation is its own sentence, with the threshold and not the live figure', () => {
    const parts = [...call('a', 'x.y', 'completed')];
    const at100 = liveTurnView(turn(), parts, T0 + 100 * S);
    const at300 = liveTurnView(turn(), parts, T0 + 300 * S);
    expect(at100.announcement).toBe('Still working, 1m 30s since the last step');
    expect(at300.announcement).toBe(at100.announcement);
    expect(announcementKey(at100)).not.toBe(announcementKey(liveTurnView(turn(), parts, T0)));
  });

  it('an ended turn announces its summary', () => {
    const view = liveTurnView(turn({ phase: 'stopped', endedAt: T0 + 12 * S }), [...call('a', 'x.y', 'completed')], T0);
    expect(view.announcement).toBe('Stopped after 1 step · 12s');
  });
});
