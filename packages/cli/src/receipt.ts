/**
 * Compact mutation receipts — `tm8.receipt.v1`, PHASE 1 (spec doc 01a0cf2e,
 * §4.1, §4.2, §4.4, §8.1).
 *
 * A receipt is what an agent needs after a write: which row, what version it
 * is now, what state it landed in, and the ids of anything the write created
 * or linked. The full server result (`CommandResult`, `MessageBatchResult`)
 * embeds the whole post-write `EntityDetail` — hierarchy, every connection with
 * both endpoints' summaries, content, capabilities — and measured 15–80k
 * chars per call on these ten commands. A receipt is under 500 B.
 *
 * PHASE 1 IS A RENDER-TIME PROJECTION of the result the Server already sends.
 * Nothing here changes a request, and every field is read out of that result
 * or out of the caller's own argv. Two honesty rules follow, and both are
 * load-bearing (D1.2):
 *
 *  - `version.from` appears ONLY when the caller passed `--expect-version`
 *    (the write succeeded, so the version it replaced was exactly that).
 *    `status.from` and `changed` never appear: the result does not carry the
 *    before-state, and a projection that guessed it would be a lie. In
 *    particular `changed: []` means a SERVER-VERIFIED no-op (phase 2) and a
 *    projection must never print it.
 *  - a fact the result does not carry is OMITTED, never defaulted.
 *
 * The receipt is always ONE MINIFIED LINE under `--format json|jsonl` (D1.5),
 * and one human line carrying the same facts under `--format human` (§4.4).
 *
 * WHO GETS IT (D5.1): agent-class callers, now. Everyone else keeps today's
 * full result for one release plus a one-line stderr notice naming `--full`.
 * `--full` is the permanent, universal opt-out and prints today's result,
 * byte-identical. See `resolveReceiptMode`.
 *
 * Error receipts (`ok:false`: conflict, gate failure, forbidden, ambiguous
 * transport) live in `receipt-error.ts` and share `SCHEMA_VERSION`,
 * `ReceiptOp` and the caps from here. Two step-1B facts ride SUCCESS receipts
 * and so live here: a partially delivered batch's `undelivered` warning, and
 * `mutationId` when — only when — the caller passed one (D4.5, D4.7).
 */
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 'tm8.receipt.v1';

/** Titles are echoed, but never more than this many characters (D1.3). */
export const TITLE_MAX = 80;

/** Multi-row fields (messages, delivery, spawn tasks) cap here (D4.6). */
export const ROW_CAP = 16;

export const RECEIPT_OPS = [
  'task.complete',
  'task.tick',
  'task.transition',
  'task.link-pr',
  'task.link-commit',
  'entity.create',
  'entity.update',
  'message.send',
  'message.reply',
  'session.spawn',
  'session.terminate',
] as const;
export type ReceiptOp = (typeof RECEIPT_OPS)[number];

/**
 * How a mutation command prints its result.
 *
 *  - `receipt`    — the compact receipt (agent-class callers).
 *  - `deprecated` — today's result, plus the one-line deprecation notice on
 *                   stderr under json/jsonl (everyone else, for one release).
 *  - `full`       — today's result, no notice (`--full`, and any Output built
 *                   without a mode — unit tests, embedded callers).
 */
export type ReceiptMode = 'receipt' | 'deprecated' | 'full';

/**
 * Decide the mode for one invocation.
 *
 * "Agent-class" is BOTH signals the CLI already has, not a third heuristic:
 * the process carries a spawned session's identity (`isAgentContext`, the
 * credential guard) AND the journal classifier calls it `agent` (the line the
 * terse default already follows, which is what lets a harness opt out with
 * `TM8_JOURNAL_CLASS=harness`). Requiring the first keeps a human at their own
 * terminal — whom the journal classifier cannot see — on the deprecation path.
 *
 * `TM8_NO_RECEIPTS=1` is the kill switch: one env var, no deploy.
 */
export function resolveReceiptMode(opts: {
  full: boolean;
  agentContext: boolean;
  journalClass: string;
  env: NodeJS.ProcessEnv;
}): ReceiptMode {
  if (opts.full) return 'full';
  if (opts.env.TM8_NO_RECEIPTS === '1') return 'deprecated';
  return opts.agentContext && opts.journalClass === 'agent' ? 'receipt' : 'deprecated';
}

/** The stderr line a non-agent json caller sees while the flip is pending. */
export function deprecationNotice(op: ReceiptOp): string {
  return (
    `note: \`${op}\` json output becomes a compact ${SCHEMA_VERSION} receipt in the next release; ` +
    'pass --full to keep the full result'
  );
}

// ---------------------------------------------------------------------------
// Receipt shape
// ---------------------------------------------------------------------------

export interface ReceiptRef {
  kind: string;
  id: string;
  type?: string;
  url?: string;
  to?: string;
  /** An incoming edge: the row it comes from. */
  from?: string;
}

/** A warning the receipt carries: the Server's verbatim, or one the CLI verified. */
export type ReceiptWarning = Record<string, unknown>;

export interface Receipt {
  schemaVersion: typeof SCHEMA_VERSION;
  ok: true;
  op: ReceiptOp;
  [field: string]: unknown;
}

/** What the command knows that the result does not: argv, and follow-up writes. */
export interface ReceiptInput {
  /** `--expect-version`, when the caller passed one. The only source of `version.from`. */
  expectedVersion?: number;
  /** Rows a chained CLI request created after the main write (e.g. `created_in`). */
  refs?: ReceiptRef[];
  /** Facts the CLI verified itself (a chained write that did not land). */
  warnings?: ReceiptWarning[];
  /** `task complete --by …`: which completed_by edges this write made. */
  completerIds?: readonly string[];
  /** `task link-pr|link-commit <url>`: fallback when the entity carries none. */
  url?: string;
  /** `session spawn`: the worktree checkout path, when the CLI read it. */
  workdirPath?: string;
  /**
   * `--mutation-id`, ONLY when the caller passed one (D4.7). A generated id
   * is noise on success; it is echoed only on an ambiguous error receipt.
   */
  mutationId?: string;
}

// ---------------------------------------------------------------------------
// Small readers over an untyped result
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function rec(v: unknown): Rec {
  return isRecord(v) ? v : {};
}

/** Cut to `TITLE_MAX` code points, marking the cut (D2.2: shortened is marked). */
export function clampTitle(title: string): { title: string; titleTruncated?: true } {
  const points = Array.from(title);
  if (points.length <= TITLE_MAX) return { title };
  return { title: `${points.slice(0, TITLE_MAX - 1).join('')}…`, titleTruncated: true };
}

/** Server warnings, verbatim, once the Server sends them (§9.13); then the CLI's own. */
function warningsOf(dto: unknown, input: ReceiptInput): ReceiptWarning[] {
  const server = Array.isArray(rec(dto).warnings) ? (rec(dto).warnings as ReceiptWarning[]) : [];
  return [...server, ...(input.warnings ?? [])];
}

/**
 * Every edge in an `EntityDetail.connections` block for one direction and
 * type. The block is `{outgoing: [{type, edges: EdgeView[]}], incoming: …}`.
 */
function edgesOf(entity: Rec, direction: 'outgoing' | 'incoming', type: string): Rec[] {
  const groups = rec(entity.connections)[direction];
  if (!Array.isArray(groups)) return [];
  const out: Rec[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.edges)) continue;
    for (const edge of group.edges) {
      if (isRecord(edge) && edge.type === type) out.push(edge);
    }
  }
  return out;
}

function endpointId(edge: Rec, side: 'source' | 'target'): string | undefined {
  return str(rec(edge[side]).id);
}

/** The common head every entity-shaped receipt starts with (§4.1). */
function head(op: ReceiptOp, entity: Rec, input: ReceiptInput): Receipt {
  const receipt: Receipt = { schemaVersion: SCHEMA_VERSION, ok: true, op };
  const id = str(entity.id);
  if (id !== undefined) receipt.id = id;
  const kind = str(entity.kind);
  if (kind !== undefined) receipt.kind = kind;
  if (typeof entity.title === 'string') Object.assign(receipt, clampTitle(entity.title));
  if (op === 'entity.create' && (typeof entity.parentId === 'string' || entity.parentId === null)) {
    receipt.parentId = entity.parentId;
  }
  // Session receipts carry no version, as in the spec's spawn/terminate
  // examples (§5): nothing versions a work_session through these commands,
  // and the spawn worst case (80-char title + worktree path) needs the bytes
  // to stay under the 640 B cap without cutting a required fact (D7.1).
  if (typeof entity.version === 'number' && !op.startsWith('session.')) {
    receipt.version =
      input.expectedVersion === undefined
        ? { to: entity.version }
        : { from: input.expectedVersion, to: entity.version };
  }
  const status = str(rec(entity.state).status);
  // `from` is phase 2 only — the result carries no before-state (D1.2).
  if (status !== undefined) receipt.status = { to: status };
  return receipt;
}

function tail(receipt: Receipt, dto: unknown, input: ReceiptInput, refs: ReceiptRef[] | undefined): Receipt {
  if (refs !== undefined) receipt.refs = [...refs, ...(input.refs ?? [])];
  const undo = rec(dto).undo;
  if (undo !== undefined) receipt.undo = undo; // verbatim, never dropped (§9.13)
  receipt.warnings = warningsOf(dto, input);
  return receipt;
}

function capped<T>(rows: T[], field: string, receipt: Receipt): T[] {
  if (rows.length <= ROW_CAP) return rows;
  receipt.truncated = true;
  receipt[`${field}Count`] = rows.length;
  return rows.slice(0, ROW_CAP);
}

// ---------------------------------------------------------------------------
// Per-op projections
// ---------------------------------------------------------------------------

function entityReceipt(op: ReceiptOp, dto: unknown, input: ReceiptInput): Receipt {
  const entity = rec(rec(dto).entity);
  const receipt = head(op, entity, input);
  const refs: ReceiptRef[] = [];

  if (op === 'task.complete') {
    const gate = str(rec(entity.state).completionGate);
    // The write succeeded, so whatever gate the task carries passed. An older
    // node that projects no gate is not guessed at.
    if (gate !== undefined) receipt.gate = { kind: gate, result: 'passed' };
    const completers = new Set(input.completerIds ?? []);
    for (const edge of edgesOf(entity, 'outgoing', 'completed_by')) {
      const to = endpointId(edge, 'target');
      const id = str(edge.id);
      if (id !== undefined && to !== undefined && completers.has(to)) {
        refs.push({ kind: 'edge', type: 'completed_by', id, to });
      }
    }
  }

  if (op === 'task.tick') {
    // What is still open after this write: `open` empty means `task complete`
    // at `version.to` clears the criteria gate.
    const criteria = rec(entity.content).acceptanceCriteria;
    if (Array.isArray(criteria)) {
      const open = criteria.filter((c) => isRecord(c) && c.done !== true).map((c) => str(rec(c).id) ?? '');
      receipt.acceptance = { done: criteria.length - open.length, total: criteria.length };
      receipt.open = capped(open, 'open', receipt);
    }
  }

  if (op === 'task.link-pr' || op === 'task.link-commit') {
    const artifactKind = op === 'task.link-pr' ? 'pull_request' : 'commit';
    const artifact = patchOf(dto, artifactKind);
    if (artifact !== undefined) {
      const id = artifact.id as string;
      const url = str(rec(artifact.state).url) ?? input.url;
      refs.push(url === undefined ? { kind: artifactKind, id } : { kind: artifactKind, id, url });
      const tracks = edgesOf(entity, 'outgoing', 'tracks').find((e) => endpointId(e, 'target') === id);
      const edgeId = tracks === undefined ? undefined : str(tracks.id);
      if (edgeId !== undefined) refs.push({ kind: 'edge', type: 'tracks', id: edgeId });
    }
  }

  return tail(receipt, dto, input, refs);
}

/** The first `patches[]` summary of a kind — where link-pr/commit put the artifact. */
export function patchOf(dto: unknown, kind: string): Rec | undefined {
  const patches = rec(dto).patches;
  if (!Array.isArray(patches)) return undefined;
  return patches.find((p): p is Rec => isRecord(p) && p.kind === kind && typeof p.id === 'string');
}

/** 12-hex sha256 prefix of the UTF-8 body (D1.4: never the body itself). */
export function bodyDigest(body: string): { bodyChars: number; bodySha256: string } {
  return {
    bodyChars: Array.from(body).length,
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12),
  };
}

function messageReceipt(op: ReceiptOp, dto: unknown, input: ReceiptInput): Receipt {
  const batch = rec(dto);
  const receipt: Receipt = { schemaVersion: SCHEMA_VERSION, ok: true, op };
  // A batch came back, so the Server stored it: `messages.post` answers only
  // after the rows commit. Delivery is a separate fact, reported below.
  receipt.stored = true;
  const batchId = str(batch.messageBatchId);
  if (batchId !== undefined) receipt.batch = batchId;

  const messages = (Array.isArray(batch.messages) ? batch.messages : []).filter(isRecord);
  receipt.messages = capped(messages, 'message', receipt).map((m) => {
    const state = rec(m.state);
    const body = rec(m.content).body;
    return {
      id: m.id,
      anchor: state.anchorId,
      root: state.rootMessageId ?? null,
      ...(typeof body === 'string' ? bodyDigest(body) : {}),
    };
  });

  let undelivered = 0;
  if (Array.isArray(batch.delivery)) {
    const rows = batch.delivery.filter(isRecord);
    // Counted over EVERY row, before the cap: the count is the fact a caller
    // acts on, and D2.2 says warnings survive truncation.
    undelivered = rows.filter((d) => d.status === 'undelivered').length;
    receipt.delivery = capped(rows, 'delivery', receipt).map((d) => ({
      message: d.targetMessageId,
      session: d.targetWorkSessionId,
      status: d.status,
      ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    }));
  }
  receipt.warnings = warningsOf(dto, input);
  // A stored batch whose live copy did not land is still `ok:true` — the write
  // succeeded — but it is never silent (§4.3 messages, D4.5).
  if (undelivered > 0) {
    (receipt.warnings as ReceiptWarning[]).push({ code: 'undelivered', count: undelivered });
  }
  return receipt;
}

function spawnReceipt(op: ReceiptOp, dto: unknown, input: ReceiptInput): Receipt {
  const entity = rec(rec(dto).entity);
  const state = rec(entity.state);
  const receipt = head(op, entity, input);

  const teammate = str(rec(state.teammate).id) ?? (rec(entity.createdBy).kind === 'team_member'
    ? str(rec(entity.createdBy).id)
    : undefined);
  if (teammate !== undefined) receipt.teammate = teammate;
  const model = str(state.model);
  if (model !== undefined) receipt.model = model;

  const tasks = edgesOf(entity, 'outgoing', 'working_on')
    .map((e) => endpointId(e, 'target'))
    .filter((id): id is string => id !== undefined);
  if (tasks.length > 0) receipt.tasks = capped([...new Set(tasks)], 'task', receipt);

  const mode = str(state.workdirMode);
  if (mode !== undefined) {
    receipt.workdir = input.workdirPath === undefined ? { mode } : { mode, path: input.workdirPath };
  }
  const branch = str(state.checkoutBranch);
  if (branch !== undefined) receipt.branch = branch;
  // `accessMode` is not on the work_session result; phase 2's server receipt
  // supplies it. Omitted rather than echoed from argv, which may not name one.
  // No `refs` either (§5's spawn example): `tasks` and `workdir` are the rows.
  return tail(receipt, dto, input, undefined);
}

/** The worktree entity a spawned session checked out, for the one follow-up read. */
export function spawnedWorktreeId(dto: unknown): string | undefined {
  const entity = rec(rec(dto).entity);
  if (rec(entity.state).workdirMode !== 'worktree') return undefined;
  const edge = edgesOf(entity, 'outgoing', 'in_worktree')[0];
  return edge === undefined ? undefined : endpointId(edge, 'target');
}

function terminateReceipt(op: ReceiptOp, dto: unknown, input: ReceiptInput): Receipt {
  const entity = rec(rec(dto).entity);
  const receipt = head(op, entity, input);
  const ended = str(rec(entity.state).endedKind);
  if (ended !== undefined) receipt.ended = ended;
  return tail(receipt, dto, input, undefined);
}

/**
 * The ops whose Server honours `?return=receipt` (phase 2). A Server that
 * predates it ignores the query and answers with the full result, which
 * `successReceipt` then projects exactly as phase 1 did.
 */
export const SERVER_RECEIPT_OPS: ReadonlySet<ReceiptOp> = new Set<ReceiptOp>([
  'task.complete',
  'task.tick',
  'task.transition',
  'task.link-pr',
  'task.link-commit',
  'entity.create',
  'entity.update',
]);

/** The query that asks the Server for a receipt, when this invocation prints one. */
export function receiptQuery(op: ReceiptOp, mode: ReceiptMode): { return?: 'receipt' } {
  return mode === 'receipt' && SERVER_RECEIPT_OPS.has(op) ? { return: 'receipt' } : {};
}

/** Whether a response is already a receipt the Server built. */
export function isServerReceipt(dto: unknown): dto is Receipt {
  return isRecord(dto) && dto.schemaVersion === SCHEMA_VERSION && dto.ok === true && typeof dto.op === 'string';
}

/**
 * Project one server success result into its receipt. Pure.
 *
 * A receipt the Server built is taken as it stands — its `version.from`,
 * `status.from` and `changed` come from a before/after read only the Server
 * can make — and only the CLI's own facts are added: chained refs, warnings it
 * verified, and the caller's `--mutation-id`.
 */
export function successReceipt(op: ReceiptOp, dto: unknown, input: ReceiptInput = {}): Receipt {
  const receipt = isServerReceipt(dto) ? fromServer(dto, input) : projectSuccess(op, dto, input);
  if (input.mutationId !== undefined) receipt.mutationId = input.mutationId;
  return receipt;
}

function fromServer(dto: Receipt, input: ReceiptInput): Receipt {
  const receipt: Receipt = { ...dto };
  const refs = Array.isArray(dto.refs) ? (dto.refs as ReceiptRef[]) : [];
  receipt.refs = [...refs, ...(input.refs ?? [])];
  receipt.warnings = warningsOf(dto, input);
  return receipt;
}

/** The id of the `kind` row a server receipt names in its refs (link-pr's pull_request). */
export function receiptRefId(dto: unknown, kind: string): string | undefined {
  if (!isServerReceipt(dto) || !Array.isArray(dto.refs)) return undefined;
  const ref = (dto.refs as ReceiptRef[]).find((r) => r.kind === kind);
  return ref?.id;
}

function projectSuccess(op: ReceiptOp, dto: unknown, input: ReceiptInput): Receipt {
  switch (op) {
    case 'message.send':
    case 'message.reply':
      return messageReceipt(op, dto, input);
    case 'session.spawn':
      return spawnReceipt(op, dto, input);
    case 'session.terminate':
      return terminateReceipt(op, dto, input);
    default:
      return entityReceipt(op, dto, input);
  }
}

/** `{mutationId}` for a success receipt: the caller's own `--mutation-id`, or nothing (D4.7). */
export function callerMutationId(options: { value(name: string): string | undefined }): { mutationId?: string } {
  const supplied = options.value('mutation-id');
  return supplied === undefined ? {} : { mutationId: supplied };
}

// ---------------------------------------------------------------------------
// Human line (§4.4) — the same facts, one line
// ---------------------------------------------------------------------------

function versionText(v: unknown): string | undefined {
  const version = rec(v);
  if (typeof version.to !== 'number') return undefined;
  return typeof version.from === 'number' ? `v${version.from}→v${version.to}` : `v${version.to}`;
}

function refText(ref: ReceiptRef): string {
  const label = ref.type ?? ref.kind;
  return [label, ref.id, ref.url, ref.to === undefined ? undefined : `→${ref.to}`,
    ref.from === undefined ? undefined : `←${ref.from}`]
    .filter((p) => p !== undefined)
    .join(' ');
}

function warningText(w: ReceiptWarning): string {
  const code = str(w.code) ?? 'warning';
  const message = str(w.message);
  return message === undefined ? `WARNING ${code}` : `WARNING ${code}: ${message}`;
}

export function renderReceiptHuman(receipt: Receipt): string {
  // Head facts are space-joined, as in §4.4's example; each ref, delivery row
  // and warning is its own ` · ` clause so a reader can split them.
  const head: string[] = [];
  const clauses: string[] = [];
  if (receipt.op === 'message.send' || receipt.op === 'message.reply') {
    head.push(receipt.op, 'stored', `batch ${String(receipt.batch ?? '?')}`);
    for (const m of (receipt.messages as Rec[] | undefined) ?? []) {
      const digest = typeof m.bodyChars === 'number' ? ` ${m.bodyChars}ch sha:${String(m.bodySha256)}` : '';
      clauses.push(`msg ${String(m.id)} on ${String(m.anchor)}${digest}`);
    }
    for (const d of (receipt.delivery as Rec[] | undefined) ?? []) {
      const reason = typeof d.reason === 'string' ? ` (${d.reason})` : '';
      // D3.2: an undelivered live copy is the one outcome a caller must not skim.
      const status = d.status === 'undelivered' ? 'NOT DELIVERED' : String(d.status);
      clauses.push(`${String(d.session)} ${status}${reason}`);
    }
  } else {
    head.push(String(receipt.id ?? '?'));
    if (typeof receipt.kind === 'string') head.push(receipt.kind);
    if (typeof receipt.title === 'string') head.push(JSON.stringify(receipt.title));
    const version = versionText(receipt.version);
    if (version !== undefined) head.push(version);
    const status = rec(receipt.status);
    if (typeof status.to === 'string') {
      head.push(typeof status.from === 'string' ? `${status.from}→${status.to}` : status.to);
    }
    const gate = rec(receipt.gate);
    if (typeof gate.kind === 'string') head.push(`gate:${gate.kind}`);
    if (typeof receipt.ended === 'string') head.push(`ended:${receipt.ended}`);
    if (typeof receipt.teammate === 'string') head.push(`teammate:${receipt.teammate}`);
    if (typeof receipt.model === 'string') head.push(`model:${receipt.model}`);
    if (Array.isArray(receipt.tasks)) head.push(`tasks:${receipt.tasks.join(',')}`);
    const workdir = rec(receipt.workdir);
    if (typeof workdir.mode === 'string') {
      head.push(`${workdir.mode}${typeof workdir.path === 'string' ? `:${workdir.path}` : ''}`);
    }
    if (typeof receipt.branch === 'string') head.push(`branch:${receipt.branch}`);
    for (const ref of (receipt.refs as ReceiptRef[] | undefined) ?? []) clauses.push(refText(ref));
    const undo = rec(receipt.undo);
    if (typeof undo.token === 'string') {
      clauses.push(`undo ${undo.token}${typeof undo.label === 'string' ? ` (${undo.label})` : ''}`);
    }
  }
  if (receipt.truncated === true) clauses.push('truncated');
  const warnings = (receipt.warnings as ReceiptWarning[] | undefined) ?? [];
  // `changed: []` exists only when the Server verified the no-op (D1.2); the
  // projection never emits it, so this line cannot be printed on a guess.
  if (Array.isArray(receipt.changed) && receipt.changed.length === 0) {
    const reason = str(warnings.find((w) => w.code === 'no_change')?.message);
    clauses.unshift(reason === undefined ? 'NO CHANGE' : `NO CHANGE (${reason})`);
  }
  for (const w of warnings) if (w.code !== 'no_change') clauses.push(warningText(w));
  return [head.join(' '), ...clauses].join(' · ');
}
