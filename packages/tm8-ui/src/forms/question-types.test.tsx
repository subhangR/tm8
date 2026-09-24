// @vitest-environment jsdom
/**
 * The UI question-type registry: totality against the contract, and one
 * component test per input and per answer renderer. Every answer an input
 * emits is run back through the CONTRACT validator, so an input can never
 * produce a shape the server would refuse.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  FORM_QUESTION_TYPE_NAMES,
  FORM_QUESTION_TYPES,
  validateFormAnswers,
  type FormQuestionRow,
} from '@tm8/contract';
import { AnswerView, QuestionField } from './parts';
import { QUESTION_TYPE_UI, resolveQuestion } from './question-types';

describe('registry totality', () => {
  it('has exactly one UI entry per contract question type', () => {
    expect(Object.keys(QUESTION_TYPE_UI).sort()).toEqual([...FORM_QUESTION_TYPE_NAMES].sort());
  });

  it('gives every entry an input and an answer renderer', () => {
    for (const entry of Object.values(QUESTION_TYPE_UI)) {
      expect(typeof entry.Input).toBe('function');
      expect(typeof entry.Answer).toBe('function');
    }
  });

  it("renders every contract type's own example answer", () => {
    for (const type of FORM_QUESTION_TYPE_NAMES) {
      const def = FORM_QUESTION_TYPES[type];
      const q: FormQuestionRow = { key: 'q', type, title: 'T', required: true, position: 0, config: def.example.config as Record<string, unknown> };
      const { container, unmount } = render(<AnswerView question={q} answer={def.example.answer} />);
      expect(container.textContent, type).not.toBe('');
      expect(container.querySelector('.fq-answer__raw'), type).toBeNull();
      unmount();
    }
  });
});

/**
 * NOTHING OUTSIDE THE REGISTRY SWITCHES ON TYPE. Scanned as source: a quoted
 * question-type name may appear only in the registry directory, fixtures and
 * tests. Anything else that needs to know a type must look an entry up.
 */
describe('no type switch outside the registry', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const files = walk(SRC)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f))
    .filter((f) => !f.includes(`${join('forms', 'question-types')}`))
    .filter((f) => !/fixtures?[./]/.test(relative(SRC, f)));

  it('scans a non-empty file set', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no non-registry source quotes a question-type name', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const type of FORM_QUESTION_TYPE_NAMES) {
        if (new RegExp(`['"\`]${type}['"\`]`).test(text)) offenders.push(`${relative(SRC, file)} → '${type}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function Harness({ question, onValue }: { question: FormQuestionRow; onValue(v: unknown): void }) {
  const [value, setValue] = useState<unknown>(null);
  return (
    <QuestionField
      question={question}
      value={value}
      onChange={(v) => { setValue(v); onValue(v); }}
    />
  );
}

function mount(question: FormQuestionRow) {
  const seen: unknown[] = [];
  const view = render(<Harness question={question} onValue={(v) => seen.push(v)} />);
  const last = () => seen[seen.length - 1];
  /** The last emitted answer passes the contract's final validation. */
  const valid = () => validateFormAnswers([question], { [question.key]: last() as Record<string, unknown> }, { final: true });
  return { ...view, seen, last, valid };
}

const q = (over: Partial<FormQuestionRow> & Pick<FormQuestionRow, 'type' | 'config'>): FormQuestionRow => ({
  key: 'q', title: 'Question', required: true, position: 0, ...over,
});

const OPTIONS = [
  { value: 'a', label: 'Alpha', recommended: true, help: 'The first one.' },
  { value: 'b', label: 'Beta' },
];

describe('single_choice input', () => {
  it('radio: picks an option and shows its help', () => {
    const m = mount(q({ type: 'single_choice', config: { options: OPTIONS } }));
    expect(screen.getByText('Recommended')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Alpha/));
    expect(m.last()).toEqual({ value: 'a' });
    expect(m.valid()).toEqual([]);
    expect(screen.getByText('The first one.')).toBeTruthy();
  });

  it('radio: a write-in emits {other}', () => {
    const m = mount(q({ type: 'single_choice', config: { options: OPTIONS, allowOther: true } }));
    fireEvent.click(screen.getByLabelText('Other'));
    fireEvent.change(screen.getByLabelText('Other answer'), { target: { value: 'Gamma' } });
    expect(m.last()).toEqual({ other: 'Gamma' });
    expect(m.valid()).toEqual([]);
  });

  it('dropdown: selects, writes in, and clears', () => {
    const m = mount(q({ type: 'single_choice', config: { options: OPTIONS, allowOther: true, display: 'dropdown' } }));
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(m.last()).toEqual({ value: 'b' });
    fireEvent.change(select, { target: { value: '\u0000other' } });
    fireEvent.change(screen.getByLabelText('Other answer'), { target: { value: 'Delta' } });
    expect(m.last()).toEqual({ other: 'Delta' });
    fireEvent.change(select, { target: { value: '' } });
    expect(m.last()).toBeNull();
  });

  it('recommends the recommended option', () => {
    const r = resolveQuestion('single_choice', { options: OPTIONS })!;
    expect(r.ui.recommended?.(r.config)).toEqual({ value: 'a' });
  });
});

describe('multi_choice input', () => {
  it('toggles values in option order, adds a write-in, empties to null', () => {
    const m = mount(q({ type: 'multi_choice', config: { options: [...OPTIONS, { value: 'c', label: 'Gamma' }], allowOther: true, maxSelected: 3 } }));
    expect(screen.getByText('Pick up to 3')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Gamma'));
    fireEvent.click(screen.getByLabelText(/Alpha/));
    expect(m.last()).toEqual({ values: ['a', 'c'] });
    fireEvent.click(screen.getByLabelText('Other'));
    fireEvent.change(screen.getByLabelText('Other answer'), { target: { value: 'Zeta' } });
    expect(m.last()).toEqual({ values: ['a', 'c'], other: 'Zeta' });
    expect(m.valid()).toEqual([]);
    fireEvent.click(screen.getByLabelText('Other'));
    fireEvent.click(screen.getByLabelText('Gamma'));
    fireEvent.click(screen.getByLabelText(/Alpha/));
    expect(m.last()).toBeNull();
  });

  it('recommends every recommended option, capped at maxSelected', () => {
    const r = resolveQuestion('multi_choice', {
      options: [{ value: 'a', label: 'A', recommended: true }, { value: 'b', label: 'B', recommended: true }], maxSelected: 1,
    })!;
    expect(r.ui.recommended?.(r.config)).toEqual({ values: ['a'] });
  });
});

describe('short_text input', () => {
  it('emits {text}, counts, and empties to null', () => {
    const m = mount(q({ type: 'short_text', config: { maxLength: 20, placeholder: 'name' } }));
    const input = screen.getByPlaceholderText('name');
    fireEvent.change(input, { target: { value: 'billing' } });
    expect(m.last()).toEqual({ text: 'billing' });
    expect(m.valid()).toEqual([]);
    expect(screen.getByText('7/20')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    expect(m.last()).toBeNull();
  });
});

describe('long_text input', () => {
  it('emits markdown text and previews it', () => {
    const m = mount(q({ type: 'long_text', config: {} }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Run it **off-peak**.' } });
    expect(m.last()).toEqual({ text: 'Run it **off-peak**.' });
    expect(m.valid()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('off-peak').tagName).toBe('STRONG');
  });
});

describe('scale input', () => {
  it('one radio per point with end labels; emits {number}', () => {
    const m = mount(q({ type: 'scale', config: { min: 0, max: 4, minLabel: 'Low', maxLabel: 'High' } }));
    const points = screen.getAllByRole('radio');
    expect(points.map((p) => p.textContent)).toEqual(['0', '1', '2', '3', '4']);
    expect(screen.getByText('Low')).toBeTruthy();
    fireEvent.click(points[3]!);
    expect(m.last()).toEqual({ number: 3 });
    expect(points[3]!.getAttribute('aria-checked')).toBe('true');
    expect(m.valid()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Answer renderers
// ---------------------------------------------------------------------------

function answer(question: FormQuestionRow, value: unknown) {
  return render(<AnswerView question={question} answer={value} />).container;
}

describe('answer renderers', () => {
  it('single_choice: label, recommended badge, write-in', () => {
    const question = q({ type: 'single_choice', config: { options: OPTIONS, allowOther: true } });
    expect(answer(question, { value: 'a' }).textContent).toBe('AlphaRecommended');
    expect(answer(question, { other: 'Gamma' }).textContent).toBe('Other: “Gamma”');
  });

  it('multi_choice: each label and the write-in', () => {
    const question = q({ type: 'multi_choice', config: { options: OPTIONS, allowOther: true } });
    expect(answer(question, { values: ['b'], other: 'Z' }).textContent).toBe('BetaOther: “Z”');
    expect(answer(question, { values: [] }).textContent).toBe('None selected');
  });

  it('short_text: the text', () => {
    expect(answer(q({ type: 'short_text', config: {} }), { text: 'billing' }).textContent).toBe('billing');
  });

  it('long_text: rendered markdown', () => {
    const c = answer(q({ type: 'long_text', config: {} }), { text: '- one\n- two' });
    expect(c.querySelectorAll('li')).toHaveLength(2);
  });

  it('scale: the number, the range and the labels', () => {
    const c = answer(q({ type: 'scale', config: { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' } }), { number: 4 });
    expect(c.textContent).toBe('4 of 1–5 (Low … High)');
    expect(c.querySelectorAll('[data-on]')).toHaveLength(4);
  });

  it('no answer, and a shape the type does not accept', () => {
    const question = q({ type: 'short_text', config: {} });
    expect(answer(question, null).textContent).toBe('No answer');
    expect(answer(question, { bogus: 1 }).querySelector('.fq-answer__raw')).not.toBeNull();
  });
});
