// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, sessionStale, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';
import {
  ROW_FACETS,
  countBadgeVisible,
  facetsForAnatomy,
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
    window.localStorage.setItem(rowViewStorageKey('doc'), JSON.stringify(['model', 'no_such_facet', 7]));
    resetRowViewCache();
    expect(readHiddenFacets('task').size).toBe(0);
    expect([...readHiddenFacets('doc')]).toEqual(['model']);
  });

  it('is per kind and persists the hidden set; clearing removes the key', () => {
    writeHiddenFacets('work_session', ['model', 'lane']);
    expect(readHiddenFacets('task').size).toBe(0);
    resetRowViewCache();
    expect([...readHiddenFacets('work_session')].sort()).toEqual(['lane', 'model']);
    writeHiddenFacets('work_session', []);
    expect(window.localStorage.getItem(rowViewStorageKey('work_session'))).toBeNull();
  });

  it('offers only the facets an anatomy draws', () => {
    const session = facetsForAnatomy('session-tree').map((spec) => spec.id);
    expect(session).toContain('model');
    expect(session).not.toContain('status_word');
    expect(facetsForAnatomy(undefined).map((spec) => spec.id)).not.toContain('model');
    // Every facet is reachable from at least one anatomy.
    for (const spec of ROW_FACETS) expect(spec.anatomies.length).toBeGreaterThan(0);
  });

  it('maps count badges to facets; the legacy total hides only when both message facets do', () => {
    expect(countBadgeVisible('docs_memories', new Set(['docs_memories']))).toBe(false);
    expect(countBadgeVisible('human_messages', new Set(['agent_messages']))).toBe(true);
    expect(countBadgeVisible('messages', new Set(['human_messages']))).toBe(true);
    expect(countBadgeVisible('messages', new Set(['human_messages', 'agent_messages']))).toBe(false);
  });
});

describe('View ▾ picker in the filter row', () => {
  const model = sessionStale.state.kind === 'work_session' ? sessionStale.state.model : null;

  it('unticking Model hides it on session rows, counts it on the chip, and persists', () => {
    expect(model).toBeTruthy();
    const view = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([sessionStale])} ctx={ctx} livenessOf={() => 'unknown'} />,
    );
    const tile = () => view.getAllByTestId('list-tile')[0]!;
    expect(tile().querySelector('.pn-st__model')?.textContent).toBe(model);

    fireEvent.click(view.getByTestId('row-view-trigger'));
    const menu = view.getByTestId('row-view-menu');
    const modelOption = menu.querySelector('[data-facet="model"]')!;
    expect(modelOption.getAttribute('aria-checked')).toBe('true');
    // A session list offers no standard-only switch.
    expect(menu.querySelector('[data-facet="status_word"]')).toBeNull();

    fireEvent.click(modelOption);
    expect(tile().querySelector('.pn-st__model')).toBeNull();
    expect(modelOption.getAttribute('aria-checked')).toBe('false');
    expect(within(view.getByTestId('row-view-trigger')).getByText('1')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(rowViewStorageKey('work_session'))!)).toEqual(['model']);

    fireEvent.click(view.getByTestId('row-view-reset'));
    expect(tile().querySelector('.pn-st__model')?.textContent).toBe(model);
    expect(window.localStorage.getItem(rowViewStorageKey('work_session'))).toBeNull();
  });

  it('a stored choice applies on mount and to that kind only', () => {
    writeHiddenFacets('work_session', ['model']);
    const sessions = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([sessionStale])} ctx={ctx} livenessOf={() => 'unknown'} />,
    );
    expect(sessions.getAllByTestId('list-tile')[0]!.querySelector('.pn-st__model')).toBeNull();
    sessions.unmount();

    const tasks = render(<EntityListPanel kind="task" rowsFor={rowsFor([taskGuideLines])} ctx={ctx} />);
    expect(tasks.getByTestId('row-view-trigger').querySelector('.lp__chip-count')).toBeNull();
  });

  it('follows a change made in another tab', () => {
    const view = render(
      <EntityListPanel kind="work_session" rowsFor={rowsFor([sessionStale])} ctx={ctx} livenessOf={() => 'unknown'} />,
    );
    act(() => {
      window.localStorage.setItem(rowViewStorageKey('work_session'), JSON.stringify(['model']));
      window.dispatchEvent(new StorageEvent('storage', { key: rowViewStorageKey('work_session') }));
    });
    expect(view.getAllByTestId('list-tile')[0]!.querySelector('.pn-st__model')).toBeNull();
  });
});
