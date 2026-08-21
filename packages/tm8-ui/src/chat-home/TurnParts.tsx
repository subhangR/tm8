import { useMemo } from 'react';
import type { EntityId } from '@tm8/contract';
import { Markdown } from '../kit';
import { type ChatEntityResolver } from './EntityChip';
import { truncateEntityId } from './entity-refs';
import { ExplanationToolCard } from './ExplanationToolCard';
import { durableOutputToolName, explanationToolName } from './explanation-tools';
import {
  buildChatLedger,
  foldChatLedger,
  readCountPairs,
  type ChatLedger,
  type LedgerCreate,
  type LedgerTransition,
} from './ledger';
import { projectTurnParts, type ProjectedTurnPart } from './turn-model';
import type { ChatTurn, ChatTurnPart, ChatUsage } from './types';

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
}

/** A tool call with nothing to show for itself — everything except the
 *  `explain_*` / `doc_*` / `artifact_create` family, whose payload IS content. */
function isPlainTool(
  part: ProjectedTurnPart,
): part is Extract<ProjectedTurnPart, { kind: 'tool' }> {
  return (
    part.kind === 'tool' &&
    !explanationToolName(part.name) &&
    !durableOutputToolName(part.name)
  );
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
  const plainTools = useMemo(() => projected.filter(isPlainTool), [projected]);
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

  return (
    <div className="tch-parts">
      {projected.map((part) => {
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
          return (
            <Markdown
              key={part.seq}
              source={part.text}
              className="tch-answer"
              testId="chat-turn-text"
            />
          );
        }
        if (part.kind === 'tool') {
          if (explanationToolName(part.name) || durableOutputToolName(part.name)) {
            return (
              <ExplanationToolCard
                key={`${part.toolCallId}:${part.seq}`}
                part={part}
                onOpenEntity={onOpenEntity}
                resolveEntity={resolveEntity}
                suppressEntityIds={suppressEntityIds}
                assetHref={assetHref}
              />
            );
          }
          const create = createsBySeq.get(part.seq);
          const transition = transitionsBySeq.get(part.seq);
          const readsHere = part.seq === readAnchorSeq && readPairs.length > 0;
          if (!create && !transition && !readsHere) return null;
          return (
            <div className="tch-ledger" key={part.seq}>
              {readsHere ? <ReadLine pairs={readPairs} /> : null}
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
            </div>
          );
        }
        if (part.kind === 'usage') {
          return <UsageCard key={part.seq} usage={part.usage} />;
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
 * `Read 3 tasks, 4 docs, 5 memories` — the whole surviving trace of every
 * plain read in the turn. A SPAN for now, by the honesty rule: a button that
 * does nothing on press is a dead control, and the expansion that will give
 * the press somewhere to land is the next slice's work.
 */
function ReadLine({ pairs }: { pairs: readonly { kind: string; count: number }[] }) {
  const sentence = pairs
    .map(({ kind, count }) => `${count} ${kindWord(kind, count)}`)
    .join(', ');
  return (
    <span className="tch-ledger__reads" data-testid="chat-ledger-reads">
      Read {sentence}
    </span>
  );
}

/**
 * One line per created entity, indented under its parent when the parent was
 * created earlier in this thread (design §4.2). The line IS the entity:
 * clicking it opens the detail panel — every kind identically, sessions
 * included (the host routes a session to its terminal).
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
  return (
    <span
      className="tch-ledger__create"
      data-testid="chat-ledger-create"
      style={{ paddingLeft: `${createDepth(create.id, ledger) * 16}px` }}
    >
      <LedgerEntity id={create.id} ledger={ledger} onOpenEntity={onOpenEntity} />
      <span className="tch-ledger__verb">Created</span>
    </span>
  );
}

/**
 * `Task 1  in_progress → done`, degrading honestly to `Task 1  → done` when
 * this thread never read the entity before writing it (design ruling 13):
 * a one-sided arrow is less than we wish we knew; an invented left side would
 * be a lie about history.
 */
function TransitionLine({
  transition,
  ledger,
  onOpenEntity,
}: {
  transition: LedgerTransition;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  return (
    <span className="tch-ledger__transition" data-testid="chat-ledger-transition">
      <LedgerEntity id={transition.entityId} ledger={ledger} onOpenEntity={onOpenEntity} />
      <span className="tch-ledger__arrow">
        {transition.from ? `${transition.from} → ${transition.to}` : `→ ${transition.to}`}
      </span>
    </span>
  );
}

/**
 * The entity's name in a ledger line — a real button when the host can open
 * entities, an inert span when it cannot. Same split `EntityChip` holds and
 * for the same reason: a press must never land on a control that goes
 * nowhere. Kind is never consulted for clickability.
 */
function LedgerEntity({
  id,
  ledger,
  onOpenEntity,
}: {
  id: string;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const label = ledger.labels.get(id);
  const text = label?.title ?? (label?.kind ? kindWord(label.kind, 1) : truncateEntityId(id));
  if (!onOpenEntity) {
    return <span className="tch-ledger__entity">{text}</span>;
  }
  return (
    <button
      type="button"
      className="tch-ledger__entity tch-ledger__open"
      onClick={() => onOpenEntity(id as EntityId)}
    >
      {text}
    </button>
  );
}

/** How deep a created entity sits under parents created in this thread. */
function createDepth(id: string, ledger: ChatLedger): number {
  const createdHere = new Set(ledger.creates.map((c) => c.id));
  let depth = 0;
  let cursor = ledger.parentOf.get(id) ?? null;
  // The hierarchy is homogeneous and acyclic, but the fold is defensive: a
  // malformed payload must terminate the walk, not hang the render.
  while (cursor && createdHere.has(cursor) && depth < 32) {
    depth += 1;
    cursor = ledger.parentOf.get(cursor) ?? null;
  }
  return depth;
}

/**
 * The kind vocabulary, humanised and pluralised for the sentence. Core kinds
 * get their English; a custom `c:*` kind sheds its prefix rather than shipping
 * `Read 3 c:invoices` (design §4.1).
 */
function kindWord(kind: string, count: number): string {
  const base = kind.startsWith('c:') ? kind.slice(2) : kind;
  const word =
    base === 'work_session' ? 'session' : base === 'entity' ? 'entity' : base.replace(/_/g, ' ');
  if (count === 1) return word;
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  if (word.endsWith('s')) return word;
  return `${word}s`;
}

function UsageCard({ usage }: { usage: ChatUsage }) {
  const tokens = tokenTotal(usage);
  return (
    <aside className="tch-usage" aria-label="Turn usage" data-testid="chat-usage-card">
      <span className="tch-usage__label">usage</span>
      {tokens !== null ? <span>{tokens.toLocaleString()} tokens</span> : null}
      {usage.total_cost_usd !== undefined ? (
        <span>{formatCost(usage.total_cost_usd)}</span>
      ) : null}
      {usage.model ? <span>{usage.model}</span> : null}
      {usage.provider ? <span>{usage.provider}</span> : null}
    </aside>
  );
}

function tokenTotal(usage: ChatUsage): number | null {
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return null;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

export { foldChatLedger };
