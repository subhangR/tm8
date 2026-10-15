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
 * WHAT RUNS IS THE VIEWER'S OWN COMMAND. The first time, the phone shows the
 * command — prefilled from the task's `live:` line when it has one — and the
 * viewer presses Start; from then on it is remembered on this device and the
 * phone starts at once. A task's line is content any member can write, so it is
 * never run without the viewer having pressed Start on it: that would let one
 * member run a command as another.
 *
 * WATCHING A TEST THAT IS ALREADY RUNNING needs no command at all. An agent that
 * runs a test in a terminal of its own writes `live-terminal: <terminal-id>
 * [iphone|android]` into the task; the phone then pops up by itself for anyone
 * with the task open and attaches to that terminal VIEW-ONLY. Nothing runs as
 * the viewer, and closing the phone leaves the agent's terminal alone. Closed
 * once, it stays closed for that terminal; the strip's button reopens it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { LiveTerminal, isLiveTerminalEnabled, type LiveTerminalHandle } from '../../terminal';
import { ptyTransport } from '../../terminal/pty/ptyTransport.js';
import { getKind } from '../../domain';
import { liveCommandOf } from '../../panels/detail/LiveScreenButton';
import { useWorkspace } from './context';
import './phone-live.css';

export type PhoneDevice = 'iphone' | 'android';

const COMMAND_KEY = 'tm8.phoneLive.command';
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
     is open keeps its last frame on screen instead of turning into a form. */
  const [watching, setWatching] = useState<PhoneWatch | null>(null);
  const liveScreen = detail ? getKind(detail.kind).panel.liveScreen : undefined;
  const watch = liveTerminalOf(detail, liveScreen);
  const live = (detail ? liveCommandOf(detail, liveScreen) : null) ?? (watch ? 'running' : null);
  const watchId = watch?.terminalId ?? null;

  /* A test that starts streaming pops the phone up, once per terminal. */
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
        aria-label={live ? 'Live phone screen — a test is running' : 'Live phone screen'}
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
      {open && watching ? (
        <PhoneWatchDialog key={watching.terminalId} watch={watching} onClose={close} />
      ) : open ? (
        <PhoneLiveDialog detail={detail ?? null} taskCommand={live === 'running' ? null : live} onClose={close} />
      ) : null}
    </>
  );
}

type Run = { device: PhoneDevice; command: string; terminalId: string | null; error: string | null };

export function PhoneLiveDialog({
  detail,
  taskCommand,
  onClose,
}: {
  detail: EntityDetail | null;
  taskCommand: string | null;
  onClose(): void;
}) {
  const { gate, spaceId } = useWorkspace();
  const commands = gate.data.seam?.commands;
  const confirmed = readStored(COMMAND_KEY);
  const [device, setDevice] = useState<PhoneDevice>(() => (readStored(DEVICE_KEY) === 'android' ? 'android' : 'iphone'));
  const [draft, setDraft] = useState(() => confirmed ?? taskCommand ?? '');
  const [run, setRun] = useState<Run | null>(null);
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
        title: `Phone · ${on === 'iphone' ? 'iPhone' : 'Android'}${detail ? ` · ${detail.title}` : ''}`.slice(0, 120),
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

  /* A command the viewer pressed Start on before starts at once. */
  useEffect(() => {
    if (confirmed) start(confirmed, device);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Closing the phone ends its terminal. */
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
      terminalRef.current?.send(`${runCommand}\r`);
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

  const choose = (next: PhoneDevice) => {
    if (next === device) return;
    setDevice(next);
    writeStored(DEVICE_KEY, next);
    if (run) start(run.command, next);
  };

  const confirmAndStart = () => {
    const command = draft.trim();
    if (!command) return;
    writeStored(COMMAND_KEY, command);
    start(command, device);
  };

  return (
    <PhoneShell
      device={device}
      onClose={onClose}
      bar={
        <>
          <div className="phl-devices" role="radiogroup" aria-label="Device">
            {(['iphone', 'android'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={device === d}
                className="phl-device"
                data-testid={`phone-live-${d}`}
                onClick={() => choose(d)}
              >
                {d === 'iphone' ? 'iPhone' : 'Android'}
              </button>
            ))}
          </div>
          {run ? (
            <button
              type="button"
              className="phl-text"
              onClick={() => {
                stop(run.terminalId);
                setDraft(run.command);
                setRun(null);
              }}
              data-testid="phone-live-change"
            >
              Command
            </button>
          ) : null}
        </>
      }
    >
      {run?.terminalId && isLiveTerminalEnabled() ? (
        <LiveTerminal ref={terminalRef} sessionId={run.terminalId} serverBaseUrl={gate.serverBaseUrl} live />
      ) : run && !run.error ? (
        <p className="phl-note" role="status">
          Starting {device === 'iphone' ? 'iPhone' : 'Android'}…
        </p>
      ) : (
        <form
          className="phl-setup"
          onSubmit={(e) => {
            e.preventDefault();
            confirmAndStart();
          }}
        >
          {run?.error ? (
            <p className="phl-note phl-note--error" role="alert">
              {run.error}
            </p>
          ) : null}
          <label className="phl-label" htmlFor="phl-command">
            Test command
          </label>
          <textarea
            id="phl-command"
            className="phl-command"
            rows={4}
            value={draft}
            spellCheck={false}
            placeholder="the command that runs the app test, e.g. jm-live iphone shopping"
            onChange={(e) => setDraft(e.target.value)}
            data-testid="phone-live-command"
          />
          <p className="phl-note">
            {draft && draft === taskCommand && draft !== confirmed
              ? 'From the task. Check it — it runs as you, on this node.'
              : 'Runs as you, on this node. Remembered on this device.'}
          </p>
          <button type="submit" className="phl-start" disabled={!draft.trim() || !commands} data-testid="phone-live-start">
            ▶ Start
          </button>
        </form>
      )}
    </PhoneShell>
  );
}

/** The phone over a running test: the agent's own terminal, attached view-only. */
export function PhoneWatchDialog({ watch, onClose }: { watch: PhoneWatch; onClose(): void }) {
  const { gate } = useWorkspace();
  return (
    <PhoneShell
      device={watch.device}
      onClose={onClose}
      bar={
        <span className="phl-watching" data-testid="phone-live-watching">
          <span className="tws-astrip-phone__dot" aria-hidden="true" />
          Test running · {watch.device === 'iphone' ? 'iPhone' : 'Android'}
        </span>
      }
    >
      {isLiveTerminalEnabled() ? (
        <LiveTerminal sessionId={watch.terminalId} serverBaseUrl={gate.serverBaseUrl} live={false} />
      ) : (
        <p className="phl-note">The live terminal is switched off in this browser.</p>
      )}
    </PhoneShell>
  );
}

/** Scrim, top bar, phone frame and caption, portaled to the body: the strip is a
    toolbar that takes Home/End, and the tokens live under `.cv2-root`. */
function PhoneShell({
  device,
  bar,
  onClose,
  children,
}: {
  device: PhoneDevice;
  bar: ReactNode;
  onClose(): void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="cv2-root phl-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="phl" role="dialog" aria-modal="true" aria-label="Live phone screen" data-testid="phone-live">
        <div className="phl-bar">
          {bar}
          <button type="button" className="phl-close" aria-label="Close" data-testid="phone-live-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={`phl-phone phl-phone--${device}`}>
          <div className="phl-notch" aria-hidden="true" />
          <div className="phl-screen">{children}</div>
          <div className="phl-home" aria-hidden="true" />
        </div>
        <p className="phl-foot">
          {device === 'iphone' ? 'iPhone 15 screen · WebKit (Safari engine)' : 'Pixel 7 screen · Chromium'} — emulated, not a
          physical device
        </p>
      </div>
    </div>,
    document.body,
  );
}
