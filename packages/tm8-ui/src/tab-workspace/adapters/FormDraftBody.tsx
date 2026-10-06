/**
 * `form` draft body (D7, Spec A §9): title plus questions, created in one
 * `forms.create` call (`seam.commands.forms.create`, the same op as
 * `tm8 form create`).
 *
 * The question list and editor are the questionnaire block's own Build parts
 * (`forms/BuildTab.tsx`): a row per question, Edit opens `QuestionEditor`
 * (title, key, help, required, type, config — a choice type's options live in
 * its config), and the contract's `FormSpecSchema` checks the whole spec
 * before the create. The form is created as a draft (a human's default, §5);
 * its Build tab opens it for responses.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  DEFAULT_FORM_SETTINGS,
  FORM_QUESTION_TYPE_NAMES,
  formQuestionTypeDef,
  type FormQuestionRow,
  type SpaceId,
} from '@tm8/contract';
import { classifyFailure, createdIdOf, placeholderTitleFor, RefusalCard, type RefusedFailure } from '../../authoring';
import { QuestionEditor, specIssues, uniqueKey } from '../../forms/BuildTab';
import { useWorkspace } from '../view/context';
import type { DraftHostProps } from './draft';
import { getKindAdapter } from './registry';
import '../../forms/questionnaire.css';
import '../view/creation.css';

/** A question row plus a mount-stable id, so editing its key keeps the editor. */
interface Row {
  id: number;
  question: FormQuestionRow;
}

function questionsOf(values: Record<string, unknown> | null): FormQuestionRow[] {
  const raw = values?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is FormQuestionRow =>
      typeof q === 'object' && q !== null && typeof (q as FormQuestionRow).key === 'string' && typeof (q as FormQuestionRow).type === 'string',
  );
}

const renumber = (questions: FormQuestionRow[]): FormQuestionRow[] => questions.map((q, position) => ({ ...q, position }));

export function FormDraftBody({ tab, values, onValues, onCreated, onCancel, onSubmitting }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const port = gate.data.seam.commands.forms;
  const noun = getKindAdapter(tab.kind).noun.toLowerCase();
  const placeholder = placeholderTitleFor(getKindAdapter(tab.kind).noun);
  const nextId = useRef(0);
  const [title, setTitle] = useState(() => (typeof values?.title === 'string' ? values.title : ''));
  const [rows, setRows] = useState<Row[]>(() => questionsOf(values).map((question) => ({ id: nextId.current++, question })));
  const [editing, setEditing] = useState<number | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [failure, setFailure] = useState<RefusedFailure | null>(null);
  const firstField = useRef<HTMLInputElement | null>(null);
  const inFlight = useRef(false);
  const submitting = tab.submitting;

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const write = (next: { title: string; rows: Row[] }) => {
    setIssues([]);
    onValues({ title: next.title, questions: renumber(next.rows.map((r) => r.question)) });
  };
  const setQuestions = (next: Row[]) => {
    setRows(next);
    write({ title, rows: next });
  };

  const add = (type: string) => {
    const def = formQuestionTypeDef(type);
    if (!def) return;
    const key = uniqueKey(type, new Set(rows.map((r) => r.question.key)));
    const row: Row = {
      id: nextId.current++,
      question: {
        key, type, title: 'New question', required: true, position: rows.length,
        config: structuredClone(def.example.config) as Record<string, unknown>,
      },
    };
    setQuestions([...rows, row]);
    setEditing(row.id);
  };

  const move = (at: number, by: -1 | 1) => {
    const to = at + by;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[at], next[to]] = [next[to]!, next[at]!];
    setQuestions(next);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (inFlight.current || submitting || !port?.create) return;
    const finalTitle = title.trim() || placeholder;
    const questions = renumber(rows.map((r) => r.question));
    const found = specIssues(finalTitle, { sections: [], questions, settings: DEFAULT_FORM_SETTINGS });
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    inFlight.current = true;
    setFailure(null);
    onSubmitting(true);
    try {
      const result = await port.create({
        spaceId: spaceId as SpaceId,
        title: finalTitle,
        questions: questions.map(({ position: _p, ...q }) => q),
      });
      gate.data.reconcileCommand(result);
      const id = createdIdOf(result);
      if (id === null) {
        setFailure({
          kind: 'refused',
          cause: 'created, but the node did not return the new id',
          detail: 'The command succeeded and carried neither an entity nor a patch to read it from.',
          aftermath: `The ${noun} MAY exist — reload the list before trying again.`,
          code: 'no_id',
          retryable: false,
        });
        onSubmitting(false);
        return;
      }
      onCreated(id, finalTitle);
    } catch (error) {
      const classified = classifyFailure(error, 'create');
      setFailure(
        classified.kind === 'refused'
          ? classified
          : { kind: 'refused', cause: classified.cause, detail: classified.detail, aftermath: 'Nothing was created.', code: 'version_conflict', retryable: false },
      );
      onSubmitting(false);
    } finally {
      inFlight.current = false;
    }
  };

  const heading = <h2 className="tws-draft-title">{`New ${noun}`}</h2>;
  if (!port?.create) {
    return (
      <div className="tws-draft-form" data-testid="tws-draft-form-kind">
        {heading}
        <p className="tws-draft-note">This node does not offer form authoring.</p>
        <div className="au-dialog__actions tws-draft-actions">
          <button type="button" onClick={onCancel} data-testid="tws-draft-cancel">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const errorId = `tws-draft-error-${tab.id}`;
  return (
    <form className="tws-draft-form" onSubmit={(event) => void submit(event)} aria-label={`New ${noun}`} data-testid="tws-draft-form-kind">
      {heading}
      <label className="au-dialog__field">
        <span className="au-dialog__label">
          Title<em className="au-dialog__optional"> · optional</em>
        </span>
        <input
          ref={firstField}
          className="au-dialog__input"
          value={title}
          placeholder={placeholder}
          disabled={submitting}
          onChange={(event) => {
            setTitle(event.target.value);
            write({ title: event.target.value, rows });
          }}
          data-testid="tws-draft-title"
        />
      </label>
      <h4 className="qn-subhead">Questions</h4>
      {rows.length === 0 ? <p className="tws-draft-note">No questions yet: add one below.</p> : null}
      <ol className="qb-list" data-testid="tws-draft-form-questions">
        {rows.map(({ id, question }, i) => (
          <li key={id} className="qb-item" data-testid={`tws-draft-form-q-${i}`}>
            <div className="qb-item__row">
              <span className="qb-item__n">{i + 1}</span>
              <span className="qb-item__title">{question.title}</span>
              <span className="qn-muted">{formQuestionTypeDef(question.type)?.label ?? question.type}</span>
              {question.required ? null : <span className="qn-muted">optional</span>}
              <span className="qb-item__actions">
                <button type="button" className="pn-btn pn-btn--quiet" aria-label={`Move ${question.key} up`} disabled={submitting || i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="pn-btn pn-btn--quiet" aria-label={`Move ${question.key} down`} disabled={submitting || i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="pn-btn pn-btn--quiet" aria-expanded={editing === id} disabled={submitting} onClick={() => setEditing(editing === id ? null : id)}>
                  {editing === id ? 'Done' : 'Edit'}
                </button>
                <button
                  type="button"
                  className="pn-btn pn-btn--quiet"
                  aria-label={`Remove ${question.key}`}
                  disabled={submitting}
                  onClick={() => setQuestions(rows.filter((r) => r.id !== id))}
                >
                  Remove
                </button>
              </span>
            </div>
            {editing === id ? (
              <QuestionEditor
                question={question}
                sections={[]}
                locked={submitting}
                taken={new Set(rows.filter((r) => r.id !== id).map((r) => r.question.key))}
                onChange={(next) => setQuestions(rows.map((r) => (r.id === id ? { id, question: next } : r)))}
              />
            ) : null}
          </li>
        ))}
      </ol>
      <div className="qb-add">
        <span className="qn-muted">Add a question:</span>
        {FORM_QUESTION_TYPE_NAMES.map((type) => (
          <button key={type} type="button" className="pn-btn" disabled={submitting} onClick={() => add(type)}>
            {formQuestionTypeDef(type)!.label}
          </button>
        ))}
      </div>
      {issues.length > 0 ? (
        <ul className="fq__issues" role="alert" data-testid="tws-draft-form-issues">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
      {failure ? (
        <div id={errorId}>
          <RefusalCard word={failure.cause} detail={failure.detail} aftermath={failure.aftermath} moves={[]} />
        </div>
      ) : null}
      <p className="tws-draft-note">The form is created as a draft; open it for responses from its Build tab.</p>
      <div className="au-dialog__actions tws-draft-actions">
        <button type="button" onClick={onCancel} disabled={submitting} data-testid="tws-draft-cancel">
          Cancel
        </button>
        <button type="submit" className="au-dialog__primary" aria-busy={submitting} disabled={submitting} data-testid="tws-draft-create">
          {submitting ? 'Creating…' : `Create ${noun}`}
        </button>
      </div>
    </form>
  );
}
