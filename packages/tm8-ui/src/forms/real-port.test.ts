/**
 * The production FormsPort's contract, against a fake transport: the op each
 * method calls and with what, version chaining and partial failure in the
 * Build diff, the error taxonomy, and which events wake the block.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CollabError,
  FormSettingsSchema,
  type DurableWorkspaceEvent,
  type FormQuestionRow,
  type FormResponseView,
} from '@tm8/contract';
import { createFakeFormsOps } from './fake-forms-ops.testkit';
import { createRealFormsPort, toFormsPortError } from './real-port';
import { FormsPortError, FormsStructureSaveError, type FormState, type FormsChange } from './seam';

const FORM = '00000000-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-0000000000aa';

const q = (key: string, position: number, extra: Partial<FormQuestionRow> = {}): FormQuestionRow => ({
  key, type: 'short_text', title: key.toUpperCase(), required: true, position, config: {}, ...extra,
});

function form(questions: FormQuestionRow[] = [q('a', 0), q('b', 1), q('c', 2)]): FormState {
  return {
    id: FORM,
    title: 'Retro',
    version: 5,
    content: {
      status: 'open', description: null, settings: FormSettingsSchema.parse({}), structureVersion: 1,
      sections: [{ key: 'one', title: 'One', position: 0 }], questions, openedAt: null, closedAt: null,
    },
  };
}

function row(extra: Partial<FormResponseView>): FormResponseView {
  return {
    id: 'r1', formId: FORM, respondentId: ME, respondentName: 'Ada', status: 'submitted', revision: 1,
    supersedesId: null, lineageKey: ME, isCurrent: true, structureVersion: 1, answers: {},
    questionsSnapshot: null, messageId: null, createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', submittedAt: '2026-09-01T00:00:00.000Z', version: 1, deliveries: [],
    ...extra,
  };
}

function setup(opts: { forms?: FormState[]; rows?: FormResponseView[]; withRedeliver?: boolean; pageSize?: number } = {}) {
  const ops = createFakeFormsOps({ forms: opts.forms ?? [form()], rows: opts.rows, withRedeliver: opts.withRedeliver, pageSize: opts.pageSize });
  const listeners = new Set<(e: DurableWorkspaceEvent) => void>();
  const port = createRealFormsPort({
    ops,
    entity: async (id) => {
      const f = ops.forms.get(id);
      if (!f) throw new CollabError('not_found', 'no');
      return { id: f.id, title: f.title, version: f.version, content: { kind: 'form', ...structuredClone(f.content) } };
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });
  const emit = (e: unknown) => listeners.forEach((cb) => cb(e as DurableWorkspaceEvent));
  const structureCalls = () => ops.calls.filter((c) => !c.op.startsWith('responses'));
  return { ops, port, emit, listeners, structureCalls };
}

describe('reads', () => {
  it('form() reads the DETAIL; a list-shaped row is refused, not guessed', async () => {
    const { port, ops } = setup();
    expect((await port.form(FORM)).content.questions.map((x) => x.key)).toEqual(['a', 'b', 'c']);
    ops.forms.get(FORM)!.content = { status: 'open', questionCount: 3 } as never;
    await expect(port.form(FORM)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('mine() = ?respondent=me (current + draft) then ?lineageKey for the history, every page', async () => {
    const rows = [
      row({ id: 'r1', revision: 1, isCurrent: false }),
      row({ id: 'r2', revision: 2, isCurrent: false, supersedesId: 'r1' }),
      row({ id: 'r3', revision: 3, supersedesId: 'r2' }),
      row({ id: 'd1', status: 'draft', isCurrent: false, supersedesId: 'r3', submittedAt: null, version: 4 }),
    ];
    const { port, ops } = setup({ rows, pageSize: 2 });
    const slot = await port.mine(FORM);
    expect(slot.current?.id).toBe('r3');
    expect(slot.draft?.id).toBe('d1');
    expect(slot.history.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(ops.calls.map((c) => c.args[1])).toEqual([
      { respondent: 'me' },
      { lineageKey: ME },
      { lineageKey: ME, cursor: '2' },
    ]);
  });

  it('responses() pages current rows with the cursor; revisions() = ?lineageKey', async () => {
    const { port, ops } = setup({ rows: [row({})] });
    await port.responses(FORM, 'abc');
    await port.revisions(FORM, ME);
    expect(ops.calls.map((c) => c.args[1])).toEqual([{ cursor: 'abc' }, { lineageKey: ME }]);
  });
});

describe('responses', () => {
  it('saveDraft/submit send responseVersion and map supersedesId → amendOf; discard sends the draft version', async () => {
    const draft = row({ id: 'd1', status: 'draft', isCurrent: false, submittedAt: null, version: 3 });
    const { port, ops } = setup({ rows: [draft] });
    await port.saveDraft(FORM, { answers: { a: { text: 'x' } }, supersedesId: 'r0', responseVersion: 3 });
    await port.submit(FORM, { answers: { a: { text: 'x' } }, supersedesId: null, responseVersion: 4 });
    await port.discardDraft(FORM, { version: 5 });
    expect(ops.calls.map((c) => [c.op, c.args[1]])).toEqual([
      ['responsesSave', { answers: { a: { text: 'x' } }, amendOf: 'r0', responseVersion: 3 }],
      ['responsesSubmit', { answers: { a: { text: 'x' } }, responseVersion: 4 }],
      ['responsesDiscard', { responseVersion: 5 }],
    ]);
  });

  it('its own writes notify subscribers before any socket echo (the session banner relies on it)', async () => {
    const draft = row({ id: 'd1', status: 'draft', isCurrent: false, submittedAt: null });
    const { port } = setup({ rows: [draft] });
    const seen: FormsChange[] = [];
    port.subscribe(FORM, (c) => seen.push(c));
    await port.saveDraft(FORM, { answers: {}, supersedesId: null });
    await port.submit(FORM, { answers: {}, supersedesId: null });
    await port.transition(FORM, 'closed', 5);
    expect(seen).toEqual([{ kind: 'responses' }, { kind: 'responses' }, { kind: 'form' }]);
  });
});

describe('error mapping', () => {
  it('TFD01 (conflict + form_draft_in_flight) → draft_in_flight with the blocking draft', () => {
    const e = toFormsPortError(new CollabError('conflict', 'in flight', { details: { reason: 'form_draft_in_flight', draftId: 'd9' } }));
    expect(e).toMatchObject({ code: 'draft_in_flight', draftId: 'd9', reason: 'form_draft_in_flight' });
  });

  it('409 version_conflict passes through; 422 details.issues become field issues', () => {
    expect(toFormsPortError(new CollabError('version_conflict', 'stale'))).toMatchObject({ code: 'version_conflict' });
    const issues = [{ key: 'a', code: 'too_long', message: 'too long' }];
    expect(toFormsPortError(new CollabError('form_answers_invalid', 'bad', { details: { issues } }))).toMatchObject({ code: 'form_answers_invalid', issues });
  });

  it.each(['delivery_not_cancelled', 'delivery_not_pending', 'session_deleted'])('redeliver refusal %s → delivery_refused', (reason) => {
    expect(toFormsPortError(new CollabError('conflict', 'no', { details: { reason } }))).toMatchObject({ code: 'delivery_refused', reason });
  });

  it('an unknown server code is "unknown", and a non-collab error passes through untouched', () => {
    expect(toFormsPortError(new CollabError('limit_exceeded', 'x'))).toMatchObject({ code: 'unknown' });
    const plain = new TypeError('boom');
    expect(toFormsPortError(plain)).toBe(plain);
  });

  it('the port rejects with the mapped error', async () => {
    const draft = row({ id: 'd1', status: 'draft', isCurrent: false, submittedAt: null });
    const { port, ops } = setup({ rows: [draft] });
    ops.failNext('responsesSave', new CollabError('conflict', 'in flight', { details: { reason: 'form_draft_in_flight', draftId: 'd0' } }));
    await expect(port.saveDraft(FORM, { answers: {}, supersedesId: null })).rejects.toBeInstanceOf(FormsPortError);
  });
});

describe('updateStructure (the Build diff)', () => {
  const next = (f: FormState, questions: FormQuestionRow[]) => ({
    sections: f.content.sections, questions, settings: f.content.settings, expectedVersion: f.version,
  });

  it('issues ordered per-op calls, each expectedVersion chained from the previous result', async () => {
    const { port, structureCalls } = setup();
    const f = form();
    const result = await port.updateStructure(FORM, next(f, [q('c', 0), q('a', 1, { title: 'A!' }), q('d', 2)]));
    expect(structureCalls().map((c) => c.op)).toEqual(['questionsRemove', 'questionsUpdate', 'questionsAdd', 'questionsMove']);
    const versions = structureCalls().map((c) => (c.args[c.args.length - 1] as { expectedVersion: number }).expectedVersion);
    expect(versions).toEqual([5, 6, 7, 8]);
    expect(result.version).toBe(9);
    expect(result.content.questions.map((x) => [x.key, x.title])).toEqual([['c', 'C'], ['a', 'A!'], ['d', 'D']]);
  });

  it('nothing changed → no calls', async () => {
    const { port, structureCalls } = setup();
    await port.updateStructure(FORM, next(form(), form().content.questions));
    expect(structureCalls()).toEqual([]);
  });

  it('a stale expectedVersion is a version_conflict before any write', async () => {
    const { port, structureCalls } = setup();
    await expect(port.updateStructure(FORM, { ...next(form(), []), expectedVersion: 4 })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(structureCalls()).toEqual([]);
  });

  it('a failure at step k says "Saved k of n", returns the form step k-1 left; retry sends only the rest', async () => {
    const { port, ops, structureCalls } = setup();
    const f = form();
    const target = next(f, [q('c', 0), q('a', 1, { title: 'A!' }), q('d', 2)]);
    ops.failStructureCall(2, new CollabError('form_structure_frozen', 'frozen now'));
    const err = await port.updateStructure(FORM, target).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormsStructureSaveError);
    const partial = err as FormsStructureSaveError;
    expect([partial.done, partial.total, partial.step]).toEqual([2, 4, 'add question “d”']);
    expect(partial.message).toMatch(/^Saved 2 of 4 changes; stopped at add question “d”: frozen now/);
    expect((partial.cause as FormsPortError).code).toBe('form_structure_frozen');
    expect(partial.form.version).toBe(7);

    const before = structureCalls().length;
    const done = await port.updateStructure(FORM, { ...target, expectedVersion: partial.form.version });
    expect(structureCalls().slice(before).map((c) => c.op)).toEqual(['questionsAdd', 'questionsMove']);
    expect(done.content.questions.map((x) => x.key)).toEqual(['c', 'a', 'd']);
  });

  it('a failure at the FIRST step is the plain mapped error (nothing was saved)', async () => {
    const { port, ops } = setup();
    ops.failStructureCall(0, new CollabError('forbidden', 'not yours'));
    await expect(port.updateStructure(FORM, next(form(), [q('a', 0)]))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('redeliver', () => {
  it('is absent when the catalog lacks the op', () => {
    expect(setup().port.redeliver).toBeUndefined();
  });

  it('sends workSessionId and `to` for the response', async () => {
    const { port, ops } = setup({ withRedeliver: true });
    await port.redeliver!('r1', 'ws1', 'new_session');
    expect(ops.calls[ops.calls.length - 1]).toEqual({ op: 'redeliver', args: ['r1', { workSessionId: 'ws1', to: 'new_session' }] });
  });
});

describe('subscribe', () => {
  it('maps form upsert → form, messages/activity on the form → responses, session upsert → session; ignores the rest', () => {
    const { port, emit, listeners } = setup();
    const cb = vi.fn();
    const off = port.subscribe(FORM, cb);
    emit({ type: 'entity.upsert', entity: { id: FORM, kind: 'form' } });
    emit({ type: 'message.created', anchorId: FORM, message: {} });
    emit({ type: 'entity.activity_touched', id: FORM, kind: 'form', activityAt: 'x' });
    emit({ type: 'entity.upsert', entity: { id: 'ws1', kind: 'work_session' } });
    emit({ type: 'entity.upsert', entity: { id: 'other', kind: 'task' } });
    emit({ type: 'message.created', anchorId: 'other', message: {} });
    expect(cb.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'form' }, { kind: 'responses' }, { kind: 'responses' }, { kind: 'session', sessionId: 'ws1' },
    ]);
    off();
    expect(listeners.size).toBe(0);
  });
});
