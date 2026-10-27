// @vitest-environment jsdom
/**
 * THE TOKEN READING IN THE ACTION STRIP (task 01a14b00): a session's context
 * number, portalled into the strip's stats slot, and a chat's, published by its
 * screen, both draw stacked — one figure per line — and open their details.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useContext } from 'react';
import { createPortal } from 'react-dom';
import type { EntityDetail, SessionTranscriptContext } from '@tm8/contract';
import { publishChatContext } from '../../chat-home/chatContextFeed';
import { formatContext } from '../../transcript/context-reading';
import { ContextChip } from '../../transcript/SessionContextNumber';
import { ActionStrip, EmbeddedWorkspace, EntityChromeContext, embeddedTab, useEmbeddedRuntime, useEntityChromeValue } from '../embed';
import type { WorkspaceGateHandles } from './context';

afterEach(() => {
  cleanup();
  publishChatContext('chat-1', null);
});

const SPACE = 'space-strip-tokens';
const VIEWER = 'viewer-strip-tokens';

const reading: SessionTranscriptContext = {
  usedTokens: 48_000,
  capacityTokens: 200_000,
  cacheReadTokens: 38_400,
  requestInputTokens: 48_000,
  model: 'claude-test',
  observedAt: new Date().toISOString(),
  source: 'claude_request_usage',
  capacitySource: 'provider',
  unavailableReason: null,
} as SessionTranscriptContext;

const gate = {
  data: {
    detailOf: (id: string) => ({ id, kind: id.startsWith('chat') ? 'chat' : 'work_session', title: id, counters: {}, deletedAt: null }) as unknown as EntityDetail,
    messagesOf: () => undefined,
  },
} as unknown as WorkspaceGateHandles;

/** What the session panel portals into the slot: the same chip, stack-fitted by the strip. */
function SessionReading() {
  const chrome = useContext(EntityChromeContext);
  return chrome?.statsSlot ? createPortal(<ContextChip reading={formatContext(reading, Date.now())} fit="stack" testId="session-context" />, chrome.statsSlot) : null;
}

function Strip({ id, kind, session = false }: { id: string; kind: string; session?: boolean }) {
  const runtime = useEmbeddedRuntime(VIEWER, SPACE);
  const chrome = useEntityChromeValue(null);
  const tab = embeddedTab(runtime, id, kind);
  return (
    <EmbeddedWorkspace runtime={runtime} gate={gate}>
      <EntityChromeContext.Provider value={chrome}>
        <ActionStrip tab={tab} />
        {session ? <SessionReading /> : null}
      </EntityChromeContext.Provider>
    </EmbeddedWorkspace>
  );
}

function lines(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.pn-context__line')].map((line) => line.lastChild?.textContent ?? '');
}

describe('the action strip’s token reading', () => {
  it('draws a session’s reading inside the toolbar, one figure per line', () => {
    const view = render(<Strip id="session-1" kind="work_session" session />);
    const slot = view.getByTestId('tws-astrip-stats');
    expect(view.getByTestId('tws-action-strip').contains(slot)).toBe(true);
    // Its own section between the kind's icons and the shared ones.
    expect(slot.parentElement?.classList.contains('tws-astrip-section--stats')).toBe(true);
    expect(slot.hidden).toBe(false);
    expect(lines(slot)).toEqual(['48k', '24%', 'c80%', expect.any(String)]);
    fireEvent.click(slot.querySelector('button')!);
    expect(view.getByRole('group', { name: 'Context details' })).toBeTruthy();
  });

  it('draws a chat tab’s reading as its screen publishes it, and drops it when withdrawn', () => {
    const view = render(<Strip id="chat-1" kind="chat" />);
    expect(view.queryByTestId('tws-astrip-chat-stats')).toBeNull();
    act(() => publishChatContext('chat-1', { context: reading, stale: null }));
    expect(lines(view.getByTestId('tws-astrip-chat-stats'))).toEqual(['48k', '24%', 'c80%', expect.any(String)]);
    act(() => publishChatContext('chat-1', { context: reading, stale: 'runtime stopped' }));
    expect(view.getByTestId('chat-context-strip').textContent?.startsWith('~')).toBe(true);
    act(() => publishChatContext('chat-1', null));
    expect(view.queryByTestId('tws-astrip-chat-stats')).toBeNull();
  });

  it('never draws another chat’s reading', () => {
    const view = render(<Strip id="chat-1" kind="chat" />);
    act(() => publishChatContext('chat-2', { context: reading, stale: null }));
    expect(view.queryByTestId('tws-astrip-chat-stats')).toBeNull();
    publishChatContext('chat-2', null);
  });
});
