/**
 * Server-built mutation receipts — `tm8.receipt.v1`, PHASE 2 (spec doc
 * 01a0d044 §4.1, §4.2, §8 item 2).
 *
 * A caller opts in per request with `?return=receipt`. The default response is
 * unchanged, and so is every caller that does not ask. With the opt-in, the
 * write runs exactly as before, but the handler answers with a compact receipt
 * instead of `CommandResult` — and so SKIPS the post-write `buildDetail` /
 * `buildUniversalDetail` (hierarchy, every connection with both endpoints'
 * summaries, content, capabilities) and the patch-summary reloads, which is
 * where the 15–80k chars per call came from.
 *
 * WHAT ONLY THE SERVER CAN SAY. Phase 1 (the CLI's render-time projection)
 * must omit `version.from`, `status.from` and `changed`, because the result it
 * projects carries no before-state (D1.2). Here the handler reads a small
 * snapshot of the row INSIDE the write's transaction, before and after the
 * RPC, and diffs them:
 *
 *  - `version.from` / `status.from` are the snapshot's, not argv's;
 *    `status.from` is printed only when it differs from `to`.
 *  - `changed` names the stored fields and edge types whose value moved.
 *    `changed: []` means the RPC REWROTE the row (its tuple xmin moved) and
 *    every stored value came out equal — a SERVER-VERIFIED no-op, reported
 *    with a `no_change` warning.
 *  - When the RPC wrote NOTHING (the row's xmin, its version and its edges are
 *    all untouched — what an idempotent `clientMutationId` replay does), the
 *    diff proves nothing about this call, so `from` and `changed` are omitted
 *    and a `no_write_observed` warning says why. A replay is never printed as
 *    a no-op.
 *
 * WHAT IT COVERS. The snapshot knows the `task` and `doc` detail tables — the
 * kinds the receipt commands write. For any other kind the handler ignores the
 * opt-in and returns the full result, and a client falls back to projecting it
 * (it can tell by the missing `schemaVersion`), exactly as against an older
 * server that has never heard of `?return=receipt`.
 *
 * COST. Two single-row reads of the entity and its detail row (each column is
 * reduced to an md5 in SQL, so a long description is never shipped twice) and
 * two reads of the edge ids touching the row. No 28-way `ENTITY_FROM` join.
 */
import type { Querier } from '../db/types.js';
import type { RequestContext } from '../http/types.js';

export const RECEIPT_SCHEMA = 'tm8.receipt.v1';

/** Titles are echoed, never more than this many characters (D1.3). */
const TITLE_MAX = 80;

/** Multi-row fields cap here, with `truncated` and a count (D4.6). */
const ROW_CAP = 16;

export type ServerReceiptOp =
  | 'task.complete'
  | 'task.tick'
  | 'task.transition'
  | 'task.link-pr'
  | 'task.link-commit'
  | 'entity.create'
  | 'entity.update';

/** The receipt a handler returns in place of `CommandResult`. */
export type ServerReceipt = { schemaVersion: typeof RECEIPT_SCHEMA; ok: true; op: ServerReceiptOp } & Record<string, unknown>;

/** Whether this request asked for a receipt instead of the full result. */
export function wantsReceipt(ctx: Pick<RequestContext, 'query'>): boolean {
  return ctx.query.get('return') === 'receipt';
}

/** The kinds whose detail row the snapshot reads. Anything else gets the full result. */
const SNAPSHOT_KINDS = new Set(['task', 'doc']);

interface EdgeRow {
  id: string;
  type: string;
  src_id: string;
  dst_id: string;
}

export interface ReceiptSnapshot {
  id: string;
  kind: string;
  version: number;
  parentId: string | null;
  title: string | null;
  status: string | null;
  gate: string | null;
  criteria: unknown;
  /** The detail row's tuple xmin: it moves whenever an RPC rewrites the row, equal values or not. */
  rowXmin: string | null;
  /** Detail-row column → md5 of its value. Equal digests are equal values. */
  fields: Record<string, string>;
  edges: Map<string, EdgeRow>;
}

interface SnapshotRow {
  kind: string;
  version: number;
  parent_id: string | null;
  title: string | null;
  status: string | null;
  gate: string | null;
  criteria: unknown;
  row_xmin: string | null;
  fields: Record<string, string> | null;
}

/**
 * The before- or after-state of one entity, read inside the write's
 * transaction. `undefined` for a kind the receipt path does not cover (or a
 * row that is gone), which sends the handler back to the full result.
 */
export async function receiptSnapshot(q: Querier, id: string): Promise<ReceiptSnapshot | undefined> {
  const rows = await q.query<SnapshotRow>(
    `select e.kind, e.version, e.parent_id,
            coalesce(t.title, d.title) as title,
            t.work_status as status,
            t.completion_gate as gate,
            t.acceptance_criteria as criteria,
            coalesce(t.xmin, d.xmin)::text as row_xmin,
            (select jsonb_object_agg(col.key, md5(col.value::text))
               from jsonb_each(coalesce(to_jsonb(t), to_jsonb(d))) as col) as fields
       from public.entities e
       left join public.tasks t     on t.entity_id = e.id
       left join public.documents d on d.entity_id = e.id
      where e.id = $1 and e.deleted_at is null`,
    [id],
  );
  const row = rows[0];
  if (!row || !SNAPSHOT_KINDS.has(row.kind)) return undefined;
  const edges = await q.query<EdgeRow>(
    `select id, type, src_id, dst_id from public.edges where src_id = $1 or dst_id = $1`,
    [id],
  );
  return {
    id,
    kind: row.kind,
    version: Number(row.version),
    parentId: row.parent_id,
    title: row.title,
    status: row.status,
    gate: row.gate,
    criteria: row.criteria,
    rowXmin: row.row_xmin,
    fields: row.fields ?? {},
    edges: new Map(edges.map((edge) => [edge.id, edge])),
  };
}

/** Detail-row columns that are bookkeeping, not facts a caller changed. */
const IGNORED_COLUMNS = new Set(['entity_id', 'created_at', 'updated_at']);

/** Stored column → the field name a caller reads it by. */
const FIELD_NAMES: Record<string, string> = {
  title: 'title',
  work_status: 'state.status',
  completion_gate: 'state.completionGate',
};

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function fieldName(column: string): string {
  return FIELD_NAMES[column] ?? `content.${camel(column)}`;
}

/** Field and edge names whose stored value differs between two snapshots, in a stable order. */
export function changedBetween(before: ReceiptSnapshot, after: ReceiptSnapshot): string[] {
  const fields: string[] = [];
  const columns = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  for (const column of [...columns].sort()) {
    if (IGNORED_COLUMNS.has(column)) continue;
    if (before.fields[column] !== after.fields[column]) fields.push(fieldName(column));
  }
  // `title` first, then state, then content: the order a reader scans them in.
  const rank = (name: string): number => (name === 'title' ? 0 : name.startsWith('state.') ? 1 : 2);
  fields.sort((a, b) => rank(a) - rank(b));
  if (before.parentId !== after.parentId) fields.push('parentId');
  const edgeTypes = new Set<string>();
  for (const [id, edge] of after.edges) if (!before.edges.has(id)) edgeTypes.add(edge.type);
  for (const [id, edge] of before.edges) if (!after.edges.has(id)) edgeTypes.add(edge.type);
  return [...fields, ...[...edgeTypes].sort().map((type) => `edge:${type}`)];
}

/** Whether anything about the row moved: its detail tuple, its version or its edges. */
function wroteBetween(before: ReceiptSnapshot, after: ReceiptSnapshot): boolean {
  if (before.rowXmin !== after.rowXmin || before.version !== after.version) return true;
  if (before.edges.size !== after.edges.size) return true;
  for (const id of after.edges.keys()) if (!before.edges.has(id)) return true;
  return false;
}

function clampTitle(title: string): { title: string; titleTruncated?: true } {
  const points = Array.from(title);
  if (points.length <= TITLE_MAX) return { title };
  return { title: `${points.slice(0, TITLE_MAX - 1).join('')}…`, titleTruncated: true };
}

/** The raw RPC command result fields a receipt reads. */
export interface ReceiptRpcResult {
  entity?: { id: string };
  patches?: Array<{ id: string }>;
  undo?: { token: string; label: string; expiresAt?: string };
}

export interface ReceiptOptions {
  /** The snapshot taken before the RPC. Absent on create, where there is no before. */
  before?: ReceiptSnapshot;
  /** `task.complete`: the completer ids the caller named, so only their edges are refs. */
  completerIds?: readonly string[];
}

/**
 * Build the receipt after the RPC has run, from a fresh snapshot of the same
 * row in the same transaction. `undefined` when the row is not a kind the
 * receipt path covers — the caller then returns the full result.
 */
export async function buildReceipt(
  q: Querier,
  op: ServerReceiptOp,
  raw: ReceiptRpcResult,
  opts: ReceiptOptions = {},
): Promise<ServerReceipt | undefined> {
  const id = raw.entity?.id ?? opts.before?.id;
  if (!id) return undefined;
  const after = await receiptSnapshot(q, id);
  if (!after) return undefined;
  const before = opts.before;

  const receipt: ServerReceipt = { schemaVersion: RECEIPT_SCHEMA, ok: true, op, id, kind: after.kind };
  if (after.title !== null) Object.assign(receipt, clampTitle(after.title));
  if (op === 'entity.create') receipt.parentId = after.parentId;

  const wrote = before === undefined ? true : wroteBetween(before, after);
  const known = before !== undefined && wrote;
  receipt.version = known ? { from: before.version, to: after.version } : { to: after.version };
  // `status.from` only when the status MOVED: `changed` already says an
  // equal one did not, and the repeat cost a link receipt its byte budget.
  if (after.status !== null) {
    receipt.status = known && before.status !== null && before.status !== after.status
      ? { from: before.status, to: after.status }
      : { to: after.status };
  }
  const warnings: Record<string, unknown>[] = [];
  if (known) {
    const changed = changedBetween(before, after);
    receipt.changed = changed;
    if (changed.length === 0) {
      warnings.push({ code: 'no_change', message: 'the write matched the stored values' });
    }
  } else if (before !== undefined) {
    warnings.push({
      code: 'no_write_observed',
      message: 'this call wrote nothing (a clientMutationId replay, or a write already in place)',
    });
  }

  if (op === 'task.complete' && after.gate !== null) receipt.gate = { kind: after.gate, result: 'passed' };

  if (op === 'task.tick' && Array.isArray(after.criteria)) {
    const criteria = after.criteria as Array<Record<string, unknown>>;
    const open = criteria.filter((c) => c?.done !== true).map((c) => String(c?.id ?? ''));
    receipt.acceptance = { done: criteria.length - open.length, total: criteria.length };
    receipt.open = capped(open, 'open', receipt);
  }

  const refs: Record<string, unknown>[] = [];
  let linked: unknown;
  if (op === 'task.link-pr' || op === 'task.link-commit') {
    const artifact = await linkedArtifact(q, raw, op === 'task.link-pr' ? 'pull_request' : 'commit');
    if (artifact) refs.push(artifact);
    linked = artifact?.id;
  }
  // New edges touching the row, as the ids a chained command needs (D2.4).
  // On complete, only the completers the caller named (the RPC may leave
  // other completed_by edges from an earlier completion).
  const completers = opts.completerIds ? new Set(opts.completerIds) : undefined;
  if (wrote) {
    const previous = before?.edges ?? new Map<string, EdgeRow>();
    for (const edge of after.edges.values()) {
      if (previous.has(edge.id)) continue;
      const outgoing = edge.src_id === id;
      const other = outgoing ? edge.dst_id : edge.src_id;
      if (edge.type === 'completed_by' && completers && !completers.has(other)) continue;
      // The link edge's far end is the artifact ref just above; naming it
      // twice costs ~43 bytes of a 500-byte budget and says nothing (§5 link-pr).
      if (linked === other) {
        refs.push({ kind: 'edge', type: edge.type, id: edge.id });
        continue;
      }
      refs.push(outgoing
        ? { kind: 'edge', type: edge.type, id: edge.id, to: other }
        : { kind: 'edge', type: edge.type, id: edge.id, from: other });
    }
  }
  receipt.refs = refs;

  if (raw.undo) {
    receipt.undo = {
      token: raw.undo.token,
      label: raw.undo.label,
      ...(raw.undo.expiresAt ? { expiresAt: new Date(raw.undo.expiresAt).toISOString() } : {}),
    };
  }
  receipt.warnings = warnings;
  return receipt;
}

function capped<T>(rows: T[], field: string, receipt: Record<string, unknown>): T[] {
  if (rows.length <= ROW_CAP) return rows;
  receipt.truncated = true;
  receipt[`${field}Count`] = rows.length;
  return rows.slice(0, ROW_CAP);
}

/** The pull_request/commit a link RPC patched, with its url (§4.2 link-pr). */
async function linkedArtifact(
  q: Querier,
  raw: ReceiptRpcResult,
  kind: 'pull_request' | 'commit',
): Promise<Record<string, unknown> | undefined> {
  const ids = (raw.patches ?? []).map((p) => p.id).filter(Boolean);
  if (ids.length === 0) return undefined;
  const rows = await q.query<{ id: string; url: string | null }>(
    kind === 'pull_request'
      ? `select e.id, pr.url from public.entities e join public.pull_requests pr on pr.entity_id = e.id
          where e.id = any($1::uuid[]) and e.kind = 'pull_request' limit 1`
      : `select e.id, c.url from public.entities e join public.commits c on c.entity_id = e.id
          where e.id = any($1::uuid[]) and e.kind = 'commit' limit 1`,
    [ids],
  );
  const row = rows[0];
  if (!row) return undefined;
  return row.url ? { kind, id: row.id, url: row.url } : { kind, id: row.id };
}
