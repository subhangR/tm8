/**
 * THE POST-MORTEM — what an exited session actually did, in the slot that used
 * to hold a ring and the words "Session exited".
 *
 * WHERE EVERY NUMBER COMES FROM: `execution.transcript`, and nothing else. This
 * surface adds NO producer, NO table and NO migration; it is a rendering of
 * `SessionTranscriptPage`, which the agent's own transcript already carries and
 * which the seam has served since the Debug surface shipped. The one thing it
 * asks the seam for that Debug does not is `files:true`, and only because an
 * exited session is read ONCE — the whole-file scan that flag costs is a price
 * a dead session can pay and a live one cannot.
 *
 * THE THREE STATES ARE THREE, NOT TWO. Loading, hollow and value are visibly
 * distinct everywhere on this panel:
 *   · loading — the read is in flight, and no number is claimed;
 *   · hollow (`—`) — the provider did not report this, which is NOT zero;
 *   · value — including a real `0`, which reaches the DOM as `0`.
 * Nothing here is gated on truthiness. See `session-stats.ts` for why that
 * sentence is load-bearing rather than pedantic.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW:
 *   · COST. There is no per-model rate table in tm8 for work sessions, and
 *     `stats.models` is a flat set across the whole session — a run that
 *     switched models has already lost the per-model split a correct figure
 *     needs. A money number assembled from what is here would be a guess
 *     wearing a currency symbol. `chat_turns.total_cost_usd` is a different
 *     domain and is not extended here.
 *   · AN EXIT CODE. The contract's `work_session` state arm carries none on any
 *     node (contract.ts:277-279), so there is nothing to render — and the
 *     oracle's "non-zero exit codes render the code in block red" stays
 *     unbuildable until a producer projects it. A red number invented here
 *     would be the exact lie the hollow rule exists to stop.
 */
import type { SessionFileChanges, SessionTranscriptStats } from '@tm8/contract';
import { transcriptUnavailableReason, type TranscriptState } from './transcript-model';
import { HOLLOW, formatCount, formatTokens, tokenShares, tokenTotal } from './session-stats';
import './session-stats.css';

/** Beyond this the list stops informing and starts being a scroll. */
const TOP_TOOLS = 6;
const TOP_FILES = 6;

export function SessionStatsPanel({ state }: { state: TranscriptState }) {
  if (state.phase === 'loading') {
    /* A SPINNER IS NOT A ZERO and is not a dash either. Until the read lands we
       claim nothing at all — which is why this is a distinct arm rather than
       the hollow rendering with empty values. */
    return (
      <div className="sst" data-testid="session-stats" data-phase="loading">
        <p className="sst__note" role="status" data-testid="session-stats-loading">
          Reading the agent transcript…
        </p>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="sst" data-testid="session-stats" data-phase="error">
        <p className="sst__note" data-tone="bad" data-testid="session-stats-error">
          The transcript could not be read — {state.message}
        </p>
      </div>
    );
  }

  const { page } = state;
  if (!page.available || page.stats === null) {
    /* PER-REASON, NEVER GENERIC. `unavailableReason` distinguishes four real
       and differently-actionable states, and the mapping already has one home
       in `transcript-model.ts` — the Debug surface renders the same sentences.
       A single "no data" banner would throw away the only thing this contract
       does better than the prior art's boolean. */
    const reason = transcriptUnavailableReason(page);
    return (
      <div className="sst" data-testid="session-stats" data-phase="unavailable">
        <p className="sst__note" data-testid="session-stats-unavailable">
          <span className="sst__note-cause">{reason.cause}</span>
          <span className="sst__note-remedy"> — {reason.remedy}</span>
        </p>
      </div>
    );
  }

  const stats = page.stats;
  return (
    <div className="sst" data-testid="session-stats" data-phase="ready">
      <Caveats stats={stats} malformed={page.malformed} />
      <Tokens stats={stats} />
      <Work stats={stats} />
      <Models models={stats.models} />
      <Files changes={page.fileChanges ?? null} agentTool={page.agentTool} />
    </div>
  );
}

/**
 * THE TWO ADMISSIONS, above the numbers they qualify.
 *
 * `partial` means the reader tailed an oversized file, so every count below is
 * of the WINDOW and understates the session. `malformed` means lines failed to
 * parse and were skipped, which is the usual explanation for a count that
 * looks suspiciously low. Both are silent under-reporting otherwise, and a
 * silently under-reported number is worse than a marked one — the reader has
 * no way to know they are holding a floor rather than a total.
 */
function Caveats({ stats, malformed }: { stats: SessionTranscriptStats; malformed: number }) {
  // `> 0`, never `malformed &&` — the truthiness form renders a literal `0`.
  const hasMalformed = malformed > 0;
  if (!stats.partial && !hasMalformed) return null;
  return (
    <div className="sst__caveats">
      {stats.partial ? (
        <p className="sst__note" data-tone="warn" data-testid="session-stats-partial">
          These counts cover only the newest part of the transcript that was read, not the whole
          session — the transcript is read as a tail.
        </p>
      ) : null}
      {hasMalformed ? (
        <p className="sst__note" data-tone="warn" data-testid="session-stats-malformed">
          {formatCount(malformed)} line{malformed === 1 ? '' : 's'} could not be parsed and are not
          counted below.
        </p>
      ) : null}
    </div>
  );
}

function Tokens({ stats }: { stats: SessionTranscriptStats }) {
  const total = tokenTotal(stats);
  const shares = tokenShares(stats);
  return (
    <section className="sst__section" data-testid="session-stats-tokens">
      <h4 className="sst__heading">
        tokens
        <span className="sst__total" data-testid="session-stats-total">
          {total === null ? HOLLOW : formatCount(total.value)}
        </span>
      </h4>

      {/* The bar is the nice-to-have; the four numbers below are the
          requirement, so it renders only when there is a real proportion to
          draw and never as an empty track pretending to be a measurement. */}
      {shares.length > 0 ? (
        <div className="sst__bar" data-testid="session-stats-bar" aria-hidden>
          {shares.map((share) => (
            <span
              key={share.key}
              className="sst__bar-seg"
              data-kind={share.key}
              style={{ width: `${share.pct}%` }}
            />
          ))}
        </div>
      ) : null}

      <dl className="sst__grid">
        <TokenCell label="input" value={stats.inputTokens} testId="session-stats-token-input" />
        <TokenCell label="output" value={stats.outputTokens} testId="session-stats-token-output" />
        <TokenCell
          label="cache read"
          value={stats.cacheReadTokens}
          testId="session-stats-token-cache-read"
        />
        <TokenCell
          label="cache create"
          value={stats.cacheCreationTokens}
          testId="session-stats-token-cache-create"
        />
      </dl>

      {total !== null && !total.complete ? (
        <p className="sst__note" data-tone="warn" data-testid="session-stats-total-partial">
          The total is the sum of what the provider reported. The fields showing {HOLLOW} were not
          reported at all and are not in it — this is a floor, not a spend.
        </p>
      ) : null}
    </section>
  );
}

/**
 * ONE token figure. `data-hollow` is the machine-readable half of the same
 * claim the dash makes visually, so a test can hold the distinction to account
 * in jsdom — which can read an attribute but cannot see a colour.
 */
function TokenCell({
  label,
  value,
  testId,
}: {
  label: string;
  value: number | null;
  testId: string;
}) {
  const hollow = value == null;
  return (
    <div className="sst__cell" data-testid={testId} data-hollow={hollow ? 'true' : 'false'}>
      <dt className="sst__cell-label">{label}</dt>
      <dd
        className="sst__cell-value"
        {...(hollow ? { title: 'the provider did not report this — not the same as zero' } : {})}
      >
        {formatTokens(value)}
      </dd>
    </div>
  );
}

/** What the agent SAID and DID. These counts are never nullable — a real 0 is a 0. */
function Work({ stats }: { stats: SessionTranscriptStats }) {
  const tools = stats.tools.slice(0, TOP_TOOLS);
  const busiest = tools[0]?.count ?? 0;
  return (
    <section className="sst__section" data-testid="session-stats-work">
      <h4 className="sst__heading">messages and tools</h4>
      <dl className="sst__grid">
        <div className="sst__cell" data-testid="session-stats-user-messages">
          <dt className="sst__cell-label">user</dt>
          <dd className="sst__cell-value">{formatCount(stats.userMessages)}</dd>
        </div>
        <div className="sst__cell" data-testid="session-stats-assistant-messages">
          <dt className="sst__cell-label">agent</dt>
          <dd className="sst__cell-value">{formatCount(stats.assistantMessages)}</dd>
        </div>
        <div className="sst__cell" data-testid="session-stats-tool-calls">
          <dt className="sst__cell-label">tool calls</dt>
          <dd className="sst__cell-value">{formatCount(stats.toolCalls)}</dd>
        </div>
      </dl>

      {/* `length > 0`, not `tools.length &&`: the truthiness form puts a bare
          `0` in the DOM for a session that called no tools. */}
      {tools.length > 0 ? (
        <ul className="sst__tools" data-testid="session-stats-tools">
          {tools.map((tool) => (
            <li className="sst__tool" key={tool.name}>
              <span className="sst__tool-name">{tool.name}</span>
              <span
                className="sst__tool-bar"
                aria-hidden
                style={{ width: `${busiest === 0 ? 0 : (tool.count / busiest) * 100}%` }}
              />
              <span className="sst__tool-count">{formatCount(tool.count)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sst__note" data-testid="session-stats-tools-empty">
          No tool calls in the transcript that was read.
        </p>
      )}
    </section>
  );
}

function Models({ models }: { models: string[] }) {
  return (
    <section className="sst__section" data-testid="session-stats-models">
      <h4 className="sst__heading">models seen</h4>
      {models.length > 0 ? (
        <ul className="sst__chips">
          {models.map((model) => (
            <li className="sst__chip" key={model}>
              {model}
            </li>
          ))}
        </ul>
      ) : (
        /* HOLLOW, not absent. An empty models list on a transcript that WAS
           read means the records carried no model id — a fact worth stating,
           where a vanished section would read as "this panel has no such
           row". */
        <p className="sst__note" data-testid="session-stats-models-empty">
          {HOLLOW} the transcript names no model
        </p>
      )}
    </section>
  );
}

/**
 * FILES TOUCHED — observed Edit/Write tool calls, which is NOT a git diff, and
 * the section says so rather than letting the reader assume otherwise.
 *
 * Absent for every dialect but claude-code, and absent means HOLLOW here: a
 * codex session renders the sentence explaining that its dialect carries no
 * file accounting, never an empty list that reads as "changed nothing".
 */
function Files({
  changes,
  agentTool,
}: {
  changes: SessionFileChanges | null;
  agentTool: 'claude-code' | 'codex' | null;
}) {
  return (
    <section className="sst__section" data-testid="session-stats-files">
      <h4 className="sst__heading">files touched</h4>
      {changes === null ? (
        <p className="sst__note" data-testid="session-stats-files-hollow">
          {HOLLOW} file accounting is read from Edit/Write tool calls, which only the claude-code
          transcript records
          {agentTool === null ? '' : ` — this session ran ${agentTool}`}.
        </p>
      ) : (
        <>
          <p className="sst__note" data-testid="session-stats-files-provenance">
            +{formatCount(changes.totalAdded)} / −{formatCount(changes.totalRemoved)} across{' '}
            {formatCount(changes.files.length)} file{changes.files.length === 1 ? '' : 's'} —
            observed tool calls, not a git diff.
          </p>
          <ul className="sst__files">
            {changes.files.slice(0, TOP_FILES).map((file) => (
              <li className="sst__file" key={file.path}>
                <span className="sst__file-path" title={file.path}>
                  {file.path}
                </span>
                <span className="sst__file-delta">
                  +{formatCount(file.linesAdded)} −{formatCount(file.linesRemoved)}
                </span>
              </li>
            ))}
          </ul>
          {changes.filesTruncated || changes.files.length > TOP_FILES ? (
            <p className="sst__note" data-testid="session-stats-files-truncated">
              Showing the first {formatCount(Math.min(TOP_FILES, changes.files.length))} of the
              files this session touched.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
