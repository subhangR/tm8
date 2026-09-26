import { useEffect, useId, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import {
  stepsIn,
  type RunSummary,
  type StepLine,
  type StepView,
} from './turn-step-lines';
import './turn-steps.css';

/** D15 §2: a live run shows its latest five lines; the rest wait behind one
 *  "earlier" button. */
export const STEP_TAIL = 5;

const ICON: Record<Extract<StepLine, { kind: 'step' }>['state'], string> = {
  completed: '✓',
  running: '●',
  error: '✕',
  stopped: '■',
};

/** The turn's one step header (rules R2/R3, doc 01a0ddb5): the whole turn's
 *  summary and the only toggle for every run's list. */
export interface TurnStepsHead {
  summary: RunSummary;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * ONE RUN'S STEP BLOCK — the agent's work between two pieces of content, as a
 * quiet, left-ruled list (advisor D7/D15; tool-call rules R1–R8, doc
 * `01a0ddb5` on task 01a0ddad, signed off by Subhang).
 *
 * - The TURN owns the fold, not the run (R2/R3, amending D15 §3 and D19): the
 *   turn's FIRST run carries the one header, `37 steps · ran 12 commands,
 *   read 6 tasks · 2 failed ▸`, counting every run of the turn, and pressing
 *   it opens or closes every run's list at once.
 * - While the turn is live only the CURRENT run is open (R4, amending D15 §2):
 *   a run the agent has written past folds into the header's count.
 * - A run that is not open still pins its stopped step (D19, one at most) and
 *   anything running (D25), and draws nothing when it has neither.
 * - Not a live region: the status row under the conversation is the only
 *   thing that announces, so nothing is said twice (D15 §2).
 * - Never a box, never a tool name, never a payload (R8). The words come from
 *   `turn-steps.ts`, the same module the status row reads.
 */
export function TurnSteps({
  lines,
  head,
  open,
  live,
}: {
  lines: readonly StepLine[];
  /** Present on the turn's first run only. */
  head?: TurnStepsHead | undefined;
  /** This run's list is open (the latest five lines, the rest one press away). */
  open: boolean;
  /** The turn is still going. */
  live: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  // The "earlier" button unmounts on press; focus follows the steps it
  // revealed rather than falling to <body>.
  const focusList = useRef(false);
  useEffect(() => {
    if (showAll && focusList.current) {
      focusList.current = false;
      listRef.current?.focus();
    }
  }, [showAll]);

  let visible: readonly StepLine[];
  let hidden = 0;
  if (open) {
    visible = showAll ? lines : lines.slice(-STEP_TAIL);
    hidden = lines.length - visible.length;
  } else {
    // Folded: only a stopped step is pinned (D19, one at most). A viewer who
    // folded a LIVE turn still sees what is running (D25).
    const stopped = lines.filter((line) => line.kind === 'step' && line.state === 'stopped').slice(-1);
    const running = lines.filter((line) => line.kind === 'step' && line.state === 'running');
    visible = [...stopped, ...running];
  }
  if (!head && visible.length === 0) return null;
  const hiddenSteps = stepsIn(lines.slice(0, hidden));

  return (
    <section className="tch-steps" data-testid="chat-steps" data-live={live ? 'true' : undefined}>
      {head ? (
        <button
          type="button"
          className="tch-steps__head"
          data-testid="chat-steps-head"
          aria-expanded={head.expanded}
          aria-controls={visible.length > 0 ? listId : undefined}
          onClick={head.onToggle}
        >
          <span className="tch-steps__count">
            {head.summary.steps} {head.summary.steps === 1 ? 'step' : 'steps'}
          </span>
          {head.summary.groups ? <span className="tch-steps__groups">{` · ${head.summary.groups}`}</span> : null}
          {head.summary.failed > 0 ? (
            <span className="tch-steps__failed">{` · ${head.summary.failed} failed`}</span>
          ) : null}
          <span className="tch-steps__caret" aria-hidden>{head.expanded ? '▾' : '▸'}</span>
        </button>
      ) : null}
      {hidden > 0 ? (
        <button
          type="button"
          className="tch-steps__earlier"
          data-testid="chat-steps-earlier"
          aria-expanded={false}
          aria-controls={listId}
          onClick={() => {
            focusList.current = true;
            setShowAll(true);
          }}
        >
          {hiddenSteps > 0
            ? `Show ${hiddenSteps} earlier ${hiddenSteps === 1 ? 'step' : 'steps'}`
            : 'Show earlier thoughts'}
        </button>
      ) : null}
      {visible.length > 0 ? (
        <ol className="tch-steps__list" id={listId} ref={listRef} tabIndex={-1}>
          {visible.map((line) =>
            line.kind === 'thought' ? (
              <ThoughtLine key={line.key} text={line.text} />
            ) : (
              <li
                key={line.key}
                className="tch-steps__line"
                data-testid="chat-step-line"
                data-state={line.state}
                data-count={line.count}
              >
                <span className="tch-steps__icon" aria-hidden>{ICON[line.state]}</span>
                <span className="tch-steps__text">{line.text}</span>
                {line.detail ? <span className="tch-steps__detail">{line.detail}</span> : null}
              </li>
            ),
          )}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * `Thought ▸` — the agent's reasoning, one quiet line that opens inline to the
 * verbatim text (D15 §4). A button, not a `<details>`: that shape is banned
 * among the step lines with the payload disclosures it used to carry.
 */
function ThoughtLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="tch-steps__line tch-steps__line--thought" data-testid="chat-step-thought">
      <span className="tch-steps__icon" aria-hidden>·</span>
      <span className="tch-steps__text">
        <button
          type="button"
          className="tch-steps__thought-toggle"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          Thought <span aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
        {open ? (
          // pre-wrap, not markdown: reasoning is quoted verbatim.
          <p id={id} className="tch-steps__thought">{text}</p>
        ) : null}
      </span>
    </li>
  );
}

/**
 * `✕ Resuming a session failed 8 times: team member not found · The agent
 * retried` — the durable record of a run's failed steps, drawn with its
 * outcomes above the step block (D13). It stays when the turn folds (R5:
 * no failure is ever hidden); identical failures fold into one line with a
 * count (R6).
 */
export function StepErrorLine({ view, count = 1, retried = view.retried }: {
  view: StepView;
  count?: number;
  retried?: boolean;
}) {
  return (
    <div className="tch-errline" data-testid="chat-step-errline">
      <span aria-hidden>✕ </span>
      {`${view.words.active} failed`}
      {count > 1 ? ` ${count} times` : ''}
      {view.reason ? `: ${view.reason}` : ''}
      {retried ? ' · The agent retried' : ''}
    </div>
  );
}

/**
 * `✎ Edited ¶ Runbook` — a settled `doc_update`, as the quiet edit line D11
 * gives every non-status edit (D17 retired its durable-output card). The name
 * opens the doc where the host can open entities; otherwise it is text.
 */
export function DocEditLine({
  docId,
  title,
  onOpenEntity,
}: {
  docId: string | null;
  title: string | null;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const label = title ?? 'a doc';
  return (
    <div className="tch-docedit" data-testid="chat-doc-edit">
      <span className="tch-docedit__glyph" aria-hidden>✎</span>
      <span>Edited</span>
      <span className="tch-docedit__kind" aria-hidden>¶</span>
      {docId && onOpenEntity ? (
        <button type="button" className="tch-docedit__open" onClick={() => onOpenEntity(docId as EntityId)}>
          {label}
        </button>
      ) : (
        <span className="tch-docedit__title">{label}</span>
      )}
    </div>
  );
}
