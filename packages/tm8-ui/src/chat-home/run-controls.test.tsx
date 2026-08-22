// @vitest-environment jsdom
/**
 * THE TWO RUN CONTROLS, AS A PERSON REACHES THEM.
 *
 * Both defects reported by Tarkesh live in one strip of the composer:
 *
 *   1. "I'm not able to change models … once model is selected I'm unable
 *      change." — the model drop-up disabled itself the moment a thread was
 *      configured, so the only way to change model was to abandon the
 *      conversation.
 *   2. "there no option to stop in between" — the Stop button existed but no
 *      real port ever supplied `interrupt`, so every live chat rendered the
 *      disabled "Working" loader instead.
 *
 * These cases pin the composer half of both. The server half — the per-turn
 * model reaching the runtime, and a stopped turn being recorded as stopped
 * rather than failed — is pinned in `packages/server/test/chat-run-controls`.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';

/** The fixture thread is configured on `claude-sonnet-4-5` (see fixtures.ts). */
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
  { model: 'claude-opus-4-5', label: 'Opus 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
  { model: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', provider: 'OpenAI', agentTool: 'codex' },
];

async function openThread(port: ChatHomePort) {
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
  await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  return view;
}

describe('changing the model of a conversation already under way', () => {
  it('opens on the model the thread has been running, not on the first in the list', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);
    await waitFor(() =>
      expect(view.getByLabelText('Chat model').textContent).toContain('Sonnet 4.5'),
    );
  });

  /**
   * THE DEFECT, INVERTED. The trigger is live on a configured thread, and the
   * choice reaches the wire — `postTurn` carries the model the person picked.
   */
  it('sends the picked model with the next turn', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = await openThread(port);

    expect((view.getByLabelText('Chat model') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-5'));
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Try that again on the bigger model.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]?.model).toBe('claude-opus-4-5');
  });

  /**
   * AN OVERRIDE IS ONLY SENT WHEN IT IS ONE. Stamping the thread's own model
   * onto every message would make "this turn asked for something different"
   * unreadable in the stored rows, and would be noise on every conversation
   * that never changed model — which is almost all of them.
   */
  it('sends no model at all when the thread default was not changed', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Carry on.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]?.model).toBeUndefined();
  });

  /**
   * A MODEL CAN BE RETIRED FROM THE CATALOG AFTER A THREAD WAS BUILT ON IT, and
   * the thread keeps running on it — the server reads its model from the
   * binding, not from this browser. So the thread's own model stays sendable
   * even when the offered list has never heard of it; requiring catalog
   * membership would leave a person unable to reply in a working conversation
   * because of a list they never see.
   */
  it('stays sendable when the thread runs a model the catalog no longer offers', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const withoutTheThreadsModel = MODELS.filter((m) => m.model !== 'claude-sonnet-4-5');
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={withoutTheThreadsModel} />,
    );
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    await waitFor(() =>
      expect(view.getByLabelText('Chat model').textContent).toContain('Sonnet 4.5'),
    );

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Carry on.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.posts).toHaveLength(1));
    // …and still sends no override: it IS the thread's default.
    expect(controls.posts[0]?.model).toBeUndefined();
  });

  /**
   * …AND HANDS IT BACK ON THE WAY OUT.
   *
   * Adopting the thread's model is only half the rule. That model stays
   * sendable INSIDE its thread even when the catalog has dropped it — but a NEW
   * conversation has no binding for the server to read it from, so a selection
   * carried over from the thread just closed would leave the composer refusing
   * to send with no control the person could use to fix it.
   *
   * Found by `craft-screen`, which walks exactly this: open a conversation,
   * press ＋, type, send. Pinned here too, at the layer that owns the rule,
   * rather than left to be re-discovered from two surfaces away.
   */
  it('drops an unofferable adopted model when starting a new conversation', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const withoutTheThreadsModel = MODELS.filter((m) => m.model !== 'claude-sonnet-4-5');
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={withoutTheThreadsModel} />,
    );
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    await waitFor(() =>
      expect(view.getByLabelText('Chat model').textContent).toContain('Sonnet 4.5'),
    );

    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    await waitFor(() =>
      expect(view.getByLabelText('Chat model').textContent).toContain('Opus 4.5'),
    );

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Start something new.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.configs).toHaveLength(1));
    expect(controls.configs[0]?.model).toBe('claude-opus-4-5');
  });

  /** A deliberate, still-offerable choice is NOT undone by leaving a thread. */
  it('keeps an offerable selection when starting a new conversation', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-5'));
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));

    await waitFor(() =>
      expect(view.getByLabelText('Chat model').textContent).toContain('Opus 4.5'),
    );
  });

  /** Teammate and mode are still the thread's for its whole life. */
  it('leaves the other two thread settings pinned', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);
    expect((view.getByLabelText('Chat teammate') as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText('Chat mode') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a model this chat cannot run', () => {
  /**
   * UNAVAILABLE IS NOT INVISIBLE. Chat launches claude-code models only, and
   * the picker offered all three Codex entries with nothing to say so — the
   * only way to find out was to send and read the server's refusal.
   */
  it('is shown with the reason it cannot be picked', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.click(view.getByLabelText('Chat model'));
    const row = view.getByTestId('tch-model-gpt-5.6-sol');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain('launches via Codex');
    // Its provider is NOT also shown: a row saying both "OpenAI" and "cannot
    // run here" has buried the half that matters.
    expect(row.textContent).not.toContain('OpenAI');
  });

  it('is refused when pressed, and does not become the selection', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-gpt-5.6-sol'));
    // The menu stays open — nothing was chosen, so nothing closed it.
    expect(view.getByTestId('tch-model-menu')).toBeTruthy();
    expect(view.getByLabelText('Chat model').textContent).toContain('Sonnet 4.5');

    fireEvent.keyDown(view.getByLabelText('Chat model'), { key: 'Escape' });
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Carry on.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]?.model).toBeUndefined();
  });

  /**
   * The arrows must not park the highlight on a row Enter would refuse — that
   * reads as a broken keyboard rather than as an unavailable option. Sonnet is
   * selected, so one step down from it lands on Opus and the NEXT step wraps
   * past the Codex row back to Sonnet.
   */
  it('is skipped by the arrow keys', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);
    const trigger = view.getByLabelText('Chat model');

    fireEvent.click(trigger);
    const active = () =>
      within(view.getByTestId('tch-model-menu'))
        .getAllByRole('option')
        .find((option) => option.hasAttribute('data-active'))
        ?.getAttribute('data-testid');

    expect(active()).toBe('tch-model-claude-sonnet-4-5');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(active()).toBe('tch-model-claude-opus-4-5');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(active()).toBe('tch-model-claude-sonnet-4-5');
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(active()).toBe('tch-model-claude-opus-4-5');
  });

  /**
   * A NEW thread starts on a model that can actually run, rather than on
   * whatever happens to be first — which for a catalog led by a Codex entry
   * would be an unsendable composer.
   */
  it('is never the default selection for a new thread', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    await waitFor(() =>
      expect(view.getByLabelText('Chat model').textContent).toContain('Sonnet 4.5'),
    );
  });
});

describe('stopping a run', () => {
  /**
   * THE DEFECT. `port.interrupt` is optional, and the real port never supplied
   * it — so the composer took the "no interrupt operation on this node" branch
   * and drew a disabled loader for every running turn in the product. This
   * case is the shape of that branch, kept so the honest-disabled state is not
   * lost now that the live one exists.
   */
  it('says the node cannot stop, rather than hiding the control, when no operation exists', async () => {
    const { port } = createChatHomeFixturePort();
    const { interrupt: _dropped, ...withoutInterrupt } = port;
    const view = await openThread(withoutInterrupt as ChatHomePort);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    const working = await waitFor(() => view.getByTestId('tch-send-working'));
    expect(working.getAttribute('aria-disabled')).toBe('true');
    expect(working.getAttribute('title')).toContain('no chat interrupt operation is exposed');
  });

  /** With the operation wired, the same control is live and reaches the port. */
  it('is a live control when the port carries the operation', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    const stop = await waitFor(() => view.getByTestId('tch-send-working'));
    expect(stop.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(stop);
    await waitFor(() => expect(controls.interrupts).toHaveLength(1));
  });

  /**
   * STOPPING IS NOT FAILING. The design of record (doc 01a02907 §3) gives the
   * stopped state this exact sentence, attributed to the person, and rules that
   * it must never read as an error — so it announces as a `status`, and the
   * words "failed", "error" and "cancelled" appear nowhere near it.
   */
  it('reads as something the person did, never as a breakage', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    fireEvent.click(await waitFor(() => view.getByTestId('tch-send-working')));

    const line = await waitFor(() => view.getByText(/pick up where it left off/i));
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('You stopped this.');
    expect(view.getByText('You stopped this')).toBeTruthy();
    expect(view.queryByText(/failed/i)).toBeNull();
    expect(view.queryByText(/cancelled/i)).toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  /** A stopped conversation is continuable — the composer stays open. */
  it('leaves the composer usable so the conversation can carry on', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    fireEvent.click(await waitFor(() => view.getByTestId('tch-send-working')));
    await waitFor(() => expect(view.getByText('You stopped this')).toBeTruthy());

    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).disabled)
      .toBe(false);
  });

  /**
   * THE TWO CONTROLS COMPOSE. Stopping and then picking a different model is
   * the obvious thing to do after deciding a run was going wrong, and it is
   * the sequence that used to be refused outright: the composer would not
   * offer the model change, and underneath, the runtime adapter's resume guard
   * treated a changed model as a resume mismatch.
   */
  it('lets the next turn carry a different model after a stop', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    fireEvent.click(await waitFor(() => view.getByTestId('tch-send-working')));
    await waitFor(() => expect(view.getByText('You stopped this')).toBeTruthy());

    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-5'));
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Try the bigger model instead.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.posts.at(-1)?.model).toBe('claude-opus-4-5'));
  });
});

describe('the thread root a stop is addressed to', () => {
  it('is the thread on screen', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = await openThread(port);

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    fireEvent.click(await waitFor(() => view.getByTestId('tch-send-working')));

    await waitFor(() => expect(controls.interrupts).toEqual([
      '019f0000-0000-7000-8000-000000000010' as EntityId,
    ]));
  });
});
