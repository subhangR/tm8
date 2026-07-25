/**
 * Gate G3 share for W3b: each screen is reachable from the left rail.
 *
 * The three ViewRegistry fragments are what Atlas mounts, so the contract is
 * tested at that seam: click the rail section, get the screen — not the
 * data-backed placeholder that stands in for unregistered views.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ShellLayout, createMemoryTarget } from '../../shell';
import { docsViews } from '../../screens/docs';
import { teamViews, profileViews } from '../../screens/team';
import { leaderboardViews } from '../../screens/leaderboard';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores } from './helpers';

let facade: MockFacade;

beforeEach(() => { resetStores(); facade = createFacade(); });
afterEach(() => { cleanup(); resetStores(); });

const W3B_VIEWS = { ...docsViews, ...teamViews, ...leaderboardViews };

describe('W3b ViewRegistry fragments', () => {
  it('each fragment registers exactly its own view', () => {
    expect(Object.keys(docsViews)).toEqual(['docs']);
    expect(Object.keys(teamViews)).toEqual(['team']);
    expect(Object.keys(leaderboardViews)).toEqual(['leaderboard']);
    // The optional profile fragment is the shared, kind-generic Z4 route.
    expect(Object.keys(profileViews)).toEqual(['entity']);
  });

  it.each([
    ['Docs', 'docs-screen'],
    ['Team', 'team-screen'],
    ['Leaderboard', 'leaderboard-screen'],
  ])('reaches the %s screen from the left rail', async (label, testId) => {
    renderWith(facade, (
      <ShellLayout
        facade={facade}
        spaceId={facade.ids.space}
        views={W3B_VIEWS}
        enableRouter={false}
        enableKeyboard={false}
        routerTarget={createMemoryTarget()}
      />
    ));

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(label, 'i') }));
    await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy());
  });
});
