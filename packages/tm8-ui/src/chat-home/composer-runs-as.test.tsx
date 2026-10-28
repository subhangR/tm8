// @vitest-environment jsdom
/**
 * THE ⚙ CHIP NAMES WHO THE CHAT RUNS AS (task 01a181da, chat 3c534e72: "the
 * chat shows one teammate, starts with another").
 *
 * The chip's word is a ROLE — Worker, Coordinator, Dispatcher — and those are
 * also the names of seeded house teammates. A new chat in `ask` read
 * "Coordinator" while `chat.start` bound the first-listed teammate (Worker on
 * the reporter's space), and the teammate actually chosen sat one click deep
 * in the panel's "Runs as" row. The chip now carries that teammate whenever
 * its name is not the role's own word, so what it says is who answers.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { McpProvider } from '../mcp/context';
import type { McpPort } from '../mcp/port';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000092';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const WORKER = '019f0000-0000-7000-8000-0000000000a1' as EntityId;
const COORDINATOR = '019f0000-0000-7000-8000-0000000000a2' as EntityId;
const REVIEWER = '019f0000-0000-7000-8000-0000000000a3' as EntityId;
const LABELS: Record<string, string> = { [WORKER]: 'Worker', [COORDINATOR]: 'Coordinator', [REVIEWER]: 'Reviewer' };

afterEach(cleanup);

/** The reporter's roster shape: house teammates, the busiest (Worker) first. */
function rosterPort() {
  const { port } = createChatHomeFixturePort([]);
  const create = vi.fn(port.startThread.create);
  const withRoster: ChatHomePort = {
    ...port,
    listTeammates: async () => [WORKER, COORDINATOR, REVIEWER].map((id) => ({ id, label: LABELS[id]!, avatar: null })),
    startThread: { ...port.startThread, create },
  };
  return { port: withRoster, create };
}

const chip = (view: ReturnType<typeof render>) => view.getByTestId('tch-settings').textContent ?? '';

async function send(view: ReturnType<typeof render>, create: ReturnType<typeof rosterPort>['create']) {
  const composer = view.getByLabelText('Message the chat agent');
  fireEvent.change(composer, { target: { value: 'hello' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  return create.mock.calls[0]![0].teammateId;
}

describe('the ⚙ chip names the teammate the chat runs as', () => {
  it('a default new chat reads Coordinator but runs as Worker: the chip says Worker too', async () => {
    const { port, create } = rosterPort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer" />);
    await waitFor(() => expect(view.getByTestId('tch-settings-runs-as').textContent).toContain('Worker'));
    expect(view.getByTestId('tch-settings-role').textContent).toBe('Coordinator');
    const started = await send(view, create);
    expect(started).toBe(WORKER);
    expect(chip(view)).toContain(LABELS[started]!);
  });

  it('an explicit "Runs as" pick is what the chip shows and what chat.start sends', async () => {
    const { port, create } = rosterPort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer" />);
    await waitFor(() => view.getByTestId('tch-settings-runs-as'));
    fireEvent.click(view.getByTestId('tch-settings'));
    fireEvent.click(view.getByTestId('tch-settings-teammate'));
    fireEvent.click(view.getByTestId(`tch-settings-teammate-${REVIEWER}`));
    await waitFor(() => expect(view.getByTestId('tch-settings-runs-as').textContent).toContain('Reviewer'));
    expect(await send(view, create)).toBe(REVIEWER);
  });

  it('a per-kind default teammate (the new-chat seed) is what the chip shows and what chat.start sends', async () => {
    const { port, create } = rosterPort();
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer"
        newChatSeed={{ teammateId: REVIEWER, model: 'claude-sonnet-4-5' }} />,
    );
    await waitFor(() => expect(view.getByTestId('tch-settings-runs-as').textContent).toContain('Reviewer'));
    expect(await send(view, create)).toBe(REVIEWER);
  });

  it('a teammate whose name IS the role word is not said twice', async () => {
    const { port, create } = rosterPort();
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer"
        newChatSeed={{ teammateId: COORDINATOR, model: 'claude-sonnet-4-5' }} />,
    );
    fireEvent.click(view.getByTestId('tch-settings'));
    await waitFor(() => expect(view.getByTestId('tch-settings-teammate-value').textContent).toBe('CCoordinator'));
    expect(view.getByTestId('tch-settings-role').textContent).toBe('Coordinator');
    expect(view.queryByTestId('tch-settings-runs-as')).toBeNull();
    expect(await send(view, create)).toBe(COORDINATOR);
  });
});

describe('a started chat reads connectors for its own teammate', () => {
  it('not for the pending new-chat pick, which can be someone else', async () => {
    const { port } = createChatHomeFixturePort();
    const roster = await port.listTeammates(SPACE_ID);
    /* Researcher listed first, so the new-chat pick is Researcher while the
       open chat is bound to Forge. */
    const reversed: ChatHomePort = { ...port, listTeammates: async () => [...roster].reverse() };
    const catalog = vi.fn<McpPort['catalog']>(async () => ({ servers: [], defaults: [], canRegister: false, canAttach: false }));
    const mcp = { catalog } as unknown as McpPort;
    const bound = CHAT_HOME_FIXTURE_THREAD.summary.config.teammateId;
    const view = render(
      <McpProvider port={mcp}>
        <ChatHomeScreen port={reversed} spaceId={SPACE_ID} models={MODELS} routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId} />
      </McpProvider>,
    );
    await waitFor(() => expect(view.getByTestId('tch-model').textContent).toContain('Sonnet'));
    await waitFor(() => expect(catalog.mock.calls.some(([, member]) => member === bound)).toBe(true));
    const settled = catalog.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(catalog.mock.calls.slice(settled - 1).every(([, member]) => member === bound)).toBe(true);
    expect(catalog.mock.calls.some(([, member]) => member === roster[1]!.id)).toBe(false);
  });
});
