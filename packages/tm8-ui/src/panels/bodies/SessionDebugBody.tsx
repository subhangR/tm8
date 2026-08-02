import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  EntityId,
  SessionJournalPage,
  SessionJournalRecord,
  SessionLaunchRecord,
} from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { describeLaunchManifest } from '../../domain';
import { DisabledAction } from '../honesty/DisabledWithReason';
import './session-debug.css';

/**
 * THE DEBUG SURFACE — what this session was TOLD, and what it then DID.
 *
 * Two reads, deliberately not one. `launch` answers "what was this agent given
 * at spawn" — the composed manifest, the environment variable names, and the
 * two prompt channels as the bytes actually sent. `journal` answers "what has
 * this agent run since". They have opposite lifetimes: the launch record is
 * written once and can never change, the journal grows every few seconds. So
 * the launch record is read ONCE per mount and the journal is the only thing
 * polled; shipping a whole manifest every 5s to learn nothing would be waste
 * dressed as freshness.
 *
 * SELF-FETCHING (like LazySessionChatSurface): it receives the seam and does
 * its own reads, rather than threading through the gate's data lens. The switch
 * mounts it ONLY while the Debug chip is selected, so unmounting is what stops
 * the poll — the "only while selected" half of the honesty rule. The `live`
 * prop carries the other half: no poll on an exited session.
 *
 * HONESTY, non-negotiable (these are requirements, not polish):
 *   · every token number carries `~` and the estimator is named — never a bare
 *     number that could be mistaken for the provider's usage;
 *   · a permanent "CLI boundary only — not model usage" line;
 *   · `available:false` is an EXPLAINED empty naming the reason, never a zero
 *     and never a spinner;
 *   · a truncated sample says so, with its exact char count;
 *   · only `tm8` commands are journaled — non-tm8 shell commands are absent, so
 *     the table is not a shell history;
 *   · a non-zero `malformed` count is surfaced;
 *   · the prompts are the STORED bytes, never recomposed from the manifest, and
 *     a session recorded before prompt capture says so rather than showing an
 *     empty prompt;
 *   · environment variable VALUES are structurally absent — the surface says
 *     they are never recorded, so their absence cannot read as a display choice.
 */

const POLL_MS = 5_000;
const BOUNDARY_NOTE = 'CLI boundary only — not model usage';

export interface SessionDebugBodyProps {
  seam: Seam;
  sessionId: EntityId;
  /** The session is running — poll for new records. Exited ⇒ one read, no poll. */
  live: boolean;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; page: SessionJournalPage };

/** The launch read fails independently of the journal — one must not blank the other. */
type LaunchState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; record: SessionLaunchRecord };

export function SessionDebugBody({ seam, sessionId, live }: SessionDebugBodyProps) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [launch, setLaunch] = useState<LaunchState>({ phase: 'loading' });
  // Kept across polls so a refresh does not throw the surface back to a spinner.
  const hasLoaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const page = await seam.journal(sessionId);
      hasLoaded.current = true;
      setState({ phase: 'ready', page });
    } catch (err) {
      // Only surface an error if we have nothing to show; a transient poll
      // failure must not blank an already-rendered table.
      if (!hasLoaded.current) {
        setState({ phase: 'error', message: err instanceof Error ? err.message : 'Journal read failed' });
      }
    }
  }, [seam, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ONE read, no poll: a launch record is written at spawn and is immutable.
  useEffect(() => {
    let cancelled = false;
    setLaunch({ phase: 'loading' });
    seam.launch(sessionId).then(
      (record) => { if (!cancelled) setLaunch({ phase: 'ready', record }); },
      (err: unknown) => {
        if (cancelled) return;
        setLaunch({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Launch record read failed',
        });
      },
    );
    return () => { cancelled = true; };
  }, [seam, sessionId]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  if (state.phase === 'loading') {
    return (
      <div className="pn-debug" data-testid="session-debug-body">
        <p className="pn-debug__loading" role="status">Reading the session journal…</p>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="pn-debug" data-testid="session-debug-body">
        <LaunchSection state={launch} />
        <div className="pn-debug__empty" data-testid="session-debug-error">
          <DisabledAction
            label="Session journal"
            reason={{ cause: 'The journal could not be read', remedy: state.message }}
          >
            Journal unavailable
          </DisabledAction>
        </div>
      </div>
    );
  }

  const { page } = state;
  return (
    <div className="pn-debug" data-testid="session-debug-body">
      <LaunchSection state={launch} />
      <DebugHeader page={page} />
      {page.available ? (
        <DebugTable records={page.records} hasMore={page.hasMore} />
      ) : (
        <div className="pn-debug__empty" data-testid="session-debug-empty">
          <DisabledAction label="Session journal" reason={unavailableReason(page.unavailableReason)}>
            No journal for this session
          </DisabledAction>
        </div>
      )}
    </div>
  );
}

/**
 * WHAT THIS SESSION WAS TOLD — the spawn-time half of the debug surface.
 *
 * Everything here comes from ONE stored document plus two stored prompt
 * strings. The manifest crosses the wire UNTYPED (`Record<string, unknown>`) on
 * purpose, so every field below is read defensively: a manifest written by an
 * older or newer build renders whatever it does carry and says "not recorded"
 * for the rest, instead of a strict schema refusing the whole document and
 * showing nothing at all. The raw JSON is always available underneath, so a
 * field this grid does not know about is still visible rather than swallowed.
 *
 * The two dead ends are DIFFERENT and are kept apart: `available:false` means
 * no manifest row was ever written for this session, while
 * `prompts.unavailableReason:'not_recorded'` means a manifest exists but was
 * written before the prompt bytes were captured. Collapsing them into one
 * "nothing here" would misattribute a data-model gap to a spawn that failed.
 */
function LaunchSection({ state }: { state: LaunchState }) {
  if (state.phase === 'loading') {
    return (
      <section className="pn-debug__launch" data-testid="session-debug-launch">
        <p className="pn-debug__loading" role="status">Reading the launch record…</p>
      </section>
    );
  }

  if (state.phase === 'error') {
    return (
      <section className="pn-debug__launch" data-testid="session-debug-launch">
        <div className="pn-debug__empty" data-testid="session-debug-launch-error">
          <DisabledAction
            label="Spawn configuration"
            reason={{ cause: 'The launch record could not be read', remedy: state.message }}
          >
            Spawn configuration unavailable
          </DisabledAction>
        </div>
      </section>
    );
  }

  const { record } = state;
  if (!record.available) {
    return (
      <section className="pn-debug__launch" data-testid="session-debug-launch">
        <div className="pn-debug__empty" data-testid="session-debug-launch-empty">
          <DisabledAction label="Spawn configuration" reason={launchUnavailableReason(record)}>
            No launch record for this session
          </DisabledAction>
        </div>
      </section>
    );
  }

  const m = record.manifest;
  // The manifest's FIELD VOCABULARY lives in domain/, not here (§15.2): this
  // component renders labelled facts and knows none of their names, so a
  // manifest that grows a field is a domain edit and not a component edit.
  const { facts, command, tasks } = describeLaunchManifest(m);

  return (
    <section className="pn-debug__launch" data-testid="session-debug-launch">
      <details className="pn-debug__launch-root" open>
        <summary className="pn-debug__launch-summary">
          Spawn configuration
          <span className="pn-debug__launch-when">
            {record.recordedAt === null
              ? ' · recorded, time unknown'
              : ` · recorded ${formatStamp(record.recordedAt)}`}
          </span>
        </summary>

        {m === null ? (
          <p className="pn-debug__note">
            A launch record exists, but its manifest is not a JSON object — nothing can be read
            out of it field by field. It is shown verbatim below.
          </p>
        ) : (
          <div className="pn-debug__fields" data-testid="session-debug-launch-fields">
            {facts.map((fact) => (
              <Field key={fact.label} label={fact.label} value={fact.value} mono={fact.mono} />
            ))}
          </div>
        )}

        {m === null ? null : (
          <>
            <LaunchBlock label="Command line">
              {command === null ? (
                <p className="pn-debug__note">The manifest records no command line.</p>
              ) : (
                <pre className="pn-debug__pre">{command}</pre>
              )}
            </LaunchBlock>

            <LaunchBlock label={`Assigned tasks · ${String(tasks.length)}`}>
              {tasks.length === 0 ? (
                <p className="pn-debug__note">
                  This session was spawned with no task attached — the agent was launched on its
                  persona alone.
                </p>
              ) : (
                <ul className="pn-debug__tasks">
                  {tasks.map((task, i) => (
                    <li key={task.id ?? String(i)}>
                      <span>{task.title}</span>
                      {task.id === null ? null : <code className="pn-debug__task-id">{task.id}</code>}
                    </li>
                  ))}
                </ul>
              )}
            </LaunchBlock>
          </>
        )}

        <LaunchBlock label={`Environment · ${String(record.envVarNames.length)} names`}>
          {/* S15: the NAMES are recorded and the VALUES never are. Saying so
              here is what stops their absence from reading as a display choice
              someone could ask to have "turned on". */}
          <p className="pn-debug__note">
            Variable names only. Values are never recorded and cannot be recovered from here.
          </p>
          {record.envVarNames.length === 0 ? (
            <p className="pn-debug__note">No variable names were recorded for this session.</p>
          ) : (
            <ul className="pn-debug__envs">
              {record.envVarNames.map((name) => (
                <li key={name}><code>{name}</code></li>
              ))}
            </ul>
          )}
        </LaunchBlock>

        {record.prompts.unavailableReason === 'not_recorded' ? (
          <div className="pn-debug__empty" data-testid="session-debug-prompts-empty">
            <DisabledAction
              label="Prompts"
              reason={{
                cause: 'The prompts sent to this agent were not recorded',
                remedy: 'it was spawned before launch prompts were captured — the manifest above is all that was kept',
              }}
            >
              Prompts not recorded
            </DisabledAction>
          </div>
        ) : (
          <>
            <PromptBlock label="System prompt" text={record.prompts.system} testId="session-debug-system-prompt" />
            <PromptBlock label="Task prompt" text={record.prompts.task} testId="session-debug-task-prompt" />
          </>
        )}

        <LaunchBlock label="Raw manifest">
          <pre className="pn-debug__pre" data-testid="session-debug-raw-manifest">
            {JSON.stringify(record.manifest, null, 2)}
          </pre>
        </LaunchBlock>
      </details>
    </section>
  );
}

/**
 * The prompts are the STORED BYTES, read back from the row that was written at
 * spawn — they are never recomposed from the manifest here. That is the whole
 * point of the surface: a recomposition would silently drift from what the
 * agent actually received the moment the prompt builder changed, and would then
 * be a confident lie exactly when someone is debugging why an agent misbehaved.
 */
function PromptBlock({ label, text, testId }: { label: string; text: string | null; testId: string }) {
  const chars = text === null ? 0 : text.length;
  return (
    <LaunchBlock label={`${label} · ${String(chars)} chars, as sent`}>
      {text === null || text === '' ? (
        <p className="pn-debug__note">Nothing was sent on this channel.</p>
      ) : (
        <pre className="pn-debug__pre" data-testid={testId}>{text}</pre>
      )}
    </LaunchBlock>
  );
}

function LaunchBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="pn-debug__block">
      <summary className="pn-debug__block-summary">{label}</summary>
      <div className="pn-debug__block-body">{children}</div>
    </details>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="pn-debug__field">
      <span className="pn-debug__field-label">{label}</span>
      {value === null ? (
        // An absent field says so. A blank cell would be indistinguishable from
        // a field the manifest recorded as empty.
        <span className="pn-debug__field-absent">not recorded</span>
      ) : (
        <span className="pn-debug__field-value" data-mono={mono === true ? 'true' : 'false'}>{value}</span>
      )}
    </div>
  );
}

function launchUnavailableReason(record: SessionLaunchRecord) {
  if (record.unavailableReason === 'no_manifest_row') {
    return {
      cause: 'No manifest was recorded for this session',
      remedy: 'it was spawned before manifests were stored, or it is not readable by this account',
    };
  }
  return {
    cause: 'No spawn configuration is available for this session',
    remedy: 'the node reported no reason',
  };
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function DebugHeader({ page }: { page: SessionJournalPage }) {
  const { totals } = page;
  return (
    <header className="pn-debug__header" data-testid="session-debug-header">
      <div className="pn-debug__stats">
        <Stat label="Commands" value={String(totals.invocations)} />
        <Stat label="Failed" value={String(totals.failed)} tone={totals.failed > 0 ? 'bad' : undefined} />
        {/* ONE PERSPECTIVE, THE AGENT'S — and it is stated in the label rather
            than left to "in"/"out", which invert depending on whether you stand
            at the agent or at the CLI. "Into context" is the number this whole
            surface exists to answer, and it is the large one: CLI stdout is what
            the teammate reads back on its next turn. */}
        <Stat
          label={`~tokens into agent context · ${totals.estimator}`}
          value={`~${abbrev(totals.cliToAgentEst)}`}
        />
        <Stat
          label={`~tokens typed by agent · ${totals.estimator}`}
          value={`~${abbrev(totals.agentToCliEst)}`}
        />
        {totals.malformed > 0 ? (
          <Stat
            label="Malformed records"
            value={String(totals.malformed)}
            tone="bad"
          />
        ) : null}
      </div>
      <p className="pn-debug__boundary" data-testid="session-debug-boundary">
        {BOUNDARY_NOTE}. Only <code>tm8</code> commands are recorded — a teammate’s other
        shell commands are absent, so this is not a shell history. Token counts are
        byte-derived estimates ({totals.estimator}), never the model’s reported usage.
      </p>
    </header>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <span className="pn-debug__stat" data-tone={tone ?? 'plain'}>
      <span className="pn-debug__stat-value">{value}</span>
      <span className="pn-debug__stat-label">{label}</span>
    </span>
  );
}

function DebugTable({ records, hasMore }: { records: SessionJournalRecord[]; hasMore: boolean }) {
  if (records.length === 0) {
    return (
      <p className="pn-debug__no-rows" role="status">
        The journal exists but has recorded no <code>tm8</code> commands yet.
      </p>
    );
  }
  // Newest first for reading; the page arrives oldest-first within its window.
  const rows = [...records].reverse();
  return (
    <div className="pn-debug__scroll">
      <table className="pn-debug__table" data-testid="session-debug-table">
        <thead>
          <tr>
            <th scope="col" className="pn-debug__col-expand" aria-label="expand" />
            <th scope="col">Time</th>
            <th scope="col">Command</th>
            <th scope="col" className="pn-debug__num">Exit</th>
            <th scope="col" className="pn-debug__num">ms</th>
            <th scope="col" className="pn-debug__num">Calls</th>
            {/* Same agent-perspective as the header stats. These columns used
                to read from the CLI's side while the header read from the
                agent's, so the same quantity appeared as "in" in one place and
                "out" in the other. */}
            <th scope="col" className="pn-debug__num" title="characters the CLI printed back">Chars →ctx</th>
            <th scope="col" className="pn-debug__num" title="characters the agent typed, including stdin">Chars typed</th>
            <th scope="col" className="pn-debug__num" title="estimated tokens into the agent's context">~tok →ctx</th>
            <th scope="col" className="pn-debug__num" title="estimated tokens the agent typed">~tok typed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((record) => (
            <CommandRow key={`${record.pid}-${record.seq}`} record={record} />
          ))}
        </tbody>
      </table>
      {hasMore ? (
        <p className="pn-debug__more" role="status">
          Older records exist beyond this window — totals above still count the whole journal.
        </p>
      ) : null}
    </div>
  );
}

function CommandRow({ record }: { record: SessionJournalRecord }) {
  const [open, setOpen] = useState(false);
  const failed = record.result.exitCode !== 0;
  const commandPath = record.command.path.length > 0 ? record.command.path.join(' ') : '(unparsed)';
  // Agent-perspective, matching the column headers: what came back INTO the
  // agent's context, and what the agent itself typed (argv is counted in the
  // token estimate; stdin is the piped part of the same direction).
  const charsIntoContext = record.output.stdoutChars + record.output.stderrChars;
  const charsTyped = record.command.argv.join(' ').length + record.input.stdinChars;
  return (
    <>
      <tr
        className="pn-debug__row"
        data-failed={failed ? 'true' : 'false'}
        data-open={open ? 'true' : 'false'}
      >
        <td className="pn-debug__col-expand">
          <button
            type="button"
            className="pn-debug__toggle"
            aria-expanded={open}
            aria-label={open ? 'Collapse command detail' : 'Expand command detail'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '▾' : '▸'}
          </button>
        </td>
        <td className="pn-debug__time">{formatTime(record.startedAt)}</td>
        <td className="pn-debug__cmd"><code>tm8 {commandPath}</code></td>
        <td className="pn-debug__num" data-tone={failed ? 'bad' : 'plain'}>{record.result.exitCode}</td>
        <td className="pn-debug__num">{record.durationMs}</td>
        <td className="pn-debug__num">{record.calls.length}</td>
        <td className="pn-debug__num">{charsIntoContext}</td>
        <td className="pn-debug__num">{charsTyped}</td>
        <td className="pn-debug__num">~{abbrev(record.tokens.cliToAgent)}</td>
        <td className="pn-debug__num">~{abbrev(record.tokens.agentToCli)}</td>
      </tr>
      {open ? (
        <tr className="pn-debug__detail-row">
          <td colSpan={10}>
            <RowDetail record={record} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RowDetail({ record }: { record: SessionJournalRecord }) {
  return (
    <div className="pn-debug__detail" data-testid="session-debug-detail">
      <dl className="pn-debug__kv">
        <dt>argv</dt>
        <dd><code>{record.command.argv.join(' ')}</code></dd>
        <dt>cwd</dt>
        <dd><code>{record.command.cwd}</code></dd>
        {record.result.error ? (
          <>
            <dt>error</dt>
            <dd className="pn-debug__err"><code>{record.result.error}</code></dd>
          </>
        ) : null}
      </dl>

      <Sample
        label="stdout"
        text={record.output.stdoutSample}
        chars={record.output.stdoutChars}
        truncated={record.output.truncated}
      />
      <Sample
        label="stderr"
        text={record.output.stderrSample}
        chars={record.output.stderrChars}
        truncated={false}
      />

      {record.calls.length > 0 ? (
        <div className="pn-debug__calls">
          <span className="pn-debug__calls-label">HTTP calls</span>
          <table className="pn-debug__calls-table">
            <thead>
              <tr>
                <th scope="col">Operation</th>
                <th scope="col">Method</th>
                <th scope="col" className="pn-debug__num">Status</th>
                <th scope="col" className="pn-debug__num">Req chars</th>
                <th scope="col" className="pn-debug__num">Resp chars</th>
                <th scope="col" className="pn-debug__num">ms</th>
              </tr>
            </thead>
            <tbody>
              {record.calls.map((call, i) => (
                <tr key={`${call.operation}-${i}`}>
                  <td><code>{call.operation}</code></td>
                  <td>{call.method}</td>
                  <td
                    className="pn-debug__num"
                    data-tone={call.status !== null && call.status >= 400 ? 'bad' : 'plain'}
                  >
                    {call.status ?? 'no response'}
                  </td>
                  <td className="pn-debug__num">{call.requestChars}</td>
                  <td className="pn-debug__num">{call.responseChars}</td>
                  <td className="pn-debug__num">{call.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="pn-debug__no-calls">This command made no HTTP calls.</p>
      )}
    </div>
  );
}

function Sample({
  label,
  text,
  chars,
  truncated,
}: {
  label: string;
  text: string;
  chars: number;
  truncated: boolean;
}) {
  return (
    <div className="pn-debug__sample">
      <span className="pn-debug__sample-label">
        {label} · {chars} chars
        {truncated ? (
          <span className="pn-debug__trunc" data-testid="session-debug-truncated">
            {' '}— sample truncated ({chars} chars total)
          </span>
        ) : null}
      </span>
      {text.length > 0 ? (
        <pre className="pn-debug__pre">{text}</pre>
      ) : (
        <span className="pn-debug__sample-empty">— empty</span>
      )}
    </div>
  );
}

function unavailableReason(reason: SessionJournalPage['unavailableReason']) {
  switch (reason) {
    case 'no_journal_file':
      return {
        cause: 'This session has no journal file',
        remedy: 'it was spawned before command journaling, or launched with it off',
      };
    case 'unreadable':
      return {
        cause: 'The journal file could not be read',
        remedy: 'the file exists but the node could not open it',
      };
    default:
      return {
        cause: 'No journal is available for this session',
        remedy: 'the node reported no reason',
      };
  }
}

/** `1840 → "1.8k"`, keeping small counts exact. Never a bare model-usage claim. */
function abbrev(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
