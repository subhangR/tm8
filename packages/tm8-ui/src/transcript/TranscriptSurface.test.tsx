// @vitest-environment jsdom
/**
 * The Transcript surface's claims, tested as claims.
 *
 * Most of these are honesty properties rather than behaviour: what the surface
 * may say about a transcript it has only partly read, what it may call the
 * person on the right-hand side, and where the composer's text actually goes.
 * Each one is here because getting it wrong would mislead a reader rather than
 * merely look wrong.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptPage } from '@tm8/contract';
import { TranscriptSurface } from './TranscriptSurface';

const SESSION = '01900000-0000-7000-8000-0000000000a1';

function page(over: Partial<SessionTranscriptPage> = {}): SessionTranscriptPage {
  return {
    available: true,
    unavailableReason: null,
    agentTool: 'claude',
    lastActivityAt: '2026-08-18T10:00:00.000Z',
    entries: [
      { at: '2026-08-18T09:59:00.000Z', source: 'user', text: 'Fix the resize race', truncated: false },
      {
        at: '2026-08-18T10:00:00.000Z',
        source: 'assistant',
        text: 'Reading the PTY resize path',
        truncated: false,
      },
    ],
    stats: {
      assistantMessages: 1,
      userMessages: 1,
      toolCalls: 3,
      inputTokens: null,
      outputTokens: null,
      models: [],
      tools: [],
      partial: false,
    },
    malformed: 0,
    stuck: null,
    // The whole file, by default: the surface's claim that this is where the
    // session began has to be EARNED, so a fixture must opt into `hasOlder`
    // rather than get it for free.
    windowStart: 0,
    hasOlder: false,
    ...over,
  } as SessionTranscriptPage;
}

function seamWith(p: SessionTranscriptPage | Error, prompt = vi.fn().mockResolvedValue({ ok: true })) {
  return {
    transcript: vi.fn(() => (p instanceof Error ? Promise.reject(p) : Promise.resolve(p))),
    commands: { prompt },
  } as never;
}

/**
 * A seam that answers each `before` cursor with a genuinely EARLIER window.
 *
 * Written as a lookup from cursor to page rather than "return the next thing in
 * a list", because the thing under test is that the surface sends back the
 * cursor it was given. A seam that ignored `before` and served pages in order
 * would pass a paging test while the surface asked for nothing at all.
 */
function pagingSeam(pages: Record<'tail' | number, SessionTranscriptPage>) {
  const transcript = vi.fn((_id: string, opts?: { before?: number }) => {
    const key = opts?.before === undefined ? 'tail' : opts.before;
    const hit = pages[key as 'tail' | number];
    return hit === undefined
      ? Promise.reject(new Error(`no fixture window for cursor ${String(key)}`))
      : Promise.resolve(hit);
  });
  return { seam: { transcript, commands: { prompt: vi.fn() } } as never, transcript };
}

const turn = (text: string) => ({
  at: '2026-08-18T09:00:00.000Z',
  source: 'assistant' as const,
  text,
  truncated: false,
});

describe('the Transcript surface', () => {
  it('renders the turns oldest-first, as the server sends them', async () => {
    render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />);
    const turns = await screen.findByTestId('transcript-turns');
    const texts = [...turns.querySelectorAll('.tr-turn')].map((n) => n.textContent ?? '');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/Fix the resize race/);
    expect(texts[1]).toMatch(/Reading the PTY resize path/);
  });

  /**
   * `source` is a bare binary with no author entity, so two humans injecting
   * into one session are indistinguishable. The surface may therefore say
   * "user" and may NOT say "you" — the right-hand side means "arrived as
   * input", not "was written by the viewer".
   */
  it('labels the input side by role and never claims it was the viewer', async () => {
    render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />);
    const turns = await screen.findByTestId('transcript-turns');
    const input = turns.querySelector('.tr-turn[data-source="user"]');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('data-input')).toBe('true');
    // The byline's own name, not the whole turn — the avatar monogram runs
    // straight into the label in `textContent`.
    expect(input!.querySelector('.tr-turn__byline strong')!.textContent).toBe('user');
    expect(
      input!.querySelector('.tr-turn__byline')!.textContent,
    ).not.toMatch(/\byou\b/i);
    expect(
      turns.querySelector('.tr-turn[data-source="assistant"]')!.getAttribute('data-input'),
    ).toBe('false');
  });

  // A window that does not reach the first byte has turns above the first one
  // shown. Saying nothing would let the first visible turn read as the
  // session's beginning, which is the lie this line exists to prevent.
  it('says earlier turns exist, and offers a way to go get them', async () => {
    const partial = page({ windowStart: 4096, hasOlder: true });
    render(<TranscriptSurface seam={seamWith(partial)} sessionId={SESSION} liveness="live" />);
    const note = await screen.findByTestId('transcript-tail-boundary');
    expect(note.textContent).toMatch(/earlier turns exist/i);
    // The manual control is the FALLBACK the observer is allowed to fail
    // behind, so it has to be a real focusable button and not a hover target.
    const button = screen.getByTestId('transcript-load-older');
    expect(button.tagName).toBe('BUTTON');
    // The retired claim. It was true before there was a cursor and is false now.
    expect(document.body.textContent).not.toMatch(/cannot be paged back to/i);
  });

  /**
   * The one claim on this surface that has to be EARNED: the server reached the
   * first byte of the file, so this really is where the session began. It must
   * never be the default a page falls into.
   */
  it('claims the beginning of the session only when nothing is older', async () => {
    render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />);
    const start = await screen.findByTestId('transcript-start-boundary');
    expect(start.textContent).toMatch(/beginning of the session/i);
    expect(screen.queryByTestId('transcript-tail-boundary')).toBeNull();
    expect(screen.queryByTestId('transcript-load-older')).toBeNull();
  });

  describe('walking back through the session', () => {
    const windows = () => ({
      tail: page({ entries: [turn('the newest turn')], windowStart: 900, hasOlder: true }),
      900: page({ entries: [turn('the middle turn')], windowStart: 400, hasOlder: true }),
      400: page({ entries: [turn('the first turn')], windowStart: 0, hasOlder: false }),
    });

    it('asks for the window before the oldest one it holds, by its cursor', async () => {
      const { seam, transcript } = pagingSeam(windows());
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />);
      fireEvent.click(await screen.findByTestId('transcript-load-older'));

      await waitFor(() => {
        expect(transcript).toHaveBeenCalledWith(SESSION, { before: 900 });
      });
      // The SECOND walk must use the cursor the SECOND page reported, not an
      // arithmetic guess from the first — real turns are wildly uneven in size.
      fireEvent.click(await screen.findByTestId('transcript-load-older'));
      await waitFor(() => {
        expect(transcript).toHaveBeenCalledWith(SESSION, { before: 400 });
      });
    });

    it('prepends older turns above the ones already on screen, in order', async () => {
      const { seam } = pagingSeam(windows());
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />);
      fireEvent.click(await screen.findByTestId('transcript-load-older'));
      await screen.findByText('the middle turn');
      fireEvent.click(screen.getByTestId('transcript-load-older'));
      await screen.findByText('the first turn');

      const texts = [...screen.getByTestId('transcript-turns').querySelectorAll('.tr-turn')]
        .map((n) => n.textContent ?? '');
      // Oldest-first across the whole walk: the accumulation reads as one
      // conversation, not as three windows stacked in arrival order.
      expect(texts[0]).toMatch(/the first turn/);
      expect(texts[1]).toMatch(/the middle turn/);
      expect(texts[2]).toMatch(/the newest turn/);
    });

    it('earns the beginning claim only after the walk reaches byte 0', async () => {
      const { seam } = pagingSeam(windows());
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />);
      await screen.findByTestId('transcript-tail-boundary');
      fireEvent.click(screen.getByTestId('transcript-load-older'));
      await screen.findByText('the middle turn');
      // Still not the beginning: one more window exists below this one.
      expect(screen.queryByTestId('transcript-start-boundary')).toBeNull();
      fireEvent.click(screen.getByTestId('transcript-load-older'));
      await screen.findByTestId('transcript-start-boundary');
      expect(screen.queryByTestId('transcript-load-older')).toBeNull();
    });

    // Same rule as the poll: a read that fails must not cost the reader the
    // turns they already had. It reports itself and offers the walk again.
    it('reports a failed walk without blanking what is on screen', async () => {
      const { seam } = pagingSeam({
        tail: page({ entries: [turn('the newest turn')], windowStart: 900, hasOlder: true }),
      });
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />);
      fireEvent.click(await screen.findByTestId('transcript-load-older'));

      await waitFor(() => {
        expect(screen.getByTestId('transcript-tail-boundary').textContent)
          .toMatch(/no fixture window for cursor 900/);
      });
      expect(screen.getByText('the newest turn')).toBeTruthy();
      expect(screen.queryByTestId('transcript-error')).toBeNull();
      expect(screen.getByTestId('transcript-load-older').textContent).toMatch(/try earlier turns/i);
    });

    /**
     * THE POLL PAUSE. The newest window is a tail, so its start slides forward
     * as the file grows; replacing it under an accumulation would open a hole
     * in the middle of the reader's history that no cursor points at. There is
     * no "after" cursor to close such a hole with, so the surface stops the
     * poll instead and says so.
     */
    it('stops polling while the reader is holding older windows, and says so', async () => {
      vi.useFakeTimers();
      try {
        const { seam, transcript } = pagingSeam(windows());
        render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="live" />);
        await vi.advanceTimersByTimeAsync(0);
        fireEvent.click(screen.getByTestId('transcript-load-older'));
        await vi.advanceTimersByTimeAsync(0);

        const afterWalk = transcript.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(transcript.mock.calls.length).toBe(afterWalk);
        expect(screen.getByTestId('transcript-poll-paused').textContent)
          .toMatch(/not being loaded while you read earlier ones/i);

        // Resuming drops the walk and re-reads the tail — the one refresh that
        // cannot leave a gap.
        fireEvent.click(screen.getByRole('button', { name: /back to the newest turns/i }));
        await vi.advanceTimersByTimeAsync(0);
        expect(transcript.mock.calls.length).toBeGreaterThan(afterWalk);
        expect(screen.queryByTestId('transcript-poll-paused')).toBeNull();
        expect(screen.queryByText('the middle turn')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // An absent transcript is a real and common state — not an error, and often
  // permanent. It names the node's own reason instead of showing nothing.
  it('explains an unavailable transcript with the node’s reason', async () => {
    const none = page({ available: false, unavailableReason: 'unsupported_agent_tool', entries: [], stats: null });
    render(<TranscriptSurface seam={seamWith(none)} sessionId={SESSION} liveness="live" />);
    const empty = await screen.findByTestId('transcript-empty');
    expect(empty.textContent).toMatch(/writes no transcript/i);
  });

  describe('the composer', () => {
    /**
     * THE CLAIM THAT MATTERS MOST. The box looks like every other composer in
     * the app and does something else entirely: it types into the session's
     * PTY. If this ever silently became `messages.post`, the surface would be
     * lying about where a reader's words went.
     */
    it('injects into the PTY via execution.prompt, and posts no message', async () => {
      const prompt = vi.fn().mockResolvedValue({ ok: true });
      const seam = seamWith(page(), prompt);
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="live" />);

      const field = await screen.findByLabelText(/send input to this session/i);
      fireEvent.change(field, { target: { value: 'ls -la' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => {
        expect(prompt).toHaveBeenCalledWith(SESSION, { message: 'ls -la' });
      });
      // Cleared, not echoed: there is no message id to echo with, and the turn
      // appears only when the agent writes it to the transcript.
      await waitFor(() => {
        expect((field as HTMLTextAreaElement).value).toBe('');
      });
    });

    it('says plainly that input goes to the terminal, not to a message feed', async () => {
      render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />);
      await screen.findByTestId('transcript-composer');
      expect(document.body.textContent).toMatch(/typed into the session’s terminal, not posted as a message/i);
    });

    // A session with no live PTY has nowhere to put the bytes. Hiding the box
    // would leave a reader wondering whether input was ever possible.
    it('refuses with a reason instead of disappearing when nothing is running', async () => {
      render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="not-running" />);
      const refusal = await screen.findByTestId('transcript-composer-unavailable');
      expect(refusal.textContent).toMatch(/unavailable/i);
      expect(screen.queryByTestId('transcript-composer')).toBeNull();
    });

    it('surfaces a rejected injection rather than swallowing it', async () => {
      const prompt = vi.fn().mockRejectedValue(new Error('no pty for this session'));
      render(
        <TranscriptSurface seam={seamWith(page(), prompt)} sessionId={SESSION} liveness="live" />,
      );
      const field = await screen.findByLabelText(/send input to this session/i);
      fireEvent.change(field, { target: { value: 'echo hi' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      const err = await screen.findByTestId('transcript-composer-error');
      expect(err.textContent).toMatch(/no pty for this session/);
      // The text is KEPT on failure — retyping a lost message is the one thing
      // a failed send must not cost.
      expect((field as HTMLTextAreaElement).value).toBe('echo hi');
    });
  });

  /**
   * A transcript is frozen once its session exits, so polling it forever is
   * pure waste. Liveness — not the mount — decides.
   */
  it('reads once and does not poll a session that is not live', async () => {
    vi.useFakeTimers();
    try {
      const seam = seamWith(page());
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seam.transcript).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls while the session is live', async () => {
    vi.useFakeTimers();
    try {
      const seam = seamWith(page());
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="live" />);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(seam.transcript.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
