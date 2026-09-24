/**
 * Forms W1 — the thirteen `forms.*` operations (FORMS-DESIGN §6; migration 211).
 *
 * Every command is ONE call to its SECURITY DEFINER door in ONE transaction;
 * the doors own the ledger, authorisation, locks and the closed error
 * taxonomy (SQLSTATE class TF). This file adds only what SQL cannot do:
 *
 *  - the plain-text body of a submitted response. It comes from the contract
 *    registry's generic renderer (`renderFormResponseText`), the one place
 *    per-type text rendering exists. It is rendered from a basis read in the
 *    same transaction, and the door re-checks that basis under the form lock
 *    (structure_version, superseded revision, exact answers), so the message
 *    can never describe something other than what was stored;
 *  - the response views (advisor ruling W1-R1), read under RLS: a draft
 *    reaches only its respondent (209, decision 10).
 *
 * NOTHING HERE VALIDATES ANSWERS OR CONFIG. The database is the authority,
 * and an author-supplied short_text `pattern` must never run through
 * in-process JS RegExp on the request path (ReDoS, W0 note). The renderer
 * only formats already-shaped answers.
 *
 * W2 SEAM: delivery is not here. Submit leaves a `form_deliveries` row
 * (pending) and the session-anchored message; `onResponseSubmitted` is the
 * post-commit hook W2's drain plugs into.
 */
import { createHash } from 'node:crypto';

import {
  CollabError,
  decodeCursor,
  encodeCursor,
  renderFormResponseText,
  type FormAnswers,
  type FormDeliveryView,
  type FormQuestionRef,
  type FormResponsePage,
  type FormResponseView,
  type FormSnapshot,
  type FormsCreateInput,
  type FormsQuestionsAddInput,
  type FormsQuestionsMoveInput,
  type FormsQuestionsRemoveInput,
  type FormsQuestionsUpdateInput,
  type FormsResponsesDiscardInput,
  type FormsResponsesSaveInput,
  type FormsResponsesSubmitInput,
  type FormsTransitionInput,
  type FormsUpdateInput,
} from '@tm8/contract';

import type { DbClaims, Querier } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, limitOf, requireParam, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { MICROS } from '../../entity-read.js';
import { toCommandResult, type RpcCommandResult } from '../../handlers/entities.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** messages.body is 1..10000 chars; the door appends the fetch pointer (< 120). */
export const FORM_MESSAGE_BODY_LIMIT = 9_850;

/** What the post-commit W2 hook is told about one submitted response. */
export interface FormResponseSubmitted {
  readonly formId: string;
  readonly responseId: string;
  readonly messageId: string | null;
  /** The requesting session with a pending form_deliveries row, if any. */
  readonly workSessionId: string | null;
}

export interface W2FormsServiceOptions {
  /** W2's delivery drain. Called after the submit transaction commits. */
  readonly onResponseSubmitted?: (event: FormResponseSubmitted) => void | Promise<void>;
}

interface SaveRpcResult { formId: string; responseId: string }
interface SubmitRpcResult {
  formId: string;
  responseId: string;
  messageId: string | null;
  deliveryWorkSessionId: string | null;
  closed: boolean;
}

interface ResponseRow {
  id: string;
  form_id: string;
  respondent_id: string;
  respondent_name: string | null;
  status: 'draft' | 'submitted';
  revision: number;
  supersedes_id: string | null;
  lineage_key: string;
  is_current: boolean;
  structure_version: number;
  answers: FormAnswers;
  questions_snapshot: FormSnapshot | null;
  message_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  submitted_at: Date | string | null;
  version: number;
  cursor_at?: string;
}

interface DeliveryRow {
  response_id: string;
  work_session_id: string;
  status: FormDeliveryView['status'];
  spawned_session_id: string | null;
  last_error: string | null;
  attempts: number;
  created_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

const RESPONSE_COLUMNS = `
  r.id, r.form_id, r.respondent_id,
  coalesce(up.display_name, mem.display_name, tm.name) as respondent_name,
  r.status, r.revision, r.supersedes_id, r.lineage_key, r.is_current, r.structure_version,
  r.answers, r.questions_snapshot, r.message_id, r.created_at, r.updated_at, r.submitted_at, r.version`;

const RESPONSE_FROM = `
  from public.form_responses r
  left join public.members mem on mem.entity_id = r.respondent_id
  left join public.user_profiles up on up.identity_id = mem.identity_id
  left join public.team_members tm on tm.entity_id = r.respondent_id`;

function fingerprint(scope: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify({ scope, value })).digest('base64url').slice(0, 22);
}

function viewOf(row: ResponseRow, deliveries: FormDeliveryView[]): FormResponseView {
  return {
    id: row.id,
    formId: row.form_id,
    respondentId: row.respondent_id,
    respondentName: row.respondent_name ?? null,
    status: row.status,
    revision: Number(row.revision),
    supersedesId: row.supersedes_id,
    lineageKey: row.lineage_key,
    isCurrent: row.is_current,
    structureVersion: Number(row.structure_version),
    answers: row.answers ?? {},
    questionsSnapshot: row.questions_snapshot ?? null,
    messageId: row.message_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    submittedAt: row.submitted_at === null ? null : iso(row.submitted_at),
    version: Number(row.version),
    deliveries,
  };
}

/** Views for these rows, deliveries attached (RLS already filtered both). */
async function viewsOf(q: Querier, rows: readonly ResponseRow[]): Promise<FormResponseView[]> {
  if (rows.length === 0) return [];
  const deliveries = await q.query<DeliveryRow>(
    `select response_id, work_session_id, status, spawned_session_id, last_error, attempts, created_at
       from public.form_deliveries where response_id = any($1::uuid[])
      order by created_at, work_session_id`,
    [rows.map((r) => r.id)],
  );
  const byResponse = new Map<string, FormDeliveryView[]>();
  for (const d of deliveries) {
    const list = byResponse.get(d.response_id) ?? [];
    list.push({
      workSessionId: d.work_session_id,
      status: d.status,
      spawnedSessionId: d.spawned_session_id,
      lastError: d.last_error,
      attempts: Number(d.attempts),
      createdAt: iso(d.created_at),
    });
    byResponse.set(d.response_id, list);
  }
  return rows.map((row) => viewOf(row, byResponse.get(row.id) ?? []));
}

async function loadResponseView(q: Querier, id: string): Promise<FormResponseView> {
  const rows = await q.query<ResponseRow>(`select ${RESPONSE_COLUMNS} ${RESPONSE_FROM} where r.id = $1`, [id]);
  if (!rows[0]) throw new CollabError('not_found', `no such form response: ${id}`);
  return (await viewsOf(q, rows))[0]!;
}

/**
 * The respondent entities that are the caller in this space — the same
 * fallback `internal.form_is_caller` uses: the bound actor, else the caller
 * identity's member row. Resolved once so the keyset indexes apply.
 */
async function callerRespondentIds(q: Querier, spaceId: string): Promise<string[]> {
  const rows = await q.query<{ ids: string[] | null }>(
    `select array_remove(array[
              internal.actor_id(),
              (select m.entity_id from public.members m
                where m.space_id = $1 and m.identity_id = internal.identity_id())
            ], null)::text[] as ids`,
    [spaceId],
  );
  return rows[0]?.ids ?? [];
}

/** The form, readable by the caller, or not_found. */
async function readableForm(q: Querier, formId: string): Promise<{ space_id: string }> {
  const rows = await q.query<{ space_id: string }>(
    `select space_id from public.entities where id = $1 and kind = 'form' and deleted_at is null`,
    [formId],
  );
  if (!rows[0]) throw new CollabError('not_found', `no such form: ${formId}`);
  return rows[0];
}

function cursorPart(value: unknown, kind: 'uuid' | 'iso' | 'int'): string {
  const text = String(value ?? '');
  const ok = kind === 'uuid' ? UUID_RE.test(text)
    : kind === 'iso' ? text.length > 0 && !Number.isNaN(Date.parse(text))
      : /^\d+$/.test(text);
  if (!ok) throw new CollabError('invalid_cursor', 'form responses cursor is malformed');
  return text;
}

/** A code-point-safe cut: Postgres counts code points, JS UTF-16 units. */
function truncateBody(body: string): { body: string; truncated: boolean } {
  const points = Array.from(body);
  if (points.length <= FORM_MESSAGE_BODY_LIMIT) return { body, truncated: false };
  return { body: points.slice(0, FORM_MESSAGE_BODY_LIMIT).join(''), truncated: true };
}

/** Only the keys the caller sent: the doors treat an absent key as "unchanged". */
function pick<T extends object>(input: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in input) out[key as string] = (input as Record<string, unknown>)[key as string];
  return out;
}

export class W2FormsService {
  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2FormsServiceOptions = {},
  ) {}

  private async access(ctx: RequestContext, withEnvelope = true): Promise<{
    claims: DbClaims; viewer: string; envelope: ReturnType<typeof commandEnvelope>;
  }> {
    const owner = await this.deps.owner();
    const envelope = withEnvelope ? commandEnvelope(ctx) : {};
    const claims = claimsFor(owner, ctx, envelope);
    return { claims, viewer: claims.identityId ?? owner.identityId, envelope };
  }

  // -- forms ---------------------------------------------------------------

  readonly create: OperationHandler = async (ctx) => {
    const input = ctx.body as FormsCreateInput;
    const { claims, viewer, envelope } = await this.access(ctx);
    // The requesting session is the BEARER's verified session, never a body
    // claim; a human names one with forSession (recorded_only, §3.2).
    const bearerSession = ctx.identity.kind === 'bearer' ? ctx.identity.workSessionId ?? null : null;
    return this.deps.db.tx(claims, async (q) => {
      const raw = await q.rpc<RpcCommandResult & { requestingSessionId: string | null; attachedTo: string[] }>(
        'create_form', [
          input.spaceId,
          input.title,
          input.description ?? null,
          JSON.stringify(input.sections ?? []),
          JSON.stringify(input.questions),
          JSON.stringify(input.settings ?? {}),
          input.open ?? null,
          bearerSession,
          input.forSession ?? null,
          input.attachTo ?? null,
          envelope.actorId ?? null,
          input.parentId ?? null,
          input.clientMutationId,
        ]);
      const result = await toCommandResult(q, raw, viewer);
      const formId = raw.entity?.id ?? '';
      return {
        ...result,
        url: `/#/s/${input.spaceId}/e/${formId}`,
        requestingSessionId: raw.requestingSessionId ?? null,
        attachedTo: raw.attachedTo ?? [],
      };
    });
  };

  readonly update: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const input = ctx.body as FormsUpdateInput;
    return this.formCommand(ctx, 'update_form', (a) => [
      formId, input.expectedVersion,
      JSON.stringify(pick(input, ['title', 'description', 'settings', 'sections'])),
      a, input.clientMutationId,
    ]);
  };

  readonly questionsAdd: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const input = ctx.body as FormsQuestionsAddInput;
    return this.formCommand(ctx, 'add_form_question', (a) => [
      formId, input.expectedVersion, JSON.stringify(input.question),
      input.after ?? null, 'after' in input, a, input.clientMutationId,
    ]);
  };

  readonly questionsUpdate: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const key = requireParam(ctx, 'questionKey');
    const input = ctx.body as FormsQuestionsUpdateInput;
    return this.formCommand(ctx, 'update_form_question', (a) => [
      formId, input.expectedVersion, key,
      JSON.stringify(pick(input, ['type', 'title', 'help', 'required', 'section', 'config'])),
      a, input.clientMutationId,
    ]);
  };

  readonly questionsRemove: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const key = requireParam(ctx, 'questionKey');
    const input = ctx.body as FormsQuestionsRemoveInput;
    return this.formCommand(ctx, 'remove_form_question', (a) => [
      formId, input.expectedVersion, key, a, input.clientMutationId,
    ]);
  };

  readonly questionsMove: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const key = requireParam(ctx, 'questionKey');
    const input = ctx.body as FormsQuestionsMoveInput;
    return this.formCommand(ctx, 'move_form_question', (a) => [
      formId, input.expectedVersion, key, input.after ?? null, a, input.clientMutationId,
    ]);
  };

  readonly transition: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const input = ctx.body as FormsTransitionInput;
    return this.formCommand(ctx, 'transition_form', (a) => [
      formId, input.expectedVersion, input.to, input.reason ?? null, a, input.clientMutationId,
    ]);
  };

  private async formCommand(
    ctx: RequestContext,
    rpc: string,
    args: (actorId: string | null) => unknown[],
  ): Promise<unknown> {
    const { claims, viewer, envelope } = await this.access(ctx);
    return this.deps.db.tx(claims, async (q) => {
      const raw = await q.rpc<RpcCommandResult>(rpc, args(envelope.actorId ?? null));
      return toCommandResult(q, raw, viewer);
    });
  }

  // -- responses -----------------------------------------------------------

  readonly responsesSave: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const input = ctx.body as FormsResponsesSaveInput;
    const { claims, envelope } = await this.access(ctx);
    return this.deps.db.tx(claims, async (q) => {
      const raw = await q.rpc<SaveRpcResult>('save_form_response', [
        formId, JSON.stringify(input.answers), input.amendOf ?? null, input.responseVersion ?? null,
        envelope.actorId ?? null, input.clientMutationId,
      ]);
      return loadResponseView(q, raw.responseId);
    });
  };

  readonly responsesSubmit: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const input = ctx.body as FormsResponsesSubmitInput;
    const { claims, envelope } = await this.access(ctx);
    const { view, raw } = await this.deps.db.tx(claims, async (q) => {
      const basis = await this.renderBasis(q, formId, input);
      const rendered = truncateBody(renderFormResponseText({
        title: basis.title,
        questions: basis.questions,
        answers: basis.answers,
        ...(basis.previousAnswers ? { previousAnswers: basis.previousAnswers } : {}),
      }));
      const raw = await q.rpc<SubmitRpcResult>('submit_form_response', [
        formId, JSON.stringify(basis.answers), input.amendOf ?? null, input.responseVersion ?? null,
        JSON.stringify({ structureVersion: basis.structureVersion, supersedesId: basis.supersedesId }),
        rendered.body, rendered.truncated,
        envelope.actorId ?? null, input.clientMutationId,
      ]);
      return { raw, view: await loadResponseView(q, raw.responseId) };
    });
    // Committed. W2's drain plugs in here; the stored row is the durable truth
    // whether or not a hook is wired, so a hook failure never fails the call.
    if (this.options.onResponseSubmitted) {
      try {
        await this.options.onResponseSubmitted({
          formId, responseId: raw.responseId, messageId: raw.messageId ?? null,
          workSessionId: raw.deliveryWorkSessionId ?? null,
        });
      } catch (error) {
        console.error('[forms] onResponseSubmitted hook failed', error);
      }
    }
    return view;
  };

  /** forms.responses.discard: the caller's own draft, idempotently. */
  readonly responsesDiscard: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const input = ctx.body as FormsResponsesDiscardInput;
    const { claims, envelope } = await this.access(ctx);
    return this.deps.db.tx(claims, async (q) => {
      const raw = await q.rpc<{ formId: string; discarded: boolean; responseId: string | null }>(
        'discard_form_response',
        [formId, input.responseVersion ?? null, envelope.actorId ?? null, input.clientMutationId],
      );
      return { formId: raw.formId, discarded: raw.discarded === true, responseId: raw.responseId ?? null };
    });
  };

  /**
   * What the submitted message will describe, read in the submit transaction:
   * the questions in order, the answers to be stored, and the answers of the
   * revision being amended ("changed first"). The door re-checks all of it.
   */
  private async renderBasis(q: Querier, formId: string, input: FormsResponsesSubmitInput): Promise<{
    title: string; structureVersion: number | null; questions: FormQuestionRef[];
    answers: Record<string, unknown>; supersedesId: string | null;
    previousAnswers: Record<string, unknown> | null;
  }> {
    const form = (await q.query<{ title: string; structure_version: number; mode: string }>(
      `select title, structure_version,
              internal.form_settings_effective(settings)->>'responses' as mode
         from public.forms where entity_id = $1`, [formId]))[0];
    const questions = (await q.query<{ key: string; type: string; title: string; required: boolean; config: Record<string, unknown> }>(
      `select key, type, title, required, config from public.form_questions
        where form_id = $1 order by position`, [formId]));
    const draft = (await q.query<{ answers: FormAnswers; supersedes_id: string | null }>(
      `select answers, supersedes_id from public.form_responses
        where form_id = $1 and status = 'draft' and internal.form_is_caller(respondent_id)
        limit 1`, [formId]))[0];

    let supersedesId: string | null = null;
    if (draft) {
      supersedesId = draft.supersedes_id;
    } else if (input.amendOf) {
      supersedesId = input.amendOf;
    } else if (form && form.mode !== 'unlimited') {
      // Mirrors internal.form_amend_target: the caller's slot's current row.
      const current = (await q.query<{ id: string }>(
        form.mode === 'single'
          ? `select id from public.form_responses where form_id = $1 and is_current limit 1`
          : `select id from public.form_responses
              where form_id = $1 and is_current and internal.form_is_caller(respondent_id) limit 1`,
        [formId]))[0];
      supersedesId = current?.id ?? null;
    }
    const previous = supersedesId === null ? undefined : (await q.query<{ answers: FormAnswers }>(
      `select answers from public.form_responses where id = $1`, [supersedesId]))[0];

    return {
      title: form?.title ?? '',
      structureVersion: form ? Number(form.structure_version) : null,
      questions: questions.map((row) => ({
        key: row.key, type: row.type, title: row.title, required: row.required, config: row.config,
      })),
      answers: (input.answers ?? draft?.answers ?? {}) as Record<string, unknown>,
      supersedesId,
      previousAnswers: previous ? (previous.answers as Record<string, unknown>) : null,
    };
  }

  /**
   * forms.responses.list (advisor ruling W1-R3):
   *   default          current submitted revisions, newest first;
   *   ?lineageKey=     that chain's submitted revisions, in revision order;
   *   ?respondent=me   the caller's current revision plus their draft.
   */
  readonly responsesList: OperationHandler = async (ctx) => {
    const formId = requireUuidParam(ctx, 'formId');
    const respondent = ctx.query.get('respondent');
    if (respondent !== null && respondent !== 'me') {
      throw new CollabError('invalid_input', "respondent must be 'me'");
    }
    const lineageKey = ctx.query.get('lineageKey');
    if (lineageKey !== null && !UUID_RE.test(lineageKey)) {
      throw new CollabError('invalid_input', 'lineageKey must be a uuid');
    }
    if (lineageKey !== null && respondent !== null) {
      throw new CollabError('invalid_input', 'pass lineageKey or respondent, not both');
    }
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');
    const { claims } = await this.access(ctx, false);
    const fp = fingerprint('forms.responses.list', { formId, respondent, lineageKey });

    return this.deps.db.tx(claims, async (q): Promise<FormResponsePage> => {
      const space = await readableForm(q, formId);
      const values: unknown[] = [formId];
      const where = ['r.form_id = $1'];
      let order: string;
      let key: string;
      let after: (k: unknown[]) => string;

      if (lineageKey !== null) {
        values.push(lineageKey);
        where.push(`r.lineage_key = $${values.length}`, `r.status = 'submitted'`);
        key = 'r.revision::text';
        order = 'r.revision asc, r.id asc';
        after = (k) => {
          values.push(Number(cursorPart(k[1], 'int')), cursorPart(k[2], 'uuid'));
          return `(r.revision, r.id) > ($${values.length - 1}::int, $${values.length}::uuid)`;
        };
      } else {
        if (respondent === 'me') {
          // The caller's rows: current revision plus the draft (RLS already
          // hides every other member's draft, 209). A draft has no
          // submitted_at, so this branch keys on created_at for it.
          values.push(await callerRespondentIds(q, space.space_id));
          where.push(`(r.is_current or r.status = 'draft')`, `r.respondent_id = any($${values.length}::uuid[])`);
          key = MICROS('coalesce(r.submitted_at, r.created_at)');
          order = 'coalesce(r.submitted_at, r.created_at) desc, r.id desc';
          after = (k) => {
            values.push(cursorPart(k[1], 'iso'), cursorPart(k[2], 'uuid'));
            return `(coalesce(r.submitted_at, r.created_at), r.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
          };
        } else {
          // Every current row is submitted: keyed on form_responses_current_page
          // (form_id, submitted_at, id) WHERE is_current.
          where.push('r.is_current');
          key = MICROS('r.submitted_at');
          order = 'r.submitted_at desc, r.id desc';
          after = (k) => {
            values.push(cursorPart(k[1], 'iso'), cursorPart(k[2], 'uuid'));
            return `(r.submitted_at, r.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
          };
        }
      }
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k[0] !== fp || decoded.k.length !== 3) {
          throw new CollabError('invalid_cursor', 'form responses cursor does not match this query');
        }
        where.push(after(decoded.k));
      }
      const rows = await q.query<ResponseRow>(
        `select ${RESPONSE_COLUMNS}, ${key} as cursor_at ${RESPONSE_FROM}
          where ${where.join(' and ')} order by ${order} limit ${limit + 1}`,
        values,
      );
      return this.page(q, rows, limit, fp);
    });
  };

  readonly responsesGet: OperationHandler = async (ctx) => {
    const id = requireUuidParam(ctx, 'responseId');
    const { claims } = await this.access(ctx, false);
    return this.deps.db.tx(claims, (q) => loadResponseView(q, id));
  };

  /** forms.responses.mine: what the caller has submitted, across a space, newest first. */
  readonly responsesMine: OperationHandler = async (ctx) => {
    const spaceId = ctx.query.get('spaceId') ?? '';
    if (!UUID_RE.test(spaceId)) throw new CollabError('invalid_input', 'spaceId must be a uuid');
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');
    const { claims } = await this.access(ctx, false);
    const fp = fingerprint('forms.responses.mine', { spaceId });
    return this.deps.db.tx(claims, async (q): Promise<FormResponsePage> => {
      // Keyed on form_responses_mine_page (space_id, respondent_id,
      // submitted_at, id) WHERE submitted: the caller's respondent ids are
      // resolved once, not tested row by row.
      const values: unknown[] = [spaceId, await callerRespondentIds(q, spaceId)];
      const where = [`r.space_id = $1`, `r.respondent_id = any($2::uuid[])`, `r.status = 'submitted'`];
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k[0] !== fp || decoded.k.length !== 3) {
          throw new CollabError('invalid_cursor', 'form responses cursor does not match this query');
        }
        values.push(cursorPart(decoded.k[1], 'iso'), cursorPart(decoded.k[2], 'uuid'));
        where.push(`(r.submitted_at, r.id) < ($3::timestamptz, $4::uuid)`);
      }
      const rows = await q.query<ResponseRow>(
        `select ${RESPONSE_COLUMNS}, ${MICROS('r.submitted_at')} as cursor_at ${RESPONSE_FROM}
          where ${where.join(' and ')} order by r.submitted_at desc, r.id desc limit ${limit + 1}`,
        values,
      );
      return this.page(q, rows, limit, fp);
    });
  };

  private async page(q: Querier, rows: ResponseRow[], limit: number, fp: string): Promise<FormResponsePage> {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: await viewsOf(q, pageRows),
      nextCursor: hasMore && last ? encodeCursor([fp, last.cursor_at ?? '', last.id]) : null,
    };
  }
}
