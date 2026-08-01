import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, SessionJournalPage, SessionJournalRecord } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import { DisabledAction } from '../honesty/DisabledWithReason';
import './session-debug.css';

/**
 * THE DEBUG SURFACE — the session's `tm8` CLI command journal.
 *
 * SELF-FETCHING (like LazySessionChatSurface): it receives the seam and does
 * its own read, rather than threading through the gate's data lens. The switch
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
 *   · a non-zero `malformed` count is surfaced.
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

export function SessionDebugBody({ seam, sessionId, live }: SessionDebugBodyProps) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
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
