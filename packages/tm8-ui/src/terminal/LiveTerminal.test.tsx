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
    onBinary = vi.fn(() => ({ dispose: vi.fn() }));
    parser = {
      registerOscHandler: vi.fn((_ident: number, _handler: (data: string) => boolean) => ({
        dispose: vi.fn(),
      })),
    };
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

const runtime = vi.hoisted(() => ({ hydrateReplay: null as ((data: string) => void) | null }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn() }));
const transport = vi.hoisted(() => ({
  sizeHandler: null as
    | ((id: string, size: { cols: number; rows: number; live?: boolean }) => void)
    | null,
  mode: 'drive' as 'view' | 'drive' | undefined,
  resize: vi.fn(),
}));
const sizes = vi.hoisted(() => ({
  clientFittedSessions: new Set<string>(),
  serverPtySizes: new Map<string, { cols: number; rows: number }>(),
}));

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
    onSize: (handler: NonNullable<typeof transport.sizeHandler>) => {
      transport.sizeHandler = handler;
      return () => {};
    },
    attachMode: () => transport.mode,
    onExit: () => () => {},
    // 187: the refusal channel. This file is about FOCUS, so the stub never
    // publishes one — but it must exist, because `LiveTerminal` subscribes
    // unconditionally on mount and a missing method is a TypeError inside a
    // passive effect, which surfaces as every test in the file failing for a
    // reason that has nothing to do with focus.
    onAttachRefused: () => () => {},
    onAttachRefusalCleared: () => () => {},
    openSession: vi.fn(),
    closeSession: vi.fn(),
    resize: transport.resize,
    write: vi.fn(),
  },
}));
vi.mock('./pty/ptyGrant.js', () => ({ mintPtyAttachGrant: vi.fn() }));
vi.mock('./pty/runtime.js', () => ({
  registerTerminal: (_id: string, _term: unknown, hydrateReplay: (data: string) => void) => {
    runtime.hydrateReplay = hydrateReplay;
    return () => {};
  },
}));
vi.mock('./domUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./domUtils.js')>()),
  copyToClipboardOrWarn: clipboard.copy,
}));
vi.mock('./pty/terminalSize.js', () => ({
  clientFittedSessions: sizes.clientFittedSessions,
  measureSpawnTerminalSize: () => ({ cols: 80, rows: 24 }),
  serverPtySizes: sizes.serverPtySizes,
  setLastFittedSize: vi.fn(),
}));

import { LiveTerminal } from './LiveTerminal';

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  xterm.instances.length = 0;
  runtime.hydrateReplay = null;
  clipboard.copy.mockReset();
  transport.sizeHandler = null;
  transport.mode = 'drive';
  transport.resize.mockReset();
  sizes.clientFittedSessions.clear();
  sizes.serverPtySizes.clear();
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

describe('LiveTerminal OSC 52', () => {
  it('refuses a copy parsed while replayed scrollback is in flight, then honours live output', () => {
    const { getByTestId } = render(<LiveTerminal sessionId="osc52-session" live />);
    const terminal = xterm.instances[0]!;
    const [ident, osc52] = terminal.parser.registerOscHandler.mock.calls[0]!;
    expect(ident).toBe(52);

    // Hold the replay write open: xterm parses it asynchronously, and every
    // OSC 52 it contains is parsed before the write's completion callback.
    let finishReplayWrite: (() => void) | undefined;
    terminal.write.mockImplementationOnce((_data: string, done?: () => void) => {
      finishReplayWrite = done;
    });
    fireEvent.pointerDown(getByTestId('terminal-host'));
    runtime.hydrateReplay!('replayed ring');
    osc52(`c;${btoa('an old copy from the ring')}`);
    expect(clipboard.copy).not.toHaveBeenCalled();

    finishReplayWrite!();
    osc52(`c;${btoa('live copy')}`);
    expect(clipboard.copy).toHaveBeenCalledExactlyOnceWith('live copy', 'Selection');
  });
});

/**
 * Task 01a0df2c-4106: a panel whose drive request was narrowed to view kept its
 * own fitted width (106) while the PTY stayed at the creator's (111), and Claude
 * Code's full-width rows wrapped one row early into garbage.
 */
describe('LiveTerminal geometry under a view-only attach', () => {
  const frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    while (frames.length > 0) frames.shift()!(0);
  };
  beforeEach(() => {
    frames.length = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  it("adopts the PTY's attach size even after this view has already fitted", () => {
    transport.mode = 'view';
    render(<LiveTerminal sessionId="narrowed" live />);
    const terminal = xterm.instances[0]!;
    // The first fit ran while the grant was still a drive request.
    sizes.clientFittedSessions.add('narrowed');

    transport.sizeHandler!('narrowed', { cols: 111, rows: 33 });

    expect(terminal.resize).toHaveBeenLastCalledWith(111, 33);
  });

  it('keeps a driving view on its own fit when an attach snapshot arrives', () => {
    render(<LiveTerminal sessionId="driving" live />);
    const terminal = xterm.instances[0]!;
    sizes.clientFittedSessions.add('driving');

    transport.sizeHandler!('driving', { cols: 111, rows: 33 });

    expect(terminal.resize).not.toHaveBeenCalledWith(111, 33);
  });

  it('never fits or ships a resize in view mode; a refit re-asserts PTY geometry', () => {
    transport.mode = 'view';
    render(<LiveTerminal sessionId="watching" live />);
    const terminal = xterm.instances[0]!;
    sizes.serverPtySizes.set('watching', { cols: 111, rows: 33 });

    flushFrames();

    expect(terminal.resize).toHaveBeenLastCalledWith(111, 33);
    expect(transport.resize).not.toHaveBeenCalled();
  });
});
