// @vitest-environment jsdom
/**
 * FINDING #1 (audit 2026-08-29) — the empty live terminal says what it is.
 *
 * A live session whose PTY had not printed yet rendered as a featureless
 * black void. `TerminalBody` (the component that mounts the live terminal)
 * now draws one dim ghost line over the canvas — DOM text, never bytes
 * injected into xterm's buffer — until the first output or replay frame
 * arrives at the transport for this session.
 *
 * `LiveTerminal` is stubbed (mounting real xterm opens sockets this suite
 * must not), and the transport is faked at the module seam the body actually
 * observes, so the test drives exactly the signal the placeholder listens to.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardRef } from 'react';

type Handler = (id: string, data: string) => void;
const outputHandlers = new Set<Handler>();
const replayHandlers = new Set<Handler>();

vi.mock('../../terminal/pty/ptyTransport', () => ({
  ptyTransport: {
    onOutput: (handler: Handler) => {
      outputHandlers.add(handler);
      return () => outputHandlers.delete(handler);
    },
    onReplay: (handler: Handler) => {
      replayHandlers.add(handler);
      return () => replayHandlers.delete(handler);
    },
  },
}));

vi.mock('../../terminal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The byte stack is not under test; the placeholder is.
  LiveTerminal: forwardRef<HTMLDivElement>(function LiveTerminalStub(_props, ref) {
    return <div ref={ref} data-testid="live-terminal-stub" />;
  }),
  isLiveTerminalEnabled: () => true,
}));

const { TerminalBody, LIVE_TERMINAL_EMPTY_PLACEHOLDER } = await import('../bodies/TerminalBody');
const { fixtureDetails, sessionStale } = await import('../../fixtures');

function sessionDetail() {
  const detail = fixtureDetails[sessionStale.id];
  if (!detail) throw new Error('fixtures must supply a work_session detail');
  return detail;
}

describe('the live terminal placeholder', () => {
  beforeEach(() => {
    outputHandlers.clear();
    replayHandlers.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('names the empty live canvas, dim and above the terminal, not in it', () => {
    render(<TerminalBody detail={sessionDetail()} liveness="live" />);
    const ghost = screen.getByTestId('terminal-live-placeholder');
    expect(ghost.textContent).toBe(LIVE_TERMINAL_EMPTY_PLACEHOLDER);
    expect(ghost.textContent).toBe('Live terminal — no output yet · click to type');
    // The ghost treatment — the same class the reserved host's placeholder
    // wears, so it inherits pointer-events:none and the dim token.
    expect(ghost.className).toContain('term-host__ghost');
    // It is a SIBLING drawn over the canvas, never a child of xterm's box and
    // never text written into the terminal's buffer.
    expect(screen.getByTestId('live-terminal-stub').contains(ghost)).toBe(false);
    expect(screen.getByTestId('terminal-stage').contains(ghost)).toBe(true);
  });

  it('clears the moment the first live output frame arrives — and stays cleared', () => {
    const detail = sessionDetail();
    render(<TerminalBody detail={detail} liveness="live" />);
    expect(screen.queryByTestId('terminal-live-placeholder')).not.toBeNull();

    // A frame for a DIFFERENT session is not this terminal's output.
    act(() => {
      for (const handler of outputHandlers) handler('someone-else', 'noise');
    });
    expect(screen.queryByTestId('terminal-live-placeholder')).not.toBeNull();

    act(() => {
      for (const handler of outputHandlers) handler(detail.id, '$ ');
    });
    expect(screen.queryByTestId('terminal-live-placeholder')).toBeNull();
  });

  it('counts a replay frame as output — retained scrollback is not an empty terminal', () => {
    const detail = sessionDetail();
    render(<TerminalBody detail={detail} liveness="live" />);
    act(() => {
      for (const handler of replayHandlers) handler(detail.id, 'retained scrollback');
    });
    expect(screen.queryByTestId('terminal-live-placeholder')).toBeNull();
  });

  it('never draws over a canvas that is not live', () => {
    render(<TerminalBody detail={sessionDetail()} liveness="not-running" />);
    // The exited fallback owns that canvas and its own copy.
    expect(screen.queryByTestId('terminal-live-placeholder')).toBeNull();
  });
});
