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
 * WRITE & RUN is the side panel's box: the viewer types or pastes what to test,
 * in plain words, and it runs IN THIS PHONE, not in a new session. The app's
 * task carries `live-ask: <command>`; pressing the button runs that command in
 * the phone's terminal, and once it prints `READY-FOR-CASES` the viewer's words
 * go in as ONE base64 line, so nothing typed can ever reach the shell as a
 * command. The runner reads the app's source, writes the cases and runs them on
 * the screen. The phone remembers that task per space; until it has one it
 * looks for it: the space's `type: test` tasks whose description starts with a
 * `live-ask:` line. So the box works from any tab, and a test an agent is
 * running on that task shows on every phone (view-only) until the viewer starts
 * their own. With no words (Explore & deep test)
 * the runner crawls every screen it can reach and writes a deep suite itself.
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
const ASK_LINE = /^[ \t]*live-ask:[ \t]*(\S[^\r\n]*)$/im;
const APP_LINE = /^[ \t]*live-app:[ \t]*(\S[^\r\n]*)$/im;
const ASK_TRUSTED_KEY = 'tm8.phoneLive.askTrusted';
const APP_TASK_KEY = 'tm8.phoneLive.appTask:';
export const READY_MARKER = 'READY-FOR-CASES';
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

function lineOf(detail: EntityDetail | null | undefined, line: RegExp): string | null {
  if (!detail || detail.deletedAt || detail.category === 'done' || detail.category === 'cancelled') return null;
  const description = (detail.content as { description?: unknown } | null | undefined)?.description;
  if (typeof description !== 'string') return null;
  const value = line.exec(description)?.[1]?.trim();
  return value && value.length <= 500 ? value : null;
}

/** The task's write-and-run command (`live-ask:`) and the app it tests (`live-app:`, display only). */
export function askCommandOf(detail: EntityDetail | null | undefined): string | null {
  return lineOf(detail, ASK_LINE);
}
export function appNameOf(detail: EntityDetail | null | undefined): string | null {
  return lineOf(detail, APP_LINE);
}

/** UTF-8 text as one base64 line: the only shape the viewer's words take on the way into the terminal. */
export function base64Line(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
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

/* `cases`: the viewer's words for a write-and-run, sent once the runner asks for them. */
type Run = { device: PhoneDevice; command: string; terminalId: string | null; error: string | null; cases?: string };

const DEVICE_NAME: Record<PhoneDevice, string> = { iphone: 'iPhone 16 Pro Max', android: 'Pixel 9 Pro' };
const DEVICE_ENGINE: Record<PhoneDevice, string> = { iphone: 'WebKit (Safari engine)', android: 'Chromium' };

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
  /* The app this phone writes and runs tests for: this tab's task when it carries
     `live-ask:`, else the one remembered for the space. */
  const space = String(detail?.spaceId ?? spaceId ?? '');
  const ownAsk = askCommandOf(detail);
  const [appTaskId, setAppTaskId] = useState<string | null>(() => (ownAsk ? detail!.id : readStored(APP_TASK_KEY + space)));
  const [, setTick] = useState(0);
  const appDetail = ownAsk ? detail : appTaskId ? (gate.data.detailOf(appTaskId as EntityId) ?? null) : null;
  const askCommand = ownAsk ?? askCommandOf(appDetail);
  const appName = appNameOf(appDetail);
  /* Not remembered yet: find the space's app task. */
  useEffect(() => {
    if (appTaskId || !space || !gate.data.seam?.query) return;
    let live = true;
    void gate.data.seam
      .query({ spaceId: space as never, kinds: ['task'], filters: { axes: { type: ['test'] } }, limit: 50 } as never)
      .then((result) => {
        const found = result.page.items.find((item) => !item.deletedAt && /(^|\s)live-ask:\s*\S/.test(item.excerpt ?? ''));
        if (live && found) {
          writeStored(APP_TASK_KEY + space, found.id);
          setAppTaskId(found.id);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space]);
  useEffect(() => {
    if (ownAsk && detail) writeStored(APP_TASK_KEY + space, detail.id);
    if (ownAsk || !appTaskId || appDetail) return;
    gate.data.refetchDetail(appTaskId as EntityId);
    let tries = 0;
    const poll = window.setInterval(() => {
      setTick((t) => t + 1);
      if (++tries >= 15) window.clearInterval(poll);
    }, 1000);
    return () => window.clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appTaskId, Boolean(appDetail)]);
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const runRef = useRef<Run | null>(null);
  runRef.current = run;
  /* What the screen watches: this task's running test, else the app task's while the viewer runs nothing. */
  const shown = watch ?? (run || ownAsk ? null : liveTerminalOf(appDetail, true));

  const stop = (terminalId: string | null) => {
    if (!terminalId || !commands) return;
    void commands
      .terminate(terminalId as EntityId, { clientMutationId: `phone-live-stop:${terminalId}:${Date.now()}`, force: true })
      .catch(() => undefined);
  };

  const start = (command: string, on: PhoneDevice, cases?: string) => {
    if (!commands || !command.trim()) return;
    stop(runRef.current?.terminalId ?? null);
    const next: Run = { device: on, command: commandForDevice(command.trim(), on), terminalId: null, error: null, ...(cases !== undefined ? { cases } : {}) };
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
  const runCases = run?.cases ?? null;
  useEffect(() => {
    if (!terminalId) return;
    let sent = false;
    let casesSent = false;
    let tail = '';
    const send = () => {
      if (sent) return;
      sent = true;
      terminalRef.current?.send(`clear; ${runCommand}\r`);
    };
    let settle: number | undefined;
    const off = ptyTransport.onOutput((id, data) => {
      if (id !== terminalId) return;
      /* The runner asks for the cases; until then they are never typed. */
      if (sent && runCases !== null && !casesSent) {
        tail = (tail + data).slice(-200);
        if (tail.includes(READY_MARKER)) {
          casesSent = true;
          terminalRef.current?.send(`${base64Line(runCases)}\r`);
        }
      }
      if (settle !== undefined) return;
      settle = window.setTimeout(send, 400);
    });
    const fallback = window.setTimeout(send, 5000);
    return () => {
      off();
      window.clearTimeout(fallback);
      if (settle !== undefined) window.clearTimeout(settle);
    };
  }, [terminalId, runCommand, runCases]);

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
    if (run) start(run.command, next, run.cases);
  };

  const runTaskTest = () => {
    if (!taskCommand) return;
    writeStored(COMMAND_KEY, taskCommand);
    start(taskCommand, device);
  };

  /* No words = explore & deep test: the runner crawls the app and writes its own suite. */
  const writeAndRun = (explore = false) => {
    const text = explore ? '' : request.trim();
    if ((!text && !explore) || !askCommand) return;
    writeStored(ASK_TRUSTED_KEY, askCommand);
    start(askCommand, device, text);
  };

  const screenDevice = shown?.device ?? device;
  const screen = shown ? (
    isLiveTerminalEnabled() ? (
      <FitScreen key={shown.terminalId}>
        <LiveTerminal sessionId={shown.terminalId} serverBaseUrl={gate.serverBaseUrl} live={false} />
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
      <span>Run the task's test, or write your own →</span>
    </div>
  );

  const status = shown
    ? 'Test running'
    : run?.error
      ? null
      : run
        ? 'Your run'
        : null;

  return createPortal(
    <div className="cv2-root phl-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="phl" role="dialog" aria-modal="true" aria-label="Live phone screen" data-testid="phone-live">
        <div className={`phl-phone phl-phone--${screenDevice}`}>
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
                aria-checked={screenDevice === d}
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
            {DEVICE_NAME[screenDevice]} screen · {DEVICE_ENGINE[screenDevice]} — emulated, not a physical device
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
              writeAndRun();
            }}
          >
            <label className="phl-h" htmlFor="phl-ask">
              Write &amp; run tests
            </label>
            {appName ? (
              <p className="phl-note" data-testid="phone-live-app">
                App: <strong>{appName}</strong>
              </p>
            ) : null}
            <textarea
              id="phl-ask"
              className="phl-ask"
              rows={6}
              value={request}
              placeholder={'Type or paste what to test, in plain words, e.g.\n1. Search "wood sage" finds products\n2. Add to bag, the badge shows 1\n3. Checkout asks a guest to sign in'}
              onChange={(e) => setRequest(e.target.value)}
              data-testid="phone-live-ask"
            />
            <div className="phl-actions">
              <button
                type="submit"
                className="phl-start"
                disabled={!request.trim() || !askCommand || !commands || Boolean(watch)}
                data-testid="phone-live-ask-send"
              >
                ✦ Write &amp; run
              </button>
              <button
                type="button"
                className="phl-secondary"
                disabled={!askCommand || !commands || Boolean(watch)}
                data-testid="phone-live-explore"
                title="Taps through every screen, checks each one, then writes and runs a deep test suite — about 15 minutes"
                onClick={() => writeAndRun(true)}
              >
                🔍 Explore &amp; deep test
              </button>
            </div>
            {askCommand ? (
              <p className="phl-note">
                Write &amp; run turns your words into tests (about a minute, then live). Explore &amp; deep test needs no
                words: it taps through every screen, then writes and runs 20+ deep cases and a report (~15 min). Runs <code>{commandForDevice(askCommand, device)}</code> as you, on this node.
              </p>
            ) : (
              <p className="phl-note" data-testid="phone-live-ask-none">
                Not connected to an app yet: this space has no live test task (a <code>type: test</code> task whose
                description starts with a <code>live-ask:</code> line). Opening one connects the phone.
              </p>
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
