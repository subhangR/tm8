// @vitest-environment jsdom
/**
 * The prompt catalog screen.
 *
 * What is worth asserting here is not "a heading renders" but the two claims
 * the screen makes that could quietly become false: that it shows the REAL
 * prompt bytes (not a paraphrase), and that it does not present unwired
 * prompts as if agents were receiving them.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  PROMPT_CATEGORIES,
  PROMPT_ENTRIES,
  findPromptEntry,
  promptCatalogStats,
} from '@tm8/prompt/catalog';
import { instructionFor } from '@tm8/prompt';
import { CATALOG_DIGEST, DISCOVERY } from '@tm8/cli/discovery';
import { PromptsScreen } from './PromptsScreen';
import { PromptsOverlay } from './PromptsOverlay';

describe('PromptsScreen', () => {
  it('lists every category', () => {
    render(<PromptsScreen />);
    // Scoped to the nav: category titles also occur in entry titles and blurbs.
    const nav = screen.getByLabelText('Prompt categories');
    for (const cat of PROMPT_CATEGORIES) {
      expect(within(nav).getByText(cat.title)).toBeTruthy();
    }
  });

  it('reports the catalog totals honestly', () => {
    const stats = promptCatalogStats();
    render(<PromptsScreen />);
    const sub = document.querySelector('.pr-head__sub')!;
    expect(sub.textContent).toContain(String(stats.total));
    expect(sub.textContent).toContain(String(stats.live));
    expect(sub.textContent).toContain(String(stats.unwired));
  });

  /**
   * A row's accessible name is title + status word + summary, so a name query
   * matches far more than the title. Select by the title span and click the
   * row that owns it.
   */
  function selectEntry(title: string) {
    const list = screen.getByLabelText('Prompts');
    const label = within(list).getByText(title);
    fireEvent.click(label.closest('button')!);
  }

  it('shows the real prompt text, byte for byte', () => {
    render(<PromptsScreen />);
    // A verbatim entry whose source of truth is a live export.
    selectEntry('Worker');
    const pre = screen.getByTestId('prompt-text');
    expect(pre.textContent).toBe(instructionFor('worker'));
  });

  it('explains why an unwired prompt is not reaching agents', () => {
    render(<PromptsScreen />);
    selectEntry('Trusted kernel (tm8.core.v1)');
    const note = screen.getByTestId('prompt-status-note');
    expect(note.textContent).toBe(findPromptEntry('kernel.v1')!.statusNote);
  });

  it('shows a pointer entry as having no text rather than faking one', () => {
    render(<PromptsScreen />);
    selectEntry('Team-member persona');
    expect(screen.queryByTestId('prompt-text')).toBeNull();
    expect(document.querySelector('.pr-empty')).toBeTruthy();
  });

  it('searches across every category, not just the selected one', () => {
    render(<PromptsScreen />);
    // Narrow to one category first, then search for a term that lives in another.
    fireEvent.click(screen.getByRole('button', { name: /Byte budgets/ }));
    fireEvent.change(screen.getByLabelText('Search prompts'), {
      target: { value: 'coordinator' },
    });
    const list = screen.getByLabelText('Prompts');
    expect(within(list).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('says so plainly when nothing matches', () => {
    render(<PromptsScreen />);
    fireEvent.change(screen.getByLabelText('Search prompts'), {
      target: { value: 'zzzznotapromptzzzz' },
    });
    expect(document.querySelector('.pr-list__empty')).toBeTruthy();
  });

  it('filters to a category when one is chosen', () => {
    render(<PromptsScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Mode identity/ }));
    const list = screen.getByLabelText('Prompts');
    // 4 → 5 when `dispatcher` became the FIFTH agent mode (Dreamer &
    // Dispatcher P3): this category holds one instruction per mode, so the
    // count IS the mode enum's size seen from the prompts screen. Measured
    // from the built catalog — worker, coordinator, both coordinated modes,
    // and dispatcher — but kept a LITERAL rather than derived: deriving it
    // would make the assertion tautological and let a mode lose its kernel
    // unnoticed.
    expect(within(list).getAllByRole('button')).toHaveLength(5);
  });

  it('renders every entry without throwing', () => {
    render(<PromptsScreen />);
    const list = screen.getByLabelText('Prompts');
    // "All prompts" is the default filter, so the list is the whole catalog.
    expect(within(list).getAllByRole('button')).toHaveLength(PROMPT_ENTRIES.length);
  });
});

describe('CLI help mode', () => {
  const toCli = () => fireEvent.click(screen.getByRole('tab', { name: /CLI help/ }));

  it('switches to the CLI catalog and lists every operation', () => {
    render(<PromptsScreen />);
    toCli();
    const list = screen.getByLabelText('Operations');
    expect(within(list).getAllByRole('button')).toHaveLength(DISCOVERY.length);
  });

  it('groups by noun and filters to one', () => {
    render(<PromptsScreen />);
    toCli();
    const nav = screen.getByLabelText('CLI nouns');
    fireEvent.click(within(nav).getByText('entity'));
    const list = screen.getByLabelText('Operations');
    const expected = DISCOVERY.filter((r) => r.noun === 'entity').length;
    expect(within(list).getAllByRole('button')).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('renders the real syntax, notes and examples for an operation', () => {
    render(<PromptsScreen />);
    toCli();
    const row = DISCOVERY.find((r) => r.operation === 'entities.create')!;
    fireEvent.click(within(screen.getByLabelText('Operations')).getByText('entities.create'));
    const pre = screen.getByTestId('cli-help-text').textContent!;
    expect(pre).toContain(row.syntax);
    expect(pre).toContain(row.summary);
    for (const note of row.notes ?? []) expect(pre).toContain(note);
    for (const ex of row.examples ?? []) expect(pre).toContain(ex);
    // The machine facts an agent needs before mutating anything.
    expect(pre).toContain(row.idempotency);
    expect(pre).toContain(row.authzTarget);
  });

  it('searches operations across every noun', () => {
    render(<PromptsScreen />);
    toCli();
    fireEvent.change(screen.getByLabelText('Search operations'), {
      target: { value: 'attention' },
    });
    const list = screen.getByLabelText('Operations');
    expect(within(list).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('finds a command whose first word is not its noun', () => {
    // `tm8 task complete` is entities.commands.complete, filed under `entity`.
    // Searching the operation name alone would never surface it.
    render(<PromptsScreen />);
    toCli();
    fireEvent.change(screen.getByLabelText('Search operations'), {
      target: { value: 'task complete' },
    });
    const list = screen.getByLabelText('Operations');
    expect(within(list).getByText('tm8 task complete')).toBeTruthy();
  });

  it('explains an empty noun instead of implying the commands do not exist', () => {
    render(<PromptsScreen />);
    toCli();
    fireEvent.click(within(screen.getByLabelText('CLI nouns')).getByText('task'));
    const empty = document.querySelector('.pr-list__empty')!;
    expect(empty.textContent).toContain('entities.commands.complete');
    expect(empty.textContent).not.toContain('No operation matches');
  });

  it('carries the pinned catalog digest, so the UI and the CLI agree', () => {
    render(<PromptsScreen />);
    toCli();
    const nav = screen.getByLabelText('CLI nouns');
    expect(nav.textContent).toContain(CATALOG_DIGEST.slice(0, 18));
  });
});

describe('PromptsOverlay', () => {
  it('renders nothing while closed', () => {
    render(<PromptsOverlay open={false} onClose={() => {}} />);
    expect(screen.queryByTestId('prompts-overlay')).toBeNull();
  });

  it('is a modal dialog when open', () => {
    render(<PromptsOverlay open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on Esc without letting it reach the shell behind', () => {
    let closed = 0;
    let leaked = 0;
    render(
      <div onKeyDown={() => (leaked += 1)}>
        <PromptsOverlay open onClose={() => (closed += 1)} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(closed).toBe(1);
    expect(leaked).toBe(0);
  });

  it('closes on the header control', () => {
    let closed = 0;
    render(<PromptsOverlay open onClose={() => (closed += 1)} />);
    fireEvent.click(screen.getByLabelText('Close prompts'));
    expect(closed).toBe(1);
  });

  it('dismisses on a click that both starts and ends on the scrim', () => {
    let closed = 0;
    render(<PromptsOverlay open onClose={() => (closed += 1)} />);
    const scrim = screen.getByTestId('prompts-overlay');
    fireEvent.pointerDown(scrim);
    fireEvent.pointerUp(scrim);
    expect(closed).toBe(1);
  });

  it('does not dismiss on a drag that merely ends on the scrim', () => {
    let closed = 0;
    render(<PromptsOverlay open onClose={() => (closed += 1)} />);
    const scrim = screen.getByTestId('prompts-overlay');
    fireEvent.pointerDown(screen.getByTestId('prompts-screen'));
    fireEvent.pointerUp(scrim);
    expect(closed).toBe(0);
  });
});
