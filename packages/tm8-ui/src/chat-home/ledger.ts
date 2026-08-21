/**
 * THE CHAT LEDGER — what this conversation did to the graph, folded from the
 * transcript it already has.
 *
 * The chat view stops rendering TOOL CALLS and starts rendering WHAT HAPPENED:
 * reads collapse to one counted line per turn, creations enumerate as a tree,
 * status transitions get their own lines. This module is the fold behind all of
 * that, and behind the sticky panel docked to the composer.
 *
 * IT PRODUCES A MODEL, NOT STRINGS. There are two projections of one fold and
 * they disagree about what a transition IS:
 *
 *   - the TRANSCRIPT is chronological. `Task 1  in_progress → done` is an event
 *     at a point in time, and it scrolls away with its turn.
 *   - the STICKY PANEL is cumulative. There is no history there — a node simply
 *     carries `done` as its current state, and it stays on screen after the
 *     turn that changed it is long gone.
 *
 * So the model carries BOTH an ordered transition list and a last-write-wins
 * `statusNow` map. The second is derived from the first, which makes it free —
 * but they are genuinely different renders of one fact and a view must not have
 * to re-derive either.
 *
 * NO NEW SOURCE OF TRUTH. Same rule the rest of this surface lives by
 * (`fleet-model.ts` states it plainly): everything here is read out of tool-call
 * payloads the thread already contains. Nothing polls, nothing subscribes, and
 * a ledger entry that is missing here is missing from the chips too — one bug,
 * not two.
 *
 * THE "FROM" SIDE OF A TRANSITION IS NOT IN THE CALL. `entities.commands.work`
 * carries only the NEW status; `entities.commands.complete` carries no status at
 * all. So prior state is remembered from summaries this thread ALREADY READ, and
 * is `null` when the entity was written without ever being read here. That is a
 * one-sided arrow (`Task 1 → done`), not a guess: inventing a plausible previous
 * status would be a lie about history, while an absent one is merely less than
 * we wish we knew. Crossing to the graph's own activity log would answer it
 * authoritatively and is deliberately NOT done in v1 — see the design doc.
 *
 * TOOL NAMES NEVER REACH THE SURFACE (graph-seeds R8). They are read here for
 * classification only; nothing in the emitted model names a tool.
 */
import type { EntityId } from '@tm8/contract';
import { walkPayload } from './payload-walk';
import { projectTurnParts, type ProjectedTurnPart } from './turn-model';
import type { ChatTurn } from './types';
import { isWriteCall, operationOf } from './write-classifier';

/**
 * The walk budget for TALLYING.
 *
 * A cap here is not a kindness, it is a wrong number on screen: "Read 8 tasks"
 * when fifty came back. Sized (measured 2026-08-21) against the largest single
 * read the MCP surface can produce — `graph.query` at its `limit: 100`, whose
 * rows carry nested source/target summaries — with headroom, because the cost of
 * being generous is a few thousand cheap property visits on a payload already in
 * memory, and the cost of being stingy is a lie.
 *
 * It remains a budget rather than being unbounded: a malformed or adversarial
 * payload must terminate the render, not hang it.
 */
export const TALLY_MAX_NODES = 20000;
const TALLY_MAX_DEPTH = 8;

/** An entity this conversation CREATED. */
export interface LedgerCreate {
  id: string;
  /** From the create call's own args — exact, and present from first paint. */
  kind: string | null;
  title: string | null;
  /** Null when created at the root, or when `parentId` was never set. */
  parentId: string | null;
  /** The turn it happened in — how the transcript groups it. */
  messageId: EntityId;
  seq: number;
  /** A spawned work session, rather than an `entities.create`. Both are
   *  creations this conversation caused; only the verb differed. */
  spawned: boolean;
}

/** One status transition this conversation caused. */
export interface LedgerTransition {
  entityId: string;
  /** Null ⇒ this thread never read the entity before writing it, so the prior
   *  status is genuinely unknown. Render a one-sided arrow, never a guess. */
  from: string | null;
  to: string;
  messageId: EntityId;
  seq: number;
}

/** What one turn READ — ruling 2: distinct entities appearing as full summaries
 *  in a RESULT, deduped by id across the turn. */
export interface LedgerReads {
  /** Entity kind → distinct count. `'entity'` buckets summaries whose kind the
   *  payload did not carry — an honest bucket, never a silent drop. */
  byKind: ReadonlyMap<string, number>;
  /** Distinct entities read this turn. */
  total: number;
  /** First-seen order, so the expandable read line can list them. */
  ids: readonly string[];
}

export interface TurnLedger {
  messageId: EntityId;
  reads: LedgerReads;
  creates: readonly LedgerCreate[];
  transitions: readonly LedgerTransition[];
  /** True when this turn did nothing to the graph — the views draw no ledger
   *  at all rather than an empty row. */
  empty: boolean;
}

export interface ChatLedger {
  /** Per-turn, in transcript order — the CHRONOLOGICAL projection. */
  turns: readonly TurnLedger[];
  /** Every created entity, first-creation order — the CUMULATIVE projection. */
  creates: readonly LedgerCreate[];
  /** Every transition, in order. The transcript renders these as events. */
  transitions: readonly LedgerTransition[];
  /** entityId → current status, last-write-wins. The sticky tree renders THIS;
   *  it has no history to show. */
  statusNow: ReadonlyMap<string, string>;
  /** entityId → parentId, honouring later reparenting. Built from all three
   *  parenting paths, so a tree drawn from it never goes stale mid-thread. */
  parentOf: ReadonlyMap<string, string | null>;
  /** Titles/kinds learned anywhere in the thread, for rendering a create whose
   *  own call carried neither. */
  labels: ReadonlyMap<string, { kind?: string; title?: string }>;
}

/* ── operation classification ─────────────────────────────────────────────
   Read from `args.operation`, never from the tool name — chat's whole write
   path is two group tools whose names carry no verb (`write-classifier.ts`
   documents why that distinction is load-bearing). */

const CREATE_OPS = new Set(['entities.create']);
const SPAWN_OPS = new Set(['execution.spawn']);
const MOVE_OPS = new Set(['entities.move']);
const PLACEMENT_OPS = new Set(['placements.apply']);
/** `complete` names no status in its body — the operation IS the status. */
const COMPLETE_OPS = new Set(['entities.commands.complete']);
const WORK_OPS = new Set(['entities.commands.work']);

/**
 * EVERY WRITE OPERATION THE CHAT SURFACE CAN CALL — the closed set, named.
 *
 * This exists because `isWriteCall`'s verb regex MISCLASSIFIES EIGHT OF THEM AS
 * READS (measured 2026-08-21 over the full `@tm8/mcp` guide list):
 * `entities.react`, `entities.points.add`, `entities.commands.work`,
 * `entities.commands.pull`, `placements.apply`,
 * `attentionRequests.resolveEntity`, `collections.addItem`, `execution.resume`
 * — none of whose verbs ("react", "add", "work", "pull", "apply", "resolve",
 * "resume") appear in the pattern. That is the same defect class the classifier
 * itself was written to fix, and it is filed separately because it also affects
 * the graph's "edited here" emphasis and the tray's created-first ordering,
 * which are shipped surfaces this slice must not quietly change.
 *
 * The ledger cannot wait for that fix, because for IT the misclassification is
 * not an understatement — a write folded as a read gets its payload COUNTED,
 * so "Read 3 tasks" would silently include a task the turn only reacted to.
 *
 * So the ledger asks a closed question against a closed set, and falls back to
 * `isWriteCall` only for what is genuinely open: direct tools (`Edit`, `Bash`)
 * and any operation added after this was written. An unknown operation still
 * counts as a read, which keeps the original conservative direction.
 */
const WRITE_OPS = new Set([
  'entities.create',
  'entities.patch',
  'entities.move',
  'entities.delete',
  'entities.restore',
  'entities.react',
  'entities.points.add',
  'entities.commands.work',
  'entities.commands.complete',
  'entities.commands.pull',
  'entities.commands.linkPr',
  'entities.commands.linkCommit',
  'edges.create',
  'edges.patch',
  'edges.delete',
  'placements.apply',
  'attentionRequests.create',
  'attentionRequests.resolveEntity',
  'collections.addItem',
  'collections.removeItem',
  'execution.dispatch',
  'execution.spawn',
  'execution.terminate',
  'execution.resume',
  'messages.post',
]);

/** Did this call write? Closed set first, generic classifier for the open tail. */
function wrote(name: string, args: unknown, operation: string | null): boolean {
  if (operation !== null) return WRITE_OPS.has(operation);
  return isWriteCall(name, args);
}

/**
 * Fold a thread's turns into the ledger.
 *
 * Pure and order-dependent: `statusNow` and the transitions' `from` sides are
 * built by replaying turns in transcript order, so the same turns always yield
 * the same ledger regardless of when it is called. Safe to re-run under
 * streaming — see `foldChatLedger`'s caching note below.
 */
export function buildChatLedger(turns: readonly ChatTurn[]): ChatLedger {
  const allCreates: LedgerCreate[] = [];
  const allTransitions: LedgerTransition[] = [];
  const statusNow = new Map<string, string>();
  const parentOf = new Map<string, string | null>();
  const labels = new Map<string, { kind?: string; title?: string }>();
  const turnLedgers: TurnLedger[] = [];

  const learn = (id: string, kind?: string, title?: string): void => {
    const existing = labels.get(id);
    if (!existing) {
      labels.set(id, { ...(kind ? { kind } : {}), ...(title ? { title } : {}) });
      return;
    }
    // Richer fields win when they finally arrive; nothing already known is lost.
    if (kind && !existing.kind) existing.kind = kind;
    if (title && !existing.title) existing.title = title;
  };

  for (const turn of turns) {
    const readIds: string[] = [];
    const readSeen = new Set<string>();
    const creates: LedgerCreate[] = [];
    const transitions: LedgerTransition[] = [];

    for (const part of projectTurnParts(turn.parts)) {
      if (part.kind !== 'tool') continue;
      const operation = operationOf(part.args);

      /* Every payload, read or write, is a chance to learn a label and a
         status — that is how a transition later gets its `from` side. */
      absorbSummaries(part, learn, statusNow);

      if (!wrote(part.name, part.args, operation)) {
        tallyReads(part, readSeen, readIds);
        continue;
      }

      if (operation && CREATE_OPS.has(operation)) {
        const created = createdFrom(part, turn.messageId);
        if (created) {
          creates.push(created);
          parentOf.set(created.id, created.parentId);
          learn(created.id, created.kind ?? undefined, created.title ?? undefined);
        }
        continue;
      }

      if (operation && SPAWN_OPS.has(operation)) {
        const spawned = spawnedFrom(part, turn.messageId);
        if (spawned) {
          creates.push(spawned);
          parentOf.set(spawned.id, null);
          learn(spawned.id, 'work_session');
        }
        continue;
      }

      if (operation && MOVE_OPS.has(operation)) {
        const moved = movedFrom(part);
        if (moved) parentOf.set(moved.id, moved.parentId);
        continue;
      }

      if (operation && PLACEMENT_OPS.has(operation)) {
        const placed = subtaskPlacementFrom(part);
        if (placed) parentOf.set(placed.id, placed.parentId);
        continue;
      }

      if (operation && (WORK_OPS.has(operation) || COMPLETE_OPS.has(operation))) {
        const transition = transitionFrom(part, turn.messageId, operation, statusNow);
        if (transition) {
          transitions.push(transition);
          statusNow.set(transition.entityId, transition.to);
        }
      }
    }

    allCreates.push(...creates);
    allTransitions.push(...transitions);

    const byKind = new Map<string, number>();
    for (const id of readIds) {
      const kind = labels.get(id)?.kind ?? 'entity';
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }

    turnLedgers.push({
      messageId: turn.messageId,
      reads: { byKind, total: readIds.length, ids: readIds },
      creates,
      transitions,
      empty: readIds.length === 0 && creates.length === 0 && transitions.length === 0,
    });
  }

  return {
    turns: turnLedgers,
    creates: allCreates,
    transitions: allTransitions,
    statusNow,
    parentOf,
    labels,
  };
}

/* ── payload readers ──────────────────────────────────────────────────────
   Each is defensive: a call that never settled has `args: undefined`, and a
   malformed one can hold anything. They return null rather than throwing a
   render away. */

type ToolPart = Extract<ProjectedTurnPart, { kind: 'tool' }>;

function body(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as { body?: unknown }).body;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function params(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as { params?: unknown }).params;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The id a create PRODUCED. Prefer the result — that is the real entity — and
 * fall back to nothing: a create whose result has not landed yet has no id to
 * key a tree on, and inventing one would produce a node that never reconciles.
 */
function createdId(part: ToolPart): string | null {
  let found: string | null = null;
  walkPayload(
    part.result,
    {
      onEntityObject: (id) => {
        if (!found) found = id;
      },
    },
    { maxNodes: TALLY_MAX_NODES, maxDepth: TALLY_MAX_DEPTH },
  );
  return found;
}

function createdFrom(part: ToolPart, messageId: EntityId): LedgerCreate | null {
  const id = createdId(part);
  if (!id) return null;
  const b = body(part.args);
  return {
    id,
    kind: b ? str(b.kind) : null,
    title: b ? str(b.title) : null,
    parentId: b ? str(b.parentId) : null,
    messageId,
    seq: part.seq,
    spawned: false,
  };
}

function spawnedFrom(part: ToolPart, messageId: EntityId): LedgerCreate | null {
  const id = createdId(part);
  if (!id) return null;
  return {
    id,
    kind: 'work_session',
    title: null,
    parentId: null,
    messageId,
    seq: part.seq,
    spawned: true,
  };
}

function movedFrom(part: ToolPart): { id: string; parentId: string | null } | null {
  const p = params(part.args);
  const b = body(part.args);
  const id = p ? str(p.id) : null;
  if (!id || !b || !('parentId' in b)) return null;
  // An explicit null parent means "moved to the root" — a real fact, not a
  // missing one, so it is recorded rather than skipped.
  return { id, parentId: str(b.parentId) };
}

function subtaskPlacementFrom(part: ToolPart): { id: string; parentId: string } | null {
  const b = body(part.args);
  if (!b || str(b.intent) !== 'subtask') return null;
  const id = str(b.sourceId);
  const parentId = str(b.targetId);
  return id && parentId ? { id, parentId } : null;
}

function transitionFrom(
  part: ToolPart,
  messageId: EntityId,
  operation: string,
  statusNow: ReadonlyMap<string, string>,
): LedgerTransition | null {
  const p = params(part.args);
  const id = p ? str(p.id) : null;
  if (!id) return null;
  // `complete` names no status in its body — the operation IS the status, and
  // it is the only operation permitted to write `done`.
  const to = COMPLETE_OPS.has(operation) ? 'done' : str(body(part.args)?.status);
  if (!to) return null;
  return { entityId: id, from: statusNow.get(id) ?? null, to, messageId, seq: part.seq };
}

/**
 * Ruling 2 — count distinct entities appearing as FULL SUMMARIES in a RESULT.
 *
 * Results only, deliberately. An id in the ARGS is the subject a call was
 * handed, not something the turn learned; counting it would inflate "Read 3
 * tasks" with tasks the agent already knew about and merely named.
 */
function tallyReads(part: ToolPart, seen: Set<string>, out: string[]): void {
  walkPayload(
    part.result,
    {
      onEntityObject: (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        out.push(id);
      },
    },
    { maxNodes: TALLY_MAX_NODES, maxDepth: TALLY_MAX_DEPTH },
  );
}

/**
 * Harvest labels and statuses from any payload, read or write.
 *
 * This is what gives a transition its `from` side: an entity read earlier in the
 * thread carries `state.status`, so by the time a later turn writes it, the
 * prior value is already known. It is also why a create whose own args carried
 * no kind can still render with one later.
 */
function absorbSummaries(
  part: ToolPart,
  learn: (id: string, kind?: string, title?: string) => void,
  statusNow: Map<string, string>,
): void {
  const visit = (payload: unknown): void => {
    walkPayload(
      payload,
      {
        onEntityObject: (id, fields, record) => {
          learn(id, fields.kind, fields.title);
          const state = record.state;
          if (typeof state === 'object' && state !== null) {
            const status = (state as { status?: unknown }).status;
            if (typeof status === 'string' && status.length > 0) statusNow.set(id, status);
          }
        },
      },
      { maxNodes: TALLY_MAX_NODES, maxDepth: TALLY_MAX_DEPTH },
    );
  };
  visit(part.args);
  visit(part.result);
}

/**
 * Streaming-safe entry point.
 *
 * `mergeChatTurnFrame` replaces ONLY the turn a frame touches, so every settled
 * turn keeps referential identity. The ledger is order-dependent (a transition's
 * `from` depends on every earlier turn), so it cannot be cached per-turn the way
 * `graph-seeds.ts` caches extraction — but the whole fold is plain array work
 * over a few hundred small records, and it is memoised on the turns array
 * identity so a re-render that changed nothing re-folds nothing.
 */
let lastTurns: readonly ChatTurn[] | null = null;
let lastLedger: ChatLedger | null = null;

export function foldChatLedger(turns: readonly ChatTurn[]): ChatLedger {
  if (lastTurns === turns && lastLedger) return lastLedger;
  const ledger = buildChatLedger(turns);
  lastTurns = turns;
  lastLedger = ledger;
  return ledger;
}

/**
 * The counted read sentence's DATA — "3 tasks, 4 docs, 5 memories" as ordered
 * pairs, largest bucket first, `entity` last however big it is (an unknown-kind
 * bucket leading the sentence reads as the headline, which it never is).
 *
 * Returns the pairs, not a string: pluralisation and humanisation of custom
 * `c:*` kinds belong to the render layer, and a model that returned English
 * could not be localised or tested for counts independently of wording.
 */
export function readCountPairs(
  reads: LedgerReads,
): readonly { kind: string; count: number }[] {
  return [...reads.byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => {
      if ((a.kind === 'entity') !== (b.kind === 'entity')) return a.kind === 'entity' ? 1 : -1;
      return b.count - a.count || a.kind.localeCompare(b.kind);
    });
}
