// @vitest-environment jsdom
/**
 * 276 — THE CHAT MODEL CHIP IS A CONTROL ON AN OPEN CHAT, NOT A LABEL.
 *
 * The reported defect was precise: once a model had answered, the composer gave
 * no way to continue the same conversation on a different model. The chip was
 * `disabled={pinned}` and said "the model is fixed when a thread starts", which
 * was an HONEST description of the runtime at the time — so unlocking it alone
 * would have replaced a refusal with a lie. These tests pin the browser half of
 * the fix: the chip is live on an open chat, it calls `chat.setModel`, and a
 * refusal is surfaced rather than swallowed.
 *
 * The chip is deliberately NOT locked while a turn is running — a switch applies
 * to the next turn claimed, so there is no reason to make the viewer wait for an
 * answer before choosing who writes the one after it.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const FIXTURE_CHAT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
/* The fixture chat opens on Sonnet. Opus is the switch target and Sol is the
   control: chat runs Claude Code only, so a codex row must stay refused even
   after the claude-to-claude lock is gone. */
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
  { model: 'claude-opus-4-1', label: 'Opus 4.1', provider: 'Anthropic', agentTool: 'claude-code' },
  { model: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', provider: 'OpenAI', agentTool: 'codex' },
];

afterEach(cleanup);

/** Mount with the fixture chat already open, so the chip is on a PINNED chat. */
async function openChat(
  overrides: Partial<ChatHomePort> = {},
  threads: readonly ChatThreadDetail[] = [CHAT_HOME_FIXTURE_THREAD],
) {
  const { port, controls } = createChatHomeFixturePort(threads);
  const view = render(
    <ChatHomeScreen
      port={{ ...port, ...overrides }}
      spaceId={SPACE_ID}
      models={MODELS}
      routeThreadId={FIXTURE_CHAT}
    />,
  );
  // "Open" means the served config has arrived — that is what makes `pinned`
  // true, and asserting on it rather than on a timer keeps this off the clock.
  await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Sonnet 4.5'));
  return { view, controls };
}

describe('276: changing an open chat’s model from the composer', () => {
  it('leaves the chip ENABLED on an open chat, with no lock reason', async () => {
    const { view } = await openChat();
    const chip = view.getByTestId('tch-model');
    // The regression this guards is the original defect verbatim.
    expect(chip.hasAttribute('disabled')).toBe(false);
    expect(chip.getAttribute('title')).not.toMatch(/fixed when a thread starts/);
  });

  it('calls chat.setModel with the open chat and the chosen model, and shows it', async () => {
    const { view, controls } = await openChat();
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));

    // THE WRITE HAPPENED, addressed to the open chat. A chip that only changed
    // locally is the bug, not the fix.
    await waitFor(() => expect(controls.modelSwitches).toEqual([
      { chatId: FIXTURE_CHAT, model: 'claude-opus-4-1' },
    ]));
    // AND THE CHIP FOLLOWS. Without the optimistic override the label snaps
    // back on the next render and the switch reads as refused.
    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Opus 4.1'));
  });

  it('still refuses a codex model — the agent tool is the one axis a switch cannot cross', async () => {
    const { view, controls } = await openChat();
    fireEvent.click(view.getByLabelText('Chat model'));
    const codexRow = view.getByTestId('tch-model-gpt-5.6-sol');
    expect(codexRow.getAttribute('aria-disabled')).toBe('true');
    expect(codexRow.textContent).toContain('Claude Code only');
    fireEvent.click(codexRow);
    // Drawn and explained, never silently omitted — and clicking it writes nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controls.modelSwitches).toEqual([]);
    expect(view.getByTestId('tch-model').textContent).toContain('Sonnet 4.5');
  });

  it('a REFUSED switch reverts the chip and reports the reason', async () => {
    const { view, controls } = await openChat({
      setModel: async () => { throw new Error('chat runs on claude-code and cannot switch'); },
    });
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));

    // The reason reaches the user...
    await waitFor(() => expect(view.getByRole('alert').textContent)
      .toContain('chat runs on claude-code and cannot switch'));
    // ...and the chip tells the truth again, rather than showing a model the
    // chat is not on. A stuck optimistic label is worse than the original lock:
    // the next turn would answer as Sonnet while the composer claimed Opus.
    expect(view.getByTestId('tch-model').textContent).toContain('Sonnet 4.5');
    expect(controls.modelSwitches).toEqual([]);
  });

  it('locks the chip, with a reason, on a node whose port has no setModel', async () => {
    const { port } = createChatHomeFixturePort();
    const { setModel: _absent, ...withoutSetModel } = port;
    const view = render(
      <ChatHomeScreen
        port={withoutSetModel}
        spaceId={SPACE_ID}
        models={MODELS}
        routeThreadId={FIXTURE_CHAT}
      />,
    );
    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Sonnet 4.5'));
    const chip = view.getByTestId('tch-model');
    // Optional on the port so a stale port literal keeps working; when it is
    // genuinely absent the chip must say so instead of failing on click.
    expect(chip.hasAttribute('disabled')).toBe(true);
    expect(chip.getAttribute('title')).toContain('cannot change');
  });
  /**
   * A UI CAN BE NEWER THAN ITS NODE, and on this host it WAS: the 276 bundle was
   * deployed restartlessly while the server dist still predated the route, so
   * `chat.setModel` came back 404 `not_found` and the chip failed on every
   * click showing the router's own words. Measured against prod on 2026-09-30:
   *   POST /v2/chats/<id>/model -> 404
   *   {"code":"not_found","message":"no operation bound to POST /v2/chats/<id>/model"}
   * These two pin the guard for that window, and the SECOND one is what keeps it
   * honest: a latch that fired on any failure would pass the first test alone
   * while quietly locking the chip on every ordinary refusal.
   */
  it('a node with no such route LOCKS the chip once, instead of failing on every click', async () => {
    let calls = 0;
    const { view } = await openChat({
      setModel: async () => {
        calls += 1;
        throw new CollabError('not_found', 'no operation bound to POST /v2/chats/x/model');
      },
    });
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));

    // The chip locks, and says why in words a human wrote.
    await waitFor(() => expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(true));
    expect(view.getByTestId('tch-model').getAttribute('title')).toContain('cannot change');
    // The router's own sentence never reaches the viewer.
    expect(view.getByRole('alert').textContent).not.toContain('no operation bound');
    expect(view.getByRole('alert').textContent).toContain('needs an update');
    // And the label is truthful again rather than stuck on the asked-for model.
    expect(view.getByTestId('tch-model').textContent).toContain('Sonnet 4.5');
    expect(calls).toBe(1);
  });

  it('an ORDINARY refusal does not lock the chip — only a missing route does', async () => {
    const { view } = await openChat({
      setModel: async () => {
        throw new CollabError('invalid_input', 'model is not in this space\u2019s catalog');
      },
    });
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));

    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('not in this space'));
    // Still live: the node HAS the route, it refused this particular model, and
    // the next pick deserves to reach it.
    expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(false);
  });

  /* BOTH OF THE FOLLOWING ARE REGRESSIONS FOUND IN A REAL BROWSER against the
     build that was already serving prod (index-DkRnSAFc.js, 2026-09-30), not
     from reading this file. The guard above was measured working; these are the
     two ways it was still wrong. */

  it('locking does not leave live rows behind a disabled trigger', async () => {
    let calls = 0;
    const { view } = await openChat({
      setModel: async () => {
        calls += 1;
        throw new CollabError('not_found', 'no operation bound to POST /v2/chats/x/model');
      },
    });
    // ONE menu, opened once, and never reopened: this popover deliberately stays
    // open after a pick because the effort row lives in it, so the lock flips
    // while these rows are still mounted.
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));
    await waitFor(() => expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(true));
    expect(calls).toBe(1);

    // A second pick from that same still-open menu. Measured sending a second
    // doomed request and filing the same error again before ModelEffortPicker's
    // rows checked the picker-level `disabled`.
    fireEvent.click(view.getByTestId('tch-model-claude-sonnet-4-5'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('needs an update'));
    expect(calls).toBe(1);
    expect(view.getByRole('alert').textContent).not.toContain('no operation bound');

    /* AND THEY MUST LOOK LOCKED, not merely be inert. This row carries no reason
       of its own -- only the picker is disabled -- so before the aria fix it kept
       dark text and no aria-disabled while the codex row beside it was greyed,
       which is a menu that reads as pickable and is not. Observed in a browser
       (frame I-fix-2a). The greying follows from aria-disabled via
       chat-home.css:2364, so asserting the attribute asserts the appearance. */
    const lockedRow = view.getByTestId('tch-model-claude-sonnet-4-5');
    expect(lockedRow.getAttribute('aria-disabled')).toBe('true');
    expect(lockedRow.getAttribute('title')).toContain('cannot change');
  });

  it('a chat the viewer cannot configure does NOT get blamed on the node', async () => {
    /* 276:117-124 raises the SAME P0002 for a non-configurer as for a missing
       chat, so code alone cannot separate "this node is old" from "this chat is
       not yours". The structural difference is `details.sqlstate`, which only a
       call that reached the function carries. Without the narrowing this latched,
       told the viewer the NODE needed updating, and — the latch being
       screen-wide — locked their own chats along with it. */
    const { view } = await openChat({
      setModel: async () => {
        throw new CollabError('not_found', 'chat not found for this identity', {
          details: { sqlstate: 'P0002' },
        });
      },
    });
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));

    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('chat not found'));
    expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(false);
    expect(view.getByRole('alert').textContent).not.toContain('needs an update');
  });
});

/** A chat as THIS viewer is served it: `canSetModel` as given, ABSENT when undefined. */
function servedAs(
  canSetModel: boolean | undefined,
  base: ChatThreadDetail = CHAT_HOME_FIXTURE_THREAD,
): ChatThreadDetail {
  return {
    ...base,
    summary: {
      ...base.summary,
      config: { ...base.summary.config, ...(canSetModel === undefined ? {} : { canSetModel }) },
    },
  };
}

/**
 * 01a0f49e — A VIEWER WHO DID NOT START THE CHAT CANNOT CHANGE ITS MODEL, AND
 * THE CHIP SAYS SO BEFORE ANYTHING IS SENT.
 *
 * Chats are multi-participant, and 276's door refuses `chat.setModel` from
 * anyone but the configurer. The server answers that per viewer as one boolean
 * (`state.canSetModel`, computed in SQL from the viewer's IDENTITY) and the
 * screen obeys it. The browser never compares ids itself: the id it holds is
 * an ACTOR id, which never equals the configurer's identity, so a client-side
 * comparison would lock everyone, the configurer included.
 */
describe('01a0f49e: the chip is locked for a viewer who did not start the chat', () => {
  const REASON = 'only the person who started this chat can change its model';

  it('canSetModel false: the chip is locked, says why, and nothing is sent', async () => {
    const { view, controls } = await openChat({}, [servedAs(false)]);
    const chip = view.getByTestId('tch-model');
    expect(chip.hasAttribute('disabled')).toBe(true);
    expect(chip.getAttribute('title')).toContain(REASON);
    // The node is fine; the chat is not theirs. Blaming the node is #979's bug.
    expect(chip.getAttribute('title')).not.toContain('this node cannot');

    fireEvent.click(view.getByLabelText('Chat model'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.queryByTestId('tch-model-claude-opus-4-1')).toBeNull();
    expect(controls.modelSwitches).toEqual([]);
  });

  it('a lock that lands while the menu is open still gates its rows', async () => {
    /* The list row has no answer yet (unknown: not locked), so the menu opens;
       then the chat's own read arrives saying "not yours" while it is open. A
       pick from that menu must send nothing, and the rows must LOOK locked. */
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { view, controls } = await openChat({
      readThread: async () => {
        await held;
        return structuredClone(servedAs(false));
      },
    });
    fireEvent.click(view.getByLabelText('Chat model'));
    expect(view.getByTestId('tch-model-claude-opus-4-1').getAttribute('aria-disabled')).not.toBe('true');

    release();
    await waitFor(() => expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(true));
    const row = view.getByTestId('tch-model-claude-opus-4-1');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toContain(REASON);
    fireEvent.click(row);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controls.modelSwitches).toEqual([]);
  });

  it('canSetModel true: the configurer\u2019s chip is unchanged, and the switch goes through', async () => {
    const { view, controls } = await openChat({}, [servedAs(true)]);
    const chip = view.getByTestId('tch-model');
    expect(chip.hasAttribute('disabled')).toBe(false);
    expect(chip.getAttribute('title') ?? '').not.toContain(REASON);
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));
    await waitFor(() => expect(controls.modelSwitches).toEqual([
      { chatId: FIXTURE_CHAT, model: 'claude-opus-4-1' },
    ]));
  });

  it('canSetModel ABSENT is unknown, not "someone else\u2019s": the chip stays live', async () => {
    /* G4 wearing a new hat: reading absence as refusal would lock every chat on
       a node older than the field, the configurer's own included. */
    const { view, controls } = await openChat({}, [servedAs(undefined)]);
    expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(false);
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));
    await waitFor(() => expect(controls.modelSwitches).toHaveLength(1));
  });

  it('with canSetModel absent, the missing-route latch is still the backstop', async () => {
    /* Absent is what an older node sends. If it also lacks the route, unknown
       does not lock, so the first click finds out and #979's latch takes over.
       (If it has the route, 276 refuses a non-configurer with a P0002 that
       carries a sqlstate, which the latch ignores: see the test above.) */
    const { view } = await openChat({
      setModel: async () => {
        throw new CollabError('not_found', 'no operation bound to POST /v2/chats/x/model');
      },
    }, [servedAs(undefined)]);
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));
    await waitFor(() => expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(true));
    expect(view.getByTestId('tch-model').getAttribute('title')).toContain('cannot change');
    expect(view.getByTestId('tch-model').getAttribute('title')).not.toContain(REASON);
  });

  it('the lock is per chat: the viewer\u2019s own chat still switches, with no reload', async () => {
    const MINE = '019f0000-0000-7000-8000-0000000000a1' as EntityId;
    const mine = servedAs(true, {
      ...CHAT_HOME_FIXTURE_THREAD,
      summary: { ...CHAT_HOME_FIXTURE_THREAD.summary, rootId: MINE, title: 'My own chat' },
    });
    const { view, controls } = await openChat({}, [servedAs(false), mine]);
    expect(view.getByTestId('tch-model').getAttribute('title')).toContain(REASON);

    fireEvent.click(view.getByRole('button', { name: /My own chat/ }));
    await waitFor(() => expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(false));
    fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));
    await waitFor(() => expect(controls.modelSwitches).toEqual([{ chatId: MINE, model: 'claude-opus-4-1' }]));

    // And back: someone else's chat is still theirs to configure, not ours.
    fireEvent.click(view.getByRole('button', { name: /Plan the launch sequence/ }));
    await waitFor(() => expect(view.getByTestId('tch-model').getAttribute('title')).toContain(REASON));
    expect(view.getByTestId('tch-model').hasAttribute('disabled')).toBe(true);
  });
});
