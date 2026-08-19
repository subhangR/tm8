// @vitest-environment jsdom
/**
 * THE PHONE'S ACTION MENU IS ACTUALLY MOUNTED, AND IT REACHES THE SHEET.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PANEL'S OWN SUITE. `panel-phone-
 * chrome.test.tsx` renders the panel and proves the strip is gone and that
 * `panelMenuItems` derives the right rows. It would pass with the app
 * completely broken, because nothing in it is a HOST: the same failure
 * `panel-primaries-wired.test.tsx` was written for, in this same directory —
 * five mount sites, five dead action bars, every unit test green. Taking the tab
 * row away and not mounting the thing that replaced it is that failure with the
 * stakes raised, because there would then be no way to reach Connections,
 * Discussion or the kind's verbs on a phone at all.
 *
 * So this mounts the REAL `EntityView` inside the REAL surface provider and
 * drives it the way a thumb would.
 *
 * === RED-FIRST RECORD: counts in the PR body. ===
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { EntityView } from './EntityView';
import { useGateData, type GateData } from './useGateData';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { MobileSurfaceProvider } from '../mobile';
import { getKind, resolveAction, type ActionRef } from '../domain';
import { screenStackStore } from '../stores/screenStackStore';
import type { DetailReasons } from '../panels';

const REASONS: DetailReasons = {
  presenceHollow: 'Presence isn’t measured yet.',
  versionHistory: 'Version history isn’t available yet.',
  provenanceHollow: 'Authorship provenance isn’t available yet.',
  shareUnavailable: 'Sharing into a session isn’t available yet.',
  withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
};

function TasksHost() {
  const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
  return (
    <EntityView
      data={data as GateData & { pull?: (id: string) => void }}
      kind="task"
      reasons={REASONS}
      onNotice={() => {}}
      onLaunchOpen={() => {}}
      launchSubjectId={null}
    />
  );
}

/**
 * The phone shell, stood up the way `MobileShell` does: the surface provider
 * around the screen, with the frame's sheet host as a real node. There is no
 * provider on any desktop path, so this wrapper IS the fork — `desktop()` below
 * is the identical mount with it removed and nothing else changed.
 */
function phone() {
  const host = document.createElement('div');
  host.className = 'msheet-host';
  document.body.append(host);
  return render(
    <div className="cv2-root" data-shell="mobile">
      <MobileSurfaceProvider sheetHost={host}>
        <TasksHost />
      </MobileSurfaceProvider>
    </div>,
  );
}

function desktop() {
  return render(<TasksHost />);
}

/**
 * Open the first task in the list — the phone's list-to-entity navigation.
 *
 * The tile's TITLE is the select control, not the tile root: `.pn-tt` is a
 * card holding several independent controls (the state dot, the assignee
 * picker, the row cluster) and a click handler on the whole card would make
 * every one of them a navigation. Clicking the root does nothing, which is
 * correct and is how the first draft of this file failed.
 */
async function openFirstTask(view: ReturnType<typeof phone>) {
  const tile = await waitFor(() => view.getAllByTestId('list-tile')[0] as HTMLElement);
  fireEvent.click(tile.querySelector('.pn-tt__title') as HTMLElement);
  return waitFor(() => view.getByTestId('entity-detail-panel'));
}

/*
 * THE SCREEN STACK IS MODULE-LEVEL, so a selection made by one case is still
 * open at the start of the next: the list has already been replaced by the
 * entity and there is no tile left to click. That is correct product behaviour
 * — the phone restores where you were — and a test isolation problem. Cleared
 * per case, so each one starts on the list the way a first visit does. Found by
 * the second and third cases failing to find a tile the first had navigated
 * away from.
 */
beforeEach(() => screenStackStore.getState().clearAll());

describe('the phone entity screen mounts the action menu the tab row became', () => {
  it('the list screen has the CREATE fab and no entity menu; opening an entity swaps them', async () => {
    const view = phone();

    /* The two floating controls are gated on opposite halves of one condition,
       so they can never be on screen together — the list and the entity are two
       different screens on this shell. */
    await waitFor(() => expect(view.getByTestId('entity-view-fab')).toBeTruthy());
    expect(view.queryByTestId('entity-fab')).toBeNull();

    await openFirstTask(view);

    expect(view.getByTestId('entity-fab')).toBeTruthy();
    expect(view.queryByTestId('entity-view-fab')).toBeNull();
  });

  it('the desktop screen mounts NEITHER — the whole branch is unreachable there', async () => {
    /*
     * WHAT THIS CASE ACTUALLY HOLDS, stated because a mutation showed it is not
     * quite what the name suggests. Removing `oneSurface &&` from the host's
     * gate leaves this GREEN: `EntityFab` returns null unless `oneSurface` on
     * its own account, so the component's gate catches what the host's would
     * have. That redundancy is deliberate on both sides — the host's gate is
     * what keeps `panelMenuItems` from being computed on every desktop render
     * of every entity — but the DESKTOP-SAFETY claim belongs to the component
     * and is pinned in `mobile/entity-fab.test.tsx`, not here. What is
     * load-bearing below is the second half: the desktop still has its strip.
     */
    const view = desktop();
    const tile = await waitFor(() => view.getAllByTestId('list-tile')[0] as HTMLElement);
    expect(view.queryByTestId('entity-fab')).toBeNull();
    /* And the desktop keeps its tab strip, which is the other half of the same
       claim: this removal is one shell declining to draw a vocabulary. */
    fireEvent.click(tile.querySelector('.pn-tt__title') as HTMLElement);
    await waitFor(() => expect(view.getByTestId('panel-tabs')).toBeTruthy());
  });

  it('the menu carries the kind\u2019s registry primaries and the two aux tabs', async () => {
    const view = phone();
    await openFirstTask(view);

    fireEvent.click(view.getByTestId('entity-fab'));
    const menu = await waitFor(() => view.getByRole('menu'));

    /*
     * DRIVEN OFF THE REGISTRY, so a kind that gains a primary gains a row here
     * without this file changing. `data-fab-item` is the row's own id attribute
     * — asserting on the LABEL would pass on a menu that had drawn the right
     * words against the wrong verbs.
     */
    const ids = [...menu.querySelectorAll('[data-fab-item]')].map(
      (n) => (n as HTMLElement).dataset.fabItem,
    );
    for (const ref of getKind('task').panel.primaries ?? []) {
      expect(ids, `task declares ${ref}`).toContain(ref);
      expect(within(menu).getByText(resolveAction(ref as ActionRef).label)).toBeTruthy();
    }
    expect(ids).toContain('connections');
    expect(ids).toContain('discussion');
    /* Content is the body, not a destination. */
    expect(ids).not.toContain('content');
  });

  it('selecting Discussion from the menu opens the aux SHEET, not a second route', async () => {
    /*
     * The route already existed: `onTabChange` → `setAux({sort:'tab'})` →
     * `wrapAux` → `MobileSheet`. The failure this guards is a menu that built
     * its own drawer beside it, which would work in a screenshot and diverge the
     * first time the sheet's dismissal rules changed.
     */
    const view = phone();
    await openFirstTask(view);

    fireEvent.click(view.getByTestId('entity-fab'));
    const menu = await waitFor(() => view.getByRole('menu'));
    fireEvent.click(menu.querySelector('[data-fab-item="discussion"]') as HTMLElement);

    await waitFor(() => expect(view.getByTestId('entity-view-aux-sheet')).toBeTruthy());
  });
});
