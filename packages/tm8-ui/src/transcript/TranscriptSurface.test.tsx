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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptPage } from '@tm8/contract';
import { TranscriptSurface } from './TranscriptSurface';

/**
 * THE UPLOAD IS MOCKED AT THE MODULE, which is the only seam there is — the
 * composer calls `uploadClipboardFile` directly and deliberately (see its
 * docblock for why the `useRichInput` attachments spec could not be satisfied
 * honestly). Mocking it here is what lets the SPLICE be asserted: what these
 * tests are about is which string lands in the draft, and where.
 */
vi.mock('../terminal/clipboardUpload', () => ({
  uploadClipboardFile: vi.fn(),
}));
const { uploadClipboardFile } = await import('../terminal/clipboardUpload');
const upload = vi.mocked(uploadClipboardFile);

const SESSION = '01900000-0000-7000-8000-0000000000a1';

const NODE_PATH = '/Users/agent/.tm8/clipboard/shot.png';

function uploaded(path = NODE_PATH, filename = 'shot.png') {
  return { path, filename, mimeType: 'image/png', bytes: 12 };
}

/** A `DataTransfer` good enough for `extractReadableFiles`, which reads
 *  `items`, `files` and `types` and nothing else. */
function transfer(files: File[], text = '') {
  return {
    items: files.map((file) => ({ getAsFile: () => file })),
    files,
    types: files.length ? ['Files'] : text ? ['text/plain'] : [],
    getData: () => text,
  };
}

const png = (name = 'shot.png') => new File(['x'], name, { type: 'image/png' });
const zip = () => new File(['x'], 'bundle.zip', { type: 'application/zip' });

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
  beforeEach(() => {
    upload.mockReset();
    upload.mockResolvedValue(uploaded());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
     * REGRESSION (review of PR #452). `loadOlder` read the shared request
     * counter that `load()` increments, and the poll paused only once a window
     * had LANDED — so a 5s tick inside the FIRST page-back discarded the
     * fetched window and left the walk in `loading` forever. With the button
     * replaced by "Reading earlier turns…", the sentinel disabled, `loadOlder`
     * early-returning on that phase, and `pagedBack` still false so the resume
     * control was not rendered, the reader had no control at all.
     *
     * The old poll-pause test could not see it: its seam resolved
     * synchronously, so no tick could land inside the walk. This one holds the
     * walk open across a tick on purpose.
     */
    it('survives a poll tick landing inside the first page-back', async () => {
      vi.useFakeTimers();
      try {
        const pages = windows();
        let release: (() => void) | undefined;
        const transcript = vi.fn((_id: string, opts?: { before?: number }) => {
          if (opts?.before === undefined) return Promise.resolve(pages.tail);
          // Held open, so the 5s tick below lands mid-walk.
          return new Promise((resolve) => {
            release = () => { resolve(pages[900]); };
          });
        });
        const seam = { transcript, commands: { prompt: vi.fn() } } as never;
        render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="live" />);
        await vi.advanceTimersByTimeAsync(0);
        fireEvent.click(screen.getByTestId('transcript-load-older'));
        await vi.advanceTimersByTimeAsync(5_000);
        release!();
        await vi.advanceTimersByTimeAsync(0);

        // The window landed rather than being discarded...
        expect(screen.getByText('the middle turn')).toBeTruthy();
        // ...and the reader has a control again rather than a frozen spinner.
        expect(screen.getByTestId('transcript-load-older')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * REGRESSION (review of PR #452). The server cannot step past a SINGLE
     * record larger than its read budget: the window lies entirely inside one
     * record, so there is no earlier boundary to name and it returns the
     * cursor it was given. Prepending that window changed nothing, left the
     * cursor where it was, and let the control ask for the identical bytes
     * again — an unbounded loop.
     *
     * It is not an error and it is not the beginning. Both would be lies:
     * there IS more above, and this reader cannot reach it.
     */
    it('stops with a reason when a window comes back on the same cursor', async () => {
      const stuck = page({ entries: [turn('the newest turn')], windowStart: 900, hasOlder: true });
      const { seam, transcript } = pagingSeam({ tail: stuck, 900: stuck });
      render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />);
      fireEvent.click(await screen.findByTestId('transcript-load-older'));

      const stalled = await screen.findByTestId('transcript-stalled');
      expect(stalled.textContent).toMatch(/cannot be reached/i);
      expect(stalled.textContent).toMatch(/larger than the node reads in one window/i);
      // Neither a beginning nor a retry: the walk is over for this cursor.
      expect(screen.queryByTestId('transcript-start-boundary')).toBeNull();
      expect(screen.queryByTestId('transcript-load-older')).toBeNull();
      const calls = transcript.mock.calls.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(transcript.mock.calls.length).toBe(calls);
    });


    /**
     * RESIDUAL FROM RE-REVIEW (PR #452). A stall taken on the FIRST walk lands
     * while `older.length` is still 0, so the poll is running again the moment
     * the walk ends and can replace the tail with a window starting somewhere
     * else. A session-wide `stalled` went on refusing on that new cursor's
     * behalf — a cursor that had refused nothing — and the reader could not
     * walk at all.
     *
     * The refusal belongs to the bytes that earned it. When the tail moves, it
     * is lifted; the same giant record will very likely refuse the new cursor
     * too, but on its own evidence rather than on a stale verdict.
     */
    it('lifts a stall when the tail slides to a cursor that refused nothing', async () => {
      vi.useFakeTimers();
      try {
        const stuck = page({ entries: [turn('the newest turn')], windowStart: 900, hasOlder: true });
        const moved = page({ entries: [turn('a newer turn')], windowStart: 1200, hasOlder: true });
        let tail = stuck;
        const transcript = vi.fn((_id: string, opts?: { before?: number }) =>
          opts?.before === undefined ? Promise.resolve(tail) : Promise.resolve(stuck));
        const seam = { transcript, commands: { prompt: vi.fn() } } as never;
        render(<TranscriptSurface seam={seam} sessionId={SESSION} liveness="live" />);
        await vi.advanceTimersByTimeAsync(0);

        fireEvent.click(screen.getByTestId('transcript-load-older'));
        await vi.advanceTimersByTimeAsync(0);
        expect(screen.getByTestId('transcript-stalled')).toBeTruthy();

        // The poll never paused — no window was ever held — so the tail moves.
        tail = moved;
        await vi.advanceTimersByTimeAsync(5_000);

        // The poll's render and the lift it triggers are separate rounds.
        await vi.advanceTimersByTimeAsync(0);

        // A different cursor is on offer, so the refusal no longer applies.
        expect(screen.queryByTestId('transcript-stalled')).toBeNull();
        expect(screen.getByTestId('transcript-load-older')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
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

    /**
     * THE DISCLOSURE MOVED; IT DID NOT GO. It used to be a 10px paragraph
     * hanging under the card, which the user asked to have removed and which
     * this test used to find in `document.body.textContent`. The FACT is
     * load-bearing — this is the one composer here that does not post a
     * message — so it now rides the field's accessible name, its `title` and
     * its placeholder, and this test follows it there rather than being
     * deleted with the paragraph. All three are asserted, because each answers
     * a different reader: a screen reader on focus, a hover, and a glance.
     */
    it('still tells a reader the input goes to a terminal, on the field itself', async () => {
      render(<TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />);
      const field = await screen.findByLabelText(/send input to this session/i);
      const disclosure = /not posted as a message/i;
      expect(field.getAttribute('aria-label')).toMatch(disclosure);
      expect(field.getAttribute('title')).toMatch(disclosure);
      expect(field.getAttribute('placeholder')).toMatch(/terminal/i);
    });

    /**
     * THE DOUBLE BOX, held as a class seam. jsdom loads no stylesheets, so no
     * test in this file can see a border — `transcript-css.test.ts` asserts the
     * rule's absence in the sheet. What IS assertable here is the structure the
     * rule hung off: the foot holds the card and NOTHING ELSE, so there is one
     * frame's worth of markup to draw and no paragraph under it.
     */
    it('puts nothing in the foot but the card', async () => {
      const { container } = render(
        <TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />,
      );
      await screen.findByTestId('transcript-composer');
      const foot = container.querySelector('.tr-surface__foot')!;
      expect(foot.children).toHaveLength(1);
      expect(foot.firstElementChild!.classList.contains('ri-card')).toBe(true);
      // The retired paragraph, by its own class and by its old words.
      expect(container.querySelector('.tr-surface__foot-note')).toBeNull();
      expect(foot.textContent).not.toMatch(/appears above only if the agent/i);
    });

    /**
     * THE CONTROL VOCABULARY IS CHAT'S — the shared card, the shared attach
     * control and the promoted Send — and it stops exactly there. The thread
     * pickers configure a chat THREAD; a PTY has no mode, no teammate and no
     * model to set, so offering them would be three controls that cannot
     * perform.
     */
    it('adopts chat’s card, attach and Send — and none of its thread pickers', async () => {
      const { container } = render(
        <TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />,
      );
      const card = await screen.findByTestId('transcript-composer');
      expect(card.classList.contains('ri-card')).toBe(true);
      expect(container.querySelector('.ri-card__foot .ri-attach')).not.toBeNull();
      expect(container.querySelector('.ri-card__foot .ri-send')).not.toBeNull();
      // The drift this ends: a hand-rolled third copy of chat's Send.
      expect(container.querySelector('.tr-send')).toBeNull();
      expect(container.querySelector('.ri-card__foot select')).toBeNull();
      expect(screen.queryByLabelText(/chat mode|teammate|model/i)).toBeNull();
    });
  });

  /**
   * ATTACHMENTS — a file becomes a PATH IN THE DRAFT, never a graph reference.
   *
   * The destination decides the transport: Send here is `execution.prompt`,
   * which injects into the PTY, and a `tm8://file/<id>` typed at an agent's
   * stdin resolves to nothing. Every agent CLI we support reads files by path.
   */
  describe('attaching a file to a terminal draft', () => {
    const live = () => {
      const view = render(
        <TranscriptSurface seam={seamWith(page())} sessionId={SESSION} liveness="live" />,
      );
      return view;
    };

    async function field() {
      return (await screen.findByLabelText(/send input to this session/i)) as HTMLTextAreaElement;
    }

    it('uploads to the session’s node and writes the returned PATH into the draft', async () => {
      const { container } = live();
      const area = await field();
      fireEvent.change(area, { target: { value: 'what is wrong with' } });

      const picker = container.querySelector('.ri-attach__input') as HTMLInputElement;
      fireEvent.change(picker, { target: { files: [png()] } });

      await waitFor(() => {
        expect(upload).toHaveBeenCalledWith(expect.any(File), SESSION);
      });
      await waitFor(() => {
        expect(area.value).toContain(NODE_PATH);
      });
      // The path, and nothing that resolves to nothing at a stdin.
      expect(area.value).not.toMatch(/tm8:\/\/file\//);
      expect(area.value).not.toMatch(/!\[/);
    });

    /**
     * THE RULE THAT HAS BEEN GOT WRONG BEFORE. A carriage return with the path
     * submits a bare path as the whole message, before the human has said what
     * they wanted asked about it. The separator is a SPACE — the same one
     * `LiveTerminal`'s `injectFiles` has always injected.
     */
    it('never puts a newline in with the path', async () => {
      const { container } = live();
      const area = await field();
      fireEvent.change(area, { target: { value: 'read this' } });
      fireEvent.change(container.querySelector('.ri-attach__input')!, {
        target: { files: [png()] },
      });

      await waitFor(() => expect(area.value).toContain(NODE_PATH));
      expect(area.value).not.toMatch(/[\r\n]/);
      expect(area.value).toBe(`read this ${NODE_PATH} `);
    });

    // The human is still composing; the path is one more word in their
    // sentence, dropped where the cursor was rather than appended at the end.
    it('splices at the caret, not at the end', async () => {
      const { container } = live();
      const area = await field();
      fireEvent.change(area, { target: { value: 'before after' } });
      area.setSelectionRange(6, 6);
      fireEvent.change(container.querySelector('.ri-attach__input')!, {
        target: { files: [png()] },
      });

      await waitFor(() => expect(area.value).toContain(NODE_PATH));
      expect(area.value).toBe(`before ${NODE_PATH} after`);
    });

    it('takes a pasted file the same way the attach button does', async () => {
      live();
      const area = await field();
      fireEvent.paste(area, { clipboardData: transfer([png()]) });
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      await waitFor(() => expect(area.value).toContain(NODE_PATH));
    });

    it('takes a dropped file the same way', async () => {
      live();
      const area = await field();
      fireEvent.drop(area, { dataTransfer: transfer([png()]) });
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      await waitFor(() => expect(area.value).toContain(NODE_PATH));
    });

    // Files win over text; a text-only paste is not intercepted at all, or the
    // composer would have stolen the ordinary paste from the person typing.
    it('leaves a text-only paste to the browser', async () => {
      live();
      const area = await field();
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer([], 'ls -la') });
      area.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(upload).not.toHaveBeenCalled();
    });

    /**
     * A REFUSAL IS SAID OUT LOUD, with the user's own file name in it. A paste
     * that visibly does nothing reads as a broken composer rather than as a
     * refusal — the same reason `LiveTerminal` supplies an `onRefused`.
     */
    it('names a file it will not take, and why', async () => {
      live();
      const area = await field();
      fireEvent.paste(area, { clipboardData: transfer([zip()]) });

      const said = await screen.findByRole('alert');
      expect(said.textContent).toMatch(/bundle\.zip/);
      expect(said.textContent).toMatch(/agents cannot read/i);
      expect(upload).not.toHaveBeenCalled();
      // Dismissible: it is a fact about one paste, not a standing condition.
      fireEvent.click(screen.getByLabelText('Dismiss'));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('reports an upload that failed instead of dropping the file silently', async () => {
      upload.mockRejectedValue(new Error('the node refused these bytes'));
      const { container } = live();
      await field();
      fireEvent.change(container.querySelector('.ri-attach__input')!, {
        target: { files: [png()] },
      });

      const said = await screen.findByRole('alert');
      expect(said.textContent).toMatch(/shot\.png could not be attached/i);
      expect(said.textContent).toMatch(/the node refused these bytes/);
    });

    /**
     * SEND IS HELD WHILE THE FILE IS IN FLIGHT. Sending now would deliver the
     * sentence WITHOUT the path it is about, and the path would then land in an
     * empty draft the agent never sees.
     */
    it('holds Send until the upload has landed', async () => {
      let land!: (value: ReturnType<typeof uploaded>) => void;
      upload.mockReturnValue(new Promise((resolve) => { land = resolve; }));
      const { container } = live();
      const area = await field();
      fireEvent.change(area, { target: { value: 'look' } });

      const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
      expect(send.disabled).toBe(false);
      fireEvent.change(container.querySelector('.ri-attach__input')!, {
        target: { files: [png()] },
      });

      await waitFor(() => expect(send.disabled).toBe(true));
      // The wait is stated, not just enforced.
      expect((await screen.findByTestId('transcript-attachments')).textContent)
        .toMatch(/shot\.png/);
      expect(send.title).toMatch(/uploading/i);

      land(uploaded());
      await waitFor(() => expect(send.disabled).toBe(false));
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
