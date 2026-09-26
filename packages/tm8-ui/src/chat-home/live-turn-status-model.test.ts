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
  /* `read.*` operations fold into a counted run (the classifier's `merges`);
     anything else stays its own line. `args.detail` stands in for the one
     human fact the real classifier extracts (a title, a basename). */
  describeToolStep: (name: string, args: unknown) => {
    const a = (args ?? {}) as { operation?: string; detail?: string };
    const op = a.operation ?? name;
    return {
      category: op,
      active: `Doing ${op}`,
      done: `Did ${op}`,
      counted: (n: number) => `Did ${n}× ${op}`,
      merges: op.startsWith('read.'),
      detail: a.detail ?? null,
    };
  },
  groupDone: (steps: { done: string; counted: (n: number) => string }[]) =>
    steps.length === 1 ? steps[0]!.done : steps[0]!.counted(steps.length),
  // The real rule: the last `done`/`error` record ends everything before it.
  turnEndSeq: (parts: { kind: string; seq: number }[]) =>
    parts.reduce((end, part) => (part.kind === 'done' || part.kind === 'error') && part.seq > end ? part.seq : end, -1),
  // The real rule: a result or a terminal record settles it; an ended turn
  // stops what never settled.
  toolStepState: (part: { state: string; result?: unknown; resultIsError?: boolean }, settled: boolean) => {
    if (part.state === 'error' || part.resultIsError === true) return 'error';
    if (part.state === 'completed' || part.result !== undefined) return 'completed';
    return settled ? 'stopped' : 'running';
  },
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
function call(
  id: string,
  operation: string,
  state: 'running' | 'completed' | 'error' = 'running',
  detail?: string,
): ChatTurnPart[] {
  const args = detail ? { operation, detail } : { operation };
  const parts: ChatTurnPart[] = [
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'mcp__tm8__tm8_read', args, state: 'running' },
  ];
  if (state !== 'running') {
    parts.push({ seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'mcp__tm8__tm8_read', args, state });
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

  it('a running step is the headline, in the present tense', () => {
    const view = liveTurnView(turn(), [...call('a', 'read.get')], T0 + 2 * S);
    expect(view.now).toBe('Doing read.get…');
    expect(view.aside).toBeNull();
    expect(view.meta).toBe('step 1 · 2s');
  });

  it('a running step’s one human fact (a title) sits muted beside it', () => {
    const view = liveTurnView(turn(), [...call('a', 'write.create', 'running', '“Provider interface”')], T0);
    expect(view.now).toBe('Doing write.create…');
    expect(view.aside).toBe('“Provider interface”');
  });

  /** `counted` is a SETTLED count; using it for calls still in flight would
   *  claim they had finished. */
  it('parallel running steps name the newest and how many more are running', () => {
    const parts = [...call('a', 'read.get'), ...call('b', 'read.get'), ...call('c', 'read.context')];
    const view = liveTurnView(turn(), parts, T0);
    expect(view.now).toBe('Doing read.context…');
    expect(view.aside).toBe('+2 more');
  });

  /** Lane 3's stuck-call guard: a continued turn appends after its first
   *  `done`, and a call abandoned before it never gets a terminal record. */
  it('a call left running before the last done is not "now" in a continued turn', () => {
    const parts: ChatTurnPart[] = [
      { seq: 1, kind: 'tool_call', toolCallId: 'stuck', name: 'x', args: { operation: 'write.spawn' }, state: 'running' },
      { seq: 2, kind: 'done' },
      { seq: 3, kind: 'text', text: 'Continuing.' },
    ];
    const view = liveTurnView(turn(), parts, T0);
    expect(view.now).toBe('Writing…');
    expect(view.aside).toBe('Did write.spawn');
  });

  it('a step whose result has landed is not running, whatever its record says', () => {
    const parts: ChatTurnPart[] = [
      { seq: 1, kind: 'tool_call', toolCallId: 'r', name: 'x', args: { operation: 'read.get' }, state: 'running' },
      { seq: 2, kind: 'tool_result', toolCallId: 'r', content: { ok: true } },
    ];
    expect(liveTurnView(turn(), parts, T0).now).toBe('Thinking…');
  });

  /**
   * THE USUAL STATE OF A TURN (lane 1's measurement: ~0.4s tools, then 12s
   * average of model silence). Keeping the finished step in the present tense
   * would be false for most of the turn.
   */
  it('between blocks it is Thinking…, with the settled step muted beside it', () => {
    const parts = [...call('a', 'read.get', 'completed')];
    const view = liveTurnView(turn({ lastFrameAt: T0 + 3 * S }), parts, T0 + 40 * S);
    expect(view.now).toBe('Thinking…');
    expect(view.aside).toBe('Did read.get');
    expect(view.meta).toBe('step 1 · 40s · last step 37s ago');
  });

  it('a settled run of steps that fold together is ONE counted aside', () => {
    const parts = [
      ...call('w', 'write.create', 'completed'),
      ...call('a', 'read.get', 'completed'),
      ...call('b', 'read.get', 'completed'),
      ...call('c', 'read.get', 'completed'),
    ];
    // The run stops at the create: only the three reads fold.
    expect(liveTurnView(turn(), parts, T0).aside).toBe('Did 3× read.get');
  });

  it('a settled step that does not fold keeps its own words and its detail', () => {
    const parts = [
      ...call('w', 'write.create', 'completed', '“Provider interface”'),
      ...call('x', 'write.create', 'completed', '“Docker provider”'),
    ];
    expect(liveTurnView(turn(), parts, T0).aside).toBe('Did write.create “Docker provider”');
  });

  it('a detail that is not a title is set apart from the words', () => {
    const parts = [...call('a', 'command', 'completed', 'Run the focused tests')];
    expect(liveTurnView(turn(), parts, T0).aside).toBe('Did command · Run the focused tests');
  });

  it('after a text block it is Writing…', () => {
    const parts = [...call('a', 'read.get', 'completed'), text('Here is the plan.')];
    const view = liveTurnView(turn(), parts, T0);
    expect(view.now).toBe('Writing…');
    expect(view.aside).toBe('Did read.get');
  });

  it('stopping keeps the spinner and the settled step', () => {
    const parts = [...call('a', 'write.patch', 'completed')];
    const view = liveTurnView(turn({ phase: 'stopping' }), parts, T0 + 2 * S);
    expect(view.now).toBe('Stopping…');
    expect(view.glyph).toBe('spinner');
    expect(view.aside).toBe('Did write.patch');
    expect(view.ticking).toBe(true);
  });
});

describe('the ended phases are frozen', () => {
  it('stopped: ■, `after N steps · clock`, and no ticking clock', () => {
    const parts = [...call('a', 'read.get', 'completed'), ...call('b', 'read.get', 'completed'), ...call('c', 'write.spawn')];
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
    const parts = [...call('a', 'read.get', 'completed')];
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
