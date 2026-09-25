// @vitest-environment jsdom
/**
 * `coldStart: 'composer'` — the entity chat slot's `new` (design 01a0da4e
 * §3.3). The slot has already decided no existing chat is wanted; the cold-
 * start auto-open (ruled 2026-08-15) would otherwise open the SPACE's most
 * recent chat, which is about some other entity entirely.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const ABOUT = '019f0000-0000-7000-8000-0000000000ab' as EntityId;
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

afterEach(cleanup);

function mount(coldStart?: 'latest' | 'composer') {
  const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
  const readThread = vi.fn(port.readThread);
  const listThreads = vi.fn(port.listThreads);
  render(
    <ChatHomeScreen
      port={{ ...port, readThread, listThreads }}
      spaceId={SPACE_ID}
      models={MODELS}
      soloConversation
      routeThreadId={null}
      aboutId={ABOUT}
      {...(coldStart ? { coldStart } : {})}
    />,
  );
  return { readThread, listThreads };
}

describe('what a cold start opens', () => {
  it('CONTROL — by default the most recent conversation opens itself', async () => {
    const { readThread } = mount();
    await waitFor(() => expect(readThread).toHaveBeenCalledWith(CHAT_HOME_FIXTURE_THREAD.summary.rootId));
  });

  it("'composer' leaves the composer up and opens nothing", async () => {
    const { readThread, listThreads } = mount('composer');
    await waitFor(() => expect(listThreads).toHaveBeenCalled());
    // Let the list read settle and any follow-on select effect run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readThread).not.toHaveBeenCalled();
  });
});
