/**
 * Error receipts — `tm8.receipt.v1` with `ok:false`, PHASE 1 (spec doc
 * 01a0cf2e §4.3, §5, §9.4–9.8, D4.1–D4.7). The success half lives in
 * `receipt.ts`; this module shares its schema version, op names and caps.
 *
 * WHERE IT PRINTS (D4.1). On stdout, one minified line, under `--format
 * json|jsonl` in RECEIPT MODE ONLY (`Output.errorReceipts`). The stderr
 * diagnostic and the exit code are unchanged: this module adds a line to
 * stdout and then rethrows, so the run funnel renders and exits exactly as it
 * did before. Human format stays stderr-only; `--full` and non-agent callers
 * keep today's empty stdout.
 *
 * WHAT IT COVERS. A refusal or a lost answer from the ONE write a command
 * exists to make. Local usage errors never reach a server and print nothing
 * here, and the best-effort chained writes (`created_in` claims) already
 * surface as success-receipt warnings.
 *
 * THE SHAPES:
 *  - version_conflict — `expectedVersion`, `currentVersion`, `current`
 *    (from #668's `ApiError.currentVersion` / `.current`). `next` is a
 *    filled-in retry for complete/transition/link-pr/link-commit, and a READ
 *    (`tm8 entity context <id>`) for `entity update`, never a retry (D4.2):
 *    a stale content write must be re-derived, not re-sent.
 *  - gate failures — `reason`, `incomplete[]`/`incompleteCount`, `prs[]`,
 *    fetched with EXACTLY ONE extra read on the failure path (D4.3).
 *  - forbidden / not_found — code, reason, requestId, actor. No entity data
 *    (D4.4): a caller refused a row learns nothing about it here.
 *  - ambiguous outcome — a transport failure or a retryable 5xx means the
 *    write may or may not have landed. `outcome:"unknown"`, the `mutationId`
 *    the CLI sent (generated when the caller passed none), and `next` is the
 *    same command with `--mutation-id` pinned, so replaying it is idempotent
 *    on the server (D4.7).
 */
import { ApiError, ProtocolError, TransportError } from './errors.js';
import { EXIT_RETRYABLE } from './exit.js';
import { clampTitle, ROW_CAP, SCHEMA_VERSION, type ReceiptOp } from './receipt.js';
import type { Tm8Client } from './client.js';
import { clientFor } from './discovery/observe.js';
import type { CommandContext } from './run.js';

/** The four gate refusals the Server names in `details.reason` (§4.3). */
export const GATE_REASONS = [
  'acceptance_criteria_incomplete',
  'gate_no_tracked_pr',
  'gate_pr_unmerged_or_ci_red',
  'use_complete_command',
] as const;
export type GateReason = (typeof GATE_REASONS)[number];

/** `incomplete[]` rows cap here; `incompleteCount` stays exact (§4.3). */
export const INCOMPLETE_CAP = 10;

/** Text fields in an error receipt clamp at the title limit (§4.3: text≤80). */
const TEXT_MAX = 80;

/** A server/transport message rides generic and transport receipts, clamped. */
const MESSAGE_MAX = 200;

/** §7.3 / D1.5: an error receipt is at most this many minified UTF-8 bytes. */
export const ERROR_BUDGET = 1024;

/** The shortest a criterion's text is cut to before rows are dropped instead. */
const TEXT_FLOOR = 24;

/** Ops whose conflict `next` is a filled-in retry rather than a read (D4.2). */
const RETRY_ON_CONFLICT: ReadonlySet<ReceiptOp> = new Set([
  'task.complete',
  'task.transition',
  'task.link-pr',
  'task.link-commit',
]);

/** Ops that take `--expect-version`: the retry fills it with the current version. */
const TAKES_EXPECT_VERSION: ReadonlySet<ReceiptOp> = new Set(['task.complete', 'entity.update']);

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function clampText(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

export interface ErrorReceipt {
  schemaVersion: typeof SCHEMA_VERSION;
  ok: false;
  op: ReceiptOp;
  id?: string;
  error: Rec;
  next?: string;
  mutationId?: string;
  [field: string]: unknown;
}

/** What the command knew when its write failed. */
export interface ErrorReceiptInput {
  op: ReceiptOp;
  /** The one existing row the command targets, if any. */
  id?: string;
  /** The invocation's argv — the source of every `next` but the read. */
  argv?: readonly string[];
  /** The `clientMutationId` the CLI sent — generated when the caller passed none. */
  mutationId?: string;
  /** Whether the caller passed `--mutation-id` themselves. */
  callerMutationId?: boolean;
  /** `--expect-version`, when passed. */
  expectedVersion?: number;
  /** The actor the CLI wrote as (`--as` / `TM8_ACTOR_ID`), when it knows it. */
  actor?: string;
}

/** The gate facts the failure-path read supplies. */
export interface GateFacts {
  criteria?: unknown;
  pullRequests?: unknown;
  /** The Server's own cap on `badges.pullRequests` dropped links. */
  pullRequestsTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// `next`: the caller's own command, one flag changed
// ---------------------------------------------------------------------------

/** POSIX-shell quoting: bare when safe, single-quoted otherwise. */
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** argv without `--name value` / `--name=value`. A literal `--` ends option parsing. */
function withoutOption(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (tok === `--${name}`) {
      i++; // and its value
      continue;
    }
    if (tok.startsWith(`--${name}=`)) continue;
    out.push(tok);
  }
  return out;
}

/** Insert flags before a literal `--`, so they stay options. */
function withOptions(argv: readonly string[], extra: readonly string[]): string[] {
  const dash = argv.indexOf('--');
  return dash < 0 ? [...argv, ...extra] : [...argv.slice(0, dash), ...extra, ...argv.slice(dash)];
}

function commandLine(argv: readonly string[]): string {
  return ['tm8', ...argv].map(shellQuote).join(' ');
}

/** `next` for an ambiguous outcome: the same command, `--mutation-id` pinned. */
export function replayCommand(argv: readonly string[], mutationId: string): string {
  return commandLine(withOptions(withoutOption(argv, 'mutation-id'), ['--mutation-id', mutationId]));
}

/**
 * `next` for a conflict on a retryable op: the same command against the
 * version it lost to. The mutation id is dropped — the conflict proves the
 * write did not land, and a new expected version under the old id would be a
 * changed stable input the Server refuses as an identity mismatch.
 */
export function retryCommand(op: ReceiptOp, argv: readonly string[], currentVersion: number | undefined): string {
  let tokens = withoutOption(argv, 'mutation-id');
  if (TAKES_EXPECT_VERSION.has(op) && currentVersion !== undefined) {
    tokens = withOptions(withoutOption(tokens, 'expect-version'), ['--expect-version', String(currentVersion)]);
  }
  return commandLine(tokens);
}

function contextCommand(id: string): string {
  return commandLine(['entity', 'context', id]);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** A transport error, or a retryable 5xx: the write may or may not have landed. */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof TransportError) return true;
  if (err instanceof ProtocolError) {
    return err.status !== undefined && err.status >= 500 && err.exitCode === EXIT_RETRYABLE;
  }
  if (err instanceof ApiError) return err.status >= 500 && err.retryable;
  return false;
}

export function gateReasonOf(err: unknown): GateReason | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const reason = err.reason;
  return (GATE_REASONS as readonly string[]).includes(reason ?? '') ? (reason as GateReason) : undefined;
}

/**
 * Whether building this receipt needs the one failure-path read (D4.3). Two
 * gate reasons need none: `use_complete_command` has no rows, and
 * `gate_no_tracked_pr` is itself the Server's claim that `prs` is empty.
 */
export function needsGateRead(err: unknown, input: ErrorReceiptInput): boolean {
  const reason = gateReasonOf(err);
  return (reason === 'acceptance_criteria_incomplete' || reason === 'gate_pr_unmerged_or_ci_red')
    && input.id !== undefined;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function base(input: ErrorReceiptInput, error: Rec): ErrorReceipt {
  // Key order is the spec's (§5): `id` before `error`.
  return input.id === undefined
    ? { schemaVersion: SCHEMA_VERSION, ok: false, op: input.op, error }
    : { schemaVersion: SCHEMA_VERSION, ok: false, op: input.op, id: input.id, error };
}

function byteSize(receipt: ErrorReceipt): number {
  return Buffer.byteLength(JSON.stringify(receipt), 'utf8');
}

/**
 * Hold a gate receipt to `ERROR_BUDGET`. The spec's own caps collide there —
 * ten criteria at 80 characters is ~1.4 KB on its own — so the variable rows
 * give way in the order that loses least: criterion text shortens first
 * (never past `TEXT_FLOOR`), then trailing rows go, marked `truncated`. The
 * facts a caller acts on never go: `incompleteCount` stays exact, every row
 * kept still names its `index`, and `next` still points at the full read
 * (D7.1: required facts are never cut to hit a number).
 */
function fitBudget(receipt: ErrorReceipt, texts: readonly string[]): void {
  const error = receipt.error;
  const rows = Array.isArray(error.incomplete) ? (error.incomplete as Rec[]) : undefined;
  if (rows !== undefined) {
    for (let max = TEXT_MAX - 8; byteSize(receipt) > ERROR_BUDGET && max >= TEXT_FLOOR; max -= 8) {
      rows.forEach((row, i) => { row.text = clampText(texts[i] ?? '', max); });
      receipt.truncated = true; // D2.2: anything shortened is marked
    }
    while (byteSize(receipt) > ERROR_BUDGET && rows.length > 1) {
      rows.pop();
      receipt.truncated = true;
    }
  }
  const prs = Array.isArray(error.prs) ? (error.prs as Rec[]) : undefined;
  if (prs !== undefined) {
    const total = typeof error.prsCount === 'number' ? error.prsCount : prs.length;
    while (byteSize(receipt) > ERROR_BUDGET && prs.length > 1) {
      prs.pop();
      receipt.truncated = true;
      error.prsCount = total;
    }
  }
}

/** `current {status, title≤80, updatedAt, updatedBy}` — only what the Server sent. */
function currentOf(err: ApiError): Rec | undefined {
  const compact = err.current;
  if (compact === undefined) return undefined;
  const out: Rec = {};
  const status = isRecord(compact.state) ? str(compact.state.status) : undefined;
  if (status !== undefined) out.status = status;
  if (typeof compact.title === 'string') out.title = clampTitle(compact.title).title;
  // #668 compacts to the retry fields; the two provenance stamps are read off
  // the same `details.current` it compacted. `updatedBy` is omitted when the
  // Server does not name one (an EntityDetail has no such field today) —
  // never defaulted to the caller.
  const raw = isRecord(err.details) && isRecord(err.details.current) ? err.details.current : {};
  const updatedAt = str(raw.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  const updatedBy = str(raw.updatedBy) ?? (isRecord(raw.updatedBy) ? str(raw.updatedBy.displayName) : undefined);
  if (updatedBy !== undefined) out.updatedBy = updatedBy;
  return out;
}

/**
 * The unchecked criteria, by their position in `acceptanceCriteria` (0-based
 * — the index an `entity update --content` of that array addresses).
 */
function incompleteOf(criteria: unknown): { rows: Rec[]; texts: string[]; count: number } | undefined {
  if (!Array.isArray(criteria)) return undefined;
  const all: { index: number; text: string }[] = [];
  criteria.forEach((c, index) => {
    if (!isRecord(c) || c.done === true) return;
    all.push({ index, text: typeof c.text === 'string' ? c.text : '' });
  });
  const kept = all.slice(0, INCOMPLETE_CAP);
  return {
    rows: kept.map((c) => ({ index: c.index, text: clampText(c.text, TEXT_MAX) })),
    texts: kept.map((c) => c.text),
    count: all.length,
  };
}

function prsOf(badges: unknown): { prs: Rec[]; prsCount?: number } | undefined {
  if (!Array.isArray(badges)) return undefined;
  const rows = badges.filter(isRecord).map((b) => ({
    id: b.entityId,
    url: b.url ?? null,
    state: b.state,
    ci: b.ciStatus ?? null,
  }));
  return rows.length > ROW_CAP ? { prs: rows.slice(0, ROW_CAP), prsCount: rows.length } : { prs: rows };
}

/**
 * Project one failure into its error receipt, or `undefined` when the failure
 * is not one a receipt reports (local usage errors, anything unclassified).
 * Pure: the gate read happens in `withErrorReceipt`, which passes its result.
 */
export function errorReceipt(err: unknown, input: ErrorReceiptInput, gate?: GateFacts): ErrorReceipt | undefined {
  const ambiguous = isAmbiguous(err);

  if (err instanceof TransportError || err instanceof ProtocolError) {
    if (!ambiguous) {
      // A non-retryable protocol failure is not a refusal the Server stated.
      const receipt = base(input, {
        code: 'protocol',
        message: clampText(err.message, MESSAGE_MAX),
        ...(err instanceof ProtocolError && err.status !== undefined ? { status: err.status } : {}),
        retryable: false,
      });
      if (input.callerMutationId && input.mutationId) receipt.mutationId = input.mutationId;
      return receipt;
    }
    return ambiguousReceipt(input, {
      code: err instanceof TransportError ? 'transport' : 'protocol',
      message: clampText(err.message, MESSAGE_MAX),
      ...(err instanceof ProtocolError && err.status !== undefined ? { status: err.status } : {}),
    });
  }

  if (!(err instanceof ApiError)) return undefined;

  if (ambiguous) {
    return ambiguousReceipt(input, {
      code: err.code,
      message: clampText(err.message, MESSAGE_MAX),
      requestId: err.requestId,
    });
  }

  const reason = err.reason;
  const error: Rec = { code: err.code };
  if (reason !== undefined) error.reason = reason;

  if (err.code === 'forbidden' || err.code === 'not_found') {
    // D4.4: who was refused, never what the row holds.
    const actor = (isRecord(err.details) ? str(err.details.actorId) : undefined) ?? input.actor;
    if (actor !== undefined) error.actor = actor;
    error.requestId = err.requestId;
    error.retryable = err.retryable;
    return withCallerMutationId(base(input, error), input);
  }

  if (err.code === 'version_conflict') {
    if (input.expectedVersion !== undefined) error.expectedVersion = input.expectedVersion;
    const currentVersion = err.currentVersion;
    if (currentVersion !== undefined) error.currentVersion = currentVersion;
    const current = currentOf(err);
    if (current !== undefined) error.current = current;
    error.requestId = err.requestId;
    error.retryable = err.retryable;
    const receipt = base(input, error);
    if (RETRY_ON_CONFLICT.has(input.op) && input.argv !== undefined) {
      receipt.next = retryCommand(input.op, input.argv, currentVersion);
    } else if (input.id !== undefined) {
      receipt.next = contextCommand(input.id);
    }
    return withCallerMutationId(receipt, input);
  }

  const gateReason = gateReasonOf(err);
  if (gateReason !== undefined) {
    let texts: string[] = [];
    let cut = false;
    if (gateReason === 'acceptance_criteria_incomplete') {
      const found = incompleteOf(gate?.criteria);
      if (found !== undefined) {
        error.incomplete = found.rows;
        error.incompleteCount = found.count;
        texts = found.texts;
        cut = found.rows.length < found.count;
      }
    }
    if (gateReason === 'gate_no_tracked_pr') error.prs = [];
    if (gateReason === 'gate_pr_unmerged_or_ci_red') {
      // An absent badge is NO CLAIM (an older node), so no `prs` is printed
      // rather than an emptiness the Server never asserted.
      const found = prsOf(gate?.pullRequests);
      if (found !== undefined) {
        Object.assign(error, found);
        cut = found.prsCount !== undefined || gate?.pullRequestsTruncated === true;
      }
    }
    error.requestId = err.requestId;
    error.retryable = err.retryable;
    const receipt = base(input, error);
    if (cut) receipt.truncated = true;
    if (input.id !== undefined) receipt.next = contextCommand(input.id);
    fitBudget(receipt, texts);
    return withCallerMutationId(receipt, input);
  }

  // Everything else the Server refused: its code, reason and message.
  error.message = clampText(err.message, MESSAGE_MAX);
  error.requestId = err.requestId;
  error.retryable = err.retryable;
  return withCallerMutationId(base(input, error), input);
}

function ambiguousReceipt(input: ErrorReceiptInput, error: Rec): ErrorReceipt {
  error.outcome = 'unknown';
  error.retryable = true;
  const receipt = base(input, error);
  // D4.7: ALWAYS echoed here, generated or not — it is what makes `next` safe.
  if (input.mutationId !== undefined) {
    receipt.mutationId = input.mutationId;
    if (input.argv !== undefined) receipt.next = replayCommand(input.argv, input.mutationId);
  }
  return receipt;
}

/** Outside the ambiguous case, `mutationId` appears only when the caller chose it. */
function withCallerMutationId(receipt: ErrorReceipt, input: ErrorReceiptInput): ErrorReceipt {
  if (input.callerMutationId && input.mutationId !== undefined) receipt.mutationId = input.mutationId;
  return receipt;
}

// ---------------------------------------------------------------------------
// The one call site shape every receipt command uses
// ---------------------------------------------------------------------------

/**
 * The single failure-path read for a gate refusal (D4.3): one `entities.get`
 * of the task, which carries both the criteria (`content.acceptanceCriteria`)
 * and the tracked PRs (`badges.pullRequests`). Best effort: a failed read
 * leaves the receipt without the rows, never replaces the original error.
 */
async function readGateFacts(client: Tm8Client, id: string): Promise<GateFacts> {
  try {
    const detail = await client.invoke<Rec>('entities.get', { params: { id } });
    const content = isRecord(detail?.content) ? detail.content : {};
    const badges = isRecord(detail?.badges) ? detail.badges : {};
    return {
      criteria: content.acceptanceCriteria,
      pullRequests: badges.pullRequests,
      pullRequestsTruncated: badges.pullRequestsTruncated === true,
    };
  } catch {
    return {};
  }
}

/**
 * The `ErrorReceiptInput` every receipt command starts from: its argv, the
 * actor it writes as, and whether the caller chose the mutation id.
 */
export function errorInput(
  cmd: CommandContext,
  op: ReceiptOp,
  extra: Pick<ErrorReceiptInput, 'id' | 'mutationId' | 'expectedVersion'> = {},
): ErrorReceiptInput {
  const input: ErrorReceiptInput = {
    op,
    callerMutationId: cmd.options.has('mutation-id'),
    ...extra,
  };
  if (cmd.argv !== undefined) input.argv = cmd.argv;
  if (cmd.ctx.actor !== undefined) input.actor = cmd.ctx.actor.value;
  return input;
}

/**
 * Run the ONE write a receipt command exists to make. On failure, print the
 * error receipt when this invocation prints receipts, then rethrow the
 * original error unchanged — the funnel still owns stderr and the exit code.
 */
export async function withErrorReceipt<T>(
  cmd: Pick<CommandContext, 'out' | 'ctx'>,
  input: ErrorReceiptInput,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (cmd.out.errorReceipts) {
      // `fresh`: one request on the wire, never a cache hit plus its
      // revalidation poll, and never criteria older than the refusal.
      const gate = needsGateRead(err, input)
        ? await readGateFacts(clientFor({ ...cmd.ctx, fresh: true }), input.id!)
        : undefined;
      const receipt = errorReceipt(err, input, gate);
      if (receipt !== undefined) cmd.out.errorReceipt(receipt);
    }
    throw err;
  }
}
