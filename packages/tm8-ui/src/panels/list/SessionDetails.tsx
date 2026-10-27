import type { EntitySummary } from '@tm8/contract';
import { useState, type ReactNode } from 'react';
import type { SessionWord } from '../../domain';
import { ageAgo, ageLabel } from '../../kit/time';
import { copyToClipboard } from '../../terminal/domUtils';

/**
 * THE EXPANDED SESSION ROW (Subhang, 2026-10-17: "expand must be redesigned,
 * showing model name, details of the session, its links, some important
 * metadata").
 *
 * The expand used to open the generic D67 strip alone — a STATE caption over
 * "running" and a sentence about observed state, then collections, then a
 * refused Archive — which is every kind's strip and says nothing a session
 * reader opens a session row to learn. This is the session's own facts, read
 * off the summary the row already holds (no extra fetch), in the order a
 * reader asks them: what is it doing, what is it running on, where, since
 * when, for which tasks, what did it produce. The D67 strip still follows it
 * (`controls`), compact, because the archive verb lives there.
 *
 * A fact the summary does not carry draws no line: an empty "Branch —" on
 * every scratch session is noise, not honesty.
 */
export interface SessionDetailsProps {
  id: string;
  state: unknown;
  word: SessionWord | null;
  tasks: readonly EntitySummary[];
  /** The counts line (`TileLinkCounts`) — the session's links, each a door. */
  links?: ReactNode;
  /** Open a linked task. Absent ⇒ the task lines are plain text. */
  onOpenTask?: (taskId: string) => void;
  /** The D67 state/archive strip, compact. */
  controls?: ReactNode;
  now?: number;
}

const TOOL_NAME: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  hermes: 'Hermes',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function when(at: string | null, now: number): string | null {
  if (!at) return null;
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  const age = ageLabel(at, now);
  const clock = t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return age ? `${clock} · ${ageAgo(age)}` : clock;
}

export function SessionDetails({ id, state, word, tasks, links, onOpenTask, controls, now = Date.now() }: SessionDetailsProps) {
  const s = (state ?? {}) as Record<string, unknown>;
  const teammate = s.teammate as { displayName?: unknown } | null | undefined;
  const shell = s.sessionKind === 'shell';
  const tool = str(s.agentTool);
  const toolName = shell ? 'Terminal' : tool ? (TOOL_NAME[tool] ?? tool) : null;
  const model = str(s.model);
  const branch = str(s.checkoutBranch);
  const workdir = str(s.workdirMode);
  const started = when(str(s.startedAt), now);
  const ended = when(str(s.exitedAt), now);
  const outcomeAt = when(str(s.outcomeAt), now);
  const outcome = str(s.outcome);
  const share = str(s.shareMode);
  const drive = str(s.driveMode);
  const ending = str(s.endedReason);
  const [copied, setCopied] = useState(false);

  const facts: Array<[string, ReactNode]> = [];
  if (toolName || model) {
    facts.push(['Model', (
      <>
        {model ? <span className="pn-sd__model">{model}</span> : null}
        {toolName ? <span className="pn-sd__muted">{model ? ` · ${toolName}` : toolName}</span> : null}
      </>
    )]);
  }
  const persona = typeof teammate?.displayName === 'string' ? teammate.displayName : null;
  if (persona) facts.push(['Teammate', persona]);
  if (branch) {
    facts.push(['Branch', (
      <>
        <span className="pn-sd__mono">⎇ {branch}</span>
        {workdir ? <span className="pn-sd__muted"> · {workdir}</span> : null}
      </>
    )]);
  } else if (workdir) {
    facts.push(['Workdir', workdir]);
  }
  if (started) facts.push(['Started', started]);
  if (ended) facts.push(['Ended', ending ? `${ended} · ${ending}` : ended]);
  if (outcome && outcome !== 'open' && outcomeAt) facts.push([outcome === 'completed' ? 'Completed' : 'Stopped', outcomeAt]);
  if (share || drive) facts.push(['Sharing', [share ? `shared: ${share}` : null, drive ? `driven by ${drive}` : null].filter(Boolean).join(' · ')]);

  return (
    <div className="pn-sd" data-testid="session-details" onClick={(event) => event.stopPropagation()}>
      {word ? (
        <div className={`pn-sd__status pn-sd__status--${word.tone}`} data-session-case={word.case}>
          <span className="pn-sd__statusword">{word.word}</span>
          {word.reason ? <span className="pn-sd__reason">{word.reason}</span> : null}
        </div>
      ) : null}

      <dl className="pn-sd__facts">
        {facts.map(([label, value]) => (
          <div key={label} className="pn-sd__fact">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {tasks.length > 0 ? (
          <div className="pn-sd__fact">
            <dt>{tasks.length === 1 ? 'Task' : 'Tasks'}</dt>
            <dd className="pn-sd__tasks">
              {tasks.map((task) => {
                const status = (task.state as unknown as { status?: string }).status ?? 'open';
                const body = (
                  <>
                    <span className={`pn-sd__taskstatus pn-sd__taskstatus--${status}`}>{status.replace(/_/g, ' ')}</span>
                    <span className="pn-sd__tasktitle">{task.title}</span>
                  </>
                );
                return onOpenTask ? (
                  <button key={task.id} type="button" className="pn-sd__task" title={`Open ${task.title}`} onClick={() => onOpenTask(task.id)}>
                    {body}
                  </button>
                ) : (
                  <span key={task.id} className="pn-sd__task">{body}</span>
                );
              })}
            </dd>
          </div>
        ) : null}
        {links ? (
          <div className="pn-sd__fact">
            <dt>Links</dt>
            <dd>{links}</dd>
          </div>
        ) : null}
        <div className="pn-sd__fact">
          <dt>ID</dt>
          <dd>
            <button
              type="button"
              className="pn-sd__id"
              title={copied ? 'Session ID copied' : 'Copy session ID'}
              onClick={() => {
                void copyToClipboard(id).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1_200);
                });
              }}
            >
              {id}
              <span className="pn-sd__muted">{copied ? ' · copied' : ' · copy'}</span>
            </button>
          </dd>
        </div>
      </dl>

      {controls ? <div className="pn-sd__controls">{controls}</div> : null}
    </div>
  );
}
