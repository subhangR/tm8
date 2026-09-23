// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DiffView } from './DiffView';
import { SAMPLE_DIFF, makeLargeDiff } from '../fixtures/diff';

const rows = (c: HTMLElement) => c.querySelectorAll('.kit-diff__row');

describe('DiffView', () => {
  it('lists every changed file with its own add/delete counts', () => {
    const { getByTestId, getAllByTestId } = render(<DiffView diff={SAMPLE_DIFF} />);
    const list = getByTestId('kit-diff-files');
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(list.textContent).toContain('packages/server/src/git/branch-topology.ts');
    // Six additions on the new file, and the sign is in the TEXT — the count
    // still reads correctly with colour stripped.
    expect(list.textContent).toContain('+6');
    expect(getAllByTestId('kit-diff-file')).toHaveLength(5);
  });

  it('summarises the whole change before any file is read', () => {
    const { getByTestId } = render(<DiffView diff={SAMPLE_DIFF} />);
    expect(getByTestId('kit-diff-summary').textContent).toContain('5 files changed');
  });

  it('colours by parsed kind, never by first character', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} />);
    const adds = container.querySelectorAll('.kit-diff__row--add');
    const dels = container.querySelectorAll('.kit-diff__row--del');
    expect(adds.length).toBeGreaterThan(0);
    expect(dels.length).toBeGreaterThan(0);
    // If headers leaked in as rows, one of them would carry `++ b/` text.
    for (const row of [...adds, ...dels]) {
      expect(row.textContent?.includes('++ b/')).toBe(false);
      expect(row.textContent?.includes('-- a/')).toBe(false);
    }
  });

  it('shows each hunk header so a line number means something', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} />);
    const hunks = [...container.querySelectorAll('.kit-diff__hunk')].map((h) => h.textContent);
    expect(hunks.some((h) => h?.includes('@@ -12,7 +12,11 @@'))).toBe(true);
    expect(hunks.some((h) => h?.includes('@@ -40,3 +42,4 @@'))).toBe(true);
  });

  it('marks every row with + or - so colour is never the only signal', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} />);
    const add = container.querySelector('.kit-diff__row--add .kit-diff__marker');
    const del = container.querySelector('.kit-diff__row--del .kit-diff__marker');
    expect(add?.textContent).toBe('+');
    expect(del?.textContent).toBe('-');
  });

  it('says a binary file is binary instead of rendering nothing', () => {
    const { getAllByTestId } = render(<DiffView diff={SAMPLE_DIFF} />);
    const binary = getAllByTestId('kit-diff-file').find(
      (f) => f.dataset.path === 'packages/tm8-ui/public/diff-icon.png',
    );
    expect(binary?.textContent).toContain('Binary file');
    expect(binary?.querySelectorAll('.kit-diff__row')).toHaveLength(0);
  });

  it('caps a huge file and states exactly how many lines it is holding back', () => {
    // 4000 additions + 1 hunk header = 4001 rows. The renderer must never
    // build them: this is the defect the cap exists for.
    const { container, getByTestId } = render(
      <DiffView diff={makeLargeDiff(4000)} maxLinesPerFile={50} />,
    );
    expect(rows(container).length).toBe(49); // 50 rows, one spent on the header
    expect(getByTestId('kit-diff-more').textContent).toBe('Show 3,951 more lines');
  });

  it('renders the file in full once the expander is pressed — nothing is hidden', () => {
    const { container, getByTestId, queryByTestId } = render(
      <DiffView diff={makeLargeDiff(120)} maxLinesPerFile={20} />,
    );
    expect(rows(container).length).toBe(19);
    fireEvent.click(getByTestId('kit-diff-more'));
    expect(rows(container).length).toBe(120);
    expect(queryByTestId('kit-diff-more')).toBeNull();
  });

  it('spends a total budget across files so many small files cannot flood it', () => {
    const many = Array.from({ length: 40 }, (_, i) => makeLargeDiff(30, `src/f${i}.ts`)).join('');
    const { container, getAllByTestId } = render(
      <DiffView diff={many} maxLinesPerFile={100} maxTotalLines={90} />,
    );
    // Every file is still LISTED — the budget bounds rendering, not disclosure.
    expect(getAllByTestId('kit-diff-file')).toHaveLength(40);
    expect(rows(container).length).toBeLessThanOrEqual(90);
    expect(getAllByTestId('kit-diff-more').length).toBeGreaterThan(1);
  });

  it('adds no expander when a file fits under both ceilings', () => {
    const { queryByTestId } = render(<DiffView diff={SAMPLE_DIFF} />);
    expect(queryByTestId('kit-diff-more')).toBeNull();
  });

  it('says so plainly when there is nothing to show', () => {
    const { getByTestId } = render(<DiffView diff="" />);
    expect(getByTestId('kit-diff').textContent).toContain('No changes.');
  });

  /**
   * PER-HUNK SELECTION — read-only unless a caller asks for it.
   *
   * Every surface that shows a diff mounts this component, and most of them
   * have nothing to stage. A checkbox that appeared by default would put a
   * control with no verb behind it on the transcript, the task detail and the
   * commit view at once.
   */
  describe('hunk selection', () => {
    const TWO_FILES = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,2 +1,2 @@ first()',
      '-a',
      '+A',
      ' keep',
      '@@ -10,2 +10,2 @@ second()',
      '-b',
      '+B',
      ' keep',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -1,2 +1,2 @@ third()',
      '-c',
      '+C',
      ' keep',
      '',
    ].join('\n');

    it('renders no checkbox at all when no selection is passed', () => {
      const { queryAllByTestId } = render(<DiffView diff={TWO_FILES} />);
      expect(queryAllByTestId('kit-diff-hunk-check')).toHaveLength(0);
    });

    it('numbers hunks 1-based ACROSS files, not restarting per file', () => {
      const { getAllByTestId } = render(
        <DiffView diff={TWO_FILES} selection={{ selected: new Set(), onToggle: () => {} }} />,
      );
      /* Restarting at each file would produce 1, 2, 1 — and the third hunk
         would then stage the first file's first hunk instead. */
      expect(getAllByTestId('kit-diff-hunk-check').map((b) => b.dataset.hunk)).toEqual(['1', '2', '3']);
    });

    it('reports the index that was ticked, and reflects what the caller holds', () => {
      const seen: number[] = [];
      const { getAllByTestId } = render(
        <DiffView
          diff={TWO_FILES}
          selection={{ selected: new Set([2]), onToggle: (i) => void seen.push(i) }}
        />,
      );
      const boxes = getAllByTestId('kit-diff-hunk-check') as HTMLInputElement[];
      /* The component holds no selection of its own — the caller's set is the
         only truth, so a stale tick cannot survive a re-read behind its back. */
      expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
      fireEvent.click(boxes[2]!);
      expect(seen).toEqual([3]);
    });

    it('names each box by its index and git’s function guess, not by the @@ arithmetic', () => {
      const { getAllByTestId } = render(
        <DiffView diff={TWO_FILES} selection={{ selected: new Set(), onToggle: () => {} }} />,
      );
      /* "at at minus one comma two plus one comma two at at" is what a screen
         reader would otherwise be given for a place in a file. */
      expect(getAllByTestId('kit-diff-hunk-check').map((b) => b.getAttribute('aria-label'))).toEqual([
        'Select hunk 1: first()',
        'Select hunk 2: second()',
        'Select hunk 3: third()',
      ]);
    });

    it('freezes the boxes while a mutation is in flight instead of hiding them', () => {
      const { getAllByTestId } = render(
        <DiffView
          diff={TWO_FILES}
          selection={{ selected: new Set([1]), onToggle: () => {}, disabled: true }}
        />,
      );
      const boxes = getAllByTestId('kit-diff-hunk-check') as HTMLInputElement[];
      /* Hidden boxes would make the ticks vanish mid-request and the reviewer
         would not know what they had asked for. */
      expect(boxes).toHaveLength(3);
      expect(boxes.every((b) => b.disabled)).toBe(true);
      expect(boxes[0]!.checked).toBe(true);
    });
  });
});
