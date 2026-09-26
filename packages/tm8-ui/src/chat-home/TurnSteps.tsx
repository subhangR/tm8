import { useId, useState } from 'react';
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

/**
 * ONE RUN'S STEP BLOCK — the agent's work between two pieces of content, as a
 * quiet, left-ruled list (advisor D7/D8/D15/D19).
 *
 * - While the TURN is live the block is open and shows the latest five lines,
 *   the running step last with a pulse. When the turn ends it collapses to its
 *   header, `37 steps · read 12 files, ran 8 commands · 2 failed ▸`.
 * - Collapsed, the one line still pinned under the header is a STOPPED step
 *   (a failure is already its errline above plus the header's count, D19).
 * - Not a live region: the status row under the conversation is the only
 *   thing that announces, so nothing is said twice (D15 §2).
 * - Never a box, never a tool name, never a payload (R8). The words come from
 *   `turn-steps.ts`, the same module the status row reads.
 */
export function TurnSteps({
  lines,
  summary,
  live,
}: {
  lines: readonly StepLine[];
  summary: RunSummary;
  /** The turn is still going: the block opens by default. */
  live: boolean;
}) {
  // null ⇒ follow the turn: open while live, closed once it ends. A press
  // pins the viewer's choice for the life of the block.
  const [open, setOpen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const expanded = open ?? live;

  let visible: readonly StepLine[];
  let hidden = 0;
  if (expanded) {
    visible = showAll ? lines : lines.slice(-STEP_TAIL);
    hidden = lines.length - visible.length;
  } else {
    // Collapsed: only a stopped step is pinned (D19, one at most). A viewer who
    // folded a LIVE run still sees what is running.
    const stopped = lines.filter((line) => line.kind === 'step' && line.state === 'stopped').slice(-1);
    const running = lines.filter((line) => line.kind === 'step' && line.state === 'running');
    visible = [...stopped, ...running];
  }
  const hiddenSteps = stepsIn(lines.slice(0, hidden));

  return (
    <section className="tch-steps" data-testid="chat-steps" data-live={live ? 'true' : undefined}>
      <button
        type="button"
        className="tch-steps__head"
        data-testid="chat-steps-head"
        aria-expanded={expanded}
        aria-controls={visible.length > 0 ? listId : undefined}
        onClick={() => setOpen(!expanded)}
      >
        <span className="tch-steps__count">
          {summary.steps} {summary.steps === 1 ? 'step' : 'steps'}
        </span>
        {summary.groups ? <span className="tch-steps__groups">{` · ${summary.groups}`}</span> : null}
        {summary.failed > 0 ? (
          <span className="tch-steps__failed">{` · ${summary.failed} failed`}</span>
        ) : null}
        <span className="tch-steps__caret" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {hidden > 0 ? (
        <button
          type="button"
          className="tch-steps__earlier"
          data-testid="chat-steps-earlier"
          aria-expanded={false}
          aria-controls={listId}
          onClick={() => setShowAll(true)}
        >
          {hiddenSteps > 0
            ? `Show ${hiddenSteps} earlier ${hiddenSteps === 1 ? 'step' : 'steps'}`
            : 'Show earlier thoughts'}
        </button>
      ) : null}
      {visible.length > 0 ? (
        <ol className="tch-steps__list" id={listId}>
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
 * `✕ Running a shell command failed: Exit code 1 · The agent retried` — the
 * durable record of one failed step, drawn with the run's outcomes above its
 * step block (D13). It stays when the block collapses.
 */
export function StepErrorLine({ view }: { view: StepView }) {
  return (
    <div className="tch-errline" data-testid="chat-step-errline">
      <span aria-hidden>✕ </span>
      {`${view.words.active} failed`}
      {view.reason ? `: ${view.reason}` : ''}
      {view.retried ? ' · The agent retried' : ''}
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
