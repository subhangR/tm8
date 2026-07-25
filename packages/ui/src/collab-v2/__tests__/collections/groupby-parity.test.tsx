/**
 * Gate L4: groupBy treats EVERY axis uniformly — `axis:<name>` behaves
 * exactly like `workStatus`/`assignee`, default and manual axes are
 * indistinguishable, and the client grouping mirrors the facade's.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { boardColumns, groupItems } from '../../collections';
import { CollectionView } from '../../collections';
import { createFacade, renderWith, resetStores } from './helpers';

describe('groupBy parity', () => {
  beforeEach(resetStores);

  it('client grouping matches the facade grouping for workStatus AND axis pivots', async () => {
    const facade = createFacade();
    const axes = await facade.getTaskAxes(facade.ids.space);
    for (const groupBy of ['workStatus', 'axis:type', 'axis:milestone', 'assignee'] as const) {
      const res = await facade.queryCollection({
        spaceId: facade.ids.space, kinds: ['task'], groupBy, sort: 'position',
      });
      const client = groupItems(res.page.items, groupBy, axes);
      const server = res.groups ?? [];
      expect(client.map((g) => g.key).sort()).toEqual(server.map((g) => g.key).sort());
      for (const g of server) {
        const mine = client.find((c) => c.key === g.key);
        expect(mine, `${groupBy} group ${g.key}`).toBeTruthy();
        expect(mine!.items.map((i) => i.id).sort()).toEqual(g.items.map((i) => i.id).sort());
      }
    }
  });

  it('default and manual axes produce indistinguishable board columns', async () => {
    const facade = createFacade();
    const axes = await facade.getTaskAxes(facade.ids.space);
    const res = await facade.queryCollection({
      spaceId: facade.ids.space, kinds: ['task'], sort: 'position',
    });
    // `type` is a default axis, `milestone` is manual — the board must not care.
    const typeCols = boardColumns(res.page.items, 'axis:type', axes);
    const milestoneCols = boardColumns(res.page.items, 'axis:milestone', axes);
    const typeAxis = axes.find((a) => a.name === 'type')!;
    const milestoneAxis = axes.find((a) => a.name === 'milestone')!;
    // every catalog value is a column (empty ones included), in catalog order
    expect(typeCols.map((c) => c.key).slice(0, typeAxis.axisValues.length)).toEqual(typeAxis.axisValues);
    expect(milestoneCols.map((c) => c.key).slice(0, milestoneAxis.axisValues.length)).toEqual(milestoneAxis.axisValues);
    // structural parity: same shape of output for both axis kinds
    expect(typeof typeCols[0].label).toBe('string');
    expect(typeof milestoneCols[0].label).toBe('string');
  });

  it('the pivot control lists built-ins and every axis the same way', async () => {
    const facade = createFacade();
        renderWith(facade, (
      <CollectionView query={{ spaceId: facade.ids.space, kinds: ['task'], sort: 'position' }} />
    ));
    await screen.findByText('T-100 · Collab V2 milestone');

    const pivot = await screen.findByRole('radiogroup', { name: 'Group by' });
    const labels = Array.from(pivot.querySelectorAll('[role="radio"]')).map((b) => b.textContent);
    expect(labels).toEqual(['None', 'Status', 'Assignee', 'type', 'milestone']);

    // pivoting on a MANUAL axis groups the flat layouts' summary identically
    fireEvent.click(screen.getByRole('radio', { name: 'milestone' }));
    const summary = await screen.findByLabelText('Group summary');
    expect(summary.textContent).toMatch(/v2-alpha · 11/);
  });
});
