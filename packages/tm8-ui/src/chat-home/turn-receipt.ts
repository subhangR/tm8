/**
 * THE TURN RECEIPT — one compact summary per run of what the chat did to the
 * graph: one row per ENTITY, not per call (proposal 01a14a8d, direction B,
 * approved by Subhang). Pure.
 *
 *   + ☐ New chat: stop the loading page after Send   [⌁ Worker · Opus 5.5 ● live]
 *   → ☐ Proposal: redesign chat widgets   2 criteria ticked · PR linked  ● in review
 *       + ¶ Chat outcome widgets: audit       doc · 1,840 words
 *   ✕ Moving “Provider interface” to done failed
 *       2 acceptance criteria are still unticked
 *
 * FOLDING, in this order:
 *   1. A create, its status moves and its edits in one run are ONE row; the
 *      leading mark says what happened (made > moved > edited > linked) and
 *      the trailing slot shows the entity's state NOW, which the view reads.
 *   2. A spawned session is a pill on its task's row. With no task row in the
 *      run it is its own row, `Worker on ◆ Task`.
 *   3. A row nests under another row of the receipt when it is that row's
 *      child, is attached to it, or is linked from it (`produces`), which is
 *      how a drawn edge finally shows. An edge with no row at either end is a
 *      `linked` row of its own.
 *   4. A write still running is a PENDING row, keyed by its call's seq so the
 *      real row replaces it in place. A refused write is a FAILED row with
 *      the server's reason, unless a later call on the same target succeeded:
 *      then it is no row at all, only counted as retried.
 *
 * WRITES LEAVE THE STEP LIST (D15 reversed, same ruling): `seqs` names every
 * call a row stands for, and the step list skips exactly those. A write the
 * receipt does not draw (a message post, a delete) stays a step line.
 *
 * NO NEW SOURCE OF TRUTH: rows are the ledger fold's records (`ledger.ts`)
 * and the step views' states (`turn-step-lines.ts`), regrouped.
 */
import { isLedgerWrite, type LedgerCreate, type LedgerEdge, type TurnLedger } from './ledger';
import type { StepView } from './turn-step-lines';
import type { ToolStepPart } from './turn-steps';
import { bareToolName } from './write-classifier';

export type ReceiptMark = 'made' | 'moved' | 'edited' | 'linked' | 'pending' | 'failed';

export interface ReceiptRow {
  /** The seq of the first call the row stands for: a pending create and the
   *  row it settles into share it, so the row is replaced in place. */
  key: string;
  mark: ReceiptMark;
  /** Null for a pending or failed write, which made nothing to open. */
  entityId: string | null;
  /** The fold's kind/title; the view resolves late ones. */
  kind: string | null;
  title: string | null;
  /** The entity's create in this run, when it was made here. */
  create: LedgerCreate | null;
  /** The net status move in this run: the first `from`, the last `to`. */
  move: { from: string | null; to: string } | null;
  /** What the run's edits changed, in words, deduped. */
  edits: readonly string[];
  /** Sessions spawned onto this row's entity in this run. */
  sessions: readonly LedgerCreate[];
  /** The row IS a spawned session whose task has no row here. */
  session: LedgerCreate | null;
  /** A link this run drew from the row: to `otherId`, or — null — to the
   *  row it is nested under, where the indentation already says so. */
  link: { type: string; otherId: string | null } | null;
  /** A pending or failed write's words (`Creating task “X”`) and reason. */
  text: string | null;
  reason: string | null;
  children: readonly ReceiptRow[];
}

export interface TurnReceipt {
  rows: readonly ReceiptRow[];
  /** Every call a row stands for, and every retried write failure — the
   *  steps the step list leaves out. */
  seqs: ReadonlySet<number>;
  /** Failed writes a later call on the same target fixed (D13): no row,
   *  only `· N retried` in the step header. */
  retried: ReadonlySet<number>;
}

const MARK_RANK: Record<ReceiptMark, number> = {
  made: 5,
  moved: 4,
  edited: 3,
  linked: 2,
  failed: 1,
  pending: 0,
};

/** Edge types that put one end UNDER the other: `[parentEnd, childEnd]`. */
const NESTING: Readonly<Record<string, 'src' | 'dst'>> = {
  produces: 'src',
  attached_to: 'dst',
  about: 'dst',
};

const MAX_DEPTH = 3;

interface Draft {
  key: string;
  /** The earliest call the row stands for — its place in the receipt. */
  firstSeq: number;
  mark: ReceiptMark;
  entityId: string | null;
  kind: string | null;
  title: string | null;
  create: LedgerCreate | null;
  move: { from: string | null; to: string } | null;
  edits: string[];
  sessions: LedgerCreate[];
  session: LedgerCreate | null;
  link: { type: string; otherId: string | null } | null;
  text: string | null;
  reason: string | null;
  parentKey: string | null;
}

/**
 * The receipt of ONE run: `steps` are the run's calls, `views` the turn's
 * step views, `turn` the turn's slice of the thread fold. `skipEdits` names
 * calls a host already narrated in its own note (Craft's patch line), whose
 * generic edit must not be said twice.
 */
export function buildTurnReceipt({
  steps,
  views,
  turn,
  labels,
  skipEdits,
}: {
  steps: readonly ToolStepPart[];
  views: ReadonlyMap<number, StepView>;
  turn: TurnLedger | undefined;
  labels?: ReadonlyMap<string, { kind?: string; title?: string }> | undefined;
  skipEdits?: ReadonlySet<number> | undefined;
}): TurnReceipt {
  const inRun = new Set(steps.map((part) => part.seq));
  const seqs = new Set<number>();
  const byEntity = new Map<string, Draft>();
  const loose: Draft[] = [];
  const retried = new Set<number>();

  const draft = (entityId: string, seq: number): Draft => {
    let row = byEntity.get(entityId);
    if (!row) {
      const known = labels?.get(entityId);
      row = {
        key: `r${seq}`,
        firstSeq: seq,
        mark: 'linked',
        entityId,
        kind: known?.kind ?? null,
        title: known?.title ?? null,
        create: null,
        move: null,
        edits: [],
        sessions: [],
        session: null,
        link: null,
        text: null,
        reason: null,
        parentKey: null,
      };
      byEntity.set(entityId, row);
    }
    row.firstSeq = Math.min(row.firstSeq, seq);
    seqs.add(seq);
    return row;
  };
  const mark = (row: Draft, next: ReceiptMark): void => {
    if (MARK_RANK[next] > MARK_RANK[row.mark]) row.mark = next;
  };
  const addEdit = (row: Draft, what: readonly string[]): void => {
    for (const word of what) if (!row.edits.includes(word)) row.edits.push(word);
    mark(row, 'edited');
  };

  const own = <T extends { seq: number }>(list: readonly T[] | undefined): T[] =>
    (list ?? []).filter((entry) => inRun.has(entry.seq));

  const creates = own(turn?.creates);
  for (const create of creates) {
    if (create.spawned) continue;
    const row = draft(create.id, create.seq);
    row.create = create;
    row.kind = create.kind ?? row.kind;
    row.title = create.title ?? row.title;
    mark(row, 'made');
  }
  for (const transition of own(turn?.transitions)) {
    const row = draft(transition.entityId, transition.seq);
    row.move = { from: row.move ? row.move.from : transition.from, to: transition.to };
    mark(row, 'moved');
  }
  for (const edit of own(turn?.edits)) {
    if (skipEdits?.has(edit.seq)) continue;
    addEdit(draft(edit.entityId, edit.seq), edit.what);
  }
  /* A settled `doc_update` is an edit the fold does not itemise (it carries
     no operation): the doc's body changed. */
  for (const part of steps) {
    if (bareToolName(part.name) !== 'doc_update' || views.get(part.seq)?.state !== 'completed') continue;
    const args = record(part.args);
    const docId = str(args?.docId);
    if (!docId || skipEdits?.has(part.seq)) continue;
    const row = draft(docId, part.seq);
    row.kind = row.kind ?? 'doc';
    row.title = str(args?.title) ?? row.title;
    addEdit(row, str(args?.title) ? ['title', 'body'] : ['body']);
  }

  /* Sessions: a pill on their task's row, else a row of their own. */
  for (const create of creates) {
    if (!create.spawned) continue;
    const host = create.subjectId ? byEntity.get(create.subjectId) : undefined;
    if (host) {
      host.sessions.push(create);
      seqs.add(create.seq);
      continue;
    }
    const row = draft(create.id, create.seq);
    row.kind = 'work_session';
    row.session = create;
    mark(row, 'made');
  }

  /* Links: nest where both ends have a row, else a linked row. */
  for (const edge of own(turn?.edges)) placeEdge(edge, byEntity, draft, mark);

  /* Hierarchy: a child or an attachment of a row nests under it. */
  for (const row of byEntity.values()) {
    if (row.parentKey || !row.create) continue;
    const parent =
      (row.create.parentId ? byEntity.get(row.create.parentId) : undefined) ??
      (row.create.subjectId ? byEntity.get(row.create.subjectId) : undefined);
    if (parent && parent !== row) row.parentKey = parent.key;
  }

  /* Pending and failed writes, from the step views. */
  for (const part of steps) {
    if (!isLedgerWrite(part.name, part.args)) continue;
    const view = views.get(part.seq);
    if (!view) continue;
    if (view.state === 'running') {
      seqs.add(part.seq);
      loose.push(stateRow(part.seq, 'pending', view, null));
    } else if (view.state === 'error') {
      seqs.add(part.seq);
      if (view.retried) retried.add(part.seq);
      else loose.push(stateRow(part.seq, 'failed', view, targetOf(part)));
    }
  }

  const all = [...byEntity.values(), ...loose];
  const rowsByKey = new Map(all.map((row) => [row.key, row]));
  breakCycles(all, rowsByKey);
  const childrenOf = new Map<string, Draft[]>();
  const top: Draft[] = [];
  for (const row of all) {
    const parent = row.parentKey ? rowsByKey.get(row.parentKey) : undefined;
    if (parent) {
      const list = childrenOf.get(parent.key) ?? [];
      list.push(row);
      childrenOf.set(parent.key, list);
    } else {
      top.push(row);
    }
  }
  /* A parent sits where its subtree began: a task the turn moved last still
     heads the doc it attached first. */
  const startOf = new Map<string, number>();
  const start = (row: Draft): number => {
    const known = startOf.get(row.key);
    if (known !== undefined) return known;
    startOf.set(row.key, row.firstSeq);
    const value = Math.min(row.firstSeq, ...(childrenOf.get(row.key) ?? []).map(start));
    startOf.set(row.key, value);
    return value;
  };
  const order = (a: Draft, b: Draft): number => start(a) - start(b) || a.firstSeq - b.firstSeq;
  const finish = (row: Draft): ReceiptRow => {
    const kids = (childrenOf.get(row.key) ?? []).sort(order);
    const { firstSeq: _firstSeq, parentKey: _parentKey, ...rest } = row;
    return { ...rest, children: kids.map(finish) };
  };
  return { rows: top.sort(order).map(finish), seqs, retried };
}

function placeEdge(
  edge: LedgerEdge,
  byEntity: Map<string, Draft>,
  draft: (entityId: string, seq: number) => Draft,
  mark: (row: Draft, next: ReceiptMark) => void,
): void {
  const parentEnd = NESTING[edge.type];
  const [parentId, childId] = parentEnd === 'dst' ? [edge.dstId, edge.srcId] : [edge.srcId, edge.dstId];
  const parent = byEntity.get(parentId);
  const child = byEntity.get(childId);
  if (parentEnd && parent && child) {
    // Both ends are here: the link IS the indentation.
    if (!child.parentKey) {
      child.parentKey = parent.key;
      child.link = child.link ?? { type: edge.type, otherId: null };
    }
    draft(childId, edge.seq);
    return;
  }
  if (parentEnd && parent) {
    // Linked to something made elsewhere: it shows under the row it joins.
    const row = draft(childId, edge.seq);
    row.link = { type: edge.type, otherId: null };
    row.parentKey = parent.key;
    mark(row, 'linked');
    return;
  }
  // A link that nests nothing (`depends_on`, or no row at the parent end)
  // is a fact on its source's row — a row of its own when it had none.
  const row = draft(edge.srcId, edge.seq);
  if (!row.link) row.link = { type: edge.type, otherId: edge.dstId };
  mark(row, 'linked');
}

/** A nest that loops (A produces B, B attached to A's child…) is cut where it
 *  closes, so every row still renders exactly once. */
function breakCycles(rows: readonly Draft[], byKey: ReadonlyMap<string, Draft>): void {
  for (const row of rows) {
    const seen = new Set<string>([row.key]);
    let depth = 0;
    let at = row.parentKey ? byKey.get(row.parentKey) : undefined;
    while (at) {
      depth += 1;
      if (seen.has(at.key) || depth > MAX_DEPTH) {
        row.parentKey = null;
        break;
      }
      seen.add(at.key);
      at = at.parentKey ? byKey.get(at.parentKey) : undefined;
    }
  }
}

function stateRow(seq: number, state: 'pending' | 'failed', view: StepView, entityId: string | null): Draft {
  return {
    key: `r${seq}`,
    firstSeq: seq,
    mark: state,
    entityId,
    kind: kindOfCategory(view.words.category),
    title: null,
    create: null,
    move: null,
    edits: [],
    sessions: [],
    session: null,
    link: null,
    text: state === 'pending' ? view.words.active : `${view.words.active} failed`,
    reason: state === 'failed' ? view.reason : null,
    parentKey: null,
  };
}

/** `create:task` names the kind a pending create will make. */
function kindOfCategory(category: string): string | null {
  if (category.startsWith('create:')) return category.slice('create:'.length);
  if (category === 'spawn' || category === 'dispatch') return 'work_session';
  if (category === 'status' || category === 'tick') return 'task';
  return null;
}

/** The existing entity a refused write was aimed at, so its row can open it. */
function targetOf(part: ToolStepPart): string | null {
  const args = record(part.args);
  return str(record(args?.params)?.id) ?? str(record(args?.params)?.formId) ?? str(args?.docId);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Rows in display order, children after their parent. */
export function flattenReceipt(rows: readonly ReceiptRow[], depth = 0): { row: ReceiptRow; depth: number }[] {
  return rows.flatMap((row) => [{ row, depth }, ...flattenReceipt(row.children, depth + 1)]);
}
