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
import { durableOutputToolName } from './explanation-tools';
import { isEntityIdLike, walkPayload } from './payload-walk';
import { projectTurnParts, type ProjectedTurnPart } from './turn-model';
import type { ChatTurn } from './types';
import { bareToolName, isWriteCall, operationOf } from './write-classifier';

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
  /** From the create call's own args — exact, and present from first paint —
   *  falling back to the result's summary when the args carried none. */
  kind: string | null;
  title: string | null;
  /** Null when created at the root, or when `parentId` was never set. The
   *  RESULT's `parentId` wins over the args: it is where the entity landed. */
  parentId: string | null;
  /**
   * The entity this creation is ABOUT, when it is not a hierarchy parent: the
   * task a spawned session was handed (`taskIds[0]`, a dispatch's `subjectId`),
   * or what a doc/form was attached to. Null when the call named none.
   */
  subjectId: string | null;
  /** The turn it happened in — how the transcript groups it. */
  messageId: EntityId;
  seq: number;
  /** A spawned work session, rather than an `entities.create`. Both are
   *  creations this conversation caused; only the verb differed. */
  spawned: boolean;
  /** A spawned session's model id, from the spawn's own result. */
  model?: string;
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

/**
 * One NON-status edit this conversation made (advisor D11): a patch, a tick of
 * acceptance criteria, a header, a PR/commit link. Status writes are
 * transitions, not edits, and are never counted twice.
 */
export interface LedgerEdit {
  entityId: string;
  /** What moved, in words (`title`, `acceptance criteria`), deduped and in
   *  first-seen order. Empty when the call did not say. */
  what: readonly string[];
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
  /** Non-status edits, in call order. The transcript draws ONE quiet line for
   *  them all, at the first one's position. */
  edits: readonly LedgerEdit[];
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

/**
 * EVERY BIRTH VERB THE CHAT CAN CALL — not just `entities.create`.
 *
 * Measured over this node's real chat transcripts (2026-09-26): of ~45 calls
 * that brought an entity into being, `entities.create` was 8. The rest came
 * through verbs the fold did not know, so they were never highlighted and
 * never reached the sticky panel's tree: `doc_create` (17), `memory_write`
 * (2), a dispatch that spawned its dispatcher, and the kinds whose birth verb
 * is not `entities.create` at all (`forms.create`, and `containers.create`
 * — `entities.create` refuses the container kind). The direct tools carry no
 * `operation`, so they are matched by their bare tool name.
 */
const CREATE_OPS = new Set([
  'entities.create',
  'forms.create',
  'containers.create',
  'containers.fork',
  'artifacts.create',
]);
/** Direct tools that create, beside the two `durableOutputToolName` owns
 *  (`doc_create`, `artifact_create` — reused, not copied). */
const CREATE_TOOLS = new Set(['memory_write', 'form_create']);
const TOOL_KIND: Readonly<Record<string, string>> = {
  doc_create: 'doc',
  artifact_create: 'artifact',
  memory_write: 'memory',
  form_create: 'form',
};

function isCreateTool(name: string): boolean {
  const durable = durableOutputToolName(name);
  return durable === 'doc_create' || durable === 'artifact_create' || CREATE_TOOLS.has(bareToolName(name));
}
const SPAWN_OPS = new Set(['execution.spawn']);
/** A dispatch creates a session only when it had to spawn the dispatcher —
 *  `dispatcherSpawned` in its result says which. */
const DISPATCH_OPS = new Set(['execution.dispatch']);
const MOVE_OPS = new Set(['entities.move']);
const PLACEMENT_OPS = new Set(['placements.apply']);
/** `complete` names no status in its body — the operation IS the status. */
const COMPLETE_OPS = new Set(['entities.commands.complete']);
const WORK_OPS = new Set(['entities.commands.work']);
/** Writes that change an entity without moving its status, and the words for
 *  what they change when the call does not itemise it. */
const EDIT_OPS: Readonly<Record<string, string | null>> = {
  'entities.patch': null,
  'entities.commands.tick': 'acceptance criteria',
  'entities.header.set': 'header',
  'entities.header.clear': 'header',
  'entities.commands.linkPr': 'pull request',
  'entities.commands.linkCommit': 'commit',
};
/** A form's open/closed/cancelled lifecycle, under its own verb and id key. */
const FORM_TRANSITION_OPS = new Set(['forms.transition']);

const MCP_ERROR_SCHEMA = 'tm8.mcp.error.v1';
const RECEIPT_SCHEMA = 'tm8.receipt.v1';

/* The closed write-op set lives in `write-classifier.ts` now (one copy — two
   lists that agree today drift tomorrow). `isWriteCall` answers operations
   against it first, so a write the verb regex cannot see (`entities.react`,
   `placements.apply`, …) can no longer fold as a read and get its payload
   COUNTED — "Read 3 tasks" never includes a task the turn only reacted to. */

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

  const learn = (id: string, kind?: string, title?: string, exact = false): void => {
    const existing = labels.get(id);
    if (!existing) {
      labels.set(id, { ...(kind ? { kind } : {}), ...(title ? { title } : {}) });
      return;
    }
    // Richer fields win when they finally arrive; nothing already known is
    // lost — except to an EXACT source (a create's own args), which outranks
    // whatever a clamped echo taught us first.
    if (kind && (exact || !existing.kind)) existing.kind = kind;
    if (title && (exact || !existing.title)) existing.title = title;
  };

  /* One create per entity across the WHOLE thread. An idempotent replay (a
     retried call with the same clientMutationId) answers with the entity it
     already made, and a second "Created" card for it would claim two births. */
  const createdIds = new Set<string>();
  const recordCreate = (created: LedgerCreate, into: LedgerCreate[]): void => {
    if (createdIds.has(created.id)) return;
    createdIds.add(created.id);
    into.push(created);
    parentOf.set(created.id, created.parentId);
    // The ARGS title is exact; a receipt clamps its echo at 80 characters,
    // and every surface reading `labels` should name it the way the card does.
    learn(created.id, created.kind ?? undefined, created.title ?? undefined, true);
  };

  for (const turn of turns) {
    const readIds: string[] = [];
    const readSeen = new Set<string>();
    const creates: LedgerCreate[] = [];
    const transitions: LedgerTransition[] = [];
    const edits: LedgerEdit[] = [];

    for (const part of projectTurnParts(turn.parts)) {
      if (part.kind !== 'tool') continue;
      const operation = operationOf(part.args);
      const tool = bareToolName(part.name);
      const births = (operation !== null && CREATE_OPS.has(operation)) || isCreateTool(part.name);
      const statusOp = operation !== null && isStatusOp(operation) ? operation : null;

      /* THE FROM SIDE IS READ BEFORE THIS CALL'S OWN PAYLOAD IS ABSORBED. A
         full command result carries the entity's NEW state, so absorbing it
         first made every transition read `working → working`. */
      const subject = statusOp ? statusSubjectOf(part, statusOp) : null;
      const prior = subject ? (statusNow.get(subject) ?? null) : null;

      /* Every payload, read or write, is a chance to learn a label and a
         status — that is how a transition later gets its `from` side. */
      absorbSummaries(part, learn, statusNow);

      /* A verb this fold acts on is a write whatever the shared classifier's
         verb regex makes of it — `containers.fork`, `forms.transition`. */
      if (!births && statusOp === null && !isWriteCall(part.name, part.args)) {
        tallyReads(part, readSeen, readIds);
        continue;
      }

      /* THE OUTCOME GUARD (coordinator ruling on the L3/L4 seam). A write the
         server has not answered, or refused, changed nothing: it draws no
         card and no transition, and it moves no `statusNow` / `parentOf`.
         The step list says it is running, or shows it failed. Before this, a
         refused `complete` (unticked criteria, a version conflict) still
         rendered `→ done` and left the sticky panel calling the task done. */
      if (!settledOk(part)) continue;

      if (births) {
        const created = createdFrom(part, turn.messageId, operation, tool);
        if (created) recordCreate(created, creates);
        continue;
      }

      if (operation && SPAWN_OPS.has(operation)) {
        const spawned = spawnedFrom(part, turn.messageId);
        if (spawned) recordCreate(spawned, creates);
        continue;
      }

      if (operation && DISPATCH_OPS.has(operation)) {
        const spawned = dispatcherSpawnedFrom(part, turn.messageId);
        if (spawned) recordCreate(spawned, creates);
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

      if (operation && operation in EDIT_OPS) {
        const edit = editFrom(part, turn.messageId, operation);
        if (edit) edits.push(edit);
        continue;
      }

      if (statusOp && subject) {
        const outcome = statusOutcome(part, statusOp, prior);
        if (outcome) {
          // The verb names the kind: `commands.work/complete` are task-only,
          // `forms.transition` form-only — so an unread subject still reads
          // as "Task", never as a bare id.
          learn(subject, FORM_TRANSITION_OPS.has(statusOp) ? 'form' : 'task');
          statusNow.set(subject, outcome.to);
          // A write that left the status where it was caused no transition —
          // `working → working` is a no-op wearing an arrow.
          if (outcome.moved) {
            transitions.push({
              entityId: subject,
              from: outcome.from,
              to: outcome.to,
              messageId: turn.messageId,
              seq: part.seq,
            });
          }
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
      edits,
      empty:
        readIds.length === 0 && creates.length === 0 && transitions.length === 0 && edits.length === 0,
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The top-level record a tool RESULT carries, whatever it arrived wrapped in.
 *
 * Claude records an MCP result as its text block — a JSON STRING; another
 * runtime can hand over the MCP envelope itself (`structuredContent`, or a
 * `content` array of text blocks). The walk in `payload-walk.ts` looks through
 * all of these for entity objects; the questions asked here are about the
 * envelope's OWN fields (`schemaVersion`, `formId`, `dispatcherSpawned`), so
 * they need the envelope, not a walk. Null when there is none to read.
 */
function envelopeOf(result: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return envelopeOf(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(result)) {
    const text = result.find((block) => record(block)?.type === 'text');
    return text ? envelopeOf(record(text)?.text, depth + 1) : null;
  }
  const value = record(result);
  if (!value) return null;
  const structured = record(value.structuredContent);
  if (structured) return structured;
  if (Array.isArray(value.content) && value.schemaVersion === undefined) {
    return envelopeOf(value.content, depth + 1) ?? value;
  }
  return value;
}

/**
 * Did the server ACCEPT this write? Only a call that settled `completed` with
 * a result that is neither flagged an error nor an MCP error envelope. A
 * running call has not been answered; an errored one changed nothing. Every
 * real transcript on this node (341 settled calls, 2026-09-26) ends in exactly
 * one of `completed` + result or `error` + error result, so this admits every
 * accepted write and nothing else.
 */
function settledOk(part: ToolPart): boolean {
  if (part.state !== 'completed' || part.resultIsError === true) return false;
  if (part.result === undefined) return false;
  return envelopeOf(part.result)?.schemaVersion !== MCP_ERROR_SCHEMA;
}

/** A server-built `tm8.receipt.v1` (the MCP default for entity writes), bare
 *  or under the MCP result's `data`. */
function receiptOf(envelope: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!envelope) return null;
  if (envelope.schemaVersion === RECEIPT_SCHEMA) return envelope;
  const data = record(envelope.data);
  return data?.schemaVersion === RECEIPT_SCHEMA ? data : null;
}

/**
 * The entity a create PRODUCED — the first entity object in the result, which
 * is the entity itself in every shape the server returns (a full command
 * result's `entity`, a receipt's own top level, a spawn's session). Prefer
 * the result; fall back to nothing: a create with no id in its result has no
 * id to key a tree on, and inventing one would produce a node that never
 * reconciles.
 */
function producedEntity(part: ToolPart): {
  id: string;
  kind: string | null;
  title: string | null;
  parentId: string | null | undefined;
  state: Record<string, unknown> | null;
} | null {
  let found: ReturnType<typeof producedEntity> = null;
  walkPayload(
    part.result,
    {
      onEntityObject: (id, fields, rec) => {
        if (found) return;
        found = {
          id,
          kind: fields.kind ?? null,
          title: fields.title ?? null,
          // `undefined` = the result did not say; `null` = it said "root".
          parentId: 'parentId' in rec ? str(rec.parentId) : undefined,
          state: record(rec.state),
        };
      },
    },
    { maxNodes: TALLY_MAX_NODES, maxDepth: TALLY_MAX_DEPTH },
  );
  return found;
}

function firstId(value: unknown): string | null {
  if (typeof value === 'string') return isEntityIdLike(value) ? value : null;
  if (Array.isArray(value)) return value.map(firstId).find((id) => id !== null) ?? null;
  const rec = record(value);
  return rec ? (firstId(rec.entityId) ?? firstId(rec.id)) : null;
}

function createdFrom(
  part: ToolPart,
  messageId: EntityId,
  operation: string | null,
  tool: string,
): LedgerCreate | null {
  const input = operation ? body(part.args) : record(part.args);
  const produced = producedEntity(part);
  /* `form_create` answers `{formId, …}` with no entity object to walk. */
  const id = produced?.id ?? (tool === 'form_create' ? firstId(envelopeOf(part.result)?.formId) : null);
  if (!id) return null;
  return {
    id,
    kind: str(input?.kind) ?? produced?.kind ?? TOOL_KIND[tool] ?? null,
    /* The ARGS title first: it is what the agent wrote, whole. A receipt's
       echo is clamped at 80 characters, and real task titles run past it. */
    title: str(input?.title) ?? str(input?.name) ?? produced?.title ?? null,
    parentId: produced?.parentId !== undefined ? produced.parentId : str(input?.parentId),
    subjectId: firstId(input?.attachTo),
    messageId,
    seq: part.seq,
    spawned: false,
  };
}

function spawnedFrom(part: ToolPart, messageId: EntityId): LedgerCreate | null {
  const produced = producedEntity(part);
  if (!produced) return null;
  const model = str(produced.state?.model);
  return {
    id: produced.id,
    kind: 'work_session',
    title: produced.title,
    parentId: null,
    subjectId: firstId(body(part.args)?.taskIds),
    messageId,
    seq: part.seq,
    spawned: true,
    ...(model ? { model } : {}),
  };
}

/**
 * A dispatch routes work to the resident dispatcher, and SPAWNS that
 * dispatcher only when none was running — its result says which
 * (`dispatcherSpawned`). Only the spawning dispatch created anything.
 */
function dispatcherSpawnedFrom(part: ToolPart, messageId: EntityId): LedgerCreate | null {
  const envelope = envelopeOf(part.result);
  const data = record(envelope?.data) ?? envelope;
  if (data?.dispatcherSpawned !== true) return null;
  const id = firstId(data.dispatcherSessionId);
  if (!id) return null;
  return {
    id,
    kind: 'work_session',
    title: null,
    parentId: null,
    subjectId: firstId(body(part.args)?.subjectId),
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

/** `acceptanceCriteria` → `acceptance criteria`. */
function words(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

/**
 * An accepted edit, or null when it provably changed nothing. A receipt's
 * `changed` list is the server's own diff: `[]` is a verified no-op (an
 * "Edited" line for it would be a lie), and its field names are the words.
 * Without one, a patch says what it SENT — its title and content keys.
 */
function editFrom(part: ToolPart, messageId: EntityId, operation: string): LedgerEdit | null {
  const id = str(params(part.args)?.id);
  if (!id) return null;
  const receipt = receiptOf(envelopeOf(part.result));
  const changed = Array.isArray(receipt?.changed)
    ? (receipt.changed as unknown[]).filter((f): f is string => typeof f === 'string')
    : null;
  if (changed && changed.length === 0) return null;
  let fields: string[];
  if (changed) {
    fields = changed
      .filter((f) => !f.startsWith('state.') && !f.startsWith('edge:'))
      .map((f) => words(f.startsWith('content.') ? f.slice('content.'.length) : f));
  } else if (EDIT_OPS[operation]) {
    fields = [EDIT_OPS[operation]!];
  } else {
    const b = body(part.args);
    const content = record(b?.content);
    fields = [
      ...(str(b?.title) ? ['title'] : []),
      ...(content ? Object.keys(content).filter((k) => k !== 'kind').map(words) : []),
    ];
  }
  return { entityId: id, what: [...new Set(fields)], messageId, seq: part.seq };
}

function isStatusOp(operation: string): boolean {
  return WORK_OPS.has(operation) || COMPLETE_OPS.has(operation) || FORM_TRANSITION_OPS.has(operation);
}

/** The entity a status write names. Forms key it `formId`. */
function statusSubjectOf(part: ToolPart, operation: string): string | null {
  const p = params(part.args);
  if (!p) return null;
  return FORM_TRANSITION_OPS.has(operation) ? str(p.formId) : str(p.id);
}

/**
 * What an ACCEPTED status write did.
 *
 * The receipt, when there is one, is the server's own before/after read inside
 * the write's transaction — `status.from` is printed only when the status
 * MOVED, and a known write whose `changed` list omits `state.status` left it
 * where it was. Without a receipt the from-side is the status this thread last
 * READ (`prior`), or null — a one-sided arrow, never a guess.
 */
function statusOutcome(
  part: ToolPart,
  operation: string,
  prior: string | null,
): { from: string | null; to: string; moved: boolean } | null {
  const receipt = receiptOf(envelopeOf(part.result));
  const status = record(receipt?.status);
  // `complete` names no status in its body — the operation IS the status, and
  // it is the only operation permitted to write `done`.
  const asked = COMPLETE_OPS.has(operation)
    ? 'done'
    : str(body(part.args)?.[FORM_TRANSITION_OPS.has(operation) ? 'to' : 'status']);
  const to = str(status?.to) ?? asked;
  if (!to) return null;
  const receiptFrom = str(status?.from);
  if (receiptFrom) return { from: receiptFrom, to, moved: receiptFrom !== to };
  const changed = Array.isArray(receipt?.changed) ? (receipt.changed as unknown[]) : null;
  if (changed && !changed.includes('state.status')) return { from: to, to, moved: false };
  return { from: prior, to, moved: prior !== to };
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
 * The status an entity-shaped record CARRIES, in every shape the server has
 * shipped one — which is four, and the fold used to read one:
 *
 *   - `state.status` — today's summary (tasks, sessions, forms);
 *   - `state.workStatus` — the task summary before the contract renamed it,
 *     still inside every durable transcript written then (all of this node's
 *     August chats); a transcript outlives the server that produced it;
 *   - a flat `status` string beside `kind` — `entities.context` v2's root;
 *   - a receipt's `status: {from?, to}` — the state AFTER the write.
 */
function statusOfSummary(rec: Record<string, unknown>): string | null {
  const state = record(rec.state);
  const fromState = str(state?.status) ?? str(state?.workStatus);
  if (fromState) return fromState;
  if (typeof rec.kind === 'string' && typeof rec.status === 'string') return str(rec.status);
  if (rec.schemaVersion === RECEIPT_SCHEMA) return str(record(rec.status)?.to);
  return null;
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
        onEntityObject: (id, fields, rec) => {
          learn(id, fields.kind, fields.title);
          const status = statusOfSummary(rec);
          if (status) statusNow.set(id, status);
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
 * The kind vocabulary, humanised and pluralised for a rendered sentence. Core
 * kinds get their English; a custom `c:*` kind sheds its prefix rather than
 * shipping `Read 3 c:invoices` (design §4.1). ONE copy — the transcript lines
 * and the ledger tree both speak through it.
 */
export function kindWord(kind: string, count: number): string {
  const base = kind.startsWith('c:') ? kind.slice(2) : kind;
  const word =
    base === 'work_session' ? 'session' : base === 'entity' ? 'entity' : base.replace(/_/g, ' ');
  if (count === 1) return word;
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  if (word.endsWith('s')) return word;
  return `${word}s`;
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
