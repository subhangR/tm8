/**
 * The TEST forms port: in memory, over `fixtures.ts`. Production never
 * imports this file (no-fixture-import.test.ts); the real port is
 * `real-port.ts`. It enforces the rules the
 * server will (FORMS-DESIGN §3.1, §5, §6) closely enough that the block's
 * error and state paths are real: the contract validators on save and
 * submit, the one freeze rule, the per-mode response limits, amend, the
 * lifecycle, and `expectedVersion`.
 */
import {
  FORM_TRANSITIONS,
  FormQuestionSchema,
  formJsonEqual,
  validateFormAnswers,
  type FormAnswers,
} from '@tm8/contract';
import { FORM_FIXTURE_FORMS, FORM_FIXTURE_RESPONSES, FORM_FIXTURE_VIEWER } from './fixtures';
import {
  FormsPortError,
  type FormsChange,
  type FormDeliveryView,
  type FormResponseView,
  type FormsPort,
  type FormState,
  type FormViewer,
  type MyFormSlot,
} from './seam';

export type FixtureFormsPort = FormsPort & {
  /** Every row, drafts included — tests only. */
  readonly rows: FormResponseView[];
  /** Every redeliver call, in order — tests only. */
  readonly redelivered: { responseId: string; workSessionId: string; to: 'resume' | 'new_session' }[];
};

export interface FixtureFormsSeed {
  viewer?: FormViewer;
  forms?: FormState[];
  responses?: FormResponseView[];
  /** Clock for new rows (tests pin it). */
  now?: () => string;
  /** Page `responses` like the server's keyset (default: one page). */
  pageSize?: number;
}

const clone = <T>(v: T): T => structuredClone(v);

export function createFixtureFormsPort(seed: FixtureFormsSeed = {}): FixtureFormsPort {
  const viewer = seed.viewer ?? FORM_FIXTURE_VIEWER;
  const forms = new Map(clone(seed.forms ?? FORM_FIXTURE_FORMS).map((f) => [f.id, f]));
  const rows: FormResponseView[] = clone(seed.responses ?? FORM_FIXTURE_RESPONSES);
  const now = seed.now ?? (() => new Date().toISOString());
  const listeners = new Map<string, Set<(change: FormsChange) => void>>();
  const redelivered: FixtureFormsPort['redelivered'] = [];
  let seq = 0;

  const notify = (formId: string, change: FormsChange = { kind: 'responses' }) =>
    listeners.get(formId)?.forEach((cb) => cb(change));
  const formOf = (id: string): FormState => {
    const f = forms.get(id);
    if (!f) throw new FormsPortError('not_found', `no form ${id}`);
    return f;
  };
  const submittedOf = (formId: string) => rows.filter((r) => r.formId === formId && r.status === 'submitted');
  const frozen = (formId: string) => submittedOf(formId).length > 0;
  const draftOf = (formId: string) =>
    rows.find((r) => r.formId === formId && r.status === 'draft' && r.respondentId === viewer.memberId) ?? null;
  const myCurrent = (formId: string) =>
    rows
      .filter((r) => r.formId === formId && r.isCurrent && r.respondentId === viewer.memberId)
      .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))[0] ?? null;
  const assertOpen = (f: FormState) => {
    if (f.content.status !== 'open') throw new FormsPortError('form_not_open', `the form is ${f.content.status}`);
  };
  const validate = (f: FormState, answers: FormAnswers, final: boolean) => {
    const issues = validateFormAnswers(f.content.questions, answers, { final });
    if (issues.length > 0) throw new FormsPortError('form_answers_invalid', 'some answers are invalid', issues);
  };
  const lineageFor = (f: FormState, supersedesId: string | null, draftId: string): string => {
    if (supersedesId) return rows.find((r) => r.id === supersedesId)?.lineageKey ?? draftId;
    switch (f.content.settings.responses) {
      case 'per_member': return viewer.memberId;
      case 'single': return f.id;
      default: return draftId;
    }
  };
  const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

  /** What a submit supersedes, given the mode, amend and what is already current. */
  function supersededBy(f: FormState, requested: string | null): FormResponseView | null {
    if (requested) {
      const prev = rows.find((r) => r.id === requested);
      if (!prev || !prev.isCurrent) throw new FormsPortError('version_conflict', 'that revision is no longer current');
      if (prev.respondentId !== viewer.memberId) throw new FormsPortError('form_response_limit', 'not your response');
      if (!f.content.settings.allowAmend) throw new FormsPortError('form_response_limit', 'this form does not allow resubmitting');
      return prev;
    }
    const mode = f.content.settings.responses;
    if (mode === 'unlimited') return null;
    const slot = mode === 'single' ? f.id : viewer.memberId;
    const current = rows.find((r) => r.formId === f.id && r.isCurrent && r.lineageKey === slot) ?? null;
    if (!current) return null;
    if (current.respondentId !== viewer.memberId || !f.content.settings.allowAmend) {
      throw new FormsPortError('form_response_limit', 'this form already has its response');
    }
    return current;
  }

  function deliveryFor(f: FormState, at: string): FormDeliveryView {
    const { target, onSessionNotLive } = f.content.settings.delivery;
    const spawned = target === 'new_session' || onSessionNotLive === 'spawn_new';
    return {
      workSessionId: 'ws-requesting',
      status: spawned ? 'spawned' : onSessionNotLive === 'queue' ? 'pending' : 'delivered',
      spawnedSessionId: spawned ? nextId('ws') : null,
      lastError: null,
      attempts: onSessionNotLive === 'queue' ? 0 : 1,
      createdAt: at,
    };
  }

  const port: FixtureFormsPort = {
    rows,
    redelivered,

    async form(formId) {
      return clone(formOf(formId));
    },

    async mine(formId) {
      formOf(formId);
      const current = myCurrent(formId);
      const history = current
        ? submittedOf(formId).filter((r) => r.lineageKey === current.lineageKey).sort((a, b) => a.revision - b.revision)
        : [];
      const slot: MyFormSlot = { current, draft: draftOf(formId), history };
      return clone(slot);
    },

    async responses(formId, cursor) {
      formOf(formId);
      // The server's order and keyset: `submittedAt desc, id desc`, the cursor
      // is the last row's key (so a new row never shifts a later page).
      const key = (r: FormResponseView) => `${r.submittedAt ?? ''}|${r.id}`;
      const items = rows
        .filter((r) => r.formId === formId && r.isCurrent && (!cursor || key(r) < cursor))
        .sort((a, b) => key(b).localeCompare(key(a)));
      const page = seed.pageSize ? items.slice(0, seed.pageSize) : items;
      const nextCursor = page.length < items.length ? key(page[page.length - 1]!) : null;
      return { items: clone(page), nextCursor };
    },

    async revisions(formId, lineageKey) {
      return clone(
        submittedOf(formId).filter((r) => r.lineageKey === lineageKey).sort((a, b) => a.revision - b.revision),
      );
    },

    async saveDraft(formId, input) {
      const f = formOf(formId);
      assertOpen(f);
      validate(f, input.answers, false);
      const at = now();
      let draft = draftOf(formId);
      if (draft && draft.supersedesId !== input.supersedesId) {
        throw new FormsPortError('draft_in_flight', 'a draft for another revision is in flight', [], 'form_draft_in_flight', draft.id);
      }
      if (!draft) {
        const prev = input.supersedesId ? rows.find((r) => r.id === input.supersedesId) : null;
        const id = nextId('resp');
        draft = {
          id, formId, respondentId: viewer.memberId, respondentName: viewer.displayName,
          status: 'draft', revision: prev ? prev.revision + 1 : 1, supersedesId: input.supersedesId,
          lineageKey: lineageFor(f, input.supersedesId, id), isCurrent: false,
          structureVersion: f.content.structureVersion, answers: {}, questionsSnapshot: null, messageId: null,
          createdAt: at, updatedAt: at, submittedAt: null, version: 0, deliveries: [],
        };
        rows.push(draft);
      }
      draft.answers = clone(input.answers);
      draft.updatedAt = at;
      draft.version += 1;
      notify(formId);
      return clone(draft);
    },

    async discardDraft(formId) {
      const i = rows.findIndex((r) => r.formId === formId && r.status === 'draft' && r.respondentId === viewer.memberId);
      if (i >= 0) rows.splice(i, 1);
      notify(formId);
    },

    async submit(formId, input) {
      const f = formOf(formId);
      assertOpen(f);
      validate(f, input.answers, true);
      const prev = supersededBy(f, input.supersedesId);
      const at = now();
      const draft = draftOf(formId);
      if (draft) rows.splice(rows.indexOf(draft), 1);
      const id = draft?.id ?? nextId('resp');
      if (prev) prev.isCurrent = false;
      const row: FormResponseView = {
        id, formId, respondentId: viewer.memberId, respondentName: viewer.displayName,
        status: 'submitted', revision: prev ? prev.revision + 1 : 1, supersedesId: prev?.id ?? null,
        lineageKey: prev?.lineageKey ?? lineageFor(f, null, id), isCurrent: true,
        structureVersion: f.content.structureVersion, answers: clone(input.answers),
        questionsSnapshot: {
          structureVersion: f.content.structureVersion,
          sections: clone(f.content.sections),
          questions: clone(f.content.questions),
        },
        messageId: nextId('msg'), createdAt: draft?.createdAt ?? at, updatedAt: at, submittedAt: at,
        version: 1, deliveries: [deliveryFor(f, at)],
      };
      rows.push(row);
      if (f.content.settings.closeOnSubmit) {
        f.content = { ...f.content, status: 'closed', closedAt: at };
        f.version += 1;
      }
      notify(formId);
      return clone(row);
    },

    async updateStructure(formId, input) {
      const f = formOf(formId);
      if (input.expectedVersion !== f.version) throw new FormsPortError('version_conflict', 'the form changed; reload');
      const structureChanged = !formJsonEqual(input.questions, f.content.questions)
        || !formJsonEqual(input.sections, f.content.sections);
      const modeChanged = input.settings.responses !== f.content.settings.responses;
      if ((structureChanged || modeChanged) && frozen(formId)) {
        throw new FormsPortError('form_structure_frozen', 'questions froze at the first submitted response');
      }
      for (const { position: _position, ...q } of input.questions) {
        const parsed = FormQuestionSchema.safeParse(q);
        if (!parsed.success) {
          throw new FormsPortError('invalid_input', `${q.key}: ${parsed.error.issues[0]?.message ?? 'invalid question'}`);
        }
      }
      f.content = {
        ...f.content,
        questions: clone(input.questions).map((q, position) => ({ ...q, position })),
        sections: clone(input.sections).map((s, position) => ({ ...s, position })),
        settings: clone(input.settings),
        structureVersion: f.content.structureVersion + (structureChanged ? 1 : 0),
      };
      f.version += 1;
      if (structureChanged) {
        // A structure edit keeps draft answers whose keys still validate (§5).
        for (const d of rows.filter((r) => r.formId === formId && r.status === 'draft')) {
          const kept: FormAnswers = {};
          for (const [key, answer] of Object.entries(d.answers)) {
            if (validateFormAnswers(f.content.questions, { [key]: answer }, { final: false }).length === 0) kept[key] = answer;
          }
          d.answers = kept;
          d.structureVersion = f.content.structureVersion;
        }
      }
      notify(formId, { kind: 'form' });
      return clone(f);
    },

    async transition(formId, to, expectedVersion) {
      const f = formOf(formId);
      if (expectedVersion !== f.version) throw new FormsPortError('version_conflict', 'the form changed; reload');
      if (!FORM_TRANSITIONS[f.content.status].includes(to)) {
        throw new FormsPortError('invalid_input', `cannot go from ${f.content.status} to ${to}`);
      }
      const at = now();
      f.content = {
        ...f.content,
        status: to,
        openedAt: to === 'open' ? (f.content.openedAt ?? at) : f.content.openedAt,
        closedAt: to === 'open' ? null : at,
      };
      f.version += 1;
      notify(formId, { kind: 'form' });
      return clone(f);
    },

    async redeliver(responseId, workSessionId, to) {
      redelivered.push({ responseId, workSessionId, to });
    },

    subscribe(formId, onChange) {
      const set = listeners.get(formId) ?? new Set();
      set.add(onChange);
      listeners.set(formId, set);
      return () => set.delete(onChange);
    },
  };
  return port;
}
