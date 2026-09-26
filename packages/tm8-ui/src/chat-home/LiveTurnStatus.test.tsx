// @vitest-environment jsdom
/**
 * THE LIVE STATUS ROW, one test per state — and the two properties no state
 * may lose: it is a screen-reader STATUS that is not chatty, and nothing that
 * ticks ever reaches the live region.
 *
 * The step WORDS are lane 3's (`turn-steps.ts`) and pinned by its own tests;
 * expectations here are computed through `describeToolStep` so they pin THIS
 * file's wiring — which step is "now", which slot it lands in — and not a
 * wording lane 3 is free to change.
 */
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ANNOUNCE_MIN_MS, LiveTurnStatus, TranscriptDock } from './LiveTurnStatus';
import type { TurnInProgress } from './live-turn-status-model';
import { describeToolStep } from './turn-steps';
import type { ChatTurnPart } from './types';

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
const BASH_ARGS = { command: 'bun run build', description: 'Build the workspace' };
function bash(id: string, settled = false): ChatTurnPart[] {
  const parts: ChatTurnPart[] = [
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'Bash', args: BASH_ARGS, state: 'running' },
  ];
  if (settled) parts.push({ seq: (seq += 1), kind: 'tool_result', toolCallId: id, content: 'ok' });
  return parts;
}
const CREATE_ARGS = { operation: 'entities.create', body: { kind: 'task', title: 'Provider interface' } };
function create(id: string): ChatTurnPart[] {
  return [
    { seq: (seq += 1), kind: 'tool_call', toolCallId: id, name: 'mcp__tm8__tm8_act', args: CREATE_ARGS, state: 'running' },
  ];
}

const row = (container: HTMLElement) => container.querySelector('.tch-live') as HTMLElement;
const text = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('each phase', () => {
  /* `sending` / `waiting` are what the old transcript wait row stood for, and
     every existing assertion (and lane 1's) finds it by this id, role and
     class — pinned by the coordinator so the two lanes cannot drift. */
  it('sending: the old wait row’s id, role and class, and nothing to time yet', () => {
    const { container } = render(<LiveTurnStatus turn={turn({ phase: 'sending', messageId: null, lastFrameAt: null })} parts={null} />);
    const el = row(container);
    expect(el.dataset.testid).toBe('chat-thinking');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.classList.contains('tch-wait')).toBe(true);
    expect(el.dataset.phase).toBe('sending');
    expect(text(container, 'chat-live-now')).toBe('Sending your message…');
    expect(text(container, 'chat-live-meta')).toBeNull();
    expect(container.querySelector('[data-testid="ribbon-mark"]')).not.toBeNull();
  });

  it('waiting: Thinking…, timed from the send', () => {
    vi.setSystemTime(T0 + 14 * S);
    const { container } = render(<LiveTurnStatus turn={turn({ phase: 'waiting', lastFrameAt: null })} parts={[]} />);
    expect(row(container).dataset.testid).toBe('chat-thinking');
    expect(text(container, 'chat-live-now')).toBe('Thinking…');
    expect(text(container, 'chat-live-meta')).toBe('14s');
  });

  it('streaming, a step running: its present tense, and a different test id', () => {
    const parts = bash('b1');
    const { container } = render(<LiveTurnStatus turn={turn()} parts={parts} />);
    const el = row(container);
    expect(el.dataset.testid).toBe('chat-live-turn');
    expect(el.classList.contains('tch-wait')).toBe(false);
    const words = describeToolStep('Bash', BASH_ARGS);
    expect(text(container, 'chat-live-now')).toBe(`${words.active}…`);
    // The agent's own description of the command rides muted beside it.
    expect(text(container, 'chat-live-aside')).toBe(words.detail);
    expect(text(container, 'chat-live-meta')).toBe('step 1 · 0s');
  });

  it('streaming, a create running: the title is in the sentence', () => {
    const { container } = render(<LiveTurnStatus turn={turn()} parts={create('c1')} />);
    expect(text(container, 'chat-live-now')).toBe(`${describeToolStep('mcp__tm8__tm8_act', CREATE_ARGS).active}…`);
    expect(text(container, 'chat-live-now')).toContain('Provider interface');
  });

  /** The USUAL state of a turn (lane 1: ~0.4s tools, then ~12s of model
   *  silence). The finished step is NOT kept in the present tense. */
  it('streaming, between blocks: Thinking…, with the settled step muted', () => {
    const { container } = render(<LiveTurnStatus turn={turn()} parts={bash('b1', true)} />);
    expect(text(container, 'chat-live-now')).toBe('Thinking…');
    expect(text(container, 'chat-live-aside')).toContain(describeToolStep('Bash', BASH_ARGS, 'ok').done);
  });

  it('stopping: the spinner keeps turning', () => {
    const { container } = render(<LiveTurnStatus turn={turn({ phase: 'stopping' })} parts={bash('b1', true)} />);
    expect(row(container).dataset.testid).toBe('chat-live-turn');
    expect(text(container, 'chat-live-now')).toBe('Stopping…');
    expect(container.querySelector('[data-testid="ribbon-mark"]')).not.toBeNull();
  });

  it('stopped: ■, frozen, and no timer left running', () => {
    const parts = [...bash('b1', true), ...bash('b2')];
    const { container } = render(
      <LiveTurnStatus turn={turn({ phase: 'stopped', lastFrameAt: T0 + 30 * S, endedAt: T0 + 72 * S })} parts={parts} />,
    );
    expect(container.querySelector('[data-testid="ribbon-mark"]')).toBeNull();
    expect(container.querySelector('.tch-live__glyph--stopped')?.textContent).toBe('■');
    expect(text(container, 'chat-live-now')).toBe('Stopped');
    expect(text(container, 'chat-live-aside')).toBe('after 2 steps · 1m 12s');
    expect(text(container, 'chat-live-meta')).toBeNull();
    const before = container.textContent;
    act(() => {
      vi.advanceTimersByTime(60 * S);
    });
    expect(container.textContent).toBe(before);
    // A frozen row must not keep an interval alive for a number that no longer moves.
    expect(vi.getTimerCount()).toBe(0);
  });

  /** D16: the transcript already renders the error part as `role=alert`. */
  it('failed: ✕, the step count, and not the error text a second time', () => {
    const { container } = render(
      <TranscriptDock
        turn={turn({ phase: 'failed', error: 'Provider refused the request', endedAt: T0 + 5 * S })}
        parts={bash('b1', true)}
        away={false}
        unseen={0}
        onJump={() => {}}
      />,
    );
    expect(container.querySelector('.tch-live__glyph--failed')?.textContent).toBe('✕');
    expect(text(container, 'chat-live-now')).toBe('Turn failed');
    expect(text(container, 'chat-live-aside')).toBe('after 1 step · 5s');
    expect(container.textContent).not.toContain('Provider refused');
    // The failed card's red edge hangs off the dock's phase (live-turn-status.css).
    expect((container.querySelector('[data-testid="chat-dock"]') as HTMLElement).dataset.phase).toBe('failed');
  });
});

describe('the clock', () => {
  it('ticks once a second and shows the silence only from 5s (D3)', () => {
    const { container } = render(<LiveTurnStatus turn={turn()} parts={bash('b1', true)} />);
    expect(text(container, 'chat-live-meta')).toBe('step 1 · 0s');
    act(() => {
      vi.advanceTimersByTime(4 * S);
    });
    expect(text(container, 'chat-live-meta')).toBe('step 1 · 4s');
    act(() => {
      vi.advanceTimersByTime(S);
    });
    expect(text(container, 'chat-live-meta')).toBe('step 1 · 5s · last step 5s ago');
  });

  it('turns calm into `still working` past 90s, in the wait tone, never an error one', () => {
    const { container } = render(<LiveTurnStatus turn={turn()} parts={bash('b1', true)} />);
    expect(row(container).dataset.quiet).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(100 * S);
    });
    expect(row(container).dataset.quiet).toBe('long');
    expect(text(container, 'chat-live-meta')).toBe('step 1 · 1m 40s · still working · 1m 40s since last step');
  });
});

describe('a11y — one status region, and it is not chatty (D4 / D16.5)', () => {
  it('everything visible is aria-hidden; the region speaks one sentence with no clock', () => {
    const { container } = render(<LiveTurnStatus turn={turn()} parts={bash('b1', true)} />);
    act(() => {
      vi.advanceTimersByTime(40 * S);
    });
    expect(container.querySelector('.tch-live__mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.tch-live__now')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.tch-live__aside')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.tch-live__meta')?.getAttribute('aria-hidden')).toBe('true');
    const spoken = container.querySelector('[data-testid="chat-live-announcement"]')!;
    expect(spoken.closest('[aria-hidden="true"]')).toBeNull();
    expect(spoken.textContent).toBe('Thinking…');
    expect(row(container).getAttribute('aria-atomic')).toBe('true');
  });

  it('a new step inside 10s is said late, as the LATEST words; a phase change at once', () => {
    const first = bash('b1');
    const { container, rerender } = render(<LiveTurnStatus turn={turn()} parts={first} />);
    const spoken = () => text(container, 'chat-live-announcement');
    const bashNow = `${describeToolStep('Bash', BASH_ARGS).active}…`;
    expect(spoken()).toBe(bashNow);

    act(() => {
      vi.advanceTimersByTime(2 * S);
    });
    const next = [...first, { seq: (seq += 1), kind: 'tool_result' as const, toolCallId: 'b1', content: 'ok' }, ...create('c1')];
    rerender(<LiveTurnStatus turn={turn({ lastFrameAt: T0 + 2 * S })} parts={next} />);
    const createNow = `${describeToolStep('mcp__tm8__tm8_act', CREATE_ARGS).active}…`;
    expect(text(container, 'chat-live-now')).toBe(createNow); // the eye sees it at once
    expect(spoken()).toBe(bashNow); // the ear does not, yet
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_MS - 2 * S);
    });
    expect(spoken()).toBe(createNow);

    rerender(<LiveTurnStatus turn={turn({ phase: 'stopping', lastFrameAt: T0 + 2 * S })} parts={next} />);
    expect(spoken()).toBe('Stopping…');
  });

  it('announces the 90s escalation exactly once', () => {
    const { container } = render(<LiveTurnStatus turn={turn()} parts={bash('b1', true)} />);
    const spoken = () => text(container, 'chat-live-announcement');
    // Sampled at every tick for five minutes: each CHANGE is one announcement.
    const said: string[] = [];
    let last = spoken();
    for (let second = 0; second < 300; second += 1) {
      act(() => {
        vi.advanceTimersByTime(S);
      });
      if (spoken() !== last) said.push((last = spoken()) ?? '');
    }
    expect(said).toEqual(['Still working, 1m 30s since the last step']);
  });
});

describe('the dock and the way back (D5 / D16.4)', () => {
  const dock = (container: HTMLElement) => container.querySelector('[data-testid="chat-dock"]') as HTMLElement | null;

  it('renders nothing when no turn is in flight and the reader is at the end — done unmounts', () => {
    const { container, rerender } = render(
      <TranscriptDock turn={turn()} parts={bash('b1')} away={false} unseen={0} onJump={() => {}} />,
    );
    expect(dock(container)).not.toBeNull();
    rerender(<TranscriptDock turn={null} parts={null} away={false} unseen={0} onJump={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('a reader away with no turn gets the pill alone, not a card', () => {
    const onJump = vi.fn();
    const { container, getByRole } = render(
      <TranscriptDock turn={null} parts={null} away unseen={0} onJump={onJump} />,
    );
    expect(dock(container)!.dataset.live).toBeUndefined();
    expect(container.querySelector('.tch-live')).toBeNull();
    const pill = getByRole('button', { name: 'Jump to latest' });
    fireEvent.click(pill);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('while a turn runs the pill sits in the card’s right slot, and counts new messages', () => {
    const { container, getByRole } = render(
      <TranscriptDock turn={turn()} parts={bash('b1')} away unseen={3} onJump={() => {}} />,
    );
    const card = dock(container)!;
    expect(card.dataset.live).toBe('true');
    const pill = getByRole('button', { name: 'Jump to latest · 3 new' });
    expect(pill.parentElement).toBe(card);
    expect(card.lastElementChild).toBe(pill);
    // The pill is NOT inside the status region, or its label would be announced.
    expect(pill.closest('[role="status"]')).toBeNull();
  });

  it('the dock opts out of the transcript’s live region', () => {
    const { container } = render(<TranscriptDock turn={turn()} parts={[]} away unseen={1} onJump={() => {}} />);
    expect(dock(container)!.getAttribute('aria-live')).toBe('off');
  });
});

describe('R8 — no tool name reaches the surface', () => {
  it.each(['Bash', 'mcp__tm8__tm8_act', 'mcp__tm8__tm8_read', 'repo_grep', 'unknown_tool_x'])('%s', (name) => {
    const parts: ChatTurnPart[] = [
      { seq: 1, kind: 'tool_call', toolCallId: 't', name, args: { operation: 'entities.get', params: { id: 'x' } }, state: 'running' },
    ];
    const { container, rerender } = render(<LiveTurnStatus turn={turn()} parts={parts} />);
    expect(container.textContent).not.toContain(name);
    rerender(
      <LiveTurnStatus
        turn={turn()}
        parts={[...parts, { seq: 2, kind: 'tool_result', toolCallId: 't', content: { ok: true } }]}
      />,
    );
    expect(container.textContent).not.toContain(name);
    expect(container.textContent).not.toMatch(/tm8_|mcp__|entities\./);
  });
});
