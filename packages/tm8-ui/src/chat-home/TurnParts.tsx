import { Fragment, memo, useId, useMemo, useState, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { Markdown } from '../kit';
import { type ChatEntityResolver } from './EntityChip';
import { ExplanationToolCard } from './ExplanationToolCard';
import { CreatedCard, EditLine, TransitionRow } from './LedgerCards';
import { LedgerTree } from './ledger-tree';
import { explanationToolName } from './explanation-tools';
import {
  buildChatLedger,
  foldChatLedger,
  kindWord,
  readCountPairs,
  type ChatLedger,
  type LedgerCreate,
  type LedgerTransition,
} from './ledger';
import { projectTurnParts, type ProjectedTurnPart } from './turn-model';
import {
  buildStepLines,
  buildStepViews,
  isStepTool,
  segmentTurn,
  summarizeRun,
  type RunItem,
  type StepView,
} from './turn-step-lines';
import { toolStepState, turnEndSeq, type ToolStepPart, type ToolStepState } from './turn-steps';
import { DocEditLine, StepErrorLine, TurnSteps } from './TurnSteps';
import type { ChatTurn, ChatTurnPart, ChatUsage } from './types';
import { bareToolName } from './write-classifier';

export interface TurnPartsProps {
  parts: readonly ChatTurnPart[];
  /** Opens the entity detail panel; absent renders ledger lines as inert text. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Lazily resolves title/kind for bare-id references. */
  resolveEntity?: ChatEntityResolver | undefined;
  /** Ids that must never surface — this thread's own messages. */
  suppressEntityIds?: ReadonlySet<string> | undefined;
  /** Resolves authenticated tm8 file bytes for an inline asset preview. */
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
  /**
   * The whole thread's fold, when the host has one. Cross-turn memory lives
   * here: a transition's `from` side read three turns ago, a create indented
   * under a parent created last turn. Absent (a lone message row, a test), the
   * turn folds itself — same rules, thread memory honestly missing.
   */
  ledger?: ChatLedger | undefined;
  /** Which of the ledger's turns this is. Required to mean anything with
   *  `ledger`; ignored without it. */
  turnMessageId?: EntityId | undefined;
  /**
   * A HOST's one-line note under a tool call — Craft names the blueprint
   * nodes a patching call changed. Called for plain tool calls only; null ⇒
   * nothing extra. Never a box and never the payload (the no-tool-boxes law):
   * the host renders a sentence, not the call.
   */
  toolNote?: ((call: ToolNoteInput) => ReactNode) | undefined;
  /**
   * The HOST knows this turn is over — the thread is not streaming, or a newer
   * turn exists. Absent, the turn ends at its own last `done`/`error` part.
   * Either way a call still `running` in an ended turn reads as STOPPED: an
   * interrupted or dead runtime never writes a terminal record for the calls
   * it abandoned, and a pulse on a call that will never finish is a lie.
   */
  settled?: boolean | undefined;
}

/** What a host's `toolNote` sees of one call. `state` is what the reader
 *  sees (`toolStepState`): a call whose result landed is never `running`, and
 *  a call its turn abandoned is `stopped`. */
export interface ToolNoteInput {
  name: string;
  args: unknown;
  result?: unknown;
  state: ToolStepState;
}

/** Fallback identity for a turn folding itself outside any thread. */
const SOLO_TURN_ID = 'solo-turn' as EntityId;

export function TurnParts({
  parts,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
  ledger,
  turnMessageId,
  toolNote,
  settled = false,
}: TurnPartsProps) {
  const projected = useMemo(() => projectTurnParts(parts), [parts]);
  /**
   * THE LEDGER, NOT THE CALLS. A turn that read nine entities used to draw
   * nine boxes; then it drew a chip row; now it says what happened to the
   * graph, in three sentence shapes and nothing else (design ruling 1):
   *
   *   Read 3 tasks, 4 docs, 5 memories     ← ONE counted line per turn
   *   Task 1 Created                       ← one line per create, tree-indented
   *   Task 1  in_progress → done           ← one line per transition
   *
   * Everything comes from the ledger fold (`ledger.ts`) — the same model the
   * sticky panel and the graph stage project — so the transcript can never
   * disagree with them. No tool name, no box, no payload ever renders
   * (graph-seeds R8; `no-tool-boxes.test.tsx` pins all three bans).
   */
  const threadLedger = useMemo(() => {
    if (ledger) return ledger;
    const solo: ChatTurn = {
      messageId: SOLO_TURN_ID,
      role: 'assistant',
      author: null,
      createdAt: '',
      body: '',
      parts: [...parts],
    };
    return buildChatLedger([solo]);
  }, [ledger, parts]);
  const ownId = ledger ? turnMessageId : SOLO_TURN_ID;
  const turnLedger = useMemo(
    () => threadLedger.turns.find((t) => t.messageId === ownId),
    [threadLedger, ownId],
  );

  /* The read line anchors at the FIRST plain call, exactly where the chip row
     anchored: it fills in live, in place, as results land. */
  const plainTools = useMemo(() => projected.filter(isStepTool), [projected]);
  const readAnchorSeq = plainTools[0]?.seq ?? null;
  const readPairs = useMemo(
    () => (turnLedger ? readCountPairs(turnLedger.reads) : []),
    [turnLedger],
  );

  const createsBySeq = useMemo(() => {
    const map = new Map<number, LedgerCreate>();
    for (const create of turnLedger?.creates ?? []) map.set(create.seq, create);
    return map;
  }, [turnLedger]);
  const transitionsBySeq = useMemo(() => {
    const map = new Map<number, LedgerTransition>();
    for (const transition of turnLedger?.transitions ?? []) map.set(transition.seq, transition);
    return map;
  }, [turnLedger]);
  /* The turn's edits draw ONE line, anchored at the first of them (D11). A
     host's note is its own sentence for its call — Craft's names the
     blueprint nodes a patch changed — so the generic line steps aside for
     any edit a host already narrated, rather than saying it twice. */
  const lineEdits = useMemo(() => {
    const edits = turnLedger?.edits ?? [];
    if (!toolNote) return edits;
    return edits.filter((edit) => {
      const call = plainTools.find((tool) => tool.seq === edit.seq);
      return !call || toolNote({ name: call.name, args: call.args, result: call.result, state: call.state }) == null;
    });
  }, [turnLedger, toolNote, plainTools]);
  const editAnchorSeq = lineEdits[0]?.seq ?? null;

  /**
   * THE STEP LIST (advisor D7/D8/D15). Every plain call is a STEP with a
   * reader-visible state, and each run of steps between two pieces of content
   * draws one quiet block: a running step pulses from its first `running`
   * part, before any result; a failed one is ✕; completed reads fold into
   * counted lines. The turn is live until its last part is a `done`/`error`
   * or the host says it is over.
   */
  const endSeq = useMemo(() => turnEndSeq(parts), [parts]);
  const lastSeq = useMemo(() => parts.reduce((max, part) => Math.max(max, part.seq), -1), [parts]);
  const turnLive = !settled && !(endSeq >= 0 && endSeq === lastSeq);
  const views = useMemo(
    () => buildStepViews(plainTools, { settled, endSeq, labels: threadLedger.labels }),
    [plainTools, settled, endSeq, threadLedger],
  );
  const segments = useMemo(() => segmentTurn(projected), [projected]);
  /* One usage card per turn. A done frame's usage and a replayed usage part
     can both survive a reconnect's reconcile under different seqs; the turn
     had one usage, so it draws one — the latest. */
  const lastUsageSeq = useMemo(() => {
    let last: number | null = null;
    for (const part of projected) if (part.kind === 'usage') last = part.seq;
    return last;
  }, [projected]);

  /** The ledger block for ONE call — the lines it produced, verbatim from
   *  before the step list; each run draws its calls' blocks above its steps. */
  const ledgerLines = (part: ToolStepPart, view: StepView | undefined) => {
    const create = createsBySeq.get(part.seq);
    const transition = transitionsBySeq.get(part.seq);
    const readsHere = part.seq === readAnchorSeq && readPairs.length > 0;
    const editsHere = part.seq === editAnchorSeq;
    const note = toolNote?.({
      name: part.name,
      args: part.args,
      result: part.result,
      state: view?.state ?? part.state,
    }) ?? null;
    if (!create && !transition && !readsHere && !editsHere && note == null) return null;
    return (
      <div className="tch-ledger" key={part.seq}>
        {readsHere && turnLedger ? (
          <ReadLine
            pairs={readPairs}
            ledger={threadLedger}
            turnMessageId={turnLedger.messageId}
            onOpenEntity={onOpenEntity}
            resolveEntity={resolveEntity}
          />
        ) : null}
        {create ? (
          <CreateLine
            create={create}
            ledger={threadLedger}
            onOpenEntity={onOpenEntity}
          />
        ) : null}
        {transition ? (
          <TransitionLine
            transition={transition}
            ledger={threadLedger}
            onOpenEntity={onOpenEntity}
          />
        ) : null}
        {editsHere ? (
          <EditLine edits={lineEdits} ledger={threadLedger} onOpenEntity={onOpenEntity} />
        ) : null}
        {note}
      </div>
    );
  };

  /** A settled `doc_update`'s edit line (D11/D17), with the call's outcomes. */
  const docEdit = (part: ToolStepPart, view: StepView | undefined) => {
    if (view?.state !== 'completed' || bareToolName(part.name) !== 'doc_update') return null;
    const args = part.args as { docId?: unknown; title?: unknown } | null | undefined;
    const docId = typeof args?.docId === 'string' ? args.docId : null;
    const title =
      (typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : null) ??
      (docId ? threadLedger.labels.get(docId)?.title ?? null : null);
    return <DocEditLine key={`edit:${part.seq}`} docId={docId} title={title} onOpenEntity={onOpenEntity} />;
  };

  const renderRun = (key: string, items: readonly RunItem[]) => {
    const steps = items.flatMap((item) => (item.kind === 'step' ? [item.part] : []));
    const failed = steps.flatMap((part) => {
      const view = views.get(part.seq);
      return view?.state === 'error' ? [view] : [];
    });
    /* D15 §5: the run's outcomes first — its calls' ledger lines in seq
       order, then any edit lines, then its failures (D13) — and the step
       block last, so the live step is the last thing on screen. */
    return (
      <Fragment key={key}>
        {steps.map((part) => ledgerLines(part, views.get(part.seq)))}
        {steps.map((part) => docEdit(part, views.get(part.seq)))}
        {failed.map((view) => <StepErrorLine key={`err:${view.seq}`} view={view} />)}
        <TurnSteps
          lines={buildStepLines(items, views)}
          summary={summarizeRun(items, views)}
          live={turnLive}
        />
      </Fragment>
    );
  };

  return (
    <div className="tch-parts">
      {segments.map((segment) => {
        if (segment.kind === 'run') return renderRun(segment.key, segment.items);
        const part = segment.part;
        if (part.kind === 'thinking') {
          return (
            <details className="tch-thinking" key={part.seq}>
              <summary>Thinking</summary>
              {/* pre-wrap, not markdown: reasoning is quoted verbatim, and its
                  line breaks are the only structure it reliably has. */}
              <p className="tch-thinking__text">{part.text}</p>
            </details>
          );
        }
        if (part.kind === 'text') {
          return <TurnText key={part.seq} source={part.text} />;
        }
        if (part.kind === 'tool') {
          // Only the `explain_*` presentations reach here (`isStepTool`).
          // Their card reads the state the reader must see: a result that
          // landed is not pending, and a call its turn abandoned is not
          // "Preparing…" forever.
          const seen = toolStepState(part, settled || part.seq < endSeq);
          const state = seen === 'stopped' ? 'error' : seen;
          return (
            <ExplanationToolCard
              key={`${part.toolCallId}:${part.seq}`}
              part={state === part.state ? part : { ...part, state }}
              onOpenEntity={onOpenEntity}
              resolveEntity={resolveEntity}
              suppressEntityIds={suppressEntityIds}
              assetHref={assetHref}
            />
          );
        }
        if (part.kind === 'usage') {
          return part.seq === lastUsageSeq ? <UsageCard key={part.seq} usage={part.usage} /> : null;
        }
        return (
          <div className="tch-turn-error" role="alert" key={part.seq}>
            <strong>Turn failed</strong>
            <span>{part.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A text part, memoised on its source. A streaming turn re-renders on every
 * delta, and `Markdown` hands react-markdown a fresh `a` component on every
 * render — so an UNmemoised text block remounted every link it contained on
 * every delta: a hovered link lost hover, a selection spanning one collapsed,
 * focus on one was dropped. Settled text must not move while the turn streams
 * below it.
 */
const TurnText = memo(function TurnText({ source }: { source: string }) {
  return <Markdown source={source} className="tch-answer" testId="chat-turn-text" />;
});

/**
 * `Read 3 tasks, 4 docs, 5 memories` — the whole surviving trace of every
 * plain read in the turn, and the door to it: activating the line expands,
 * in place, the shared `LedgerTree` filtered to THIS turn's reads (design
 * ruling 7 — same component as the sticky panel, different filter).
 *
 * A BUTTON now, where S3 shipped a span, by the same honesty rule read
 * forwards: the expansion is the press's destination, and it exists on every
 * host — including one that cannot open entities, where the tree's rows fall
 * to spans and the view stays view-only. Collapse state lives HERE, one line
 * one toggle, so no turn's expansion can leak into another's. Not a
 * `<details>`: that shape is banned with the payload dumps it used to carry
 * (no-tool-boxes.test.tsx), and the ban stays honest by never being resembled.
 */
function ReadLine({
  pairs,
  ledger,
  turnMessageId,
  onOpenEntity,
  resolveEntity,
}: {
  pairs: readonly { kind: string; count: number }[];
  ledger: ChatLedger;
  turnMessageId: string;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const sentence = pairs
    .map(({ kind, count }) => `${count} ${kindWord(kind, count)}`)
    .join(', ');
  return (
    <>
      <button
        type="button"
        className="tch-ledger__reads"
        data-testid="chat-ledger-reads"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Read {sentence}
        <span className="tch-ledger__caret" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div id={regionId} className="tch-ledger__readtree" data-testid="chat-ledger-readtree">
          <LedgerTree
            model={ledger}
            filter={{ readsOnly: true, turnMessageId }}
            onOpenEntity={onOpenEntity}
            resolveEntity={resolveEntity}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * What the chat MADE: a highlighted card per created entity or spawned
 * session, and a pill line per status transition it caused — both drawn by
 * `LedgerCards.tsx` (advisor D9–D11, D17). These two names stay as the seam
 * the per-call ledger block calls, so the block's shape (lane 3's) and the
 * cards' design (lane 4's) can move independently.
 */
function CreateLine({
  create,
  ledger,
  onOpenEntity,
}: {
  create: LedgerCreate;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  return <CreatedCard create={create} ledger={ledger} onOpenEntity={onOpenEntity} />;
}

function TransitionLine({
  transition,
  ledger,
  onOpenEntity,
}: {
  transition: LedgerTransition;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  return <TransitionRow transition={transition} ledger={ledger} onOpenEntity={onOpenEntity} />;
}

/**
 * One turn's usage, each count under its own name. These are the TURN's
 * figures — the step in the runtime's running totals, not the totals — and
 * they are the provider's categories: Claude bills a cached prefix as cache
 * read, not as input, so "input + output" alone would read a 40k-token turn
 * as 15 tokens. An absent count is left out, never shown as 0.
 */
function UsageCard({ usage }: { usage: ChatUsage }) {
  const counts = usageCounts(usage);
  return (
    <aside className="tch-usage" aria-label="Turn usage" data-testid="chat-usage-card">
      <span className="tch-usage__label">usage</span>
      {counts.map(([label, value]) => (
        <span key={label}>{`${value.toLocaleString()} ${label}`}</span>
      ))}
      {usage.total_cost_usd !== undefined ? (
        <span>{formatCost(usage.total_cost_usd)}</span>
      ) : null}
      {usage.model ? <span>{usage.model}</span> : null}
      {usage.provider ? <span>{usage.provider}</span> : null}
    </aside>
  );
}

function usageCounts(usage: ChatUsage): Array<[string, number]> {
  const counts: Array<[string, number | undefined]> = [
    ['in', usage.input_tokens],
    ['cache read', usage.cache_read_tokens],
    ['cache write', usage.cache_creation_tokens],
    ['out', usage.output_tokens],
  ];
  return counts.filter((entry): entry is [string, number] => entry[1] !== undefined);
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

export { foldChatLedger };
