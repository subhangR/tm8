/**
 * `tm8 form wait <form-id> [--timeout S] [--since <response-id|timestamp>]`
 * (FORMS-DESIGN §7.4) — block until a NEW submitted response exists, or the
 * form reaches `closed` or `cancelled`.
 *
 * A CLI LOOP, NOT AN OPERATION. It composes four existing reads and adds no
 * catalog row and no Server code:
 *
 *   events.changes      the wake signal: `--entity <form> --events`,
 *                       index-backed, so a quiet poll is one small page. A
 *                       submit records an activity on the form and a
 *                       transition upserts it, so both land in its subject set.
 *   forms.responses.list  the truth: current submitted rows, newest first.
 *   entities.get        the form's status (the terminal check).
 *   forms.responses.get   the printed answer (a FormResponseView).
 *
 * The feed only decides WHEN to re-read; what the command prints is always
 * decided by the two reads. The state is also re-read every
 * STATE_REREAD_MS whatever the feed says (the bounded fallback), and if the
 * feed refuses (index_incomplete, not_implemented, a node without it) the loop
 * polls the reads alone with a 1s -> 10s backoff.
 *
 * ORDER MATTERS: a new response is looked for BEFORE the status, because
 * `closeOnSubmit` closes the form in the submit's own transaction — the answer
 * that closed it must win over the close.
 *
 * NO CLIENT CLOCK. "New" is judged against the Server's `submittedAt`: the
 * baseline is the newest submitted response when the command starts (or the
 * `--since` response / timestamp). The OLDEST new response is printed, so
 * `--since <printed-id>` chains waits without skipping one.
 *
 * Terminal detection reads the form's status only. The cancel REASON is then
 * read best-effort from the `form_cancelled` message on the form, as DATA: it
 * is printed as a JSON string field (or one quoted human line) and never
 * interpolated into a command. A missing or unreadable reason is still exit 15.
 *
 * BOUNDED BY DEFAULT. `--timeout` (the global, read as the wait's lifetime as
 * `event watch` reads it) defaults to 600s and is capped at 3600s: an agent
 * that forgets the flag must not hang forever.
 */
import type { FormResponsePage, FormResponseView } from '@tm8/contract';
import type { CliContext } from '../context.js';
import { ApiError, TransportError } from '../errors.js';
import {
  CliError,
  EXIT_FORM_TERMINAL,
  EXIT_OK,
  EXIT_RETRYABLE,
  EXIT_USAGE,
  EXIT_WAIT_TIMEOUT,
  type ExitCode,
} from '../exit.js';
import { Tm8Client } from '../client.js';
import { observedInvoke } from '../discovery/observe.js';
import { requireSpace } from '../context.js';
import type { CommandContext } from '../run.js';
import { renderResponse } from './form.js';

/** The statuses that end a wait: no response can arrive in either without a human reopening. */
export const TERMINAL_FORM_STATUSES: readonly string[] = ['closed', 'cancelled'];

/** Feed backoff: a quiet form is asked 1s, 2s, 4s, then every 5s; any change resets it. */
export const FEED_BACKOFF_MS = { initial: 1_000, cap: 5_000 } as const;
/** Poll-only backoff (no feed): 1s doubling to a 10s cap. */
export const POLL_BACKOFF_MS = { initial: 1_000, cap: 10_000 } as const;
/** The bounded fallback: the state is re-read at least this often even when the feed is quiet. */
export const STATE_REREAD_MS = 30_000;
/** One request never hangs longer than this. */
const REQUEST_CAP_MS = 30_000;
/**
 * …and is never given less than this, even on the deadline tick: a read
 * clamped to the last second of a wait is a spurious timeout on a slow Server
 * (measured in CI: a 1000ms entities.get). The wait may overrun --timeout by it.
 */
export const REQUEST_MIN_MS = 5_000;
/** Pages of the response list read per check before giving up on finding the baseline. */
const MAX_LIST_PAGES = 10;
const LIST_PAGE = 50;
/** `--timeout` absent: the §7.4 example's 600s. */
export const DEFAULT_WAIT_SECONDS = 600;
/** Longer waits belong to a scheduler re-invoking the command. */
export const MAX_WAIT_SECONDS = 3_600;
/** How many of the form's newest messages are searched for the cancel notice. */
const CANCEL_SCAN = 20;

/** What "new" is measured against. `tieIds` null means strictly after `at`. */
export interface WaitBaseline {
  /** Epoch ms of the Server's `submittedAt`, or null when there was no response at all. */
  at: number | null;
  /** Ids already seen AT `at` (same millisecond); null for a `--since <timestamp>`. */
  tieIds: ReadonlySet<string> | null;
  /** The resume token for the timeout hint: a response id or an ISO timestamp. */
  resume: string | null;
}

export interface FeedView {
  through: number;
  changed: boolean;
}

/** The wire, injected so the loop is testable without a Server or a clock. */
export interface FormWaitDeps {
  /** One page of forms.responses.list (current submitted rows, newest first). */
  listPage(cursor: string | undefined, timeoutMs: number): Promise<FormResponsePage>;
  getResponse(id: string, timeoutMs: number): Promise<FormResponseView>;
  /** The form's lifecycle status (entities.get content arm). */
  formStatus(timeoutMs: number): Promise<string>;
  /** Bodies of the form's newest messages (messages.list), for the cancel reason. */
  formMessages(timeoutMs: number): Promise<string[]>;
  /** events.changes scoped to the form. Throws when the feed is unavailable. */
  changes(after: number, timeoutMs: number): Promise<FeedView>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** One stderr line; the loop says once when it drops to polling. */
  warn(line: string): void;
}

export type WaitOutcome =
  | { kind: 'answered'; response: FormResponseView }
  | { kind: 'terminal'; status: string; reason: string | null }
  | { kind: 'timeout'; resume: string | null };

export const EXIT_BY_OUTCOME: Record<WaitOutcome['kind'], ExitCode> = {
  answered: EXIT_OK,
  terminal: EXIT_FORM_TERMINAL,
  timeout: EXIT_WAIT_TIMEOUT,
};

/** A transport blip (a dropped socket, a per-request deadline) or a retryable refusal: the next tick may succeed. */
function isRetryable(err: unknown): boolean {
  if (err instanceof TransportError) return true;
  return (err instanceof ApiError || err instanceof CliError) && err.exitCode === EXIT_RETRYABLE;
}

function isNew(r: FormResponseView, base: WaitBaseline): boolean {
  if (r.status !== 'submitted' || r.submittedAt === null) return false;
  if (base.at === null) return true;
  const t = Date.parse(r.submittedAt);
  if (t > base.at) return true;
  return t === base.at && base.tieIds !== null && !base.tieIds.has(r.id);
}

/**
 * The oldest new submitted response, or undefined. Pages newest-first and
 * stops at the first row at or before the baseline.
 */
export async function findNew(
  deps: Pick<FormWaitDeps, 'listPage'>,
  base: WaitBaseline,
  timeoutMs: number,
): Promise<FormResponseView | undefined> {
  const fresh: FormResponseView[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const p = await deps.listPage(cursor, timeoutMs);
    let reachedBaseline = false;
    for (const r of p.items) {
      if (isNew(r, base)) fresh.push(r);
      else if (r.submittedAt !== null && base.at !== null && Date.parse(r.submittedAt) < base.at) reachedBaseline = true;
    }
    if (reachedBaseline || !p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return fresh.at(-1);
}

/**
 * The reason line of this form's `form_cancelled` notice (211's
 * `transition_form`: `form_cancelled: <title>\nform: <id>\nreason: <text>`),
 * or null. Best-effort and DATA only: the text is the canceller's, it is
 * returned verbatim and never reaches a command line.
 */
export function parseCancelReason(bodies: readonly string[], formId: string): string | null {
  const marker = `\nform: ${formId}\nreason: `;
  for (const body of bodies) {
    if (!body.startsWith('form_cancelled: ')) continue;
    const at = body.lastIndexOf(marker);
    if (at < 0) continue;
    const reason = body.slice(at + marker.length);
    return reason.length > 0 ? reason : null;
  }
  return null;
}

/** The baseline when no `--since` is given: the newest submitted response right now. */
export async function currentBaseline(
  deps: Pick<FormWaitDeps, 'listPage'>,
  timeoutMs: number,
): Promise<WaitBaseline> {
  const page = await deps.listPage(undefined, timeoutMs);
  const newest = page.items.find((r) => r.status === 'submitted' && r.submittedAt !== null);
  if (newest === undefined) return { at: null, tieIds: new Set(), resume: null };
  const at = Date.parse(newest.submittedAt as string);
  const tieIds = new Set(page.items.filter((r) => r.submittedAt !== null && Date.parse(r.submittedAt) === at).map((r) => r.id));
  return { at, tieIds, resume: newest.id };
}

/**
 * Drive one wait to its outcome. `deadline` is epoch ms on `deps.now()`'s
 * clock; a wait is always bounded.
 *
 * ONLY THE DEADLINE ENDS A WAIT WITH 13. A per-request timeout or a dropped
 * socket inside the loop (a slow Server) is "no news this tick", never exit 7:
 * the loop backs off and asks again, and the tick that reaches the deadline
 * re-reads once with a full REQUEST_MIN_MS of its own (overrunning --timeout
 * by at most that). A non-transient refusal (not_found, forbidden, …) still
 * ends the wait with its own code.
 */
export async function runFormWait(
  deps: FormWaitDeps,
  formId: string,
  base: WaitBaseline,
  deadline: number,
): Promise<WaitOutcome> {
  /** Never less than REQUEST_MIN_MS, even past the deadline: a clamped 1s read on a slow Server is a spurious miss. */
  const budget = (): number => Math.min(REQUEST_CAP_MS, Math.max(REQUEST_MIN_MS, deadline - deps.now()));

  // The feed: 'seed' until its position is known (a transient failure retries
  // the seed next tick), 'live' with a position, 'off' after a real refusal.
  type FeedState = 'seed' | 'live' | 'off';
  let feed = 'seed' as FeedState;
  let through = 0;
  const feedStep = async (): Promise<boolean> => {
    try {
      const view = await deps.changes(through, budget());
      const changed = feed === 'live' && view.changed;
      through = view.through;
      feed = 'live';
      return changed;
    } catch (err) {
      if (isRetryable(err)) return true; // a blip: the reads decide this tick
      if (err instanceof ApiError || err instanceof CliError) {
        feed = 'off';
        deps.warn('`tm8 form wait`: the change feed is unavailable — polling the form instead');
        return true;
      }
      throw err;
    }
  };

  const check = async (): Promise<WaitOutcome | undefined> => {
    const found = await findNew(deps, base, budget());
    if (found !== undefined) return { kind: 'answered', response: await deps.getResponse(found.id, budget()) };
    const status = await deps.formStatus(budget());
    if (TERMINAL_FORM_STATUSES.includes(status)) {
      let reason: string | null = null;
      if (status === 'cancelled') {
        try {
          reason = parseCancelReason(await deps.formMessages(budget()), formId);
        } catch {
          reason = null; // best-effort: the status already decided the outcome
        }
      }
      return { kind: 'terminal', status, reason };
    }
    return undefined;
  };
  /** One state read; a transient failure is "no news" (undefined), anything else is the answer. */
  const tryCheck = async (): Promise<WaitOutcome | undefined> => {
    try {
      return await check();
    } catch (err) {
      if (isRetryable(err)) return undefined;
      throw err;
    }
  };

  // The feed position is taken BEFORE the first state read, so nothing that
  // lands between the two can be missed.
  await feedStep();
  let outcome = await tryCheck();
  if (outcome !== undefined) return outcome;
  let lastCheck = deps.now();
  let delay: number = feed === 'off' ? POLL_BACKOFF_MS.initial : FEED_BACKOFF_MS.initial;

  for (;;) {
    if (deps.now() >= deadline) return { kind: 'timeout', resume: base.resume };
    await deps.sleep(Math.min(delay, deadline - deps.now()));
    // The tick that reaches the deadline re-reads the state once more, so an
    // answer landing in the last backoff interval is not reported as a timeout.
    const lastTick = deps.now() >= deadline;

    let reread = feed !== 'live' || lastTick || deps.now() - lastCheck >= STATE_REREAD_MS;
    if (feed !== 'off' && !lastTick && (await feedStep())) reread = true;

    if (reread) {
      outcome = await tryCheck();
      lastCheck = deps.now();
      if (outcome !== undefined) return outcome;
      // A live feed re-arms at 1s after a re-read; without one (off, or a seed
      // still failing) the reads back off 1s -> 10s.
      delay = feed === 'live' ? FEED_BACKOFF_MS.initial : Math.min(delay * 2, POLL_BACKOFF_MS.cap);
    } else {
      delay = Math.min(delay * 2, FEED_BACKOFF_MS.cap);
    }
  }
}

// ── the command ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh client: every read in the loop must reach the Server, never the read-cache. */
function freshClient(ctx: CliContext): Tm8Client {
  return new Tm8Client({ baseUrl: ctx.baseUrl.value, token: ctx.token, timeoutMs: ctx.timeoutMs, fresh: true, gapRetryMs: ctx.gapRetryMs });
}

export function wireDeps(cmd: CommandContext, formId: string): FormWaitDeps {
  const client = freshClient(cmd.ctx);
  const spaceId = requireSpace(cmd.ctx);
  return {
    listPage: (cursor, timeoutMs) =>
      observedInvoke<FormResponsePage>(client, 'forms.responses.list', {
        params: { formId },
        query: { limit: String(LIST_PAGE), cursor },
        timeoutMs,
      }),
    getResponse: (responseId, timeoutMs) =>
      observedInvoke<FormResponseView>(client, 'forms.responses.get', { params: { responseId }, timeoutMs }),
    formStatus: async (timeoutMs) => {
      const detail = await observedInvoke<unknown>(client, 'entities.get', { params: { id: formId }, timeoutMs });
      const content = (detail as { content?: { kind?: unknown; status?: unknown } } | null)?.content;
      if (content?.kind !== 'form') {
        throw new CliError(`${formId} is not a form`, EXIT_USAGE, { hint: 'check the id with `tm8 entity context <id>`' });
      }
      return String(content.status);
    },
    formMessages: async (timeoutMs) => {
      const page = await observedInvoke<{ items?: Array<{ content?: { body?: unknown } }> }>(client, 'messages.list', {
        params: { anchorId: formId },
        query: { order: 'newest', limit: String(CANCEL_SCAN) },
        timeoutMs,
      });
      return (page.items ?? []).map((m) => m.content?.body).filter((b): b is string => typeof b === 'string');
    },
    changes: async (after, timeoutMs) => {
      // Thin rows (`events=true`), not the digest: the digest folds a submit
      // away (its message and its `updated` activity roll up to nothing, so
      // `changed` stays []), while the thin rows carry the form's
      // activity.created — measured on a real Server.
      const view = await client.invoke<{ through: number; more?: boolean; gap?: unknown; events?: unknown[] }>(
        'events.changes',
        { params: { spaceId }, query: { entity: formId, after: String(after), events: 'true' }, timeoutMs },
      );
      const changed = (Array.isArray(view.events) && view.events.length > 0) || view.more === true || (view.gap ?? null) !== null;
      return { through: view.through, changed };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    warn: (line) => cmd.out.warn(line),
  };
}

/** `--since`: a response id (its submittedAt) or an ISO timestamp (strictly after). */
async function sinceBaseline(deps: FormWaitDeps, formId: string, raw: string): Promise<WaitBaseline> {
  if (UUID_RE.test(raw)) {
    const r = await deps.getResponse(raw, REQUEST_CAP_MS);
    if (r.formId !== formId) throw new CliError(`--since ${raw} is a response to form ${r.formId}, not ${formId}`, EXIT_USAGE);
    if (r.submittedAt === null) throw new CliError(`--since ${raw} is a draft; name a submitted response or a timestamp`, EXIT_USAGE);
    return { at: Date.parse(r.submittedAt), tieIds: new Set([r.id]), resume: r.id };
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    throw new CliError(`--since expects a <response-id> or an ISO timestamp, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return { at, tieIds: null, resume: new Date(at).toISOString() };
}

export async function formWait(cmd: CommandContext): Promise<ExitCode> {
  const formId = cmd.args[0];
  if (formId === undefined || formId.length === 0) {
    throw new CliError('tm8 form wait requires <form-id>', EXIT_USAGE, { hint: 'tm8 help form wait' });
  }
  const timeoutMs = cmd.ctx.timeoutMs ?? DEFAULT_WAIT_SECONDS * 1_000;
  if (timeoutMs > MAX_WAIT_SECONDS * 1_000) {
    throw new CliError(
      `--timeout ${Math.round(timeoutMs / 1_000)}s exceeds the ${MAX_WAIT_SECONDS}s cap for \`tm8 form wait\``,
      EXIT_USAGE,
      { hint: 'chain bounded waits with --since <last-response-id>, or let the answer arrive as a message' },
    );
  }
  const deps = wireDeps(cmd, formId);
  const since = cmd.options.value('since');
  const base = since === undefined ? await currentBaseline(deps, REQUEST_CAP_MS) : await sinceBaseline(deps, formId, since);
  const deadline = deps.now() + timeoutMs;

  const outcome = await runFormWait(deps, formId, base, deadline);
  switch (outcome.kind) {
    case 'answered':
      cmd.out.data(outcome.response, renderResponse);
      break;
    case 'terminal':
      // The reason is the canceller's text: a JSON string field, or one
      // JSON-quoted human line — never interpolated unquoted.
      cmd.out.data({ formId, status: outcome.status, reason: outcome.reason }, () =>
        `form ${formId} is ${outcome.status}: no new response arrived (exit ${EXIT_FORM_TERMINAL})` +
          (outcome.reason === null ? '' : `\nreason (untrusted): ${JSON.stringify(outcome.reason)}`));
      break;
    case 'timeout': {
      const seconds = Math.round(timeoutMs / 1_000);
      const resume = `tm8 form wait ${formId} --timeout ${seconds}` + (outcome.resume === null ? '' : ` --since ${outcome.resume}`);
      cmd.out.warn(`no new response to form ${formId} within ${seconds}s (exit ${EXIT_WAIT_TIMEOUT}); resume without a gap: ${resume}`);
      break;
    }
  }
  return EXIT_BY_OUTCOME[outcome.kind];
}
