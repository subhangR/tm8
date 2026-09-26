/**
 * Attention v2 — the note delivery sweep (spec chapter 3, "Resolve with undo,
 * then delivery").
 *
 * A Resolve settles its rows at once and stamps `note_deliver_after = now +
 * 8s`. Every ~2s this job asks `list_due_attention_notes` for batches past
 * their window, and posts each through `deliver_attention_batch` (256): one
 * message per target anchor — the raising session or chat while it is live,
 * the roll-up root once it has ended or when there is none — authored by the
 * RESOLVER, with `note_message_id` recorded on the rows. An Undo inside the
 * window reopens the rows, so they are never due and nothing is posted.
 *
 * WHOSE CREDENTIAL. The note is the resolver's words, so it is posted under
 * the resolver's own identity (`resolverIdentityId`, off the member row). A
 * teammate resolver (Q15: agents may, by convention not) has no identity of
 * its own; the node owner's claims act as that teammate, which `can_act_as`
 * allows for any active member.
 *
 * AFTER COMMIT, exactly like `messages.post`: the routes are recorded and
 * dispatched to PTYs (a work-session anchor, or every live session working on
 * a task anchor), and a chat anchor's agent is woken.
 */
import type { Db, DbClaims } from '../../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../../../scheduler/types.js';
import type { NudgeDispatcher } from '../../../tracking/nudges.js';

export const ATTENTION_DELIVERY_JOB_NAME = 'attention.note-delivery';

export interface AttentionDeliveryJobOptions {
  db: Db;
  /** The node owner's claims: lists due batches, and acts for teammate resolvers. */
  ownerClaims: () => Promise<DbClaims>;
  /** The same PTY dispatch the nudge loops use; absent without an execution runtime. */
  dispatch?: NudgeDispatcher;
  /** Post-commit chat wake (176): run the chat's next turn as its configuring member. */
  wakeChat?: (chatId: string, requesterIdentityId: string) => void;
  /** Batches per tick. */
  budget?: number;
  intervalMs?: number;
}

interface DueBatch {
  batchId: string;
  spaceId: string;
  resolverId: string;
  resolverIdentityId: string | null;
}

interface PostedNote {
  messageId: string;
  anchorId: string;
  anchorKind: string;
  chatIdentityId: string | null;
}

export interface AttentionDeliveryOutcome {
  batches: number;
  messages: number;
  failed: string[];
}

function normalizeDue(raw: unknown): DueBatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item === null || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    if (typeof r.batchId !== 'string' || typeof r.spaceId !== 'string' || typeof r.resolverId !== 'string') return [];
    return [{
      batchId: r.batchId,
      spaceId: r.spaceId,
      resolverId: r.resolverId,
      resolverIdentityId: typeof r.resolverIdentityId === 'string' ? r.resolverIdentityId : null,
    }];
  });
}

function normalizePosted(raw: unknown): PostedNote[] {
  const posted = (raw as { posted?: unknown } | null)?.posted;
  if (!Array.isArray(posted)) return [];
  return posted.flatMap((item) => {
    if (item === null || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    if (typeof r.messageId !== 'string' || typeof r.anchorId !== 'string') return [];
    return [{
      messageId: r.messageId,
      anchorId: r.anchorId,
      anchorKind: typeof r.anchorKind === 'string' ? r.anchorKind : '',
      chatIdentityId: typeof r.chatIdentityId === 'string' ? r.chatIdentityId : null,
    }];
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAttentionDeliveryTick(options: AttentionDeliveryJobOptions): Promise<JobOutcome> {
  const owner = await options.ownerClaims();
  const due = normalizeDue(await options.db.rpc<unknown>(
    owner, 'public.list_due_attention_notes', [options.budget ?? 50],
  ));
  if (due.length === 0) return { skipped: true, reason: 'no attention notes due' };

  const outcome: AttentionDeliveryOutcome = { batches: 0, messages: 0, failed: [] };
  for (const batch of due) {
    const claims: DbClaims = batch.resolverIdentityId
      ? { identityId: batch.resolverIdentityId, requestId: `attention-note:${batch.batchId}` }
      : { ...owner, requestId: `attention-note:${batch.batchId}` };
    let posted: PostedNote[];
    try {
      posted = normalizePosted(await options.db.rpc<unknown>(claims, 'public.deliver_attention_batch', [batch.batchId]));
    } catch (error) {
      outcome.failed.push(`${batch.batchId}: ${describe(error)}`);
      continue;
    }
    outcome.batches += 1;
    outcome.messages += posted.length;
    if (posted.length === 0) continue;

    if (options.dispatch) {
      try {
        const routes = await options.db.rpc<unknown>(claims, 'public.w2_record_session_message_routes', [
          posted.map((note) => note.messageId),
          null,
        ]);
        await options.dispatch({ routes, workSessionId: batch.batchId });
      } catch (error) {
        // Stored and recorded; only the terminal write failed, and 019's
        // delivery rows own that retry.
        outcome.failed.push(`${batch.batchId}: dispatch failed: ${describe(error)}`);
      }
    }
    for (const note of posted) {
      if (note.anchorKind === 'chat' && note.chatIdentityId) options.wakeChat?.(note.anchorId, note.chatIdentityId);
    }
  }
  return {
    affected: outcome.messages,
    detail: { ...outcome, due: due.length, failed: outcome.failed.slice(0, 10) },
  };
}

export function createAttentionDeliveryJob(options: AttentionDeliveryJobOptions): ScheduledJob {
  return {
    name: ATTENTION_DELIVERY_JOB_NAME,
    // Chapter 3: the note lands ~8s after the resolve; a 2s tick keeps that
    // under ~10s. An idle tick is one indexed read, and it does not log.
    intervalMs: options.intervalMs ?? 2_000,
    jitterRatio: 0.1,
    runOnStart: true,
    quietSkips: true,
    timeoutMs: 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runAttentionDeliveryTick(options);
    },
  };
}
