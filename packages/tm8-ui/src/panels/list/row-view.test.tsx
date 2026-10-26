// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';
import {
  ROW_FACETS,
  facetsForAnatomy,
  legacyRowViewStorageKey,
  readHiddenFacets,
  resetRowViewCache,
  rowViewStorageKey,
  writeHiddenFacets,
} from './row-view';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

beforeEach(() => {
  window.localStorage.clear();
  resetRowViewCache();
});
afterEach(cleanup);

describe('row view store', () => {
  it('defaults to nothing hidden, and survives garbage in storage', () => {
    expect(readHiddenFacets('work_session').size).toBe(0);
    window.localStorage.setItem(rowViewStorageKey('task'), '{not json');
    window.localStorage.setItem(rowViewStorageKey('doc'), JSON.stringify(['avatar', 'no_such_facet', 7]));
    resetRowViewCache();
    expect(readHiddenFacets('task').size).toBe(0);
    expect([...readHiddenFacets('doc')]).toEqual(['avatar']);
  });

  it('is per kind and persists the hidden set; clearing removes the key', () => {
    writeHiddenFacets('work_session', ['counts']);
    expect(readHiddenFacets('task').size).toBe(0);
    resetRowViewCache();
    expect([...readHiddenFacets('work_session')]).toEqual(['counts']);
    writeHiddenFacets('work_session', []);
    expect(window.localStorage.getItem(rowViewStorageKey('work_session'))).toBeNull();
  });

  it('offers only the facets an anatomy draws, and every facet is reachable', () => {
    const session = facetsForAnatomy('session-tree').map((spec) => spec.id);
    /* The session tile has no people-avatar slot and no progress figure; what
       it does have is the counts line, the same one every anatomy draws. */
    expect(session).toEqual(['counts']);
    expect(facetsForAnatomy(undefined).map((spec) => spec.id)).toEqual(['avatar', 'progress', 'counts']);
    for (const spec of ROW_FACETS) expect(spec.anatomies.length).toBeGreaterThan(0);
  });

  /**
   * THE QUIET-TILE CUT, ASSERTED AS AN ABSENCE. Twelve facets left with the
   * facts they switched (approved change list 01a14695-6b54, §6). This is the
   * test that stops one creeping back as a dead switch — a control for a fact
   * no renderer draws is worse than no control, because it reads as broken.
   */
  it('offers no switch for a fact the quiet tile no longer draws', () => {
    const ids = ROW_FACETS.map((spec) => spec.id as string);
    for (const gone of [
      'model',
      'agent_avatar',
      'lane',
      'linked_tasks',
      'forms',
      'meta',
      'status_word',
      'prs',
      'sessions_chip',
      'docs_memories',
      'human_messages',
      'agent_messages',
    ]) {
      expect(ids, `${gone} is still offered`).not.toContain(gone);
    }
  });

  describe('the one-time carry-over from the pre-quiet-tile key', () => {
    it('keeps the ids that survived and drops the key', () => {
      window.localStorage.setItem(legacyRowViewStorageKey('task'), JSON.stringify(['avatar', 'status_word', 'model']));
      resetRowViewCache();
      expect([...readHiddenFacets('task')]).toEqual(['avatar']);
      expect(window.localStorage.getItem(legacyRowViewStorageKey('task'))).toBeNull();
      expect(JSON.parse(window.localStorage.getItem(rowViewStorageKey('task'))!)).toEqual(['avatar']);
    });

    it('leaves no key when every stored id was cut, which is the default look', () => {
      window.localStorage.setItem(legacyRowViewStorageKey('doc'), JSON.stringify(['status_word', 'human_messages']));
      resetRowViewCache();
      expect(readHiddenFacets('doc').size).toBe(0);
      expect(window.localStorage.getItem(legacyRowViewStorageKey('doc'))).toBeNull();
      expect(window.localStorage.getItem(rowViewStorageKey('doc'))).toBeNull();
    });

    it('never overwrites a choice made since — and runs at most once', () => {
      window.localStorage.setItem(legacyRowViewStorageKey('task'), JSON.stringify(['avatar']));
      window.localStorage.setItem(rowViewStorageKey('task'), JSON.stringify(['counts']));
      resetRowViewCache();
      expect([...readHiddenFacets('task')]).toEqual(['counts']);
      /* The v1 key is left alone when v2 already answered: nothing read it, so
         nothing had cause to remove it. The next write of v2 is what retires
         it in practice, and either way it can never win. */
      resetRowViewCache();
      expect([...readHiddenFacets('task')]).toEqual(['counts']);
    });
  });
});

describe('the View picker', () => {
  it('unticking Counts line hides it on task rows, counts it on the chip, and persists', () => {
    /* A row with a count to lose: `counters.docs` is the one group a pre-108
       server already sends, so this is also the rolling-compatibility case. */
    const row: EntitySummary = {
      ...taskGuideLines,
      counters: { ...taskGuideLines.counters, docs: 2 },
    };
    const view = render(<EntityListPanel kind="task" rowsFor={rowsFor([row])} ctx={ctx} />);
    expect(view.getAllByTestId('tile-link-counts').length).toBe(1);

    fireEvent.click(view.getByTestId('row-view-trigger'));
    const menu = view.getByTestId('row-view-menu');
    const option = menu.querySelector('[data-facet="counts"]')!;
    expect(option.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(option);
    expect(view.queryAllByTestId('tile-link-counts').length).toBe(0);
    expect(option.getAttribute('aria-checked')).toBe('false');
    expect(JSON.parse(window.localStorage.getItem(rowViewStorageKey('task'))!)).toEqual(['counts']);

    fireEvent.click(view.getByTestId('row-view-reset'));
    expect(view.getAllByTestId('tile-link-counts').length).toBe(1);
    expect(window.localStorage.getItem(rowViewStorageKey('task'))).toBeNull();
  });

  it('a stored choice applies on mount and to that kind only', () => {
    writeHiddenFacets('task', ['counts']);
    const row: EntitySummary = { ...taskGuideLines, counters: { ...taskGuideLines.counters, docs: 2 } };
    const tasks = render(<EntityListPanel kind="task" rowsFor={rowsFor([row])} ctx={ctx} />);
    expect(tasks.queryAllByTestId('tile-link-counts').length).toBe(0);
    expect(tasks.getByTestId('row-view-trigger').querySelector('.lp__chip-count')?.textContent).toBe('1');
    tasks.unmount();

    const docs = render(
      <EntityListPanel kind="doc" rowsFor={rowsFor([{ ...row, kind: 'doc' }])} ctx={ctx} />,
    );
    expect(docs.getByTestId('row-view-trigger').querySelector('.lp__chip-count')).toBeNull();
    expect(docs.getAllByTestId('tile-link-counts').length).toBe(1);
  });

  it('follows a change made in another tab', () => {
    const row: EntitySummary = { ...taskGuideLines, counters: { ...taskGuideLines.counters, docs: 2 } };
    const view = render(<EntityListPanel kind="task" rowsFor={rowsFor([row])} ctx={ctx} />);
    act(() => {
      window.localStorage.setItem(rowViewStorageKey('task'), JSON.stringify(['counts']));
      window.dispatchEvent(new StorageEvent('storage', { key: rowViewStorageKey('task') }));
    });
    expect(view.queryAllByTestId('tile-link-counts').length).toBe(0);
  });
});
