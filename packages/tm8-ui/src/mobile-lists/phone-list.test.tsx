// @vitest-environment jsdom
/**
 * THE PHONE LIST, MOUNTED THE WAY THE SHELL MOUNTS IT — the real `EntityView`
 * inside the real surface provider over the fixture seam, driven by taps.
 * Same harness as `views/entity-fab-mount.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { EntityView } from '../views/EntityView';
import { useGateData, type GateData } from '../views/useGateData';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { MobileSurfaceProvider } from '../mobile';
import { screenStackStore } from '../stores/screenStackStore';
import type { DetailReasons } from '../panels';
import { forgetPlaces, HOLD_MS } from '.';

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

function Host({ kind }: { kind: string }) {
  const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
  return (
    <EntityView
      data={data as GateData & { pull?: (id: string) => void }}
      kind={kind}
      reasons={REASONS}
      onNotice={() => {}}
    />
  );
}

function phone(kind = 'task') {
  const host = document.createElement('div');
  host.className = 'msheet-host';
  document.body.append(host);
  return render(
    <div className="cv2-root" data-shell="mobile">
      <MobileSurfaceProvider sheetHost={host}>
        <Host kind={kind} />
      </MobileSurfaceProvider>
    </div>,
  );
}

const rows = (view: ReturnType<typeof phone>) => waitFor(() => {
  const found = view.getAllByTestId('phone-list-row');
  expect(found.length).toBeGreaterThan(0);
  return found;
});

beforeEach(() => {
  screenStackStore.getState().clearAll();
  forgetPlaces();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('.msheet-host').forEach((n) => n.remove());
});

describe('the phone list replaces the squeezed desktop list on the phone shell', () => {
  it('draws one row per entity with the shared anatomy, and no desktop tiles', async () => {
    const view = phone();
    const found = await rows(view);
    expect(view.queryAllByTestId('list-tile')).toHaveLength(0);
    const first = found[0]!;
    expect(first.querySelector('.pl-g')).toBeTruthy();
    expect(first.querySelector('.pl-t')?.textContent).toBeTruthy();
    expect(first.querySelector('.pl-l2')).toBeTruthy();
    /* The header: a count, ⚙ and — tasks can be created — ＋. */
    expect(view.getByTestId('phone-list-count').textContent).toMatch(/task/);
    expect(view.getByTestId('phone-list-tune')).toBeTruthy();
    expect(view.getByTestId('phone-list-new')).toBeTruthy();
    /* The search field is 16px so iOS does not zoom on focus — asserted in CSS. */
    expect(view.getByTestId('phone-list-search').getAttribute('type')).toBe('search');
  });

  it('a kind with no list create draws no ＋ at all', async () => {
    const view = phone('work_session');
    await waitFor(() => expect(view.getByTestId('phone-list')).toBeTruthy());
    expect(view.queryByTestId('phone-list-new')).toBeNull();
  });

  it('search filters in place and says when nothing matches', async () => {
    const view = phone();
    const before = (await rows(view)).length;
    fireEvent.change(view.getByTestId('phone-list-search'), { target: { value: 'zzzz-no-such-title' } });
    await waitFor(() => expect(view.queryAllByTestId('phone-list-row')).toHaveLength(0));
    const empty = view.getByTestId('phone-list-empty');
    expect(empty.textContent).toMatch(/No results for/);
    fireEvent.click(within(empty).getByText('Clear search'));
    await waitFor(() => expect(view.getAllByTestId('phone-list-row')).toHaveLength(before));
  });

  it('a tap pushes the entity; Up returns to the list at the same place with focus on the row', async () => {
    const view = phone();
    const found = await rows(view);
    const scroller = view.getByTestId('phone-list-scroller');
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    const target = found[0]!;
    const id = target.closest('[data-row-id]')!.getAttribute('data-row-id');
    fireEvent.click(target);
    await waitFor(() => expect(view.getByTestId('entity-detail-panel')).toBeTruthy());
    expect(view.queryByTestId('phone-list')).toBeNull();
    expect(view.getByTestId('entity-view-detail').getAttribute('data-phone-enter')).toBe('push');

    act(() => screenStackStore.getState().clearAll());
    await waitFor(() => expect(view.getByTestId('phone-list')).toBeTruthy());
    expect(view.getByTestId('phone-list-scroller').scrollTop).toBe(120);
    const back = view.container.querySelector(`[data-row-id="${id}"] .pl-r`);
    expect(document.activeElement).toBe(back);
    expect(view.getByTestId('phone-list').className).toContain('pl--back');
  });

  it('press and hold opens the row’s action sheet; a hold is not also a tap', async () => {
    const view = phone();
    const row = (await rows(view))[0]!;
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    await act(() => new Promise((r) => setTimeout(r, HOLD_MS + 50)));
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    const sheet = await waitFor(() => document.querySelector('[data-testid="phone-list-actions"]') as HTMLElement);
    expect(within(sheet).getByText('Open')).toBeTruthy();
    expect(within(sheet).getByText('Copy link')).toBeTruthy();
    expect(view.queryByTestId('entity-detail-panel')).toBeNull();
  });

  it('moving the finger cancels the hold, so scrolling never opens it', async () => {
    const view = phone();
    const row = (await rows(view))[0]!;
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { clientX: 10, clientY: 40 });
    await act(() => new Promise((r) => setTimeout(r, HOLD_MS + 50)));
    expect(document.querySelector('[data-testid="phone-list-actions"]')).toBeNull();
  });

  it('⚙ opens sort & filter as a sheet; applying shows what is filtered, Clear undoes it', async () => {
    const view = phone();
    await rows(view);
    fireEvent.click(view.getByTestId('phone-list-tune'));
    const sheet = await waitFor(() => document.querySelector('[data-testid="phone-list-filter-sheet"]') as HTMLElement);
    expect(within(sheet).getByText('Sort')).toBeTruthy();
    expect(within(sheet).getByText('Status')).toBeTruthy();
    fireEvent.click(within(sheet).getByLabelText('All'));
    fireEvent.click(within(sheet).getByTestId('phone-list-apply'));
    await waitFor(() => expect(view.getByTestId('phone-list-filtered').textContent).toMatch(/All/));
    expect(view.getByTestId('phone-list-tune').getAttribute('aria-label')).toMatch(/1 active/);
    fireEvent.click(within(view.getByTestId('phone-list-filtered')).getByText('Clear'));
    await waitFor(() => expect(view.queryByTestId('phone-list-filtered')).toBeNull());
  });
});

describe('the desktop is untouched', () => {
  it('without the phone surface the desktop list renders and the phone list does not', async () => {
    const view = render(<Host kind="task" />);
    await waitFor(() => expect(view.getAllByTestId('list-tile').length).toBeGreaterThan(0));
    expect(view.queryByTestId('phone-list')).toBeNull();
  });
});
