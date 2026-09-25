/**
 * THE PRODUCTION FORMS PORT (FORMS-DESIGN §6, §7.3, §10) — `FormsPort` over
 * the `forms.*` operations, `entities.get` and the durable event stream.
 *
 *   form            → entities.get (the DETAIL: list rows carry only a count)
 *   mine            → forms.responses.list ?respondent=me   (current + draft)
 *                     + ?lineageKey=<current's chain>       (history)
 *   responses       → forms.responses.list                   (current, keyset)
 *   revisions       → forms.responses.list ?lineageKey
 *   saveDraft       → forms.responses.save    { responseVersion, amendOf }
 *   discardDraft    → forms.responses.discard { responseVersion }
 *   submit          → forms.responses.submit  { responseVersion, amendOf }
 *   updateStructure → structure-diff.ts's plan, one op per step, each step's
 *                     expectedVersion the previous result's version
 *   transition      → forms.transition
 *   redeliver       → forms.responses.redeliver (only when the catalog has it)
 *   subscribe       → entity.upsert(form) → 'form'; message.* on the form and
 *                     entity.activity_touched(form) → 'responses';
 *                     entity.upsert(work_session) → 'session'. Plus a LOCAL
 *                     notify after this port's own writes, so a surface that
 *                     shares the port (the session banner) hears a submit
 *                     before the socket echo arrives.
 *
 * Errors leave here as `FormsPortError` with the server's code, or the few
 * codes the UI acts on distinctly (draft_in_flight, delivery_refused).
 */
import {
  isCollabError,
  type CommandResult,
  type DurableWorkspaceEvent,
  type FormAnswerIssue,
  type FormResponseView,
} from '@tm8/contract';
import type { FormsOps, FormsListQuery } from './ops-port';
import {
  FormsPortError,
  FormsStructureSaveError,
  formContentOf,
  type FormsChange,
  type FormsPort,
  type FormsPortErrorCode,
  type FormState,
} from './seam';
import { planStructure, type StructureStep } from './structure-diff';

/** The detail fields the port reads off an entity. */
export interface FormDetailLike {
  id: string;
  title: string;
  version: number;
  kind?: string;
  content: unknown;
}

export interface RealFormsPortDeps {
  ops: FormsOps;
  entity(id: string): Promise<FormDetailLike>;
  onEvent(cb: (event: DurableWorkspaceEvent) => void): () => void;
}

const PASS_THROUGH: ReadonlySet<FormsPortErrorCode> = new Set([
  'form_answers_invalid', 'form_not_open', 'form_structure_frozen', 'form_response_limit',
  'form_respondent_not_allowed', 'version_conflict', 'conflict', 'invalid_input', 'forbidden', 'not_found',
]);

const DELIVERY_REFUSALS = new Set(['delivery_not_cancelled', 'delivery_not_pending', 'session_deleted']);

/** A thrown transport error → the port's taxonomy. */
export function toFormsPortError(e: unknown): unknown {
  if (e instanceof FormsPortError || e instanceof FormsStructureSaveError) return e;
  if (!isCollabError(e)) return e;
  const details = (e.details ?? {}) as Record<string, unknown>;
  const reason = typeof details.reason === 'string' ? details.reason : null;
  const issues = Array.isArray(details.issues) ? (details.issues as FormAnswerIssue[]) : [];
  if (e.code === 'conflict' && reason === 'form_draft_in_flight') {
    const draftId = typeof details.draftId === 'string' ? details.draftId : null;
    return new FormsPortError('draft_in_flight', 'You have another unsent draft on this form. Discard it to start this one.', [], reason, draftId);
  }
  if (e.code === 'conflict' && reason !== null && DELIVERY_REFUSALS.has(reason)) {
    return new FormsPortError('delivery_refused', e.message, [], reason);
  }
  const code = (PASS_THROUGH as ReadonlySet<string>).has(e.code) ? (e.code as FormsPortErrorCode) : 'unknown';
  return new FormsPortError(code, e.message, issues, reason);
}

async function mapped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw toFormsPortError(e);
  }
}

function stateOf(detail: FormDetailLike | undefined): FormState {
  const content = detail ? formContentOf(detail.content) : null;
  if (!detail || !content) throw new FormsPortError('not_found', 'The form’s questions did not come back from the node.');
  return { id: detail.id, title: detail.title, version: detail.version, content };
}

const resultState = (r: CommandResult): FormState => stateOf(r.entity);

export function createRealFormsPort(deps: RealFormsPortDeps): FormsPort {
  const { ops } = deps;
  const listeners = new Map<string, Set<(change: FormsChange) => void>>();
  const notify = (formId: string, change: FormsChange) => listeners.get(formId)?.forEach((cb) => cb(change));

  /** Every page of one query (a chain's revisions, the caller's rows). */
  async function all(formId: string, query: FormsListQuery): Promise<FormResponseView[]> {
    const items: FormResponseView[] = [];
    let cursor: string | undefined;
    do {
      const page = await mapped(ops.responsesList(formId, { ...query, ...(cursor ? { cursor } : {}) }));
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  async function runStep(formId: string, step: StructureStep, expectedVersion: number): Promise<CommandResult> {
    switch (step.op) {
      case 'update':
        return ops.update(formId, {
          expectedVersion,
          ...(step.settings ? { settings: step.settings } : {}),
          ...(step.sections ? { sections: step.sections } : {}),
        });
      case 'remove':
        return ops.questionsRemove(formId, step.key, { expectedVersion });
      case 'patch':
        return ops.questionsUpdate(formId, step.key, { expectedVersion, ...step.patch });
      case 'add':
        return ops.questionsAdd(formId, { expectedVersion, question: step.question });
      case 'move':
        return ops.questionsMove(formId, step.key, { expectedVersion, after: step.after });
    }
  }

  const port: FormsPort = {
    async form(formId) {
      return stateOf(await mapped(deps.entity(formId)));
    },

    async mine(formId) {
      const rows = await all(formId, { respondent: 'me' });
      const draft = rows.find((r) => r.status === 'draft') ?? null;
      // Under `unlimited` the caller can hold several current chains; the slot
      // shows the latest (accepted W1 risk). The list is newest first.
      const current = rows.find((r) => r.status === 'submitted' && r.isCurrent) ?? null;
      const history = current ? await all(formId, { lineageKey: current.lineageKey }) : [];
      return { current, draft, history };
    },

    async responses(formId, cursor) {
      return mapped(ops.responsesList(formId, cursor ? { cursor } : {}));
    },

    async revisions(formId, lineageKey) {
      return all(formId, { lineageKey });
    },

    async saveDraft(formId, input) {
      const view = await mapped(ops.responsesSave(formId, {
        answers: input.answers,
        ...(input.supersedesId ? { amendOf: input.supersedesId } : {}),
        ...(input.responseVersion ? { responseVersion: input.responseVersion } : {}),
      }));
      notify(formId, { kind: 'responses' });
      return view;
    },

    async discardDraft(formId, draft) {
      await mapped(ops.responsesDiscard(formId, draft ? { responseVersion: draft.version } : {}));
      notify(formId, { kind: 'responses' });
    },

    async submit(formId, input) {
      const view = await mapped(ops.responsesSubmit(formId, {
        answers: input.answers,
        ...(input.supersedesId ? { amendOf: input.supersedesId } : {}),
        ...(input.responseVersion ? { responseVersion: input.responseVersion } : {}),
      }));
      notify(formId, { kind: 'responses' });
      return view;
    },

    async updateStructure(formId, input) {
      let form = await port.form(formId);
      if (form.version !== input.expectedVersion) {
        throw new FormsPortError('version_conflict', 'The form changed since you loaded it. Reload to see the latest.');
      }
      const steps = planStructure(form.content, input);
      for (const [i, step] of steps.entries()) {
        try {
          form = resultState(await runStep(formId, step, form.version));
        } catch (e) {
          if (i === 0) throw toFormsPortError(e);
          notify(formId, { kind: 'form' });
          throw new FormsStructureSaveError(i, steps.length, step.label, toFormsPortError(e), form);
        }
      }
      if (steps.length > 0) notify(formId, { kind: 'form' });
      return form;
    },

    async transition(formId, to, expectedVersion) {
      const form = resultState(await mapped(ops.transition(formId, { to, expectedVersion })));
      notify(formId, { kind: 'form' });
      return form;
    },

    ...(ops.redeliver ? {
      async redeliver(responseId: string, workSessionId: string, to: 'resume' | 'new_session') {
        await mapped(ops.redeliver!(responseId, { deliverySessionId: workSessionId, to }));
      },
    } : {}),

    subscribe(formId, onChange) {
      const set = listeners.get(formId) ?? new Set();
      set.add(onChange);
      listeners.set(formId, set);
      const off = deps.onEvent((e) => {
        switch (e.type) {
          case 'entity.upsert':
            if (e.entity.id === formId) onChange({ kind: 'form' });
            else if (e.entity.kind === 'work_session') onChange({ kind: 'session', sessionId: e.entity.id });
            break;
          case 'entity.activity_touched':
            if (e.id === formId) onChange({ kind: 'responses' });
            break;
          case 'message.created':
          case 'message.updated':
          case 'message.deleted':
            if (e.anchorId === formId) onChange({ kind: 'responses' });
            break;
          default:
            break;
        }
      });
      return () => {
        set.delete(onChange);
        off();
      };
    },
  };
  return port;
}
