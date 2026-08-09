// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    focus = vi.fn();
    blur = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    scrollToBottom = vi.fn();
    refresh = vi.fn();
    write = vi.fn((_data: string, done?: () => void) => done?.());
    resize = vi.fn();
    paste = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    rows = 24;
    cols = 80;
    element: HTMLDivElement | null = null;
    options: Record<string, unknown> = {};
    _core = {
      _renderService: {
        _renderer: {
          value: { dimensions: { css: { cell: { width: 8 } } } },
        },
      },
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xterm.instances.push(this);
    }

    open(container: HTMLElement) {
      this.element = document.createElement('div');
      container.appendChild(this.element);
    }
  }
  return { FakeTerminal, instances: [] as FakeTerminal[] };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('./terminalTheme.js', () => ({
  TERMINAL_CURSOR_INACTIVE_STYLE: 'none',
  TERMINAL_CURSOR_STYLE: 'block',
  TERMINAL_FONT_SIZE: 13,
  TERMINAL_FONT_STACK: 'monospace',
  TERMINAL_FONT_WEIGHT: 400,
  TERMINAL_FONT_WEIGHT_BOLD: 600,
  TERMINAL_LETTER_SPACING: 0,
  TERMINAL_LINE_HEIGHT: 1,
  TERMINAL_SCROLLBACK: 100,
  buildTerminalTheme: () => ({}),
}));
vi.mock('./pty/ptyTransport.js', () => ({
  ptyTransport: {
    onSize: () => () => {},
    onExit: () => () => {},
    openSession: vi.fn(),
    closeSession: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock('./pty/ptyGrant.js', () => ({ mintPtyAttachGrant: vi.fn() }));
vi.mock('./pty/runtime.js', () => ({ registerTerminal: () => () => {} }));
vi.mock('./pty/terminalSize.js', () => ({
  clientFittedSessions: new Set<string>(),
  measureSpawnTerminalSize: () => ({ cols: 80, rows: 24 }),
  serverPtySizes: new Map(),
  setLastFittedSize: vi.fn(),
}));

import { LiveTerminal } from './LiveTerminal';

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  xterm.instances.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

describe('LiveTerminal focus capture', () => {
  it('focuses an opted-in login terminal on mount and again when it is pressed', () => {
    const { getByTestId } = render(
      <LiveTerminal sessionId="credential-session" live autoFocus />,
    );
    const terminal = xterm.instances[0]!;

    expect(terminal.focus).toHaveBeenCalledOnce();
    fireEvent.pointerDown(getByTestId('terminal-host'));
    expect(terminal.focus).toHaveBeenCalledTimes(2);
  });

  it('does not focus a read-only terminal', () => {
    render(<LiveTerminal sessionId="read-only-session" live={false} autoFocus />);
    expect(xterm.instances[0]!.focus).not.toHaveBeenCalled();
  });
});
