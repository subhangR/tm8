// @vitest-environment jsdom
// The panel bar's context number: what it says, and how it reads.
//
// The derivation is tested bare (`readContext`) so each honesty rule is one
// assertion; the component is tested for the things only a render can show —
// the shared poll, the sample's own age, the disclosure, and its fit.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptContext, SessionTranscriptPage } from '@tm8/contract';
import { ageLabel } from '../kit/time';
import { compactTokens, readContext } from './context-reading';
import { SessionContextNumber } from './SessionContextNumber';
import { useSessionTranscript } from './useSessionTranscript';
import { subscribeTail, type TailSnapshot } from './tail-resource';

const SESSION = '01a0c9ce-c6d7-725d-b087-89eb536b27f8' as never;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');

function ctx(over: Partial<SessionTranscriptContext> = {}): SessionTranscriptContext {
  return {
    usedTokens: 48_000,
    capacityTokens: 200_000,
    cacheReadTokens: 38_400,
    requestInputTokens: 48_000,
    model: 'gpt-6-astra',
    observedAt: new Date(T0).toISOString(),
    source: 'codex_request_usage',
    capacitySource: 'provider',
    unavailableReason: null,
    ...over,
  };
}

function page(context: SessionTranscriptContext | null | undefined, over: Partial<SessionTranscriptPage> = {}) {
  return {
    sessionId: SESSION,
    available: true,
    unavailableReason: null,
    searchedPaths: [],
    agentTool: 'codex',
    entries: [],
    stats: null,
    stuck: null,
    lastActivityAt: null,
    malformed: 0,
    windowStart: 0,
    hasOlder: false,
    ...(context === undefined ? {} : { context }),
    ...over,
  } as SessionTranscriptPage;
}

function snap(p: SessionTranscriptPage | null, over: Partial<TailSnapshot> = {}): TailSnapshot {
  return { page: p, error: null, errorAt: null, receivedAt: T0, ...over };
}

describe('readContext', () => {
  it('reads occupancy, percentage, same-request cache reuse and the sample age', () => {
    const r = readContext(snap(page(ctx())), null, T0 + 8_000);
    expect([r.used, r.percent, r.cache, r.age]).toEqual(['48k', '24%', '80%', '8s ago']);
    expect(r.label).toMatch(/48,000 tokens of 200,000, 24%/);
    const byTerm = Object.fromEntries(r.details.map((d) => [d.term, d.value]));
    expect(byTerm.Capacity).toMatch(/^200,000 tokens \(reported by provider\)/);
    expect(byTerm.Remaining).toBe('152,000 tokens');
  });

  it('shows no percentage without a known capacity, and says so', () => {
    const r = readContext(snap(page(ctx({ capacityTokens: null, capacitySource: null }))), null, T0);
    expect(r.percent).toBeNull();
    expect(r.used).toBe('48k');
    expect(r.details.find((d) => d.term === 'Capacity')?.value).toMatch(/unknown/);
    expect(r.details.find((d) => d.term === 'Remaining')).toBeUndefined();
  });

  it('keeps a reported zero apart from an unknown', () => {
    const zero = readContext(snap(page(ctx({ cacheReadTokens: 0 }))), null, T0);
    expect(zero.cache).toBe('0%');
    const hollow = readContext(snap(page(ctx({ cacheReadTokens: null }))), null, T0);
    expect(hollow.cache).toBe('—');
    const nothing = readContext(
      snap(page(ctx({ usedTokens: null, requestInputTokens: null, unavailableReason: 'incomplete_usage' }))),
      null,
      T0,
    );
    expect(nothing.used).toBe('—');
    expect(nothing.tone).toBe('unknown');
    expect(nothing.label).toMatch(/full input split/);
  });

  it('never reports negative room when over capacity', () => {
    const r = readContext(snap(page(ctx({ usedTokens: 210_000, requestInputTokens: 210_000 }))), null, T0);
    expect(r.percent).toBe('105%');
    expect(r.details.find((d) => d.term === 'Remaining')?.value).toBe('none — over by 10,000 tokens');
  });

  it('carries the last sample past a window with none, and says it is last known', () => {
    const outside = ctx({ usedTokens: null, requestInputTokens: null, observedAt: null, unavailableReason: 'sample_outside_window' });
    const r = readContext(snap(page(outside)), ctx(), T0 + 3_000);
    expect(r.lastKnown).toBe(true);
    expect(r.used).toBe('48k');
    expect(r.age).toBe('3s ago');
    expect(r.label).toMatch(/^Last known/);
  });

  it('drops the old sample after compaction instead of carrying it', () => {
    const compacted = ctx({ usedTokens: null, requestInputTokens: null, unavailableReason: 'awaiting_new_sample' });
    const r = readContext(snap(page(compacted)), ctx(), T0);
    expect(r.used).toBe('—');
    expect(r.label).toMatch(/compacted/);
  });

  it('keeps the reading through a failed poll and flags it delayed', () => {
    const r = readContext(snap(page(ctx()), { error: 'node timed out', errorAt: T0 + 5_000 }), null, T0 + 9_000);
    expect(r.used).toBe('48k');
    expect(r.tone).toBe('delayed');
    expect(r.label).toMatch(/update delayed/);
  });

  it('separates loading, a failed first read, and an older server', () => {
    expect(readContext(snap(null, { receivedAt: null }), null, T0).used).toBe('…');
    expect(readContext(snap(null, { error: 'boom', errorAt: T0 }), null, T0).used).toBe('—');
    expect(readContext(snap(page(undefined)), null, T0).label).toMatch(/does not report/);
  });

  it('reads a garbled or future sample time as unknown, never as 0s', () => {
    expect(readContext(snap(page(ctx({ observedAt: 'nope' }))), null, T0).age).toBeNull();
    expect(ageLabel(T0 + 60_000, T0)).toBeNull();
    expect(ageLabel(T0 + 2_000, T0)).toBe('0s');
    expect(ageLabel(T0 - 3 * 3_600_000, T0)).toBe('3h');
  });

  it('compacts counts without rounding up past what was used', () => {
    expect([compactTokens(0), compactTokens(999), compactTokens(9_999), compactTokens(136_717), compactTokens(1_250_000)])
      .toEqual(['0', '999', '9.9k', '137k', '1.2M']);
  });
});

describe('SessionContextNumber', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** Drain microtasks under fake timers without moving the clock. */
  async function settle() {
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
  }

  it('ages from the sample time, and an unchanged poll does not reset it', async () => {
    vi.useFakeTimers({ now: T0 + 8_000 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    render(<SessionContextNumber seam={{ transcript }} sessionId={SESSION} live />);
    await settle();
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('48k · 24% · cache 80% · 8s ago');

    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(transcript.mock.calls.length).toBe(2);
    expect(button.textContent).toBe('48k · 24% · cache 80% · 13s ago');
  });

  it('shares ONE poll with a Transcript reader on the same session', async () => {
    vi.useFakeTimers({ now: T0 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    const seam = { transcript };
    function Reader() {
      useSessionTranscript(seam, SESSION, { intervalMs: 5_000 });
      return null;
    }
    render(
      <>
        <SessionContextNumber seam={seam} sessionId={SESSION} live />
        <Reader />
      </>,
    );
    await settle();
    expect(transcript).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    // One read per 5s tick between them, not two.
    expect(transcript.mock.calls.length).toBeLessThanOrEqual(5);
    // …and never the full-file scan.
    for (const call of transcript.mock.calls as unknown[][]) expect(call[1]).toBeUndefined();
  });

  it('never stacks reads behind a slow node', async () => {
    vi.useFakeTimers({ now: T0 });
    const transcript = vi.fn(() => new Promise<SessionTranscriptPage>(() => {}));
    render(<SessionContextNumber seam={{ transcript }} sessionId={SESSION} live />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transcript).toHaveBeenCalledTimes(1);
  });

  it('reads once and stops for a session that is not live', async () => {
    vi.useFakeTimers({ now: T0 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    render(<SessionContextNumber seam={{ transcript }} sessionId={SESSION} live={false} />);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transcript).toHaveBeenCalledTimes(1);
  });

  it('reads one final time when the session stops being live', async () => {
    vi.useFakeTimers({ now: T0 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    const seam = { transcript };
    const { rerender } = render(<SessionContextNumber seam={seam} sessionId={SESSION} live />);
    await settle();
    rerender(<SessionContextNumber seam={seam} sessionId={SESSION} live={false} />);
    await settle();
    expect(transcript).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transcript).toHaveBeenCalledTimes(2);
  });

  it('opens exact counts on press, and Escape closes it back to the button', async () => {
    vi.useFakeTimers({ now: T0 + 8_000 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    render(<SessionContextNumber seam={{ transcript }} sessionId={SESSION} live={false} />);
    await settle();
    const button = screen.getByRole('button');
    // Label in name: the accessible name opens with the visible text.
    expect(button.getAttribute('aria-label')?.startsWith(`${button.textContent ?? ''} — `)).toBe(true);
    expect(button.getAttribute('aria-label')).toMatch(/Context 48,000 tokens of 200,000, 24%/);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Not a live region: a per-second number must never be announced.
    expect(document.querySelector('[aria-live]')).toBeNull();

    button.focus();
    fireEvent.click(button);
    const details = screen.getByRole('group', { name: 'Context details' });
    expect(button.getAttribute('aria-controls')).toBe(details.id);
    expect(details.textContent).toMatch(/200,000 tokens/);
    expect(details.textContent).toMatch(/152,000 tokens/);
    expect(details.textContent).toMatch(/gpt-6-astra/);

    // The panel stack listens for Esc on window; closing the details must
    // not also close the panel under them.
    const panelEsc = vi.fn();
    window.addEventListener('keydown', panelEsc);
    try {
      act(() => {
        fireEvent.keyDown(button, { key: 'Escape' });
      });
    } finally {
      window.removeEventListener('keydown', panelEsc);
    }
    expect(panelEsc).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Context details' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('never brings a pre-compaction sample back as last known', async () => {
    vi.useFakeTimers({ now: T0 + 8_000 });
    const pages = [
      page(ctx()),
      page(ctx({ usedTokens: null, requestInputTokens: null, cacheReadTokens: null, unavailableReason: 'awaiting_new_sample' })),
      page(ctx({ usedTokens: null, requestInputTokens: null, cacheReadTokens: null, observedAt: null, unavailableReason: 'sample_outside_window' })),
    ];
    let i = 0;
    const transcript = vi.fn(() => Promise.resolve(pages[Math.min(i++, pages.length - 1)]));
    render(<SessionContextNumber seam={{ transcript }} sessionId={SESSION} live />);
    await settle();
    const button = screen.getByRole('button');
    expect(button.textContent).toMatch(/^48k/);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(button.textContent).toBe('—');
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(transcript).toHaveBeenCalledTimes(3);
    expect(button.textContent).toBe('—');
    expect(button.getAttribute('aria-label')).not.toMatch(/Last known/);
  });

  it('carries a sample past a window with none when nothing retired it', async () => {
    vi.useFakeTimers({ now: T0 + 8_000 });
    const pages = [
      page(ctx()),
      page(ctx({ usedTokens: null, requestInputTokens: null, cacheReadTokens: null, observedAt: null, unavailableReason: 'sample_outside_window' })),
    ];
    let i = 0;
    const transcript = vi.fn(() => Promise.resolve(pages[Math.min(i++, pages.length - 1)]));
    render(<SessionContextNumber seam={{ transcript }} sessionId={SESSION} live />);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(screen.getByRole('button').textContent).toMatch(/^~48k/);
  });

  it('a pause stops polling without a final read; an exit takes one', async () => {
    vi.useFakeTimers({ now: T0 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    const seam = { transcript };
    const sub = subscribeTail(seam, SESSION, () => {}, 5_000);
    await settle();
    expect(transcript).toHaveBeenCalledTimes(1);
    sub.setInterval(null, { finalRead: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transcript).toHaveBeenCalledTimes(1);
    sub.setInterval(5_000);
    sub.setInterval(null);
    await settle();
    expect(transcript).toHaveBeenCalledTimes(2);
    sub.close();
  });

  it('gives up words on a narrow bar instead of growing', async () => {
    vi.useFakeTimers({ now: T0 + 8_000 });
    const transcript = vi.fn(() => Promise.resolve(page(ctx())));
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    try {
      render(
        <div className="pn-panelbar">
          <SessionContextNumber seam={{ transcript }} sessionId={SESSION} live={false} />
        </div>,
      );
      await settle();
      expect(screen.getByRole('button').textContent).toBe('24%');
      expect(screen.getByTestId('session-context').getAttribute('data-fit')).toBe('narrow');
    } finally {
      width.mockRestore();
    }
  });
});
