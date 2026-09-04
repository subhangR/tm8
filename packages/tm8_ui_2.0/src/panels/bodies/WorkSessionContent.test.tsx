// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkSessionInteractionProfileProjection } from '@tm8/contract';
import { WorkSessionContent } from './WorkSessionContent';

const SESSION_PROFILE: WorkSessionInteractionProfileProjection = {
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
  ...SESSION_PROFILE,
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

function StatefulTranscript({ onMount }: { onMount?: () => void }) {
  const [value, setValue] = useState('transcript-state');
  useEffect(() => onMount?.(), [onMount]);
  return (
    <div data-testid="transcript-scroll">
      <button type="button" onClick={() => setValue('transcript-preserved')}>
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

  // NOTHING IS GATED ANY MORE. The last conditional chip was Chat, offered only
  // when the immutable pin projected it; that gate retired with the name. A
  // session with NO interaction profile at all still gets the full strip,
  // because every surface reads the session directly and none of them depends
  // on a chat template. The Transcript's own read reports whether a transcript
  // exists — hiding the chip would have answered that question by refusing to
  // raise it.
  it('offers the whole strip, in order, on a session with no interaction pin', () => {
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-000000000001"
        profile={null}
        terminal={<div>native terminal</div>}
        transcript={<div>agent transcript</div>}
        debug={<div>debug journal</div>}
      />,
    );

    expect(screen.getByText('native terminal')).toBeTruthy();
    expect(
      screen.getAllByRole('tab').map((tab) => tab.textContent),
    ).toEqual(['Terminal', 'Transcript', 'Git', 'Debug', 'Graph']);
    // The retired name is gone from the strip entirely.
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    expect(screen.getByTestId('work-session-transcript-surface')).toBeTruthy();
  });

  it('shows the Debug journal only while its chip is selected, keeping Terminal mounted', () => {
    const onMount = vi.fn();
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-000000000009"
        profile={null}
        terminal={<StatefulTerminal onMount={onMount} />}
        transcript={<div>explicit transcript</div>}
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
  it('opens on Terminal even when the pin projects another initial surface', () => {
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-00000000000a"
        viewerMemberId="member-a"
        profile={SESSION_PROFILE}
        terminal={<div>native terminal</div>}
        transcript={<div>explicit transcript</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('work-session-terminal-surface').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('work-session-transcript-surface').getAttribute('aria-hidden')).toBe('true');
    // Switching is still available and still works.
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(screen.getByTestId('work-session-transcript-surface').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('explicit transcript')).toBeTruthy();
  });

  it('honours a saved viewer preference on a session already switched', () => {
    const sessionId = '01900000-0000-7000-8000-00000000000b';
    localStorage.setItem(`tm8:work-session-surface:v1:member-a:${sessionId}`, 'transcript');

    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-a"
        profile={SESSION_PROFILE}
        terminal={<div>native terminal</div>}
        transcript={<div>explicit transcript</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('native terminal')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByText('native terminal')).toBeTruthy();
  });

  // A viewer's own prior click must survive a rename WE made. Anyone who last
  // selected the Chat chip has `chat` in storage, and silently dropping it
  // would look like the app forgetting their choice for no reason they could
  // see. Read under the new name, and rewritten to it on the next click.
  it('honours a saved preference written under the retired Chat name', () => {
    const sessionId = '01900000-0000-7000-8000-00000000000c';
    localStorage.setItem(`tm8:work-session-surface:v1:member-a:${sessionId}`, 'chat');

    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-a"
        profile={SESSION_PROFILE}
        terminal={<div>native terminal</div>}
        transcript={<div>explicit transcript</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('explicit transcript')).toBeTruthy();

    // One-directional, like the route token: read, never written back.
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(localStorage.getItem(`tm8:work-session-surface:v1:member-a:${sessionId}`)).toBe('transcript');
  });

  it('uses explicit URL selection before saved preference and the pinned default', () => {
    const sessionId = '01900000-0000-7000-8000-000000000002';
    localStorage.setItem(`tm8:work-session-surface:v1:member-a:${sessionId}`, 'transcript');

    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-a"
        profile={SESSION_PROFILE}
        requestedSurface="terminal"
        terminal={<div>native terminal</div>}
        transcript={<div>explicit transcript</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('work-session-terminal-surface').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('work-session-transcript-surface').getAttribute('aria-hidden')).toBe('true');
  });

  it('defaults an unknown template to Terminal and still offers every surface', () => {
    render(
      <WorkSessionContent
        sessionId="01900000-0000-7000-8000-000000000003"
        profile={UNKNOWN_PROFILE}
        terminal={<div>native terminal</div>}
        transcript={<div>explicit transcript</div>}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Transcript' })).toBeTruthy();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/newer interaction template/i);
    // §14.3.1 — the failed pinned key/version must be preserved and displayed as safe
    // diagnostics, not swallowed behind a generic sentence.
    expect(notice.textContent).toMatch(/chat\.future\.unknown/);
    expect(notice.textContent).toMatch(/99/);
  });

  it('switches with tab keys, persists per viewer/session, and retains both mounted surfaces', () => {
    const onMount = vi.fn();
    const onTranscriptMount = vi.fn();
    const onSurfaceChange = vi.fn();
    const sessionId = '01900000-0000-7000-8000-000000000004';
    render(
      <WorkSessionContent
        sessionId={sessionId}
        viewerMemberId="member-b"
        profile={SESSION_PROFILE}
        requestedSurface="terminal"
        onSurfaceChange={onSurfaceChange}
        terminal={<StatefulTerminal onMount={onMount} />}
        transcript={<StatefulTranscript onMount={onTranscriptMount} />}
      />,
    );

    expect(onTranscriptMount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('terminal-state'));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), { key: 'ArrowRight' });
    expect(onSurfaceChange).toHaveBeenLastCalledWith('transcript');
    expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true');
    expect(onTranscriptMount).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('transcript-state'));
    const transcriptScroll = screen.getByTestId('transcript-scroll');
    transcriptScroll.scrollTop = 123;

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Transcript' }), { key: 'Home' });
    expect(screen.getByText('terminal-preserved')).toBeTruthy();
    // ArrowRight walks the list terminal→transcript; the transcript pane kept
    // its state while hidden.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), { key: 'ArrowRight' });
    expect(screen.getByText('transcript-preserved')).toBeTruthy();
    expect(transcriptScroll.scrollTop).toBe(123);
    // End jumps to the LAST surface — Graph. The transcript pane stays mounted
    // (its scroll survives), the terminal too.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Transcript' }), { key: 'End' });
    expect(onSurfaceChange).toHaveBeenLastCalledWith('graph');
    expect(screen.getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe('true');
    // ArrowLeft walks back onto Debug, so the walk still covers the chip that
    // used to be last.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Graph' }), { key: 'ArrowLeft' });
    expect(onSurfaceChange).toHaveBeenLastCalledWith('debug');
    expect(screen.getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected')).toBe('true');
    expect(transcriptScroll.scrollTop).toBe(123);
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onTranscriptMount).toHaveBeenCalledTimes(1);
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
          profile={SESSION_PROFILE}
          requestedSurface="terminal"
          onSurfaceChange={onClaudeSurface}
          terminal={<div>Claude Code · claude-opus-5 terminal</div>}
          transcript={<div>Claude transcript</div>}
        />
        <WorkSessionContent
          sessionId="01900000-0000-7000-8000-000000000006"
          viewerMemberId="member-c"
          profile={SESSION_PROFILE}
          requestedSurface="transcript"
          onSurfaceChange={onCodexSurface}
          terminal={<div>Codex · gpt-5.6-sol terminal</div>}
          transcript={<div>Codex transcript</div>}
        />
      </>,
    );

    const transcriptTabs = getAllByRole('tab', { name: 'Transcript' });
    fireEvent.click(transcriptTabs[0]!);
    expect(onClaudeSurface).toHaveBeenCalledWith('transcript');
    expect(onCodexSurface).not.toHaveBeenCalled();
    expect(getAllByTestId('work-session-transcript-surface').map((pane) => pane.getAttribute('aria-hidden')))
      .toEqual(['false', 'false']);
  });
});
