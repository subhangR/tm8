/**
 * Plug-in points: the rail's slot adapter satisfies EntityPanel's Connections
 * slot exactly (type + runtime), and the bar drops into any host that already
 * holds an envelope — the two W2b subsystems as the panel and the thread
 * consume them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { EntityPanel, type EntityPanelSlots } from '../../entity';
import { ConnectionsRail, connectionsSlot } from '../../subsystems/rail';
import { ReactionsPointsBar } from '../../subsystems/reactions';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores } from './helpers';

let facade: MockFacade;

beforeEach(() => {
  resetStores();
  facade = createFacade();
});

describe('EntityPanel Connections slot', () => {
  it('type-checks as the panel slot and replaces the W1 fallback', async () => {
    const detail = await facade.getEntity(facade.ids.t105);
    const slots: EntityPanelSlots = { connections: connectionsSlot() };

    renderWith(facade, <EntityPanel entityId={detail.id} detail={detail} initialTab="connections" slots={slots} />);

    // the rail took over the tab…
    const rail = await waitFor(() => {
      const el = document.querySelector('.cv2-rail');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(rail.getAttribute('data-entity')).toBe(detail.id);
    // …and the W1 placeholder list is gone
    expect(document.querySelector('[data-slot="connections-fallback"]')).toBeNull();
    expect(within(rail).getByRole('status').textContent).toContain('Blocked');
  });

  it('forwards host options (nav intents) through the adapter', async () => {
    const detail = await facade.getEntity(facade.ids.t100);
    const seen: string[] = [];
    const slots: EntityPanelSlots = {
      connections: connectionsSlot({
        onOpenCollection: ({ layout }) => seen.push(layout),
      }),
    };
    renderWith(facade, <EntityPanel entityId={detail.id} detail={detail} initialTab="connections" slots={slots} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open as tree' }));
    expect(seen).toEqual(['tree']);
  });

  it('reuses the detail the panel already loaded (no extra section fetch)', async () => {
    const detail = await facade.getEntity(facade.ids.t103);
    let calls = 0;
    const original = facade.getConnections.bind(facade);
    facade.getConnections = (id) => { calls += 1; return original(id); };

    renderWith(facade, (
      <EntityPanel
        entityId={detail.id}
        detail={detail}
        initialTab="connections"
        slots={{ connections: connectionsSlot() }}
      />
    ));
    await screen.findByLabelText('Hierarchy');
    expect(calls).toBe(0);
  });
});

describe('ReactionsPointsBar as a host-embedded bar', () => {
  it('renders standalone from an id alone (thread rows, list cells)', async () => {
    const message = await facade.getEntity(facade.ids.forgeProgressMessage);
    renderWith(facade, <ReactionsPointsBar entityId={message.id} size="sm" />);
    await waitFor(() => {
      expect(Number(screen.getByRole('button', { name: 'Grant a point' })
        .querySelector('.cv2-actioncount')?.textContent)).toBe(message.counters.points);
    });
  });

  it('composes inside the rail-bearing panel without clashing', async () => {
    const detail = await facade.getEntity(facade.ids.t103);
    renderWith(facade, (
      <div>
        <ReactionsPointsBar entityId={detail.id} entity={detail} />
        <ConnectionsRail entityId={detail.id} detail={detail} />
      </div>
    ));
    expect(await screen.findByLabelText('Hierarchy')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Like' })).toBeTruthy();
  });
});
