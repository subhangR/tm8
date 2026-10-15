/**
 * PHONE LIVE — the 📱 button in the entity action strip and the phone that pops
 * up when it is pressed: the app under test, driven by the test run, drawn
 * live inside an iPhone or Android frame.
 *
 * The screen is a vanilla terminal started for the viewer and mounted INSIDE
 * the frame; the test command streams real frames into it (inline images, see
 * `terminal/inlineImages.ts`). Closing the phone or switching the device ends
 * that terminal.
 *
 * WHAT RUNS IS ONLY THE TASK'S OWN TEST. The phone shows the task's `live:`
 * command and the viewer presses Run; from then on that exact command starts at
 * once on this device. There is no free-text box: it read like a chat prompt,
 * and what people typed into it ran as a shell command. A task's line is content any member can write, so it is
 * never run without the viewer having pressed Start on it: that would let one
 * member run a command as another.
 *
 * ASKING FOR A TEST is the side panel's box: the viewer types or pastes what to
 * test, in plain words, and it goes to the space's dispatcher on this task
 * (`execution.dispatch`); the agent it picks writes the cases and runs them, and
 * the phone shows that run the moment its `live-terminal:` line lands.
 *
 * WATCHING A TEST THAT IS ALREADY RUNNING needs no command at all. An agent that
 * runs a test in a terminal of its own writes `live-terminal: <terminal-id>
 * [iphone|android]` into the task; the phone then pops up by itself for anyone
 * with the task open and attaches to that terminal VIEW-ONLY. Nothing runs as
 * the viewer, and closing the phone leaves the agent's terminal alone. Closed
 * once, it stays closed for that terminal; the strip's button reopens it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { LiveTerminal, isLiveTerminalEnabled, type LiveTerminalHandle } from '../../terminal';
import { ptyTransport } from '../../terminal/pty/ptyTransport.js';
import { getKind } from '../../domain';
import { liveCommandOf } from '../../panels/detail/LiveScreenButton';
import { useWorkspace } from './context';
import './phone-live.css';

export type PhoneDevice = 'iphone' | 'android';

/* The task command this viewer pressed Run on. The older free-text key held
   whatever was typed into the phone (English included) and is dropped. */
const COMMAND_KEY = 'tm8.phoneLive.trusted';
const OLD_COMMAND_KEY = 'tm8.phoneLive.command';
const DEVICE_KEY = 'tm8.phoneLive.device';
const DEVICE_WORD = /\b(iphone|pixel|android)\b/i;
const SEEN_KEY = 'tm8.phoneLive.seen';
const LIVE_TERMINAL_LINE = /^[ \t]*live-terminal:[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[ \t]+(iphone|android|pixel))?[ \t]*$/im;

export type PhoneWatch = { terminalId: string; device: PhoneDevice };

/** The agent terminal a running test streams into, from the task's `live-terminal:` line. */
export function liveTerminalOf(detail: EntityDetail | null | undefined, liveScreen: boolean | undefined): PhoneWatch | null {
  if (!liveScreen || !detail || detail.deletedAt) return null;
  if (detail.category === 'done' || detail.category === 'cancelled') return null;
  const description = (detail.content as { description?: unknown } | null | undefined)?.description;
  if (typeof description !== 'string') return null;
  const match = LIVE_TERMINAL_LINE.exec(description);
  if (!match?.[1]) return null;
  return { terminalId: match[1], device: match[2] === 'android' || match[2] === 'pixel' ? 'android' : 'iphone' };
}

/** The command with its device word swapped for the chosen one (`jm-live iphone …` → `jm-live android …`). */
export function commandForDevice(command: string, device: PhoneDevice): string {
  return DEVICE_WORD.test(command) ? command.replace(DEVICE_WORD, device) : command;
}

function readStored(key: string, store: Storage = window.localStorage): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string, store: Storage = window.localStorage) {
  try {
    store.setItem(key, value);
  } catch {
    /* storage refused: the choice still applies to this phone */
  }
}

/** The strip's button: a phone, green and blinking while the tab's task streams a test. */
export function PhoneLiveButton({ detail }: { detail: EntityDetail | null | undefined }) {
  const [open, setOpen] = useState(false);
  /* The terminal the open phone shows. Held, so a test that ends while the phone
     is open keeps its last frame on screen. */
  const [watching, setWatching] = useState<PhoneWatch | null>(null);
  const liveScreen = detail ? getKind(detail.kind).panel.liveScreen : undefined;
  const watch = liveTerminalOf(detail, liveScreen);
  const taskCommand = detail ? liveCommandOf(detail, liveScreen) : null;
  const live = Boolean(watch || taskCommand);
  const watchId = watch?.terminalId ?? null;

  /* A test that starts streaming pops the phone up (or onto the open one), once per terminal. */
  useEffect(() => {
    if (watch && readStored(SEEN_KEY, window.sessionStorage) !== watch.terminalId) {
      setWatching(watch);
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchId]);
  const close = () => {
    if (watching) writeStored(SEEN_KEY, watching.terminalId, window.sessionStorage);
    setOpen(false);
    setWatching(null);
  };
  return (
    <>
      <button
        type="button"
        className="tws-astrip-btn tws-astrip-phone"
        data-live={live ? 'true' : undefined}
        aria-label={watch ? 'Live phone screen — a test is running' : 'Live phone screen'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="tws-phone-live"
        onClick={() => {
          if (open) return close();
          setWatching(watch);
          setOpen(true);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="4.25" y="1.5" width="7.5" height="13" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7 3.4h2M7.2 12.4h1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {live ? <span className="tws-astrip-phone__dot" aria-hidden="true" /> : null}
      </button>
      {open ? <PhoneLiveDialog detail={detail ?? null} taskCommand={taskCommand} watch={watching} onClose={close} /> : null}
    </>
  );
}

type Run = { device: PhoneDevice; command: string; terminalId: string | null; error: string | null };
type Ask = { state: 'sending' } | { state: 'sent'; spawned: boolean } | { state: 'failed'; error: string };

const DEVICE_NAME: Record<PhoneDevice, string> = { iphone: 'iPhone 16 Pro Max', android: 'Pixel 9 Pro' };
const DEVICE_ENGINE: Record<PhoneDevice, string> = { iphone: 'WebKit (Safari engine)', android: 'Chromium' };

/** What the dispatched agent is told, around the viewer's own words. */
export function testRequestNote(request: string, device: PhoneDevice): string {
  return [
    `App test request from the live phone (${DEVICE_NAME[device]}):`,
    '',
    request.trim(),
    '',
    `Write these as app test cases and run them on the ${device === 'iphone' ? 'iPhone' : 'Android'} screen so the phone in tm8 shows the run:`,
    `while it runs, keep a line \`live-terminal: <terminal-id> ${device}\` in this task's description, and remove it when the run ends.`,
    "The task's description says how its app is tested.",
  ].join('\n');
}

export function PhoneLiveDialog({
  detail,
  taskCommand,
  watch,
  onClose,
}: {
  detail: EntityDetail | null;
  taskCommand: string | null;
  watch: PhoneWatch | null;
  onClose(): void;
}) {
  const { gate, spaceId } = useWorkspace();
  const commands = gate.data.seam?.commands;
  /* Runs at once only when it is the very command this viewer ran before. */
  const trusted = taskCommand !== null && readStored(COMMAND_KEY) === taskCommand;
  const [chosen, setDevice] = useState<PhoneDevice>(() => (readStored(DEVICE_KEY) === 'android' ? 'android' : 'iphone'));
  const device = watch?.device ?? chosen;
  const [run, setRun] = useState<Run | null>(null);
  const [request, setRequest] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const runRef = useRef<Run | null>(null);
  runRef.current = run;

  const stop = (terminalId: string | null) => {
    if (!terminalId || !commands) return;
    void commands
      .terminate(terminalId as EntityId, { clientMutationId: `phone-live-stop:${terminalId}:${Date.now()}`, force: true })
      .catch(() => undefined);
  };

  const start = (command: string, on: PhoneDevice) => {
    if (!commands || !command.trim()) return;
    stop(runRef.current?.terminalId ?? null);
    const next: Run = { device: on, command: commandForDevice(command.trim(), on), terminalId: null, error: null };
    setRun(next);
    void commands
      .startTerminal({
        clientMutationId: `phone-live:${Date.now()}`,
        spaceId: (detail?.spaceId ?? spaceId) as never,
        projectId: null,
        title: `Phone · ${DEVICE_NAME[on]}${detail ? ` · ${detail.title}` : ''}`.slice(0, 120),
      })
      .then((result) => {
        gate.data.reconcileCommand(result);
        const id = (result as { entity?: { id?: string } }).entity?.id ?? null;
        setRun((was) => (was === next ? { ...next, terminalId: id, error: id ? null : 'The terminal did not start.' } : was));
      })
      .catch((error: unknown) => {
        setRun((was) => (was === next ? { ...next, error: error instanceof Error ? error.message : String(error) } : was));
      });
  };

  useEffect(() => {
    try {
      window.localStorage.removeItem(OLD_COMMAND_KEY);
    } catch {
      /* storage refused */
    }
    if (trusted && taskCommand && !watch) start(taskCommand, device);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* An agent's run arriving takes the screen: the viewer's own run ends. */
  const watchId = watch?.terminalId ?? null;
  useEffect(() => {
    if (!watchId || !runRef.current) return;
    stop(runRef.current.terminalId);
    setRun(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchId]);

  /* Closing the phone ends the viewer's own terminal (never the agent's). */
  useEffect(() => () => stop(runRef.current?.terminalId ?? null), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* Type the command once the shell has said something (its prompt). */
  const terminalId = run?.terminalId ?? null;
  const runCommand = run?.command ?? '';
  useEffect(() => {
    if (!terminalId) return;
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      terminalRef.current?.send(`clear; ${runCommand}\r`);
    };
    let settle: number | undefined;
    const off = ptyTransport.onOutput((id) => {
      if (id !== terminalId || settle !== undefined) return;
      settle = window.setTimeout(send, 400);
    });
    const fallback = window.setTimeout(send, 5000);
    return () => {
      off();
      window.clearTimeout(fallback);
      if (settle !== undefined) window.clearTimeout(settle);
    };
  }, [terminalId, runCommand]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = (next: PhoneDevice) => {
    if (next === chosen || watch) return;
    setDevice(next);
    writeStored(DEVICE_KEY, next);
    if (run) start(run.command, next);
  };

  const runTaskTest = () => {
    if (!taskCommand) return;
    writeStored(COMMAND_KEY, taskCommand);
    start(taskCommand, device);
  };

  const askAgent = () => {
    const text = request.trim();
    if (!text || !detail || !commands?.dispatch) return;
    setAsk({ state: 'sending' });
    commands
      .dispatch({
        clientMutationId: `phone-live-ask:${detail.id}:${Date.now()}`,
        spaceId: (detail.spaceId ?? spaceId) as never,
        subjectId: detail.id as EntityId,
        note: testRequestNote(text, device).slice(0, 4000),
      })
      .then((result) => {
        setAsk({ state: 'sent', spawned: result.dispatcherSpawned });
        setRequest('');
      })
      .catch((error: unknown) => setAsk({ state: 'failed', error: error instanceof Error ? error.message : String(error) }));
  };

  const screen = watch ? (
    isLiveTerminalEnabled() ? (
      <FitScreen key={watch.terminalId}>
        <LiveTerminal sessionId={watch.terminalId} serverBaseUrl={gate.serverBaseUrl} live={false} />
      </FitScreen>
    ) : (
      <p className="phl-idle">The live terminal is switched off in this browser.</p>
    )
  ) : run?.terminalId && isLiveTerminalEnabled() ? (
    <LiveTerminal ref={terminalRef} sessionId={run.terminalId} serverBaseUrl={gate.serverBaseUrl} live />
  ) : run && !run.error ? (
    <p className="phl-idle" role="status">
      Starting…
    </p>
  ) : (
    <div className="phl-idle" data-testid="phone-live-idle">
      <span className="phl-idle__big">No test running</span>
      <span>Run the task's test or ask an agent →</span>
    </div>
  );

  const status = watch
    ? 'Test running'
    : run?.error
      ? null
      : run
        ? 'Your run'
        : null;

  return createPortal(
    <div className="cv2-root phl-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="phl" role="dialog" aria-modal="true" aria-label="Live phone screen" data-testid="phone-live">
        <div className={`phl-phone phl-phone--${device}`}>
          <div className="phl-screen">
            {/* The status bar the page sits under: the run draws only Safari's viewport, below it. */}
            <div className="phl-status" aria-hidden="true">
              <span>9:41</span>
              <svg className="phl-status__icons" viewBox="0 0 54 12">
                <path d="M1 9h2v2H1zM5 7h2v4H5zM9 4.5h2V11H9zM13 2h2v9h-2z" fill="currentColor" />
                <rect x="24.5" y="1.5" width="22" height="9" rx="2.5" fill="none" stroke="currentColor" opacity="0.5" />
                <rect x="26" y="3" width="16" height="6" rx="1.2" fill="currentColor" />
                <path d="M48 4.5v3a1.6 1.6 0 0 0 0-3z" fill="currentColor" opacity="0.5" />
              </svg>
            </div>
            {screen}
          </div>
          <div className="phl-island" aria-hidden="true" />
        </div>

        <aside className="phl-side">
          <header className="phl-head">
            <span className="phl-title">Live phone</span>
            {status ? (
              <span className="phl-watching" data-testid="phone-live-watching">
                <span className="tws-astrip-phone__dot" aria-hidden="true" />
                {status}
              </span>
            ) : null}
            <button type="button" className="phl-close" aria-label="Close" data-testid="phone-live-close" onClick={onClose}>
              ✕
            </button>
          </header>

          <div className="phl-devices" role="radiogroup" aria-label="Device">
            {(['iphone', 'android'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={device === d}
                disabled={Boolean(watch) && device !== d}
                className="phl-device"
                data-testid={`phone-live-${d}`}
                onClick={() => choose(d)}
              >
                {d === 'iphone' ? 'iPhone' : 'Android'}
              </button>
            ))}
          </div>
          <p className="phl-spec">
            {DEVICE_NAME[device]} screen · {DEVICE_ENGINE[device]} — emulated, not a physical device
          </p>

          {run?.error ? (
            <p className="phl-note phl-note--error" role="alert">
              {run.error}
            </p>
          ) : null}

          {!watch ? (
            <section className="phl-section">
              <h3 className="phl-h">This task's test</h3>
              {taskCommand ? (
                <>
                  <code className="phl-command" data-testid="phone-live-command">
                    {commandForDevice(taskCommand, device)}
                  </code>
                  <p className="phl-note">From the task — it runs as you, on this node.</p>
                  {run ? (
                    <button
                      type="button"
                      className="phl-secondary"
                      data-testid="phone-live-change"
                      onClick={() => {
                        stop(run.terminalId);
                        setRun(null);
                      }}
                    >
                      ■ Stop
                    </button>
                  ) : (
                    <button type="button" className="phl-start" disabled={!commands} data-testid="phone-live-start" onClick={runTaskTest}>
                      ▶ Run test
                    </button>
                  )}
                </>
              ) : (
                <p className="phl-note" data-testid="phone-live-empty">
                  None set up yet. Ask an agent below and it will write one.
                </p>
              )}
            </section>
          ) : null}

          <form
            className="phl-section"
            onSubmit={(e) => {
              e.preventDefault();
              askAgent();
            }}
          >
            <label className="phl-h" htmlFor="phl-ask">
              Ask an agent to test
            </label>
            <textarea
              id="phl-ask"
              className="phl-ask"
              rows={6}
              value={request}
              placeholder={'Type or paste what to test, in plain words, e.g.\n1. Search "wood sage" finds products\n2. Add to bag, the badge shows 1\n3. Checkout asks a guest to sign in'}
              onChange={(e) => setRequest(e.target.value)}
              data-testid="phone-live-ask"
            />
            <button
              type="submit"
              className="phl-start"
              disabled={!request.trim() || !detail || !commands?.dispatch || ask?.state === 'sending'}
              data-testid="phone-live-ask-send"
            >
              {ask?.state === 'sending' ? 'Sending…' : '✦ Write & run these tests'}
            </button>
            {ask?.state === 'sent' ? (
              <p className="phl-note" role="status" data-testid="phone-live-ask-sent">
                Sent to an agent{ask.spawned ? ' (starting one now)' : ''}. It writes the cases and runs them — this phone
                shows the run as soon as it starts.
              </p>
            ) : ask?.state === 'failed' ? (
              <p className="phl-note phl-note--error" role="alert">
                {ask.error}
              </p>
            ) : (
              <p className="phl-note">An agent turns these into test cases and runs them here, on this phone.</p>
            )}
          </form>
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Scales a view-only terminal to fill the phone's screen. A view draws at the
 * PTY's grid, not its box's, so its size is the run's choice; this fits that
 * fixed picture to whatever size the phone has on this window.
 */
function FitScreen({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const xterm = box.querySelector<HTMLElement>('.xterm');
        const screen = box.querySelector<HTMLElement>('.xterm-screen');
        if (!xterm || !screen || !screen.offsetWidth || !screen.offsetHeight) return;
        if (screen !== watched) {
          watched = screen;
          observer.observe(screen);
        }
        const scale = Math.min(box.clientWidth / screen.offsetWidth, box.clientHeight / screen.offsetHeight);
        const transform = `translateX(${Math.max(0, (box.clientWidth - screen.offsetWidth * scale) / 2)}px) scale(${scale})`;
        if (xterm.style.transform !== transform) {
          xterm.style.transformOrigin = '0 0';
          xterm.style.transform = transform;
        }
      });
    };
    let watched: HTMLElement | null = null;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    const watcher = new MutationObserver(fit);
    watcher.observe(box, { subtree: true, childList: true });
    fit();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      watcher.disconnect();
    };
  }, []);
  return (
    <div ref={boxRef} className="phl-fit">
      {children}
    </div>
  );
}
