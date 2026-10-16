/**
 * WEBSITE TESTER — the 🖥 button under the phone in the entity action strip, and
 * the browser window that pops up when it is pressed: a website, built and run
 * from its GitHub source, tested live on a desktop screen.
 *
 * The viewer gives a GitHub repository and, in plain words, what to test (or
 * nothing: Explore & deep test writes a deep suite from the source itself).
 * Like the phone (`PhoneLive.tsx`), WHAT RUNS IS ONLY A TASK'S OWN COMMAND: the
 * space's test task carries `live-web: <command>`, pressing the button runs
 * that command in a terminal started for the viewer, and once it prints
 * `READY-FOR-CASES` the repository and the words go in as ONE base64 line, so
 * nothing typed can ever reach the shell. The runner clones the repo, installs,
 * builds and serves the site in a sandbox, has a model read the source and
 * write the tests, and runs them; the frames, the cases and their outcomes
 * stream back like the phone's, and the same report follows.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { LiveTerminal, isLiveTerminalEnabled, type LiveTerminalHandle } from '../../terminal';
import { ptyTransport } from '../../terminal/pty/ptyTransport.js';
import { EMPTY_RUN } from './phoneRun';
import type { ReportFormat } from './reportFiles';
import { READY_MARKER, RunCases, RunReport, base64Line, downloadReport, runReducer } from './PhoneLive';
import { useWorkspace } from './context';
import './phone-live.css';
import './web-test.css';

const WEB_LINE = /^[ \t]*live-web:[ \t]*(\S[^\r\n]*)$/im;
const REPO_KEY = 'tm8.webTest.repo';
const TASK_KEY = 'tm8.webTest.task:';
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}?(?:\.git)?\/?$/;

/** The task's website-test command (`live-web:`). */
export function webCommandOf(detail: EntityDetail | null | undefined): string | null {
  if (!detail || detail.deletedAt || detail.category === 'done' || detail.category === 'cancelled') return null;
  const description = (detail.content as { description?: unknown } | null | undefined)?.description;
  if (typeof description !== 'string') return null;
  const value = WEB_LINE.exec(description)?.[1]?.trim();
  return value && value.length <= 500 ? value : null;
}

/** A GitHub repository link as the runner takes it, or null: `owner/repo` and `github.com/owner/repo` are accepted too. */
export function normalizeRepo(input: string): string | null {
  let value = input.trim().replace(/\s+/g, '');
  if (!value) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) value = `https://github.com/${value}`;
  value = value.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, 'https://github.com/');
  value = value.replace(/\/(?:tree|blob)\/.*$/, '').replace(/\.git$/, '').replace(/\/$/, '');
  return GITHUB_REPO.test(value) && !value.includes('..') ? value : null;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage refused: the choice still applies to this window */
  }
}

/** The strip's button: a monitor, under the phone. */
export function WebTestButton({ detail }: { detail: EntityDetail | null | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="tws-astrip-btn tws-astrip-web"
        aria-label="Website tester"
        title="Website tester — build a site from GitHub and test it live"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="tws-web-test"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="9" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      {open ? <WebTestDialog detail={detail ?? null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Run = { command: string; payload: string; terminalId: string | null; error: string | null; repo: string; cases: string };

export function WebTestDialog({ detail, onClose }: { detail: EntityDetail | null; onClose(): void }) {
  const { gate, spaceId } = useWorkspace();
  const commands = gate.data.seam?.commands;
  const space = String(detail?.spaceId ?? spaceId ?? '');
  const own = webCommandOf(detail);
  const [taskId, setTaskId] = useState<string | null>(() => (own ? detail!.id : readStored(TASK_KEY + space)));
  const [, setTick] = useState(0);
  const taskDetail = own ? detail : taskId ? (gate.data.detailOf(taskId as EntityId) ?? null) : null;
  const command = own ?? webCommandOf(taskDetail);
  const [repo, setRepo] = useState(() => readStored(REPO_KEY) ?? '');
  const [request, setRequest] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [screenRun, dispatch] = useReducer(runReducer, EMPTY_RUN);
  const [peek, setPeek] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const terminalRef = useRef<LiveTerminalHandle>(null);
  const runRef = useRef<Run | null>(null);
  runRef.current = run;
  const repoUrl = normalizeRepo(repo);

  /* Not remembered yet: find the space's website test task. */
  useEffect(() => {
    if (taskId || !space || !gate.data.seam?.query) return;
    let live = true;
    void gate.data.seam
      .query({ spaceId: space as never, kinds: ['task'], filters: { axes: { type: ['test'] } }, limit: 50 } as never)
      .then((result) => {
        const found = result.page.items.find((item) => !item.deletedAt && /(^|\s)live-web:\s*\S/.test(item.excerpt ?? ''));
        if (live && found) {
          writeStored(TASK_KEY + space, found.id);
          setTaskId(found.id);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space]);
  useEffect(() => {
    if (own && detail) writeStored(TASK_KEY + space, detail.id);
    if (own || !taskId || taskDetail) return;
    gate.data.refetchDetail(taskId as EntityId);
    let tries = 0;
    const poll = window.setInterval(() => {
      setTick((t) => t + 1);
      if (++tries >= 15) window.clearInterval(poll);
    }, 1000);
    return () => window.clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, Boolean(taskDetail)]);

  const stop = (terminalId: string | null) => {
    if (!terminalId || !commands) return;
    void commands
      .terminate(terminalId as EntityId, { clientMutationId: `web-test-stop:${terminalId}:${Date.now()}`, force: true })
      .catch(() => undefined);
  };

  const start = (explore: boolean) => {
    const cases = explore ? '' : request.trim();
    if (!commands || !command || !repoUrl || (!explore && !cases)) return;
    stop(runRef.current?.terminalId ?? null);
    writeStored(REPO_KEY, repoUrl);
    setReportOpen(false);
    const next: Run = {
      command: command.trim(),
      payload: base64Line(JSON.stringify({ repo: repoUrl, cases })),
      terminalId: null,
      error: null,
      repo: repoUrl,
      cases,
    };
    setRun(next);
    void commands
      .startTerminal({
        clientMutationId: `web-test:${Date.now()}`,
        spaceId: space as never,
        projectId: null,
        title: `Website test · ${repoUrl.replace('https://github.com/', '')}`.slice(0, 120),
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

  /* Closing the window ends the viewer's terminal. */
  useEffect(() => () => stop(runRef.current?.terminalId ?? null), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* Type the command once the shell has said something; the repo and words go in only when asked. */
  const terminalId = run?.terminalId ?? null;
  const runCommand = run?.command ?? '';
  const payload = run?.payload ?? '';
  useEffect(() => {
    dispatch({ type: 'reset' });
    setPeek(false);
    if (!terminalId) return;
    let sent = false;
    let payloadSent = false;
    let tail = '';
    const send = () => {
      if (sent) return;
      sent = true;
      terminalRef.current?.send(`clear; ${runCommand}\r`);
    };
    let settle: number | undefined;
    const off = ptyTransport.onOutput((id, data) => {
      if (id !== terminalId) return;
      if (sent && !payloadSent) {
        tail = (tail + data).slice(-200);
        if (tail.includes(READY_MARKER)) {
          payloadSent = true;
          terminalRef.current?.send(`${payload}\r`);
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
  }, [terminalId, runCommand, payload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !reportOpen) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, reportOpen]);

  const download = (format: ReportFormat) => downloadReport(screenRun, { app: run?.repo ?? null, asked: run?.cases || null }, format);

  const screen =
    run?.terminalId && isLiveTerminalEnabled() ? (
      <LiveTerminal ref={terminalRef} sessionId={run.terminalId} serverBaseUrl={gate.serverBaseUrl} live onScreenSignal={dispatch} />
    ) : run && !run.error ? (
      <p className="phl-idle" role="status">
        Starting…
      </p>
    ) : (
      <div className="phl-idle" data-testid="web-test-idle">
        <span className="phl-idle__big">No website running</span>
        <span>Give a GitHub repository and what to test →</span>
      </div>
    );

  return createPortal(
    <div className="cv2-root phl-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="phl wbt" role="dialog" aria-modal="true" aria-label="Website tester" data-testid="web-test">
        <div className="wbt-window">
          <div className="wbt-bar" aria-hidden="true">
            <span className="wbt-dots">
              <i />
              <i />
              <i />
            </span>
            <span className="wbt-url">{run ? run.repo.replace('https://', '') : 'website under test'}</span>
          </div>
          <div className="wbt-screen">
            {screen}
            {screenRun.frame && !peek ? (
              <img className="wbt-frame" src={screenRun.frame} alt="The website, live" data-testid="web-test-frame" />
            ) : null}
          </div>
        </div>

        <aside className="phl-side">
          <header className="phl-head">
            <span className="phl-title">Website tester</span>
            {run && !run.error ? (
              <span className="phl-watching">
                <span className="tws-astrip-phone__dot" aria-hidden="true" />
                {screenRun.done ? 'Done' : 'Running'}
              </span>
            ) : null}
            <button type="button" className="phl-close" aria-label="Close" data-testid="web-test-close" onClick={onClose}>
              ✕
            </button>
          </header>
          <p className="phl-spec">Desktop 1280×800 · Chromium — the site is built from its source and run in a sandbox</p>

          {run?.error ? (
            <p className="phl-note phl-note--error" role="alert">
              {run.error}
            </p>
          ) : null}

          <RunCases run={screenRun} peek={peek} onPeek={() => setPeek((p) => !p)} onReport={() => setReportOpen(true)} onDownload={download} />

          <form
            className="phl-section"
            onSubmit={(e) => {
              e.preventDefault();
              start(false);
            }}
          >
            <label className="phl-h" htmlFor="wbt-repo">
              GitHub repository
            </label>
            <input
              id="wbt-repo"
              className="phl-ask wbt-repo"
              value={repo}
              placeholder="https://github.com/owner/shop"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setRepo(e.target.value)}
              data-testid="web-test-repo"
            />
            {repo.trim() && !repoUrl ? (
              <p className="phl-note phl-note--error" data-testid="web-test-repo-bad">
                Not a GitHub repository link — use https://github.com/owner/repo
              </p>
            ) : null}
            <label className="phl-h" htmlFor="wbt-ask">
              What to test
            </label>
            <textarea
              id="wbt-ask"
              className="phl-ask"
              rows={6}
              value={request}
              placeholder={'In plain words, e.g.\n1. Search "shirt" finds products\n2. Add a product to the cart, the count shows 1\n3. Checkout without an address shows an error'}
              onChange={(e) => setRequest(e.target.value)}
              data-testid="web-test-ask"
            />
            <div className="phl-actions">
              <button
                type="submit"
                className="phl-start"
                disabled={!request.trim() || !repoUrl || !command || !commands}
                data-testid="web-test-send"
              >
                ✦ Write &amp; run
              </button>
              <button
                type="button"
                className="phl-secondary"
                disabled={!repoUrl || !command || !commands}
                data-testid="web-test-explore"
                title="Reads the whole source and writes and runs a deep e-commerce suite: home, navigation, search, products, cart, checkout…"
                onClick={() => start(true)}
              >
                🔍 Explore &amp; deep test
              </button>
              {run ? (
                <button
                  type="button"
                  className="phl-secondary"
                  data-testid="web-test-stop"
                  onClick={() => {
                    stop(run.terminalId);
                    setRun(null);
                  }}
                >
                  ■ Stop
                </button>
              ) : null}
            </div>
            {command ? (
              <p className="phl-note">
                Downloads the repository, installs and builds it, and serves it in a sandbox; an agent reads the source
                and writes the tests, then runs them here live, with a report at the end. The first build of a repo
                takes a few minutes. Runs <code>{command}</code> as you, on this node.
              </p>
            ) : (
              <p className="phl-note" data-testid="web-test-none">
                Not set up in this space yet: it needs a <code>type: test</code> task whose description has a{' '}
                <code>live-web:</code> line.
              </p>
            )}
          </form>
        </aside>
      </div>
      {reportOpen ? (
        <RunReport run={screenRun} app={run?.repo ?? null} asked={run?.cases || null} onClose={() => setReportOpen(false)} onDownload={download} />
      ) : null}
    </div>,
    document.body,
  );
}
