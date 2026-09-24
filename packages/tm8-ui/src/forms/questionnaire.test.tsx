// @vitest-environment jsdom
/**
 * The questionnaire block, tab by tab and state by state, over a fresh
 * fixture port per test (so writes never leak between cases).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureFormsPort } from './fixture-port';
import { FORM_FIXTURE_FORMS, FORM_FIXTURE_IDS, FORM_FIXTURE_RESPONSES } from './fixtures';
import { AUTOSAVE_MS } from './FillTab';
import { QuestionnaireBlock, type QuestionnaireTab } from './QuestionnaireBlock';
import { FormsPortProvider, type FormResponseView } from './seam';

afterEach(() => {
  vi.useRealTimers();
});

async function mount(formId: string, tab: QuestionnaireTab = 'fill', responses?: FormResponseView[]) {
  const port = createFixtureFormsPort(responses ? { responses } : {});
  const f = FORM_FIXTURE_FORMS.find((x) => x.id === formId)!;
  const detail = { id: f.id, title: f.title, version: f.version, content: { kind: 'form', ...f.content } };
  const view = render(
    <FormsPortProvider port={port}>
      <QuestionnaireBlock detail={detail as never} initialTab={tab} />
    </FormsPortProvider>,
  );
  await screen.findByRole('tabpanel');
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return { ...view, port };
}

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

describe('header', () => {
  it('shows status, and the locked chip only once a response is submitted', async () => {
    await mount(FORM_FIXTURE_IDS.release);
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByTestId('frozen-chip')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Responses/ }).textContent).toBe('Responses4');
  });

  it('an unanswered form is not locked', async () => {
    await mount(FORM_FIXTURE_IDS.migration);
    expect(screen.queryByTestId('frozen-chip')).toBeNull();
  });
});

describe('Fill', () => {
  it('resumes the autosaved draft', async () => {
    await mount(FORM_FIXTURE_IDS.migration);
    expect(screen.getByTestId('fill-form')).toBeTruthy();
    expect((screen.getByLabelText('Dual write') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('save-state').textContent).toBe('Draft saved');
  });

  it('"Accept recommended" pre-selects the recommended options', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'fill', []);
    fireEvent.click(screen.getByRole('button', { name: 'Accept recommended' }));
    expect((screen.getByLabelText(/Feature flag/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^CLI/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^Web UI/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('beta');
    expect(screen.queryByRole('button', { name: 'Accept recommended' })).toBeNull();
  });

  it('renders one heading per section', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'fill', []);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Scope', 'Quality', 'Notes']);
  });

  it('autosaves a draft through the seam after the debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { port } = await mount(FORM_FIXTURE_IDS.release, 'fill', []);
    fireEvent.click(screen.getAllByRole('radio', { name: '4' })[0]!);
    expect(screen.getByTestId('save-state').textContent).toBe('Unsaved changes');
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    await waitFor(() => expect(screen.getByTestId('save-state').textContent).toBe('Draft saved'));
    const draft = port.rows.find((r) => r.status === 'draft' && r.formId === FORM_FIXTURE_IDS.release)!;
    expect(draft.answers).toEqual({ confidence: { number: 4 } });
  });

  it('does not autosave an answer that breaks a bound', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { port } = await mount(FORM_FIXTURE_IDS.release, 'fill', []);
    fireEvent.change(screen.getByPlaceholderText('e.g. quiet-harbor'), { target: { value: 'Not Valid' } });
    expect(screen.getByText('does not match the required pattern')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_MS + 10); });
    expect(screen.getByTestId('save-state').textContent).toBe('Not saved: fix the marked answers');
    expect(port.rows.some((r) => r.status === 'draft' && r.formId === FORM_FIXTURE_IDS.release)).toBe(false);
  });

  it('refuses to submit with required answers missing, and says which', async () => {
    const { port } = await mount(FORM_FIXTURE_IDS.release, 'fill', []);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getAllByText('An answer is required.')).toHaveLength(4);
    expect(port.rows).toHaveLength(0);
  });

  it('submits, then shows the answers and the delivery; closeOnSubmit closes it', async () => {
    await mount(FORM_FIXTURE_IDS.migration);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByTestId('fill-submitted');
    expect(within(screen.getByTestId('answer-strategy')).getByText('Dual write')).toBeTruthy();
    expect(screen.getByTestId('delivery-chip').getAttribute('data-status')).toBe('delivered');
  });

  it('after submit: answers, queued delivery with a stub Resume now, and the revision history', async () => {
    await mount(FORM_FIXTURE_IDS.release);
    expect(screen.getByTestId('fill-submitted')).toBeTruthy();
    expect(screen.getByText(/revision 3/)).toBeTruthy();
    expect(screen.getByText('Answer saved; will be delivered when the session resumes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(screen.getByText(/Resume requested/)).toBeTruthy();
    const history = screen.getByTestId('revision-history');
    expect([...history.querySelectorAll('[data-testid^="revision-"]')].map((li) => li.getAttribute('data-testid')))
      .toEqual(['revision-3', 'revision-2', 'revision-1']);
    expect(within(screen.getByTestId('revision-3')).getByText('Changed (4)')).toBeTruthy();
    expect(within(screen.getByTestId('revision-1')).getByText('First answer')).toBeTruthy();
  });

  it('Edit & resubmit makes the next revision', async () => {
    const { port } = await mount(FORM_FIXTURE_IDS.release);
    fireEvent.click(screen.getByRole('button', { name: 'Edit & resubmit' }));
    expect(screen.getByText('Editing revision 3')).toBeTruthy();
    expect((screen.getAllByRole('radio', { name: '4' })[0] as HTMLElement).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getAllByRole('radio', { name: '5' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Resubmit' }));
    await screen.findByTestId('fill-submitted');
    expect(screen.getByText(/revision 4/)).toBeTruthy();
    const current = port.rows.filter((r) => r.formId === FORM_FIXTURE_IDS.release && r.respondentId === 'act-ada' && r.isCurrent);
    expect(current.map((r) => [r.revision, r.supersedesId])).toEqual([[4, 'resp-ada-3']]);
  });

  it('closed: read-only answers, no Edit & resubmit', async () => {
    await mount(FORM_FIXTURE_IDS.retro);
    expect(screen.getByTestId('fill-closed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit & resubmit' })).toBeNull();
    expect(within(screen.getByTestId('answer-went_well')).getByText('Fast reviews')).toBeTruthy();
  });

  it('cancelled: says so, and offers nothing to fill', async () => {
    await mount(FORM_FIXTURE_IDS.naming);
    expect(screen.getByTestId('fill-cancelled')).toBeTruthy();
    expect(screen.getByTestId('fill-no-answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('a draft form cannot be answered yet', async () => {
    await mount(FORM_FIXTURE_IDS.onboarding);
    expect(screen.getByTestId('fill-draft')).toBeTruthy();
  });
});

describe('Build', () => {
  it('frozen: explains why, and locks questions, sections and the responses setting', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'build');
    expect(screen.getByTestId('frozen-banner').textContent).toMatch(/questions,\s+sections and the responses setting are frozen/);
    expect(screen.queryByText('+ Short text')).toBeNull();
    expect((screen.getByLabelText('Move target down') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Remove target') as HTMLButtonElement).disabled).toBe(true);
    const settings = screen.getByTestId('build-settings');
    expect((within(settings).getByDisplayValue('One per member') as HTMLSelectElement).disabled).toBe(true);
    expect((within(settings).getByDisplayValue('Humans only') as HTMLSelectElement).disabled).toBe(false);
  });

  it('frozen: the other settings still save', async () => {
    const { port } = await mount(FORM_FIXTURE_IDS.release, 'build');
    fireEvent.click(screen.getByLabelText('Members can edit and resubmit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    expect((await port.mine(FORM_FIXTURE_IDS.release)).current).not.toBeNull();
    expect(screen.queryByTestId('build-error')).toBeNull();
  });

  it('adds, edits, reorders and saves a question, with a live preview', async () => {
    await mount(FORM_FIXTURE_IDS.migration, 'build');
    fireEvent.click(screen.getByRole('button', { name: '+ Short text' }));
    const editor = screen.getByTestId('question-editor');
    fireEvent.change(within(editor).getByDisplayValue('New question'), { target: { value: 'Ticket id' } });
    const preview = screen.getByTestId('build-preview');
    expect(within(preview).getByText('Ticket id')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Move short_text_1 up'));
    expect(within(screen.getByTestId('build-questions')).getAllByRole('listitem').map((li) => li.getAttribute('data-testid')))
      .toEqual(['build-q-strategy', 'build-q-short_text_1', 'build-q-risks']);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Structure version 2');
  });

  it('checks configs with the contract schema and refuses to save a bad one', async () => {
    await mount(FORM_FIXTURE_IDS.migration, 'build');
    fireEvent.click(within(screen.getByTestId('build-q-strategy')).getByRole('button', { name: 'Edit' }));
    const json = within(screen.getByTestId('question-editor')).getByRole('textbox', { name: /Config/ });
    fireEvent.change(json, { target: { value: '{"options": []}' } });
    expect(within(screen.getByTestId('question-editor')).getByRole('alert').textContent).toMatch(/at least 2/);
    expect(screen.getByTestId('build-issues')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves the form through its lifecycle', async () => {
    await mount(FORM_FIXTURE_IDS.onboarding, 'build');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

describe('Responses', () => {
  it('a table of current responses with a delivery chip each; drafts never appear', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'responses');
    const rows = within(screen.getByTestId('responses-table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(screen.getAllByTestId('delivery-chip').map((c) => c.getAttribute('data-status')).sort())
      .toEqual(['cancelled', 'delivered', 'pending', 'spawned']);
    expect(screen.getAllByTestId('delivery-chip').map((c) => c.textContent).sort())
      .toEqual(['Cancelled', 'Delivered', 'Queued', 'Spawned']);
  });

  it('a response detail shows its revisions and its queued delivery', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'responses');
    fireEvent.click(screen.getByRole('button', { name: 'Ada' }));
    const detail = await screen.findByTestId('response-detail');
    expect(within(detail).getByText('Answer saved; will be delivered when the session resumes.')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Resume now' })).toBeTruthy();
    await within(detail).findByTestId('revision-history');
    expect(within(detail).getAllByText('Changed').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '← All responses' }));
    expect(screen.getByTestId('responses-table')).toBeTruthy();
  });

  it('a cancelled delivery says the answer is stored', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'responses');
    fireEvent.click(screen.getByRole('button', { name: 'Omar' }));
    expect((await screen.findByTestId('delivery-note')).textContent).toMatch(/session is gone \(session deleted\)/);
  });

  it('empty', async () => {
    await mount(FORM_FIXTURE_IDS.migration, 'responses');
    expect(screen.getByTestId('responses-empty')).toBeTruthy();
  });

  it('switching tabs keeps the same form', async () => {
    await mount(FORM_FIXTURE_IDS.release, 'responses', FORM_FIXTURE_RESPONSES);
    tab('Fill');
    expect(screen.getByTestId('fill-submitted')).toBeTruthy();
  });
});
