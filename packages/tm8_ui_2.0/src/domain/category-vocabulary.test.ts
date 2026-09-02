/**
 * ONE DEFINITION OF A LIFECYCLE BUCKET, SHARED BY THE LIST HEADER AND THE BOARD.
 *
 * The 898-of-466 report came with a second observation: the BOARD, over the
 * same data, showed sane figures while the list header did not. Two surfaces
 * over one dataset disagreeing means one of them is computing from something
 * the other is not — and the standing rule is that two surfaces may not each
 * carry their own derivation of the same fact.
 *
 * WHAT I FOUND, and it is better than expected: they already share the
 * derivation. Both partition on `StatusCategory`, the contract's own closed
 * union — the list header through `CATEGORY_TABS` (registry.ts), which sends
 * `filters.category` to the SERVER and renders `page.total`; the board through
 * `CATEGORY_SPECS` (board-v2/board-model.ts), which builds one column per
 * category. Neither derives a category from a status client-side. Measured on
 * the deployed build, the header's four reads return 204 · 142 · 113 · 7 and
 * sum to 466 — the same universe the board reports against.
 *
 * SO THE DIVERGENCE RISK IS NOT THE DERIVATION, IT IS THE VOCABULARY: two
 * hand-written lists of the same four categories, in two files, that nothing
 * forces to agree. Reorder one, relabel one, add a fifth to one, and the two
 * surfaces silently stop meaning the same thing — which is the shape of the
 * defect that was reported, even though this particular instance was not its
 * cause.
 *
 * THIS FILE IS THAT FORCING. It is a test rather than a refactor because
 * `board-v2` is another lane's directory and I am not editing it; pinning the
 * two lists to each other gets the guarantee without reaching across the
 * boundary, and it fails loudly the moment either moves. If the two are ever
 * merged into one exported constant, this file should be deleted with the
 * duplication it exists to watch.
 */
import { describe, expect, it } from 'vitest';
import { CATEGORY_SPECS } from '../board-v2/board-model';
import { allKinds, getKind } from './registry';

/** Every category any kind's tab row declares, in first-seen order. */
function tabVocabulary(): string[] {
  const seen: string[] = [];
  for (const config of allKinds()) {
    for (const tab of config.list.categories ?? []) {
      if (!seen.includes(tab.id)) seen.push(tab.id);
    }
  }
  return seen;
}

describe('the list header and the board share one lifecycle vocabulary', () => {
  it('names the same four categories, in the same reading order', () => {
    /* Order matters as much as membership: the board draws columns left to
       right and the header draws tabs left to right, and a reader moving
       between them reads the two as the same ladder. */
    const board = CATEGORY_SPECS.map((s) => s.key);
    expect(tabVocabulary()).toEqual(board);
  });

  it('gives each category the same LABEL on both surfaces', () => {
    /* `To Do` on one surface and `Todo` on the other is the same defect in
       miniature: the reader cannot tell whether they are looking at the same
       band. The tab labels live per-kind, so every kind that declares a
       category has to agree with the board about what it is called. */
    const boardLabel = new Map(CATEGORY_SPECS.map((s) => [s.key, s.label] as const));
    for (const config of allKinds()) {
      for (const tab of config.list.categories ?? []) {
        expect(
          tab.label,
          `${config.kind}'s "${tab.id}" tab disagrees with the board about this band's name`,
        ).toBe(boardLabel.get(tab.id));
      }
    }
  });

  it('partitions on the CATEGORY axis and never on a per-kind status', () => {
    /*
     * THE LAW BEHIND THE SHARED VOCABULARY, restated as a check.
     *
     * The tab row used to run on statuses, and it could not work: a session
     * that FAILED counted as Done, a task that was CANCELLED counted as Done,
     * and a custom status nobody had listed counted as neither. The category is
     * the one axis every kind shares, which is why the tabs run on it — and why
     * the board's columns do too.
     *
     * A tab whose filter names a `status` would be a kind reintroducing its own
     * private derivation of a shared fact, which is exactly what produced two
     * surfaces disagreeing.
     */
    for (const config of allKinds()) {
      for (const tab of config.list.categories ?? []) {
        expect(
          tab.filter.category,
          `${config.kind}'s "${tab.id}" tab does not filter on category`,
        ).toBeDefined();
        expect(
          tab.filter.status,
          `${config.kind}'s "${tab.id}" tab reintroduces a status-based derivation`,
        ).toBeUndefined();
      }
    }
  });

  it('lets a kind narrow the partition but never redefine it', () => {
    /* `work_session` declares three of the four (Cancelled is structurally
       unreachable for it). Narrowing is allowed and is how a kind stays honest;
       inventing a band the board cannot draw is not. */
    const board = new Set(CATEGORY_SPECS.map((s) => s.key));
    const kinds: string[] = [];
    for (const config of allKinds()) {
      const cats = config.list.categories ?? [];
      if (cats.length === 0) continue;
      kinds.push(config.kind);
      for (const tab of cats) {
        expect(board.has(tab.id), `${config.kind} declares "${tab.id}", which the board cannot draw`).toBe(true);
      }
    }
    /* Named so the report can say WHICH kinds were confirmed rather than "the
       shared header" — the owner's claim was that this is on every entity. */
    expect(kinds.length, 'no kind declares a lifecycle tab row at all').toBeGreaterThan(0);
    expect(kinds).toContain('task');
    expect(kinds).toContain('work_session');
  });
});
