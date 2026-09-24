/**
 * BUILD — the author's view: add, reorder and edit questions and sections
 * with a live preview, edit settings, and move the form through its
 * lifecycle (FORMS-DESIGN §5, §10).
 *
 * ONE FREEZE RULE (§5): at the first submitted response, questions, sections
 * AND `settings.responses` freeze together. The rest of the settings stay
 * editable. The banner says why, so a disabled control is never a mystery.
 *
 * Question configs are edited as JSON checked by the CONTRACT registry's
 * config schema, and a new question starts from its type's contract
 * `example.config` — so Build knows no type either; the live preview is the
 * registry's own input component.
 */
import { useMemo, useState } from 'react';
import {
  DEFAULT_FORM_SETTINGS,
  FORM_QUESTION_TYPE_NAMES,
  FormSettingsSchema,
  FormSpecSchema,
  formQuestionConfigIssues,
  formQuestionTypeDef,
  formJsonEqual,
  type FormAnswers,
  type FormQuestionRow,
  type FormSectionRow,
  type FormSettings,
} from '@tm8/contract';
import { Notice, QuestionField, QuestionFields } from './parts';
import { FORM_TRANSITIONS, type FormState } from './seam';
import { errorText, type Questionnaire } from './useQuestionnaire';

interface Draft {
  sections: FormSectionRow[];
  questions: FormQuestionRow[];
  settings: FormSettings;
}

const TRANSITION_WORD = { open: 'Open', closed: 'Close', cancelled: 'Cancel form' } as const;

function draftOf(form: FormState): Draft {
  return {
    sections: [...form.content.sections].sort((a, b) => a.position - b.position),
    questions: [...form.content.questions].sort((a, b) => a.position - b.position),
    settings: form.content.settings,
  };
}

const renumber = <T extends { position: number }>(rows: T[]): T[] => rows.map((r, position) => ({ ...r, position }));

function uniqueKey(base: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const key = `${base}_${n}`;
    if (!taken.has(key)) return key;
  }
}

/** The contract's own spec check, over the working copy. */
function specIssues(title: string, d: Draft): string[] {
  const parsed = FormSpecSchema.safeParse({
    title,
    sections: d.sections.map(({ position: _p, ...s }) => s),
    questions: d.questions.map(({ position: _p, ...q }) => q),
    settings: d.settings,
  });
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => {
    const [head, index, ...rest] = i.path;
    const where = head === 'questions' && typeof index === 'number'
      ? `${d.questions[index]?.key ?? `question ${index + 1}`}${rest.length ? `.${rest.join('.')}` : ''}`
      : i.path.join('.');
    return where ? `${where}: ${i.message}` : i.message;
  });
}

export function BuildTab({ q }: { q: Questionnaire }) {
  const { form, frozen, port } = q;
  const base = useMemo(() => (form ? draftOf(form) : null), [form]);
  const [work, setWork] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!form || !base) return null;
  const d = work ?? base;
  const dirty = work !== null && !formJsonEqual(work, base);
  const locked = frozen || form.content.status === 'cancelled';
  const issues = dirty ? specIssues(form.title, d) : [];
  const update = (next: Partial<Draft>) => { setWork({ ...d, ...next }); setError(null); };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const written = await port.updateStructure(form.id, {
        sections: renumber(d.sections),
        questions: renumber(d.questions),
        settings: d.settings,
        expectedVersion: form.version,
      });
      q.setForm(written);
      setWork(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const transition = async (to: 'open' | 'closed' | 'cancelled') => {
    setError(null);
    try {
      q.setForm(await port.transition(form.id, to, form.version));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const move = (key: string, by: -1 | 1) => {
    const i = d.questions.findIndex((x) => x.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= d.questions.length) return;
    const next = [...d.questions];
    [next[i], next[j]] = [next[j]!, next[i]!];
    update({ questions: renumber(next) });
  };

  const add = (type: string) => {
    const def = formQuestionTypeDef(type);
    if (!def) return;
    const key = uniqueKey(type, new Set(d.questions.map((x) => x.key)));
    const question: FormQuestionRow = {
      key, type, title: 'New question', required: true, position: d.questions.length,
      config: structuredClone(def.example.config) as Record<string, unknown>,
    };
    update({ questions: [...d.questions, question] });
    setEditing(key);
  };

  return (
    <div className="qn-build" data-testid="build">
      {frozen ? (
        <Notice tone="wait" title="Questions are locked" testId="frozen-banner">
          A response has been submitted, so the questions, sections and the responses setting are frozen: changing them would change what earlier answers meant. Other
          settings can still change.
        </Notice>
      ) : null}

      <div className="qn-bar">
        <span className="qn-bar__lead qn-muted">Structure version {form.content.structureVersion}</span>
        <span className="qn-bar__actions">
          {FORM_TRANSITIONS[form.content.status].map((to) => (
            <button
              key={to}
              type="button"
              className={to === 'open' ? 'pn-btn pn-btn--primary' : 'pn-btn'}
              onClick={() => void transition(to)}
            >
              {form.content.status === 'closed' && to === 'open' ? 'Reopen' : TRANSITION_WORD[to]}
            </button>
          ))}
        </span>
      </div>

      <h4 className="qn-subhead">Questions</h4>
      <ol className="qb-list" data-testid="build-questions">
        {d.questions.map((question, i) => (
          <li key={question.key} className="qb-item" data-testid={`build-q-${question.key}`}>
            <div className="qb-item__row">
              <span className="qb-item__n">{i + 1}</span>
              <span className="qb-item__title">{question.title}</span>
              <span className="qn-muted">{formQuestionTypeDef(question.type)?.label ?? question.type}</span>
              {question.required ? null : <span className="qn-muted">optional</span>}
              <span className="qb-item__actions">
                <button type="button" className="pn-btn pn-btn--quiet" aria-label={`Move ${question.key} up`} disabled={locked || i === 0} onClick={() => move(question.key, -1)}>↑</button>
                <button type="button" className="pn-btn pn-btn--quiet" aria-label={`Move ${question.key} down`} disabled={locked || i === d.questions.length - 1} onClick={() => move(question.key, 1)}>↓</button>
                <button type="button" className="pn-btn pn-btn--quiet" aria-expanded={editing === question.key} onClick={() => setEditing(editing === question.key ? null : question.key)}>
                  {locked ? 'View' : 'Edit'}
                </button>
                <button
                  type="button"
                  className="pn-btn pn-btn--quiet"
                  aria-label={`Remove ${question.key}`}
                  disabled={locked}
                  onClick={() => update({ questions: renumber(d.questions.filter((x) => x.key !== question.key)) })}
                >
                  ✕
                </button>
              </span>
            </div>
            {editing === question.key ? (
              <QuestionEditor
                question={question}
                sections={d.sections}
                locked={locked}
                taken={new Set(d.questions.filter((x) => x.key !== question.key).map((x) => x.key))}
                onChange={(next) => {
                  update({ questions: d.questions.map((x) => (x.key === question.key ? next : x)) });
                  if (next.key !== question.key) setEditing(next.key);
                }}
              />
            ) : null}
          </li>
        ))}
      </ol>
      {locked ? null : (
        <div className="qb-add">
          <span className="qn-muted">Add a question:</span>
          {FORM_QUESTION_TYPE_NAMES.map((type) => (
            <button key={type} type="button" className="pn-btn" onClick={() => add(type)}>
              + {formQuestionTypeDef(type)!.label}
            </button>
          ))}
        </div>
      )}

      <SectionsEditor sections={d.sections} locked={locked} onChange={(sections) => update({ sections })} />
      <SettingsEditor settings={d.settings} frozen={frozen} disabled={form.content.status === 'cancelled'} onChange={(settings) => update({ settings })} />

      {issues.length > 0 ? (
        <ul className="fq__issues" role="alert" data-testid="build-issues">
          {issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      ) : null}
      {error ? <p className="fq__issues" role="alert" data-testid="build-error">{error}</p> : null}
      <div className="qn-bar qn-bar--foot">
        <span className="qn-bar__lead qn-muted">{dirty ? 'Unsaved changes' : ''}</span>
        <span className="qn-bar__actions">
          <button type="button" className="pn-btn pn-btn--quiet" disabled={!dirty || saving} onClick={() => { setWork(null); setError(null); }}>
            Revert
          </button>
          <button
            type="button"
            className="pn-btn pn-btn--primary"
            disabled={!dirty || saving || issues.length > 0}
            onClick={() => void save()}
          >
            Save changes
          </button>
        </span>
      </div>

      <h4 className="qn-subhead">Live preview</h4>
      <Preview draft={d} />
    </div>
  );
}

/** The working copy, rendered by the same fields Fill uses. Answers here are never saved. */
function Preview({ draft }: { draft: Draft }) {
  const [answers, setAnswers] = useState<FormAnswers>({});
  return (
    <div className="qb-preview" data-testid="build-preview">
      <QuestionFields
        sections={draft.sections}
        questions={draft.questions}
        answers={answers}
        onChange={(key, next) => setAnswers({ ...answers, [key]: next as FormAnswers[string] })}
      />
    </div>
  );
}

function QuestionEditor({
  question, sections, locked, taken, onChange,
}: {
  question: FormQuestionRow;
  sections: FormSectionRow[];
  locked: boolean;
  taken: Set<string>;
  onChange(next: FormQuestionRow): void;
}) {
  const [configText, setConfigText] = useState(() => JSON.stringify(question.config, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [previewValue, setPreviewValue] = useState<unknown>(null);
  const configIssues = formQuestionConfigIssues(question.type, question.config);
  const keyTaken = taken.has(question.key);
  const set = (patch: Partial<FormQuestionRow>) => onChange({ ...question, ...patch });

  return (
    <div className="qb-editor" data-testid="question-editor">
      <fieldset className="qb-editor__fields" disabled={locked}>
        <label className="qb-field">
          <span>Title</span>
          <input className="fq-text" value={question.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="qb-field">
          <span>Key</span>
          <input
            className="fq-text"
            value={question.key}
            aria-invalid={keyTaken || undefined}
            onChange={(e) => set({ key: e.target.value })}
          />
          {keyTaken ? <span className="fq__issues">Another question uses this key.</span> : null}
        </label>
        <label className="qb-field">
          <span>Help (markdown)</span>
          <textarea
            className="fq-textarea"
            rows={2}
            value={question.help ?? ''}
            onChange={(e) => {
              const { help: _h, ...rest } = question;
              onChange(e.target.value ? { ...rest, help: e.target.value } : rest);
            }}
          />
        </label>
        <label className="qb-field qb-field--inline">
          <input type="checkbox" checked={question.required} onChange={(e) => set({ required: e.target.checked })} />
          <span>Required</span>
        </label>
        {sections.length > 0 ? (
          <label className="qb-field">
            <span>Section</span>
            <select
              className="fq-select"
              value={question.section ?? ''}
              onChange={(e) => {
                const { section: _s, ...rest } = question;
                onChange(e.target.value ? { ...rest, section: e.target.value } : rest);
              }}
            >
              <option value="">No section</option>
              {sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
            </select>
          </label>
        ) : null}
        <label className="qb-field">
          <span>Type</span>
          <select
            className="fq-select"
            value={question.type}
            onChange={(e) => {
              const def = formQuestionTypeDef(e.target.value);
              if (!def) return;
              const config = structuredClone(def.example.config) as Record<string, unknown>;
              setConfigText(JSON.stringify(config, null, 2));
              setParseError(null);
              setPreviewValue(null);
              set({ type: e.target.value, config });
            }}
          >
            {FORM_QUESTION_TYPE_NAMES.map((type) => (
              <option key={type} value={type}>{formQuestionTypeDef(type)!.label}</option>
            ))}
          </select>
        </label>
        <label className="qb-field">
          <span>Config (JSON, checked by the {formQuestionTypeDef(question.type)?.label ?? question.type} schema)</span>
          <textarea
            className="fq-textarea qb-json"
            rows={6}
            spellCheck={false}
            value={configText}
            aria-invalid={parseError !== null || configIssues.length > 0 || undefined}
            onChange={(e) => {
              setConfigText(e.target.value);
              try {
                const parsed: unknown = JSON.parse(e.target.value);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be an object');
                setParseError(null);
                set({ config: parsed as Record<string, unknown> });
              } catch (err) {
                setParseError(errorText(err));
              }
            }}
          />
        </label>
        {parseError ? <span className="fq__issues" role="alert">{parseError}</span> : null}
        {!parseError && configIssues.length > 0 ? (
          <span className="fq__issues" role="alert">{configIssues.map((i) => i.message).join('; ')}</span>
        ) : null}
      </fieldset>
      <div className="qb-editor__preview">
        <span className="qn-muted">Preview</span>
        <QuestionField question={question} value={previewValue} onChange={setPreviewValue} />
      </div>
    </div>
  );
}

function SectionsEditor({
  sections, locked, onChange,
}: {
  sections: FormSectionRow[];
  locked: boolean;
  onChange(next: FormSectionRow[]): void;
}) {
  return (
    <div className="qb-sections" data-testid="build-sections">
      <h4 className="qn-subhead">Sections</h4>
      {sections.length === 0 ? <p className="qn-muted">No sections: the questions render as one list.</p> : null}
      <fieldset className="qb-editor__fields" disabled={locked}>
        {sections.map((s) => (
          <div key={s.key} className="qb-section-row">
            <input
              className="fq-text"
              aria-label={`Section ${s.key} title`}
              value={s.title}
              onChange={(e) => onChange(sections.map((x) => (x.key === s.key ? { ...x, title: e.target.value } : x)))}
            />
            <code className="qn-muted">{s.key}</code>
            <button
              type="button"
              className="pn-btn pn-btn--quiet"
              aria-label={`Remove section ${s.key}`}
              onClick={() => onChange(renumber(sections.filter((x) => x.key !== s.key)))}
            >
              ✕
            </button>
          </div>
        ))}
        {locked ? null : (
          <button
            type="button"
            className="pn-btn"
            onClick={() => onChange([
              ...sections,
              { key: uniqueKey('section', new Set(sections.map((s) => s.key))), title: 'New section', position: sections.length },
            ])}
          >
            + Section
          </button>
        )}
      </fieldset>
    </div>
  );
}

function SettingsEditor({
  settings, frozen, disabled, onChange,
}: {
  settings: FormSettings;
  frozen: boolean;
  disabled: boolean;
  onChange(next: FormSettings): void;
}) {
  const set = (patch: Partial<FormSettings>) => {
    const parsed = FormSettingsSchema.safeParse({ ...settings, ...patch });
    onChange(parsed.success ? parsed.data : { ...settings, ...patch });
  };
  return (
    <div className="qb-settings" data-testid="build-settings">
      <h4 className="qn-subhead">Settings</h4>
      <fieldset className="qb-editor__fields" disabled={disabled}>
        <label className="qb-field">
          <span>Responses{frozen ? ' (locked)' : ''}</span>
          <select
            className="fq-select"
            value={settings.responses}
            disabled={frozen}
            onChange={(e) => set({ responses: e.target.value as FormSettings['responses'] })}
          >
            <option value="per_member">One per member</option>
            <option value="single">One for the whole form</option>
            <option value="unlimited">Unlimited</option>
          </select>
        </label>
        <label className="qb-field">
          <span>Who can answer</span>
          <select
            className="fq-select"
            value={settings.respondents}
            onChange={(e) => set({ respondents: e.target.value as FormSettings['respondents'] })}
          >
            <option value="humans">Humans only</option>
            <option value="anyone">Humans and agents</option>
          </select>
        </label>
        <label className="qb-field qb-field--inline">
          <input type="checkbox" checked={settings.allowAmend} onChange={(e) => set({ allowAmend: e.target.checked })} />
          <span>Members can edit and resubmit</span>
        </label>
        <label className="qb-field qb-field--inline">
          <input type="checkbox" checked={settings.closeOnSubmit} onChange={(e) => set({ closeOnSubmit: e.target.checked })} />
          <span>Close after the first submit</span>
        </label>
        <label className="qb-field">
          <span>Deliver answers to</span>
          <select
            className="fq-select"
            value={settings.delivery.target}
            onChange={(e) => set({ delivery: { ...settings.delivery, target: e.target.value as FormSettings['delivery']['target'] } })}
          >
            <option value="requesting_session">The requesting session</option>
            <option value="new_session">A new session</option>
          </select>
        </label>
        <label className="qb-field">
          <span>If that session isn’t running</span>
          <select
            className="fq-select"
            value={settings.delivery.onSessionNotLive}
            onChange={(e) => set({ delivery: { ...settings.delivery, onSessionNotLive: e.target.value as FormSettings['delivery']['onSessionNotLive'] } })}
          >
            <option value="resume">Resume it</option>
            <option value="queue">Queue until it resumes</option>
            <option value="spawn_new">Start a new session</option>
          </select>
        </label>
        <label className="qb-field">
          <span>Attention points (1–100)</span>
          <input
            className="fq-text"
            type="number"
            min={1}
            max={100}
            value={settings.attentionPoints}
            onChange={(e) => set({ attentionPoints: Number(e.target.value) || DEFAULT_FORM_SETTINGS.attentionPoints })}
          />
        </label>
      </fieldset>
    </div>
  );
}
