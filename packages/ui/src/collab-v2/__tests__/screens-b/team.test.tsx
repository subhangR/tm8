/**
 * Team screen — humans with the agents they own, nested by hierarchy.
 *
 * The seed's org is Subhang → Forge → (Scout, Probe), with Mira owning none:
 * exactly the two shapes the screen must handle (a nested tree and a teaching
 * empty state).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { TeamScreen, groupByOwner, orgRows } from '../../screens/team';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores, screenProps } from './helpers';

let facade: MockFacade;

beforeEach(() => { resetStores(); facade = createFacade(); });
afterEach(() => { cleanup(); resetStores(); });

const cards = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="team-member-card"]'));

const cardFor = (memberId: string): HTMLElement =>
  document.querySelector(`[data-member="${memberId}"]`) as HTMLElement;

/** The member's own EntityCard — agents below it carry their owner's name too. */
const headOf = (memberId: string): HTMLElement =>
  cardFor(memberId).querySelector('.cv2-team__cardhead') as HTMLElement;

const agentRow = (memberId: string, name: string): HTMLElement => {
  const row = within(cardFor(memberId)).getAllByRole('treeitem').find((r) =>
    (r.querySelector('.cv2-card__title') as HTMLElement).textContent === name);
  return row as HTMLElement;
};

async function renderTeam() {
  const harness = screenProps(facade);
  const view = renderWith(facade, <TeamScreen {...harness.props} />);
  await screen.findByTestId('team-screen');
  await waitFor(() => expect(cards().length).toBeGreaterThan(0));
  return { ...harness, view };
}

describe('Team screen', () => {
  it('renders a card per human with the roster tally', async () => {
    await renderTeam();
    const members = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['member'] });
    const agents = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['team_member'] });

    expect(cards()).toHaveLength(members.page.items.length);
    expect(screen.getByText(
      new RegExp(`${members.page.items.length} humans? · ${agents.page.items.length} agents?`),
    )).toBeTruthy();
    expect(within(headOf(facade.ids.subhang)).getByText('Subhang')).toBeTruthy();
    expect(within(headOf(facade.ids.mira)).getByText('Mira')).toBeTruthy();
  });

  it('nests a member’s agents as an org-tree under their owner', async () => {
    await renderTeam();
    const card = cardFor(facade.ids.subhang);

    await waitFor(() => expect(within(card).getAllByRole('treeitem')).toHaveLength(3));

    // Forge leads; Scout and Probe are its children — one level deeper.
    expect(agentRow(facade.ids.subhang, 'Forge').dataset.depth).toBe('0');
    expect(agentRow(facade.ids.subhang, 'Scout').dataset.depth).toBe('1');
    expect(agentRow(facade.ids.subhang, 'Probe').dataset.depth).toBe('1');
    // The nesting is rendered as tree levels, not just indentation.
    expect(agentRow(facade.ids.subhang, 'Scout').getAttribute('aria-level')).toBe('2');

    // Agents are attributed to their owner only.
    expect(within(cardFor(facade.ids.mira)).queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('teaches the empty state for a member with no agents', async () => {
    await renderTeam();
    expect(within(cardFor(facade.ids.mira)).getByText(/no agents yet/i)).toBeTruthy();
  });

  it('shows live status badges on agent rows', async () => {
    await renderTeam();
    const card = cardFor(facade.ids.subhang);
    await waitFor(() => {
      expect(within(card).getAllByTestId('live-badges').length).toBe(3);
    });
  });

  it('opens a profile on the Entity Z4 route', async () => {
    const { navigated } = await renderTeam();

    fireEvent.click(within(headOf(facade.ids.mira)).getByText('Mira'));
    expect(navigated).toContainEqual({ view: 'entity', entityId: facade.ids.mira });

    fireEvent.click(agentRow(facade.ids.subhang, 'Forge').querySelector('.cv2-team__orgcell') as HTMLElement);
    expect(navigated).toContainEqual({ view: 'entity', entityId: facade.ids.forge });
  });

  it('offers a SPAWN affordance per member', async () => {
    await renderTeam();
    expect(within(cardFor(facade.ids.subhang)).getByRole('button', { name: /Spawn/i })).toBeTruthy();
    expect(within(cardFor(facade.ids.mira)).getByRole('button', { name: /Spawn/i })).toBeTruthy();
  });
});

describe('Team model', () => {
  it('buckets agents by owner and flattens the hierarchy depth-first', async () => {
    const agents = await facade.queryCollection({ spaceId: facade.ids.space, kinds: ['team_member'] });
    const byOwner = groupByOwner(agents.page.items);

    expect(byOwner.get(facade.ids.subhang)).toHaveLength(3);
    expect(byOwner.get(facade.ids.mira) ?? []).toHaveLength(0);

    const rows = orgRows(byOwner.get(facade.ids.subhang) ?? []);
    expect(rows.map((r) => [r.entity.title, r.depth])).toEqual([
      ['Forge', 0], ['Scout', 1], ['Probe', 1],
    ]);
  });
});
