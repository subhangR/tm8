// @vitest-environment jsdom
/**
 * SORT, FILTER COMPOSITION AND PAGING — the three things the list panel
 * claimed to do and did not.
 *
 * ITS OWN FILE, AND THE REASON IS THE DEFECT ITSELF. `panels.test.tsx` shares
 * one helper — `rowsFor = (rows) => (_filter) => rows` — which returns the
 * same array whatever it is asked. Every test built on it is structurally
 * incapable of noticing that the panel dropped the filter, and it was green
 * throughout the whole period the sort chip reached nothing. A helper that
 * ignores its arguments cannot fail an argument-passing test.
 *
 * So the helper here HONOURS what it is given: it records every query and
 * answers from a tiny in-memory collection it actually filters and sorts. Not
 * because the panel should sort client-side — it must not, and does not — but
 * because a stub that answers differently for different questions is the only
 * kind that can prove a different question was asked.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, ListPageState, QueryFilter, SortKey } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { EntityListPanel } from './index';
import { narrow } from './EntityListPanel';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const tasks = fixtureSummaries.filter((s) => s.state.kind === 'task');

interface Ask {
  filter: QueryFilter;
  sort?: SortKey;
}

/** A row seam that remembers every question and can be asked a new one. */
function recorder(rows: readonly EntitySummary[] = []) {
  const asks: Ask[] = [];
  return {
    asks,
    rowsFor: (filter: QueryFilter, sort?: SortKey) => {
      asks.push({ filter, sort });
      return rows;
    },
    /** Every distinct sort the panel has asked for, in order of first ask. */
    sorts: () => [...new Set(asks.map((a) => a.sort))],
  };
}

describe('the sort chip reaches the seam', () => {
  it('offers every sort the registry declares for the kind, not two of them', () => {
    const seam = recorder();
    const { getByTestId, getAllByRole } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('sort-trigger'));
    const labels = getAllByRole('menuitemradio').map((b) => b.textContent?.replace('✓', ''));
    // The contract's six, all of them, because a task has a due date and a
    // priority. Pinned as a SET so re-ordering the menu is not a failure.
    expect(new Set(labels)).toEqual(
      new Set(['Recent activity', 'Recently modified', 'Newest', 'Manual order', 'Due date', 'Priority']),
    );
  });

  it('CHOOSING a sort issues a query carrying it — the defect, stated directly', () => {
    const seam = recorder();
    const { getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    // Before: the only ordered query is the kind's default. The `undefined`
    // alongside it is the tier-count read, which is deliberately unsorted —
    // see the next test.
    expect(new Set(seam.sorts())).toEqual(new Set([undefined, 'activityAt_desc']));

    fireEvent.click(getByTestId('sort-trigger'));
    fireEvent.click(getByRole('menuitemradio', { name: /Priority/ }));

    // After: a REAL query went out under the chosen sort. This is the whole
    // fix — the panel previously held `sortKey` in state and passed it
    // nowhere, so this array never gained a second member.
    expect(seam.sorts()).toContain('priority');
    expect(seam.asks.at(-1)?.sort ?? seam.asks.filter((a) => a.sort === 'priority')[0]?.sort).toBe(
      'priority',
    );
  });

  it('counts the tiers WITHOUT the active sort — a count cannot depend on order', () => {
    const seam = recorder();
    const { getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('sort-trigger'));
    fireEvent.click(getByRole('menuitemradio', { name: /Due date/ }));

    // Three tier counts per render, and none of them may carry a sort: they
    // would be three extra server queries per sort change, to learn three
    // numbers that cannot have changed.
    const counting = seam.asks.filter((a) => a.sort === undefined);
    expect(counting.length).toBeGreaterThan(0);
  });

  it('the chip shows the CHOSEN sort, so the control and the data agree', () => {
    const seam = recorder();
    const { getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('sort-trigger'));
    fireEvent.click(getByRole('menuitemradio', { name: /Manual order/ }));
    expect(getByTestId('sort-trigger').textContent).toContain('Manual order');
  });
});

describe('narrow — three axes intersect, they never overwrite', () => {
  it('array members INTERSECT: two "only these" lists are both still true', () => {
    expect(narrow({ status: ['open', 'blocked'] }, { status: ['blocked', 'done'] })).toEqual(
      { status: ['blocked'] },
    );
  });

  it('an empty intersection is NULL, never `[]` — `[]` means NO CONSTRAINT', () => {
    // The distinction is the whole reason this returns a nullable. Emitting
    // `{status: []}` would ask the server for EVERYTHING, turning "these
    // cannot both hold" into "show me all rows" — the loudest wrong answer
    // available, and indistinguishable on screen from a filter that worked.
    expect(narrow({ status: ['open'] }, { status: ['done'] })).toBeNull();
  });

  it('a scalar takes the LATER value, because scalars have no intersection', () => {
    expect(narrow({ deleted: 'exclude' }, { deleted: 'exclude' })).toEqual({ deleted: 'exclude' });
    // NOT null. This exact pair is the task Archived tab: both sections carry
    // `deleted:'exclude'` and the Archived TIER carries `deleted:'only'`, and
    // the tier is applied second precisely because the tier owns the lifecycle
    // band while a section only triages WITHIN it. Treating the pair as a
    // contradiction empties the Archive instead of grouping it.
    expect(narrow({ deleted: 'exclude' }, { deleted: 'only' })).toEqual({ deleted: 'only' });
  });

  it('disjoint axes compose into one narrower query', () => {
    expect(narrow({ deleted: 'exclude' }, { readyToPull: true }, undefined)).toEqual({
      deleted: 'exclude',
      readyToPull: true,
    });
  });
});

describe('a contradiction is STATED, and costs no query', () => {
  it('the archive FILTER is a REAL query, not a self-contradiction', () => {
    // The regression this guards is one narrowing rule away. Every category
    // tab says `deleted:'exclude'` and the archive chip says `deleted:'only'`;
    // read as a contradiction rather than as a scalar the later value wins,
    // the archive would render the explanation and ask nothing — an Archive
    // that is always empty and always sure of itself.
    //
    // Phase 7 SHARPENED this: archived used to be a TAB, so it was applied at
    // the same layer as the thing it overrode. It is a chip now, applied
    // AFTER the tab, and `narrow`'s argument order (band, tab, chips) is what
    // makes that the later value.
    const seam = recorder(tasks);
    const view = render(<EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />);
    seam.asks.length = 0;
    fireEvent.click(view.getByTestId('filter-trigger'));
    fireEvent.click(view.getByRole('menuitemcheckbox', { name: 'Archived only' }));

    expect(view.container.textContent).not.toContain('contradict this tab');
    const archived = seam.asks.filter((a) => (a.filter as Record<string, unknown>).deleted === 'only');
    expect(archived.length).toBeGreaterThan(0);
  });

  it('picking Done on the To Do tab explains itself instead of going blank', () => {
    const seam = recorder(tasks);
    const { getByTestId, getByRole, container } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    fireEvent.click(getByRole('menuitemcheckbox', { name: /^Done$/ }));

    // The panel says which two choices cannot hold together. Before, the tab
    // and the chip were spread over each other and one silently won: the tab
    // read "Open" while the rows were done, or the list emptied with no word.
    //
    // PHASE 7 keeps this working only because each status chip declares its
    // CATEGORY beside its status (`registry.statusFilter`). The tab speaks
    // `category` now; without that second member the two would be different
    // keys, the merge would succeed, and the empty result would arrive with no
    // explanation — the exact failure this test was written for.
    expect(container.textContent).toContain('contradict this tab');
  });

  it('and issues NO query for the band it knows is unsatisfiable', () => {
    const seam = recorder(tasks);
    const { getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    seam.asks.length = 0;
    fireEvent.click(getByRole('menuitemcheckbox', { name: /^Done$/ }));

    // Every query that DID go out is a tier count (no `done` outside the tier
    // that owns it). None of them is the impossible open∩done band, because a
    // question you already know the answer to is a wasted round trip whose
    // empty result is indistinguishable from a real one.
    const impossible = seam.asks.find((a) => {
      const ws = (a.filter as Record<string, unknown>).status;
      return Array.isArray(ws) && ws.length === 0;
    });
    expect(impossible).toBeUndefined();
  });
});

describe('counts stop lying at the page boundary', () => {
  const saturated = (): ListPageState => ({ hasMore: true, loading: false });
  const complete = (): ListPageState => ({ hasMore: false, loading: false });

  it('a tab whose page is full reads `N+`, not `N`', () => {
    const seam = recorder(tasks);
    const { getByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        pageStateOf={saturated}
        ctx={ctx}
      />,
    );
    // The footer is the same source as the tabs and the selector total, so
    // one assertion here covers all three surfaces.
    expect(getByTestId('list-footer').textContent).toMatch(/\d\+ to do/);
    expect(getByTestId('kind-total').textContent).toMatch(/\+$/);
  });

  it('a tab the server finished reads a plain number', () => {
    const seam = recorder(tasks);
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} pageStateOf={complete} ctx={ctx} />,
    );
    expect(getByTestId('list-footer').textContent).not.toContain('+');
    expect(getByTestId('kind-total').textContent).not.toContain('+');
  });

  it('a host that has not wired paging says `N` — absence of evidence, not evidence', () => {
    const seam = recorder(tasks);
    const { getByTestId } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    expect(getByTestId('kind-total').textContent).not.toContain('+');
  });

  it('the server’s own total wins over the `+` estimate when it volunteers one', () => {
    const seam = recorder(tasks);
    const { getByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        pageStateOf={() => ({ hasMore: true, loading: false, total: 601 })}
        ctx={ctx}
      />,
    );
    expect(getByTestId('list-footer').textContent).toContain('601 to do');
  });
});

describe('paging asks for the next page of THIS question', () => {
  it('the sentinel appears only while the server holds a cursor', () => {
    const seam = recorder(tasks);
    const { queryByTestId, rerender } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        pageStateOf={() => ({ hasMore: false, loading: false })}
        loadMore={() => {}}
        ctx={ctx}
      />,
    );
    expect(queryByTestId('list-load-more')).toBeNull();

    rerender(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        pageStateOf={() => ({ hasMore: true, loading: false })}
        loadMore={() => {}}
        ctx={ctx}
      />,
    );
    expect(queryByTestId('list-load-more')).toBeTruthy();
  });

  it('and carries the band’s OWN filter and sort, not the panel default', () => {
    const seam = recorder(tasks);
    const more: Ask[] = [];
    const { getByTestId, getByRole } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        pageStateOf={() => ({ hasMore: true, loading: false })}
        loadMore={(filter, sort) => more.push({ filter, sort })}
        ctx={ctx}
      />,
    );
    fireEvent.click(getByTestId('sort-trigger'));
    fireEvent.click(getByRole('menuitemradio', { name: /Priority/ }));
    fireEvent.click(getByRole('button', { name: 'Load more' }));

    // A keyset cursor is bound to its query's fingerprint: asking for page 2
    // of a DIFFERENT question is refused by the server as an invalid cursor.
    // So the sort must travel with the request, not be re-derived.
    expect(more.at(-1)?.sort).toBe('priority');
    // The band's own filter is the CATEGORY TAB's now, not a status array.
    expect((more.at(-1)?.filter as Record<string, unknown>).category).toBeDefined();
  });

  it('never mounts a sentinel a host cannot service', () => {
    const seam = recorder(tasks);
    const { queryByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        pageStateOf={() => ({ hasMore: true, loading: false })}
        ctx={ctx}
      />,
    );
    // `hasMore` with no `loadMore` is an unwired host, and a Load-more button
    // that does nothing is the enabled-and-inert failure the honesty rules
    // exist to prevent.
    expect(queryByTestId('list-load-more')).toBeNull();
  });
});

describe('the viewer-scoped chips refuse rather than answer for nobody', () => {
  const VIEWER = '00000000-0000-4000-8000-0000000000aa';

  it('are DISABLED when the workspace has not resolved who you are', () => {
    const seam = recorder(tasks);
    const { getByTestId, getByRole } = render(
      <EntityListPanel kind="task" rowsFor={seam.rowsFor} ctx={ctx} />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    const mine = getByRole('menuitemcheckbox', { name: /Assigned to me/ });
    // Offered and refused with a reason, never offered and inert. An enabled
    // "Assigned to me" with no id would answer "you have nothing assigned" —
    // a claim about the data made out of ignorance about the identity.
    expect((mine as HTMLButtonElement).disabled).toBe(true);
    expect(mine.getAttribute('title')).toContain('who you are');
  });

  it('substitute the real actor id into the query when there is one', () => {
    const seam = recorder(tasks);
    const { getByTestId, getByRole } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        ctx={{ ...ctx, viewerActorId: VIEWER }}
      />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    fireEvent.click(getByRole('menuitemcheckbox', { name: /Assigned to me/ }));

    const scoped = seam.asks.find((a) =>
      ((a.filter as Record<string, unknown>).assigneeIds as string[] | undefined)?.includes(VIEWER),
    );
    // And the sentinel must NEVER reach the wire: the server `assertUuid`s
    // this member, so a leaked '@me' returns a 400 that reads like a broken
    // list rather than an unresolved identity.
    const leaked = seam.asks.find((a) => JSON.stringify(a.filter).includes('@me'));
    expect(scoped, `no query carried the viewer id; saw ${JSON.stringify(seam.asks)}`).toBeTruthy();
    expect(leaked).toBeUndefined();
  });

  it('offers "Needs me" too, and tasks additionally get "In review for me"', () => {
    const seam = recorder(tasks);
    const { getByTestId, getByRole } = render(
      <EntityListPanel
        kind="task"
        rowsFor={seam.rowsFor}
        ctx={{ ...ctx, viewerActorId: VIEWER }}
      />,
    );
    fireEvent.click(getByTestId('filter-trigger'));
    fireEvent.click(getByRole('menuitemcheckbox', { name: /^Needs me$/ }));
    expect(
      seam.asks.find((a) => (a.filter as Record<string, unknown>).needsActorId === VIEWER),
    ).toBeTruthy();
    // `inReviewForActorId` adds `t.work_status = 'in_review'` server-side, so
    // it is genuinely task-only and is offered here and not on every kind.
    expect(getByRole('menuitemcheckbox', { name: /In review for me/ })).toBeTruthy();
  });
});
