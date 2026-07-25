/**
 * The composer — and specifically the ORDER of its two writes.
 *
 * The regression these exist to prevent is not a rendering one. It is a prompt
 * recorded in the graph that the agent never received: tm8's `MessageView` has
 * no delivered flag, so such a row is indistinguishable from a real one forever
 * after. `deliverPrompt` is tested as a plain function for exactly that reason —
 * the rule lives in the ordering, not in the markup, and a test that has to
 * render a textarea to check it would not survive the next layout change.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RealFacade } from '../../RealFacade';
import { Composer, deliverPrompt } from '../Composer';

const SESSION = 'ws_live';

/** Records the order of the two writes, which is the thing under test. */
let order: string[] = [];

function fakeFacade(over: Partial<Record<'promptSession' | 'postMessage' | 'terminateSession', unknown>> = {}) {
  return {
    promptSession: vi.fn(async () => { order.push('prompt'); return { patches: [] }; }),
    postMessage: vi.fn(async () => { order.push('post'); return { patches: [] }; }),
    terminateSession: vi.fn(async () => { order.push('terminate'); return { patches: [] }; }),
    ...over,
  } as unknown as RealFacade & {
    promptSession: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    terminateSession: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => { order = []; });

describe('deliverPrompt — deliver first, then record', () => {
  it('delivers to the PTY before it writes the durable record', async () => {
    const facade = fakeFacade();

    const result = await deliverPrompt(facade, SESSION, 'run the tests');

    expect(result.outcome).toBe('delivered');
    // The whole rule, in one assertion.
    expect(order).toEqual(['prompt', 'post']);
    expect(facade.promptSession).toHaveBeenCalledWith(SESSION, 'run the tests', expect.objectContaining({
      clientMutationId: expect.stringContaining('cmid_'),
    }));
    // Anchored to the work_session, so the record hangs off the thing that ran it.
    expect(facade.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      anchorId: SESSION, body: 'run the tests',
    }));
  });

  it('records NOTHING when delivery fails', async () => {
    const facade = fakeFacade({
      promptSession: vi.fn(async () => { throw new Error('session has exited'); }),
    });

    const result = await deliverPrompt(facade, SESSION, 'do the thing');

    expect(result.outcome).toBe('undelivered');
    expect(result.error).toContain('session has exited');
    // THE assertion. A recorded-but-undelivered prompt is a permanent lie in the
    // graph, because nothing in the message shape can mark it as one.
    expect(facade.postMessage).not.toHaveBeenCalled();
  });

  it('distinguishes "delivered but not recorded" from "not delivered"', async () => {
    const facade = fakeFacade({
      postMessage: vi.fn(async () => { throw new Error('messages.post 500'); }),
    });

    const result = await deliverPrompt(facade, SESSION, 'ship it');

    // The agent HAS this prompt — only the thread is incomplete. Reporting it as
    // undelivered would send the operator to re-send something already running.
    expect(result.outcome).toBe('delivered_unrecorded');
    expect(facade.promptSession).toHaveBeenCalled();
  });
});

describe('Composer — keys, history and liveness', () => {
  const type = (text: string) =>
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } });

  it('sends on Cmd/Ctrl+Enter and treats bare Enter as a newline', async () => {
    const facade = fakeFacade();
    render(<Composer facade={facade} sessionId={SESSION} live status="running" />);

    type('line one');
    // Bare Enter must NOT send: a stray newline costs a keystroke, a stray send
    // costs an agent acting on half an instruction.
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(facade.promptSession).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(facade.promptSession).toHaveBeenCalledWith(SESSION, 'line one', expect.anything()));
  });

  it('keeps a history of what was sent', async () => {
    const facade = fakeFacade();
    render(<Composer facade={facade} sessionId={SESSION} live status="running" />);

    type('first prompt');
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(screen.getByTestId('composer-history')).toBeTruthy());
    expect(screen.getByText('first prompt')).toBeTruthy();
    expect(document.querySelector('.ws-composer__sent')?.getAttribute('data-outcome')).toBe('delivered');
    // The box is cleared for the next thought.
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('says "not delivered" distinctly and gives the text back', async () => {
    const facade = fakeFacade({
      promptSession: vi.fn(async () => { throw new Error('pty gone'); }),
    });
    render(<Composer facade={facade} sessionId={SESSION} live status="running" />);

    type('important instruction');
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(screen.getByText(/not delivered — the agent never received this/i)).toBeTruthy());
    // Restored verbatim, so the send is retried by pressing send again rather
    // than by remembering what was typed.
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('important instruction');
    expect(screen.getByTestId('composer-error').textContent).toContain('pty gone');
  });

  it('disables Send and Terminate for a session that has exited, with the reason', () => {
    const facade = fakeFacade();
    render(<Composer facade={facade} sessionId={SESSION} live={false} status="exited" />);

    const terminate = screen.getByTestId('composer-terminate') as HTMLButtonElement;
    expect(terminate.disabled).toBe(true);
    // Disabled-with-reason, never hidden: the user must not hunt for a control
    // that is simply inapplicable right now.
    expect(terminate.title).toContain('exited');
    expect((screen.getByTestId('composer-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('terminates a live session', async () => {
    const facade = fakeFacade();
    const onTerminated = vi.fn();
    render(<Composer facade={facade} sessionId={SESSION} live status="running" onTerminated={onTerminated} />);

    fireEvent.click(screen.getByTestId('composer-terminate'));
    await waitFor(() => expect(facade.terminateSession).toHaveBeenCalledWith(SESSION, expect.anything()));
    expect(onTerminated).toHaveBeenCalled();
  });

  it('recalls previous prompts with ArrowUp/ArrowDown from an empty box', async () => {
    const facade = fakeFacade();
    render(<Composer facade={facade} sessionId={SESSION} live status="running" />);
    const box = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;

    type('first');
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(facade.promptSession).toHaveBeenCalledTimes(1));
    type('second');
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(facade.promptSession).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('second');
    // The walk continues rather than sticking on the most recent one.
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('first');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('second');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('');
  });

  it('leaves ArrowUp alone while a draft is being written', () => {
    const facade = fakeFacade();
    render(<Composer facade={facade} sessionId={SESSION} live status="running" />);

    type('half a thought');
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'ArrowUp' });

    // Cursor movement inside a paragraph must stay cursor movement.
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('half a thought');
  });

  it('drops the history when the session changes', async () => {
    const facade = fakeFacade();
    const { rerender } = render(<Composer facade={facade} sessionId={SESSION} live status="running" />);

    type('for the first agent');
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByTestId('composer-history')).toBeTruthy());

    rerender(<Composer facade={facade} sessionId="ws_other" live status="running" />);

    // One agent's prompts under another agent's terminal would be a false
    // account of what that agent was told.
    expect(screen.queryByTestId('composer-history')).toBeNull();
  });
});
