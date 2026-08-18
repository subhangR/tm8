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
    ...over,
  } as SessionTranscriptPage;
}

function seamWith(p: SessionTranscriptPage | Error, prompt = vi.fn().mockResolvedValue({ ok: true })) {
  return {
    transcript: vi.fn(() => (p instanceof Error ? Promise.reject(p) : Promise.resolve(p))),
    commands: { prompt },
  } as never;
}

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

  // A tail read has turns above the first one shown. Saying nothing would let
  // the first visible turn read as the session's beginning.
  it('marks a partial read as a tail rather than a beginning', async () => {
    const partial = page({ stats: { ...page().stats!, partial: true } });
    render(<TranscriptSurface seam={seamWith(partial)} sessionId={SESSION} liveness="live" />);
    const note = await screen.findByTestId('transcript-tail-boundary');
    expect(note.textContent).toMatch(/read as a tail/i);
  });

  it('does not claim a tail when the whole transcript was read', async () => {
    render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />);
    await screen.findByTestId('transcript-turns');
    expect(screen.queryByTestId('transcript-tail-boundary')).toBeNull();
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
