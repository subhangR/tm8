// @vitest-environment jsdom
/**
 * The Responses tab: keyset paging that a live reload never collapses, the
 * Summary (the default) across the loaded responses, and Individual's
 * table + detail with prev/next.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFixtureFormsPort } from './fixture-port';
import { FORM_FIXTURE_FORMS, FORM_FIXTURE_IDS, FORM_FIXTURE_RESPONSES } from './fixtures';
import { QuestionnaireBlock } from './QuestionnaireBlock';
import { FormsPortProvider, type FormResponseView } from './seam';

const release = FORM_FIXTURE_FORMS.find((f) => f.id === FORM_FIXTURE_IDS.release)!;

async function mount(seed: { responses?: FormResponseView[]; pageSize?: number } = {}) {
  const port = createFixtureFormsPort({ ...seed, now: () => '2026-09-30T00:00:00.000Z' });
  const detail = { id: release.id, title: release.title, version: release.version, content: { kind: 'form', ...release.content } };
  render(
    <FormsPortProvider port={port}>
      <QuestionnaireBlock detail={detail as never} initialTab="responses" />
    </FormsPortProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return port;
}

const view = (name: 'Summary' | 'Individual') => fireEvent.click(screen.getByRole('tab', { name }));
const rowIds = () =>
  within(screen.getByTestId('responses-table')).getAllByRole('row').slice(1).map((r) => r.getAttribute('data-testid'));

/** `n` other members' current responses on the release review, newest p<n> → oldest p1. */
function others(n = 5): FormResponseView[] {
  const template = FORM_FIXTURE_RESPONSES.find((r) => r.id === 'resp-noor-1')!;
  return Array.from({ length: n }, (_, i) => ({
    ...structuredClone(template),
    id: `p${i + 1}`,
    respondentId: `mbr-p${i + 1}`,
    respondentName: `P${i + 1}`,
    lineageKey: `mbr-p${i + 1}`,
    submittedAt: `2026-09-20T0${i}:00:00.000Z`,
    deliveries: [],
  }));
}

describe('Responses paging', () => {
  it('later pages appear only after Load more, and the last page hides it', async () => {
    await mount({ responses: others(), pageSize: 2 });
    view('Individual');
    expect(rowIds()).toEqual(['response-row-p5', 'response-row-p4']);
    expect(screen.getByTestId('responses-more').textContent).toMatch(/2 shown/);
    expect(screen.getByRole('tab', { name: /^Responses/ }).textContent).toBe('Responses2+');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowIds()).toHaveLength(4));
    expect(rowIds()).toEqual(['response-row-p5', 'response-row-p4', 'response-row-p3', 'response-row-p2']);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowIds()).toHaveLength(5));
    expect(screen.queryByTestId('responses-more')).toBeNull();
    expect(screen.getByRole('tab', { name: /^Responses/ }).textContent).toBe('Responses5');
  });

  it('a live reload keeps the loaded pages', async () => {
    const port = await mount({ responses: others(), pageSize: 2 });
    view('Individual');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowIds()).toHaveLength(4));

    // An event with nothing new (the viewer discards a draft): still 4, not page 1's 2.
    await act(async () => { await port.discardDraft(release.id); });
    await waitFor(() => expect(rowIds()).toEqual(['response-row-p5', 'response-row-p4', 'response-row-p3', 'response-row-p2']));
  });

  it('a new submission lands on top without pushing a loaded row out or duplicating one', async () => {
    const port = await mount({ responses: others(7), pageSize: 2 });
    view('Individual');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowIds()).toEqual(['p7', 'p6', 'p5', 'p4'].map((id) => `response-row-${id}`)));

    let mine = '';
    await act(async () => {
      mine = (await port.submit(release.id, {
        supersedesId: null,
        answers: { target: { value: 'beta' }, surfaces: { values: ['cli'] }, rollback: { value: 'flag' }, confidence: { number: 3 } },
      })).id;
    });
    // The reload reads on through the page holding p4 (the oldest loaded): every loaded row stays.
    await waitFor(() => expect(rowIds()[0]).toBe(`response-row-${mine}`));
    expect(rowIds()).toEqual([mine, 'p7', 'p6', 'p5', 'p4', 'p3'].map((id) => `response-row-${id}`));

    // And the next page carries on from there: nothing repeated, nothing skipped.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowIds()).toHaveLength(8));
    expect(rowIds()).toEqual([mine, 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1'].map((id) => `response-row-${id}`));
    expect(screen.queryByTestId('responses-more')).toBeNull();
  });

  it('the summary says it covers only the loaded pages', async () => {
    await mount({ responses: others(), pageSize: 2 });
    expect(screen.getByTestId('summary-scope').textContent).toMatch(/Summary of the 2 loaded responses\. More exist/);
    expect(screen.getByTestId('summary-confidence-counts').textContent).toBe('2 answered · 0 unanswered');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByTestId('summary-confidence-counts').textContent).toBe('4 answered · 0 unanswered'));
  });
});

describe('Responses summary', () => {
  it('is the default view; Individual shows the table', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: 'Summary' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Individual' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('responses-summary')).toBeTruthy();
    expect(screen.queryByTestId('responses-table')).toBeNull();
    expect(screen.getByTestId('summary-scope').textContent).toBe('Summary of all 4 responses.');

    view('Individual');
    expect(screen.getByRole('tab', { name: 'Individual' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByTestId('responses-table')).getAllByRole('row')).toHaveLength(5);
    expect(screen.queryByTestId('responses-summary')).toBeNull();
  });

  // Current rows: Ada r3, Noor, Lin, Omar.
  it('single choice: count and % per option, the recommended one marked, and Other listed', async () => {
    await mount();
    const q = screen.getByTestId('summary-target');
    expect(within(q).getByTestId('summary-bar-beta').textContent).toMatch(/Beta.*Recommended.*2 · 50%/);
    expect(within(q).getByTestId('summary-bar-stable').textContent).toMatch(/0 · 0%$/);
    expect(within(q).getByTestId('summary-bar-internal').textContent).toMatch(/1 · 25%$/);
    expect(within(q).getByTestId('summary-bar-__other').textContent).toMatch(/1 · 25%$/);
    const other = within(q).getByRole('list', { name: 'Other answers' });
    expect(other.textContent).toMatch(/Noor.*“Canary for a day, then beta”/);
  });

  it('multi choice: each option as a share of those who answered', async () => {
    await mount();
    const q = screen.getByTestId('summary-surfaces');
    expect(within(q).getByTestId('summary-bar-cli').textContent).toMatch(/2 · 50%$/);
    expect(within(q).getByTestId('summary-bar-ui').textContent).toMatch(/2 · 50%$/);
    expect(within(q).getByTestId('summary-bar-mcp').textContent).toMatch(/1 · 25%$/);
    expect(within(q).getByTestId('summary-bar-api').textContent).toMatch(/1 · 25%$/);
    expect(within(q).getByTestId('summary-bar-__other').textContent).toMatch(/1 · 25%$/);
    expect(within(q).getByRole('list', { name: 'Other answers' }).textContent).toMatch(/Ada.*Docs site/);
  });

  it('scale: the distribution across min..max and the average', async () => {
    await mount();
    const q = screen.getByTestId('summary-confidence');
    expect(within(q).getByTestId('summary-average').textContent).toBe('Average 4.0 of 1–5');
    expect(within(q).getAllByTestId(/^summary-bar-/).map((b) => b.getAttribute('data-testid')))
      .toEqual(['summary-bar-1', 'summary-bar-2', 'summary-bar-3', 'summary-bar-4', 'summary-bar-5']);
    expect(within(q).getByTestId('summary-bar-1').textContent).toMatch(/^1 \(Worried\).*0 · 0%$/);
    expect(within(q).getByTestId('summary-bar-4').textContent).toMatch(/2 · 50%$/);
    expect(within(q).getByTestId('summary-bar-5').textContent).toMatch(/^5 \(Ship it\).*1 · 25%$/);
  });

  it('text: every answer under its respondent (long text as markdown), and the unanswered count', async () => {
    await mount();
    const codename = screen.getByTestId('summary-codename');
    expect(screen.getByTestId('summary-codename-counts').textContent).toBe('2 answered · 2 unanswered');
    expect(within(codename).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Adaquiet-harbor', 'Linnorth-light']);

    const risks = screen.getByTestId('summary-risks');
    expect(screen.getByTestId('summary-risks-counts').textContent).toBe('2 answered · 2 unanswered');
    expect(within(risks).getByText('billing').tagName).toBe('STRONG');
    expect(within(risks).getByText('None beyond the usual.')).toBeTruthy();
  });

  it('questions follow section order under their headings', async () => {
    await mount();
    const summary = screen.getByTestId('responses-summary');
    expect(within(summary).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Scope', 'Quality', 'Notes']);
    expect(within(summary).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(
      release.content.questions.map((q) => q.title),
    );
  });

  it('snapshots that disagree are matched by key and never crash', async () => {
    const rows = FORM_FIXTURE_RESPONSES.filter((r) => r.formId === release.id && r.isCurrent).map((r) => structuredClone(r));
    // Lin's snapshot predates a `notes_extra` question; Omar's has a scale where the others have text.
    const lin = rows.find((r) => r.id === 'resp-lin-1')!;
    lin.questionsSnapshot!.questions.push({ key: 'extra', type: 'short_text', title: 'An older question', required: false, position: 9, config: {} });
    lin.answers.extra = { text: 'kept' };
    rows.find((r) => r.id === 'resp-omar-1')!.answers.codename = { number: 3 } as never;
    await mount({ responses: rows });
    expect(screen.getByTestId('summary-codename-counts').textContent).toBe('2 answered · 1 unanswered · 1 in a shape this question no longer reads');
    expect(screen.getByTestId('summary-extra-counts').textContent).toBe('1 answered · 3 unanswered');
    expect(within(screen.getByTestId('summary-extra')).getByText('kept')).toBeTruthy();
  });
});

describe('Responses individual', () => {
  it('prev/next walks the loaded respondents in table order', async () => {
    await mount();
    view('Individual');
    // Newest first: Ada, Omar, Lin, Noor.
    fireEvent.click(screen.getByRole('button', { name: 'Lin' }));
    const detail = await screen.findByTestId('response-detail');
    expect(within(detail).getByRole('heading', { level: 3, name: 'Lin' })).toBeTruthy();
    expect(screen.getByTestId('response-position').textContent).toBe('3 of 4');

    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Noor' })).toBeTruthy();
    expect(screen.getByTestId('response-position').textContent).toBe('4 of 4');
    expect((screen.getByRole('button', { name: 'Next ›' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '‹ Previous' }));
    fireEvent.click(screen.getByRole('button', { name: '‹ Previous' }));
    fireEvent.click(screen.getByRole('button', { name: '‹ Previous' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Ada' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '‹ Previous' }) as HTMLButtonElement).disabled).toBe(true);
    // The detail still carries the delivery door and the revision chain.
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeTruthy();
    expect(await screen.findByTestId('revision-history')).toBeTruthy();
  });
});
