// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import { WorkSessionContent } from './WorkSessionContent';

const CHAT_PROFILE: WorkSessionInteractionProfileProjection = {
  pinRevision: 4,
  templateKey: 'chat.agent.canonical',
  templateVersion: 1,
  compatibility: 'supported',
  chatEnabled: true,
  initialContentSurface: 'chat',
  feedPolicy: {
    scope: 'session_chat_v1',
    defaultLimit: 50,
    maxLimit: 200,
    includeActivity: true,
  },
  composerPolicy: {
    maxBodyChars: 12_000,
    allowedAttachmentKinds: ['file'],
    operationBindings: { post: 'messages.post' },
  },
};

const UNKNOWN_PROFILE: WorkSessionInteractionProfileProjection = {
  ...CHAT_PROFILE,
  templateKey: 'chat.future.unknown',
  templateVersion: 99,
  compatibility: 'unknown_template',
};

function StatefulTerminal({ onMount }: { onMount(): void }) {
  const [value, setValue] = useState('terminal-state');
  useEffect(onMount, [onMount]);
  return (
    <button type="button" onClick={() => setValue('terminal-preserved')}>
      {value}
    </button>
  );
}

function StatefulChat({ onMount }: { onMount?: () => void }) {
  const [value, setValue] = useState('chat-state');
  useEffect(() => onMount?.(), [onMount]);
  return (
    <div data-testid="chat-scroll">
      <button type="button" onClick={() => setValue('chat-preserved')}>
        {value}
      </button>
    </div>
  );
}

describe('WorkSessionContent', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Storage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  });

  // The switch is no longer chat-gated: Debug is always offered, so a session
  // with no chat pin still shows a Terminal|Debug switch — but NO Chat chip,
  // and the chat pane is never rendered.
  it('offers Terminal and Debug (no Chat) when no immutable interaction pin projected Chat', () => {
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-000000000001"
        profile={null}
        terminal={<div>native terminal</div>}
        chat={<div>explicit chat</div>}
        debug={<div>debug journal</div>}
      />,
    );

    expect(screen.getByText('native terminal')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Debug' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    expect(screen.queryByTestId('work-session-chat-surface')).toBeNull();
    expect(screen.queryByText('explicit chat')).toBeNull();
  });

  it('shows the Debug journal only while its chip is selected, keeping Terminal mounted', () => {
    const onMount = vi.fn();
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-000000000009"
        profile={null}
        terminal={<StatefulTerminal onMount={onMount} />}
        chat={<div>explicit chat</div>}
        debug={<div data-testid="debug-content">debug journal</div>}
      />,
    );

    // Terminal is default; Debug pane is present but empty until selected.
    expect(screen.queryByTestId('debug-content')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Debug' }));
    expect(screen.getByTestId('debug-content')).toBeTruthy();
    expect(screen.getByTestId('work-session-terminal-surface')).toBeTruthy();
    // Switching back unmounts debug (this is how its poll stops) but keeps the
    // terminal mounted throughout — onMount fired exactly once.
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.queryByTestId('debug-content')).toBeNull();
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  // USER RULING 2026-08-01 — the default is always Terminal, for every session.
  it('opens on Terminal even when the pin projects Chat as its initial surface', () => {
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-00000000000a"
        viewerMemberId="member-a"
        profile={CHAT_PROFILE}
        terminal={<div>native terminal</div>}
        chat={<div>explicit chat</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('work-session-terminal-surface').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('work-session-chat-surface').getAttribute('aria-hidden')).toBe('true');
    // Switching is still available and still works.
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByTestId('work-session-chat-surface').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('explicit chat')).toBeTruthy();
  });

  it('honours a saved viewer preference for Chat on a session already switched', () => {
    const sessionId = '01900000-0000-7000-8000-00000000000b';
    localStorage.setItem(`tm8:work-session-surface:v1:member-a:${sessionId}`, 'chat');

    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-a"
        profile={CHAT_PROFILE}
        terminal={<div>native terminal</div>}
        chat={<div>explicit chat</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });

  it('uses explicit URL selection before saved preference and the pinned default', () => {
    const sessionId = '01900000-0000-7000-8000-000000000002';
    localStorage.setItem(`tm8:work-session-surface:v1:member-a:${sessionId}`, 'chat');

    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-a"
        profile={CHAT_PROFILE}
        requestedSurface="terminal"
        terminal={<div>native terminal</div>}
        chat={<div>explicit chat</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('work-session-terminal-surface').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('work-session-chat-surface').getAttribute('aria-hidden')).toBe('true');
  });

  it('defaults an unknown template to Terminal while keeping a warned core-safe Chat available', () => {
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-000000000003"
        profile={UNKNOWN_PROFILE}
        terminal={<div>native terminal</div>}
        chat={<div>explicit chat</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeTruthy();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/newer interaction template/i);
    // §14.3.1 — the failed pinned key/version must be preserved and displayed as safe
    // diagnostics, not swallowed behind a generic sentence.
    expect(notice.textContent).toMatch(/chat\.future\.unknown/);
    expect(notice.textContent).toMatch(/99/);
  });

  it('switches with tab keys, persists per viewer/session, and retains both mounted surfaces', () => {
    const onMount = vi.fn();
    const onChatMount = vi.fn();
    const onSurfaceChange = vi.fn();
    const sessionId = '01900000-0000-7000-8000-000000000004';
    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-b"
        profile={CHAT_PROFILE}
        requestedSurface="terminal"
        onSurfaceChange={onSurfaceChange}
        terminal={<StatefulTerminal onMount={onMount} />}
        chat={<StatefulChat onMount={onChatMount} />}
      />,
    );

    expect(onChatMount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('terminal-state'));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), { key: 'ArrowRight' });
    expect(onSurfaceChange).toHaveBeenLastCalledWith('chat');
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
    expect(onChatMount).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('chat-state'));
    const chatScroll = screen.getByTestId('chat-scroll');
    chatScroll.scrollTop = 123;

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat' }), { key: 'Home' });
    expect(screen.getByText('terminal-preserved')).toBeTruthy();
    // ArrowRight walks the dynamic list terminal→chat; the chat pane kept its
    // state while hidden.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), { key: 'ArrowRight' });
    expect(screen.getByText('chat-preserved')).toBeTruthy();
    expect(chatScroll.scrollTop).toBe(123);
    // End now jumps to the LAST surface — Debug, the always-present third chip.
    // The chat pane stays mounted (its scroll survives), the terminal too.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat' }), { key: 'End' });
    expect(onSurfaceChange).toHaveBeenLastCalledWith('debug');
    expect(screen.getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected')).toBe('true');
    expect(chatScroll.scrollTop).toBe(123);
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onChatMount).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`tm8:work-session-surface:v1:member-b:${sessionId}`)).toBe('debug');
  });

  it('isolates two pinned panels and gives Claude/Codex context no authority over surface selection', () => {
    const onClaudeSurface = vi.fn();
    const onCodexSurface = vi.fn();
    const { getAllByRole, getAllByTestId } = render(
      <>
        <WorkSessionContent
          sessionId="01900000-0000-7000-8000-000000000005"
          viewerMemberId="member-c"
          profile={CHAT_PROFILE}
          requestedSurface="terminal"
          onSurfaceChange={onClaudeSurface}
          terminal={<div>Claude Code · claude-opus-5 terminal</div>}
          chat={<div>Claude provider-neutral Chat</div>}
        />
        <WorkSessionContent
          sessionId="01900000-0000-7000-8000-000000000006"
          viewerMemberId="member-c"
          profile={CHAT_PROFILE}
          requestedSurface="chat"
          onSurfaceChange={onCodexSurface}
          terminal={<div>Codex · gpt-5.6-sol terminal</div>}
          chat={<div>Codex provider-neutral Chat</div>}
        />
      </>,
    );

    const chatTabs = getAllByRole('tab', { name: 'Chat' });
    fireEvent.click(chatTabs[0]!);
    expect(onClaudeSurface).toHaveBeenCalledWith('chat');
    expect(onCodexSurface).not.toHaveBeenCalled();
    expect(getAllByTestId('work-session-chat-surface').map((pane) => pane.getAttribute('aria-hidden')))
      .toEqual(['false', 'false']);
  });
});
