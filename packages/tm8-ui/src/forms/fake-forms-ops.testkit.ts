/**
 * A fake `FormsOps` transport for the real port's contract tests: the form
 * structure ops behave like the server's doors (expectedVersion guard, one
 * version bump per call, the form DETAIL in `result.entity`), the response
 * ops record their inputs, and any call can be made to fail.
 */
import { CollabError, type CommandResult, type EntityDetail, type FormResponseView } from '@tm8/contract';
import type { FormsListQuery, FormsOps } from './ops-port';
import type { FormState } from './seam';

export interface OpCall {
  op: string;
  args: unknown[];
}

export interface FakeFormsOps extends FormsOps {
  calls: OpCall[];
  forms: Map<string, FormState>;
  rows: FormResponseView[];
  /** Make the nth structure call from now (0-based) throw this error, once. */
  failStructureCall(n: number, error: unknown): void;
  /** The next call of this op throws `error`, once. */
  failNext(op: string, error: unknown): void;
}

const clone = <T>(v: T): T => structuredClone(v);

export function createFakeFormsOps(
  seed: { forms: FormState[]; rows?: FormResponseView[]; withRedeliver?: boolean; pageSize?: number },
): FakeFormsOps {
  const forms = new Map(clone(seed.forms).map((f) => [f.id, f]));
  const rows = clone(seed.rows ?? []);
  const calls: OpCall[] = [];
  const pageSize = seed.pageSize ?? 50;
  let structureFail: { at: number; error: unknown } | null = null;
  let structureCount = 0;
  const nextFail = new Map<string, unknown>();

  const record = (op: string, ...args: unknown[]) => {
    calls.push({ op, args: clone(args) });
    const failure = nextFail.get(op);
    if (failure !== undefined) {
      nextFail.delete(op);
      throw failure;
    }
  };

  /** One structure door: guard, mutate, bump, answer the detail. */
  function door(op: string, formId: string, expectedVersion: number, args: unknown[], mutate: (f: FormState) => void): CommandResult {
    record(op, formId, ...args);
    const f = forms.get(formId);
    if (!f) throw new CollabError('not_found', `no form ${formId}`);
    if (structureFail && structureCount++ === structureFail.at) {
      const { error } = structureFail;
      structureFail = null;
      throw error;
    }
    if (f.version !== expectedVersion) throw new CollabError('version_conflict', 'stale expectedVersion');
    mutate(f);
    f.version += 1;
    return { patches: [], entity: { id: f.id, title: f.title, version: f.version, content: { kind: 'form', ...clone(f.content) } } as unknown as EntityDetail };
  }

  const renumber = (f: FormState) => {
    f.content.questions = f.content.questions.map((q, position) => ({ ...q, position }));
  };

  const ops: FakeFormsOps = {
    calls,
    forms,
    rows,
    failStructureCall(n, error) {
      structureFail = { at: n, error };
      structureCount = 0;
    },
    failNext(op, error) {
      nextFail.set(op, error);
    },

    async update(formId, input) {
      return door('update', formId, input.expectedVersion, [input], (f) => {
        if (input.settings) f.content.settings = { ...f.content.settings, ...input.settings } as FormState['content']['settings'];
        if (input.sections) f.content.sections = input.sections.map((s, position) => ({ ...s, position }));
      });
    },
    async questionsAdd(formId, input) {
      return door('questionsAdd', formId, input.expectedVersion, [input], (f) => {
        const { question } = input;
        f.content.questions.push({ required: true, config: {}, ...question, position: f.content.questions.length } as FormState['content']['questions'][number]);
        renumber(f);
      });
    },
    async questionsUpdate(formId, key, input) {
      return door('questionsUpdate', formId, input.expectedVersion, [key, input], (f) => {
        const { expectedVersion: _v, ...patch } = input;
        f.content.questions = f.content.questions.map((q) => {
          if (q.key !== key) return q;
          const next: Record<string, unknown> = { ...q, ...patch };
          for (const k of ['help', 'section']) if (next[k] === null) delete next[k];
          return next as unknown as typeof q;
        });
      });
    },
    async questionsRemove(formId, key, input) {
      return door('questionsRemove', formId, input.expectedVersion, [key, input], (f) => {
        f.content.questions = f.content.questions.filter((q) => q.key !== key);
        renumber(f);
      });
    },
    async questionsMove(formId, key, input) {
      return door('questionsMove', formId, input.expectedVersion, [key, input], (f) => {
        const qs = f.content.questions.filter((q) => q.key !== key);
        const moving = f.content.questions.find((q) => q.key === key)!;
        const at = input.after == null ? 0 : qs.findIndex((q) => q.key === input.after) + 1;
        qs.splice(at, 0, moving);
        f.content.questions = qs;
        renumber(f);
      });
    },
    async transition(formId, input) {
      return door('transition', formId, input.expectedVersion, [input], (f) => {
        f.content.status = input.to;
      });
    },

    async responsesSave(formId, input) {
      record('responsesSave', formId, input);
      const draft = rows.find((r) => r.formId === formId && r.status === 'draft');
      if (!draft) throw new CollabError('not_found', 'the fake stores no new drafts');
      draft.answers = clone(input.answers);
      draft.version += 1;
      return clone(draft);
    },
    async responsesDiscard(formId, input) {
      record('responsesDiscard', formId, input);
      const i = rows.findIndex((r) => r.formId === formId && r.status === 'draft');
      if (i >= 0) rows.splice(i, 1);
      return { discarded: i >= 0 };
    },
    async responsesSubmit(formId, input) {
      record('responsesSubmit', formId, input);
      const draft = rows.find((r) => r.formId === formId && r.status === 'draft');
      if (!draft) throw new CollabError('not_found', 'the fake submits drafts only');
      Object.assign(draft, { status: 'submitted', isCurrent: true, submittedAt: draft.updatedAt, answers: clone(input.answers ?? draft.answers) });
      return clone(draft);
    },
    async responsesList(formId, query: FormsListQuery = {}) {
      record('responsesList', formId, query);
      let items = rows.filter((r) => r.formId === formId);
      if (query.lineageKey) items = items.filter((r) => r.lineageKey === query.lineageKey && r.status === 'submitted').sort((a, b) => a.revision - b.revision);
      else if (query.respondent === 'me') items = items.filter((r) => r.isCurrent || r.status === 'draft');
      else items = items.filter((r) => r.isCurrent);
      const start = query.cursor ? Number(query.cursor) : 0;
      const page = items.slice(start, start + pageSize);
      return { items: clone(page), nextCursor: start + pageSize < items.length ? String(start + pageSize) : null };
    },
  };
  if (seed.withRedeliver) {
    ops.redeliver = async (responseId, input) => {
      record('redeliver', responseId, input);
      return {};
    };
  }
  return ops;
}
