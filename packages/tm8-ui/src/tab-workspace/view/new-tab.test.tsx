// @vitest-environment jsdom
/**
 * The New tab (Kalai, 2026-10-07): space-wide search on top, the four main
 * kinds and More, Recent below. An idle Enter opens nothing.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { FIXTURE_SPACE_ID, docLayoutSpec, taskGuideLines } from '../../fixtures';
import { createDomainStore } from '../../data/project/domain-store';
import { NEW_KINDS } from '../../keyboard';
import { createWorkspaceStore } from '../runtime/store';
import { Chooser } from './Chooser';
import { WorkspaceProvider, type WorkspaceContextValue } from './context';

afterEach(cleanup);

const doc = { ...docLayoutSpec, kind: 'doc' } as EntitySummary;

function newTab(rows: EntitySummary[] = [taskGuideLines, doc], byType = false) {
  const store = createWorkspaceStore('viewer-1', FIXTURE_SPACE_ID);
  if (byType) store.setState((s) => ({ ...s, scope: { mode: 'byType', selectedTypeIds: ['task'] } }) as typeof s);
  const domain = createDomainStore();
  domain.store.getState().ingestSummaries(rows);
  const ensureKind = vi.fn();
  const dispatch = vi.fn(() => ({ ok: true }));
  const gate = {
    data: { rowsFor: (kind: string) => () => rows.filter((r) => r.kind === kind), ensureKind, domain, livenessOf: () => 'unknown' },
  };
  const value = {
    runtime: { registerEffect: () => () => {}, hooks: { toast: () => {} } },
    store, dispatch, viewerId: 'viewer-1', spaceId: FIXTURE_SPACE_ID, gate,
  } as unknown as WorkspaceContextValue;
  render(
    <WorkspaceProvider value={value}>
      <Chooser tabId={'tab-new' as never} variant="tab" />
    </WorkspaceProvider>,
  );
  return { dispatch, ensureKind, search: screen.getByTestId('tws-chooser-search') };
}

const opened = (dispatch: ReturnType<typeof vi.fn>) =>
  dispatch.mock.calls.map(([call]) => call as { command: string; args: Record<string, unknown> });

describe('the New tab', () => {
  it('offers task, doc, session and chat as cards, with their chords, and the rest under More', () => {
    newTab();
    const create = screen.getByRole('region', { name: 'Create' });
    const cards = within(create).getAllByRole('button').map((b) => b.textContent);
    expect(cards).toEqual(['New taskn t', 'New docn d', 'New sessionn s', 'New chatn c', 'More▾']);
    fireEvent.click(screen.getByTestId('tws-chooser-more'));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.getAttribute('data-testid'))).toEqual(
      NEW_KINDS.slice(4).map(({ kind }) => `tws-chooser-new-${kind}`),
    );
    expect(screen.queryByTestId('tws-chooser-new-file')).toBeNull();
    expect(screen.queryByTestId('tws-chooser-new-pull_request')).toBeNull();
  });

  it('a pick from More opens that draft in place of the New tab, and the menu closes', () => {
    const { dispatch } = newTab();
    fireEvent.click(screen.getByTestId('tws-chooser-more'));
    fireEvent.click(screen.getByTestId('tws-chooser-new-story'));
    expect(opened(dispatch)).toContainEqual({
      command: 'workspace.drafts.open', args: { kind: 'story', replaceTabId: 'tab-new' }, source: 'click',
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Enter on an empty search opens nothing, though Recent has rows', () => {
    const { dispatch, search } = newTab();
    expect(screen.getAllByTestId('tws-chooser-row')).toHaveLength(2);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('typing highlights the first result; Enter opens it, ↓ moves on', () => {
    const { dispatch, search } = newTab();
    fireEvent.change(search, { target: { value: taskGuideLines.title.slice(0, 5) } });
    expect(screen.getByText(/^Results in this space \(\d+\)$/)).toBeTruthy();
    const first = screen.getAllByTestId('tws-chooser-row')[0]!;
    expect(first.hasAttribute('data-current')).toBe(true);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(opened(dispatch)[0]).toMatchObject({ command: 'workspace.tabs.open', args: { replaceTabId: 'tab-new' } });
  });

  it('searches the whole space, whatever the tab scope', () => {
    const { ensureKind, search } = newTab([taskGuideLines, doc], true);
    expect(ensureKind).toHaveBeenCalledWith('doc');
    fireEvent.change(search, { target: { value: doc.title } });
    expect(screen.getAllByTestId('tws-chooser-row').map((r) => r.textContent)).toContainEqual(expect.stringContaining(doc.title));
  });
});
