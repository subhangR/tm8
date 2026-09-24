/**
 * Forms W2 — delivering a submitted response (and a cancel notice) to the
 * session that asked (FORMS-DESIGN §7.2–7.3; migration 214).
 *
 * THE OUTBOX IS THE DURABLE PATH. Submit writes `form_deliveries(pending)` in
 * its own transaction; cancel's notice lands in `form_notices` by trigger.
 * Everything here drains those rows, and every entry point calls the SAME
 * claim (`public.claim_form_deliveries`), only with a narrower scope:
 *
 *   * the post-commit submit hook      → one response (the fast path);
 *   * the post-commit cancel hook      → the requesting session;
 *   * drain-on-live (SpawnService)     → one session, on resume success and on
 *                                        a running/idle transition;
 *   * the backstop tick                → everything, so a restart, a lost hook
 *                                        or a crash between steps still ends.
 *
 * Exactly-once per (response, session) is the claim's job, not this file's:
 * SKIP LOCKED plus a lease, `attempts + 1` as the delivery's attempt_no (UNIQUE
 * per message and target), and adoption of any reservation already in flight.
 * So a submit REPLAY, a re-fired hook, or two drains racing each other all
 * reach the terminal once.
 *
 * Settlement is ASYNC and not here: a row turns `delivered` only when its
 * session_message_deliveries row settles `delivered` (214 F's trigger) — or
 * `unknown`, which is AT MOST ONCE: the bytes may have reached the PTY, so it
 * settles delivered with `last_error = delivery_unverified: …` rather than
 * risk handing the agent the same answer twice.
 *
 * THE SEAM. A claimed row whose session is not live — or whose target is a new
 * session — goes to `dispatchNotLiveDelivery`, which switches on
 * `settings.delivery`. This file implements `queue` (leave it pending; the
 * drain-on-live hook delivers it) and `cancelled` (session deleted, decided in
 * SQL). `resume`, `spawn_new` and `new_session` are handlers the Spawn-modes
 * worker supplies through `notLive`; until one exists, the claim is never asked
 * for that mode (`routeModes`), so such a row waits exactly as `queue` does.
 *
 * AUTHORITY (coordinator ruling): the server's own claims deliver, resume and
 * spawn — not the respondent's, who may not be allowed to touch the session.
 * `claimed_by` records it on the row.
 */
import { formSessionInputInjection, type FormSessionInputKind } from '@tm8/prompt';

import type { Db, DbClaims } from '../../../db/types.js';
import type { JobOutcome, ScheduledJob } from '../../../scheduler/types.js';
import {
  dispatchSessionMessages,
  type DispatchableRoute,
  type MessageDeliveryPort,
} from './message-dispatch.js';

export const FORM_DELIVERY_JOB_NAME = 'forms.deliveries';

export type FormDeliveryTarget = 'requesting_session' | 'new_session';
export type FormSessionNotLiveMode = 'resume' | 'queue' | 'spawn_new';
/** The modes a not-live handler can own. `queue` needs none: it waits. */
export type FormRouteMode = 'resume' | 'spawn_new' | 'new_session';

export interface FormDeliverySettings {
  readonly target: FormDeliveryTarget;
  readonly onSessionNotLive: FormSessionNotLiveMode;
}

/** One row as `claim_form_deliveries` hands it out, already claimed. */
export interface ClaimedFormDelivery {
  readonly kind: 'response' | 'notice';
  /** `inject`: the session is live, send it. `route`: the seam decides. */
  readonly purpose: 'inject' | 'route';
  readonly responseId: string | null;
  /** The session copy of the message. */
  readonly messageId: string;
  readonly formId: string;
  readonly workSessionId: string;
  /** This attempt's number: session_message_deliveries.attempt_no. */
  readonly attemptNo: number;
  readonly sessionStatus: string | null;
  readonly delivery: FormDeliverySettings;
  readonly form: { readonly status: string; readonly structureVersion: number };
  readonly response: {
    readonly revision: number;
    readonly supersedesId: string | null;
    readonly submittedAt: string | null;
    readonly answered: number;
    readonly total: number;
  } | null;
  /** Present exactly when `purpose` is `inject`. */
  readonly route: DispatchableRoute | null;
}

// -- the seam ------------------------------------------------------------------

/** What a not-live handler did with a claimed row. */
export type NotLiveOutcome =
  /** Nothing to do now (queue, or a mode with no handler): wait for live. */
  | { readonly kind: 'left_pending'; readonly reason: string }
  /** Tried and failed; the claim is freed for the next drain. */
  | { readonly kind: 'released'; readonly error: string }
  /** It can never be delivered; settle it cancelled. */
  | { readonly kind: 'cancelled'; readonly reason: string }
  /**
   * Handed to another session. The HANDLER settles the row `spawned` (with
   * `spawned_session_id`) in the same step that spawned it; the drain only
   * records the outcome. `resume` answers `left_pending` after a successful
   * resume instead: the drain-on-live hook then injects the row normally.
   */
  | { readonly kind: 'spawned'; readonly spawnedSessionId: string }
  /**
   * The handler already wrote the row's next state itself (a backoff, or a
   * resume that released the row before resuming so drain-on-live could claim
   * it). The drain writes nothing, which a release here would overwrite.
   */
  | { readonly kind: 'handled'; readonly reason: string };

export interface NotLiveContext {
  readonly db: Db;
  /** The server's claims (coordinator ruling), not the respondent's. */
  readonly claims: DbClaims;
  /** Deliver a session's pending rows, e.g. right after a resume. */
  readonly drainSession: (workSessionId: string) => Promise<FormDrainResult>;
}

export type NotLiveHandler = (row: ClaimedFormDelivery, ctx: NotLiveContext) => Promise<NotLiveOutcome>;

/** Filled by the Spawn-modes worker. Absent handler = the mode waits like queue. */
export type NotLiveHandlers = Partial<Record<FormRouteMode, NotLiveHandler>>;

/** Which mode governs a row that is not being injected. */
export function notLiveModeOf(delivery: FormDeliverySettings): FormRouteMode | 'queue' {
  return delivery.target === 'new_session' ? 'new_session' : delivery.onSessionNotLive;
}

/**
 * THE SEAM: given a pending delivery whose session is not live (or whose target
 * is a new session), act on `settings.delivery`. `queue` leaves it pending;
 * the others go to their handler, and a mode with no handler waits too.
 * A deleted session never reaches here for resume/queue — the claim cancels
 * those rows in SQL (214 D2).
 */
export async function dispatchNotLiveDelivery(
  row: ClaimedFormDelivery,
  handlers: NotLiveHandlers,
  ctx: NotLiveContext,
): Promise<NotLiveOutcome> {
  const mode = notLiveModeOf(row.delivery);
  if (mode === 'queue') return { kind: 'left_pending', reason: 'queued' };
  const handler = handlers[mode];
  if (!handler) return { kind: 'left_pending', reason: `${mode}_not_implemented` };
  return handler(row, ctx);
}

/**
 * Stubs for the stacked Spawn-modes worker, deliberately NOT wired: an empty
 * `notLive` keeps these modes out of `routeModes`, so the claim never hands
 * such a row out. Replace each with the real handler and pass it in.
 */
export const SPAWN_MODE_STUBS: Required<NotLiveHandlers> = {
  resume: async () => ({ kind: 'left_pending', reason: 'resume_not_implemented' }),
  spawn_new: async () => ({ kind: 'left_pending', reason: 'spawn_new_not_implemented' }),
  new_session: async () => ({ kind: 'left_pending', reason: 'new_session_not_implemented' }),
};

// -- the drain -----------------------------------------------------------------

export interface FormDrainScope {
  readonly responseId?: string;
  readonly workSessionId?: string;
}

export interface FormDrainResult {
  claimed: number;
  /** Reserved and handed to the terminal; settles later. */
  accepted: number;
  released: number;
  cancelled: number;
  leftPending: number;
  spawned: number;
  failed: string[];
}

export interface FormDeliveryDrainOptions {
  readonly db: Db;
  /** The server's own claims (the owner), as the nudge jobs use. */
  readonly claims: () => Promise<DbClaims>;
  /** Absent: no delivery runtime, so nothing is claimed and rows wait. */
  readonly delivery?: MessageDeliveryPort;
  readonly notLive?: NotLiveHandlers;
  /** Rows per claim. */
  readonly limit?: number;
  readonly leaseSeconds?: number;
}

/** Reasons after which another attempt cannot succeed (214's list, mirrored). */
const PERMANENT = new Set([
  'delivery_envelope_budget_exceeded',
  'delivery_envelope_render_failed',
  'session_input_not_allowed',
  'self_delivery',
]);

export class FormDeliveryDrain {
  private readonly routeModes: FormRouteMode[];

  constructor(private readonly options: FormDeliveryDrainOptions) {
    this.routeModes = (Object.keys(options.notLive ?? {}) as FormRouteMode[])
      .filter((mode) => typeof options.notLive?.[mode] === 'function');
  }

  /**
   * Post-commit submit hook. Replays re-fire it; the claim makes that safe.
   * The drain is NOT awaited: a spawn-mode row resumes or spawns a session
   * (first-prompt settlement can take minutes), and the respondent's submit
   * must not wait on it. No `workSessionId` still drains: a session deleted
   * before submit has none, yet a spawn-mode row for it is pending (214 C).
   */
  readonly onResponseSubmitted = async (event: { responseId: string; workSessionId: string | null }): Promise<void> => {
    void this.drain({ responseId: event.responseId }).catch((error: unknown) => {
      console.error('[forms] delivery drain after submit failed', error);
    });
  };

  /** Post-commit cancel hook: the notice (and anything else pending) for the requester. */
  readonly onFormCancelled = async (event: { formId: string }): Promise<void> => {
    const claims = await this.options.claims();
    const rows = await this.options.db.query<{ work_session_id: string }>(
      claims,
      `select distinct work_session_id from public.form_notices where form_id = $1 and status = 'pending'`,
      [event.formId],
    );
    for (const row of rows) await this.drain({ workSessionId: row.work_session_id });
  };

  /** Drain-on-live: resume success, or a running/idle transition. */
  readonly onSessionLive = async (workSessionId: string): Promise<void> => {
    await this.drain({ workSessionId });
  };

  async drain(scope: FormDrainScope = {}): Promise<FormDrainResult> {
    const result: FormDrainResult = {
      claimed: 0, accepted: 0, released: 0, cancelled: 0, leftPending: 0, spawned: 0, failed: [],
    };
    const delivery = this.options.delivery;
    // No runtime means no terminal to write to. Claiming would only churn the
    // lease; the rows stay pending, which is the truth.
    if (!delivery) return result;

    const claims = await this.options.claims();
    const claimed = await this.options.db.rpc<{ items?: unknown; cancelled?: unknown }>(
      claims,
      'public.claim_form_deliveries',
      [
        scope.responseId ?? null,
        scope.workSessionId ?? null,
        this.options.limit ?? 25,
        this.options.leaseSeconds ?? 120,
        this.routeModes,
      ],
    );
    result.cancelled += typeof claimed?.cancelled === 'number' ? claimed.cancelled : 0;
    const items = normalizeClaimedFormDeliveries(claimed?.items);
    result.claimed = items.length;

    for (const item of items) {
      try {
        if (item.purpose === 'inject' && item.route) {
          await this.inject(item, item.route, delivery, claims, result);
        } else {
          await this.route(item, claims, result);
        }
      } catch (error) {
        result.failed.push(`${item.kind}/${keyOf(item)}: ${describe(error)}`);
        // The lease expires on its own; releasing early just saves the wait.
        await this.release(claims, item, describe(error), false).catch(() => {});
      }
    }
    return result;
  }

  private async inject(
    item: ClaimedFormDelivery,
    route: DispatchableRoute,
    delivery: MessageDeliveryPort,
    claims: DbClaims,
    result: FormDrainResult,
  ): Promise<void> {
    const kind: FormSessionInputKind = item.kind === 'response' ? 'form_response' : 'form_cancelled';
    const facts = {
      kind,
      messageId: route.targetMessageId,
      messageBatchId: route.messageBatchId,
      deliveryAttemptNo: item.attemptNo,
      senderActorId: route.senderActorId,
      senderActorKind: route.senderActorKind,
      destinationSessionId: item.workSessionId,
      formId: item.formId,
      formStatus: item.form.status,
      structureVersion: item.form.structureVersion,
      sourceMessageId: route.sourceMessageId,
      ...(item.response && item.responseId
        ? {
            response: {
              id: item.responseId,
              submittedAt: item.response.submittedAt,
              answered: item.response.answered,
              of: item.response.total,
              revision: item.response.revision,
              supersedesId: item.response.supersedesId,
            },
          }
        : {}),
      body: route.body,
      // The submit door cut the stored body at 10k and appended its pointer (211).
      truncated: item.responseId !== null && route.body.endsWith(doorTruncationSuffix(item.responseId)),
      maxBytes: route.rollingControlMaxBytes,
    };
    const [disposition] = await dispatchSessionMessages({
      routes: [{
        ...route,
        attemptNo: item.attemptNo,
        renderEnvelope: (deliveryAttemptId) => formSessionInputInjection({ ...facts, deliveryAttemptId }),
      }],
      parentsById: new Map(),
      requestId: `forms-delivery:${keyOf(item)}:${item.attemptNo}`,
      // A loop is not a session; the author is the respondent (see the envelope).
      sourceWorkSessionId: null,
      senderAttribution: 'verified',
      delivery,
    });
    if (disposition?.status === 'accepted' && disposition.deliveryId) {
      await this.options.db.rpc(claims, 'public.record_form_delivery_attempt', [
        item.kind, keyOf(item), item.workSessionId, disposition.deliveryId,
      ]);
      result.accepted += 1;
      return;
    }
    const reason = disposition?.reason ?? 'no_disposition';
    const final = PERMANENT.has(reason);
    await this.release(claims, item, reason, final);
    if (final) result.cancelled += 1;
    else result.released += 1;
  }

  private async route(item: ClaimedFormDelivery, claims: DbClaims, result: FormDrainResult): Promise<void> {
    const outcome = await dispatchNotLiveDelivery(item, this.options.notLive ?? {}, {
      db: this.options.db,
      claims,
      drainSession: (workSessionId) => this.drain({ workSessionId }),
    });
    switch (outcome.kind) {
      case 'spawned':
        result.spawned += 1;
        return;
      case 'cancelled':
        await this.release(claims, item, outcome.reason, true);
        result.cancelled += 1;
        return;
      case 'released':
        await this.release(claims, item, outcome.error, false);
        result.released += 1;
        return;
      case 'left_pending':
        await this.release(claims, item, outcome.reason, false);
        result.leftPending += 1;
        return;
      case 'handled':
        result.leftPending += 1;
        return;
    }
  }

  private async release(claims: DbClaims, item: ClaimedFormDelivery, error: string, final: boolean): Promise<void> {
    await this.options.db.rpc(claims, 'public.release_form_delivery', [
      item.kind, keyOf(item), item.workSessionId, error.slice(0, 200), final,
    ]);
  }
}

// -- the backstop tick ---------------------------------------------------------

export function createFormDeliveryJob(options: {
  readonly drain: FormDeliveryDrain;
  readonly intervalMs?: number;
}): ScheduledJob {
  return {
    name: FORM_DELIVERY_JOB_NAME,
    // The hooks are the fast path; this only has to bound the wait after a
    // restart, a lost hook or a status change that fired no hook.
    intervalMs: options.intervalMs ?? 15_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 60_000,
    async run(): Promise<JobOutcome> {
      const drained = await options.drain.drain();
      if (drained.claimed === 0 && drained.cancelled === 0) {
        return { skipped: true, reason: 'no deliverable form responses' };
      }
      return {
        affected: drained.accepted + drained.cancelled,
        detail: { ...drained, failed: drained.failed.slice(0, 10) },
      };
    },
  };
}

// -- parsing -------------------------------------------------------------------

/** What 211's submit door appends to a body it cut (`p_truncated`). */
export function doorTruncationSuffix(responseId: string): string {
  return `\n… truncated. Full response: tm8 form response get ${responseId} --format json`;
}

function keyOf(item: ClaimedFormDelivery): string {
  return item.kind === 'response' ? item.responseId ?? item.messageId : item.messageId;
}

const TARGETS: ReadonlySet<string> = new Set(['requesting_session', 'new_session']);
const MODES: ReadonlySet<string> = new Set(['resume', 'queue', 'spawn_new']);

export function normalizeClaimedFormDeliveries(raw: unknown): ClaimedFormDelivery[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaimedFormDelivery[] = [];
  for (const value of raw) {
    if (value === null || typeof value !== 'object') continue;
    const r = value as Record<string, any>;
    if ((r.kind !== 'response' && r.kind !== 'notice') || (r.purpose !== 'inject' && r.purpose !== 'route')) continue;
    if (typeof r.messageId !== 'string' || typeof r.formId !== 'string' || typeof r.workSessionId !== 'string') continue;
    const d = (r.delivery ?? {}) as Record<string, unknown>;
    out.push({
      kind: r.kind,
      purpose: r.purpose,
      responseId: typeof r.responseId === 'string' ? r.responseId : null,
      messageId: r.messageId,
      formId: r.formId,
      workSessionId: r.workSessionId,
      attemptNo: typeof r.attemptNo === 'number' ? r.attemptNo : 1,
      sessionStatus: typeof r.sessionStatus === 'string' ? r.sessionStatus : null,
      delivery: {
        target: TARGETS.has(String(d.target)) ? (d.target as FormDeliveryTarget) : 'requesting_session',
        onSessionNotLive: MODES.has(String(d.onSessionNotLive)) ? (d.onSessionNotLive as FormSessionNotLiveMode) : 'resume',
      },
      form: {
        status: String(r.form?.status ?? 'open'),
        structureVersion: Number(r.form?.structureVersion ?? 1),
      },
      response: r.response && typeof r.response === 'object'
        ? {
            revision: Number(r.response.revision ?? 1),
            supersedesId: typeof r.response.supersedesId === 'string' ? r.response.supersedesId : null,
            submittedAt: r.response.submittedAt == null ? null : String(r.response.submittedAt),
            answered: Number(r.response.answered ?? 0),
            total: Number(r.response.total ?? 0),
          }
        : null,
      route: r.purpose === 'inject' && r.route && typeof r.route === 'object'
        ? (r.route as DispatchableRoute)
        : null,
    });
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
