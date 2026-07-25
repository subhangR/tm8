/**
 * ConnectionsRail against the seeded world: grouping (incl. the 50-edge
 * rule), per-item HARD/SOFT badges, the blocked rollup, hierarchy render +
 * reorder/reparent/add intents, `x:*` groups, remove-on-hover, the inline
 * composer, and standalone (unseeded) mounting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ConnectionsRail, GROUP_PREVIEW } from '../../subsystems/rail';
import type { MockFacade } from '../../mock';
import {
  createFacade, firstGroup, inflateGroup, renderWith, resetStores, withGroup,
} from './helpers';
import type { EntityDetail } from '../../types/contract';

let facade: MockFacade;

async function detailOf(id: string): Promise<EntityDetail> {
  return facade.getEntity(id);
}

beforeEach(() => {
  resetStores();
  facade = createFacade();
});

describe('edge groups', () => {
  it('groups edges by type with a direction arrow and a count', async () => {
    const detail = await detailOf(facade.ids.t104);
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);

    const assigned = await screen.findByLabelText('Assigned to (outgoing)');
    expect(within(assigned).getByText('→')).toBeTruthy();
    expect(within(assigned).getByText('Assigned to')).toBeTruthy();

    // T-104 is attached to the build channel (outgoing) AND has docs/files
    // attached to IT (incoming) — the same type, two groups, two directions.
    expect(screen.getByLabelText('Attached (outgoing)')).toBeTruthy();
    expect(screen.getByLabelText('Attached (incoming)')).toBeTruthy();
  });

  it('renders unregistered x:* groups exactly like registered ones', async () => {
    const detail = await detailOf(facade.ids.t108);
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);
    expect(await screen.findByLabelText('Inspired by (outgoing)')).toBeTruthy();
  });

  it('previews a big group and expands it on "show all" (50-edge rule)', async () => {
    const base = await detailOf(facade.ids.t104);
    const big = inflateGroup(firstGroup(base), 50);
    const detail = withGroup(base, big);

    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);
    const section = await screen.findByLabelText(`${big.label} (${big.direction})`);

    expect(within(section).getAllByRole('listitem')).toHaveLength(GROUP_PREVIEW);
    expect(within(section).getByText('50')).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Show all 50' }));
    expect(within(section).getAllByRole('listitem')).toHaveLength(50);

    fireEvent.click(within(section).getByRole('button', { name: 'Show less' }));
    expect(within(section).getAllByRole('listitem')).toHaveLength(GROUP_PREVIEW);
  });
});

describe('dependency resolution', () => {
  it('badges each dependency item with its own hard/soft resolution state', async () => {
    // T-105 depends (hard) on the still-open T-104.
    const blockedDetail = await detailOf(facade.ids.t105);
    const { unmount } = renderWith(facade, <ConnectionsRail entityId={blockedDetail.id} detail={blockedDetail} />);
    const depends = await screen.findByLabelText('Depends on (outgoing)');
    expect(within(depends).getByText('HARD ⚠')).toBeTruthy();
    unmount();

    // T-106 depends (hard) on T-101, which shipped → resolved.
    const resolvedDetail = await detailOf(facade.ids.t106);
    renderWith(facade, <ConnectionsRail entityId={resolvedDetail.id} detail={resolvedDetail} />);
    const resolved = await screen.findByLabelText('Depends on (outgoing)');
    expect(within(resolved).getByText('HARD ✓')).toBeTruthy();
  });

  it('rolls the group up and banners the entity as blocked with waiting-on chips', async () => {
    const detail = await detailOf(facade.ids.t105);
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Blocked');
    expect(banner.textContent).toContain('1 unresolved hard dependency');
    // …and chips what it is waiting on (the still-open T-104)
    const chips = banner.querySelectorAll('.cv2-chip');
    expect(chips).toHaveLength(1);
    const t104 = await facade.getEntity(facade.ids.t104);
    expect(chips[0].getAttribute('title')).toContain(t104.title);

    const depends = screen.getByLabelText('Depends on (outgoing)');
    expect(within(depends).getByText('⚠ 1 unresolved')).toBeTruthy();
  });

  it('shows no blocked banner when nothing hard is open', async () => {
    const detail = await detailOf(facade.ids.t106);
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);
    await screen.findByLabelText('Hierarchy');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('hierarchy section', () => {
  it('renders the parent up and ordered children down', async () => {
    const detail = await detailOf(facade.ids.t103);
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);

    const section = await screen.findByLabelText('Hierarchy');
    const items = within(section).getAllByRole('listitem');
    expect(items.length).toBe(detail.hierarchy.children.items.length);
    expect(items[0].textContent).toContain('1');
    // the parent sits above the children, with its own detach affordance
    expect(within(section).getByLabelText('Detach from parent')).toBeTruthy();
    expect(section.querySelector('.cv2-rail__updown .cv2-chip')?.getAttribute('title'))
      .toContain(detail.hierarchy.parent!.title);
  });

  it('emits a reorder plan instead of guessing (dnd wiring is W4)', async () => {
    const detail = await detailOf(facade.ids.t100);
    const onReorder = vi.fn();
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} onReorder={onReorder} />);

    const first = detail.hierarchy.children.items[0];
    fireEvent.click(await screen.findByLabelText(`Move ${first.title} down`));

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder.mock.calls[0][0]).toMatchObject({ childId: first.id, fromIndex: 0, toIndex: 1 });
    expect((screen.getByLabelText(`Move ${first.title} up`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits reparent intents for drag-out', async () => {
    const detail = await detailOf(facade.ids.t103);
    const onReparent = vi.fn();
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} onReparent={onReparent} />);

    const child = detail.hierarchy.children.items[0];
    fireEvent.click(await screen.findByLabelText(`Move ${child.title} out`));
    expect(onReparent).toHaveBeenCalledWith({
      childId: child.id, newParentId: detail.hierarchy.parent?.id ?? null,
    });
  });

  it('emits open-as-tree / open-as-board nav intents', async () => {
    const detail = await detailOf(facade.ids.t100);
    const onOpenCollection = vi.fn();
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} onOpenCollection={onOpenCollection} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open as tree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open as board' }));
    expect(onOpenCollection.mock.calls.map((c) => c[0].layout)).toEqual(['tree', 'board']);
    expect(onOpenCollection.mock.calls[0][0].entityId).toBe(detail.id);
  });

  it('routes add-child through the host', async () => {
    const detail = await detailOf(facade.ids.t100);
    const onAddChild = vi.fn();
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} onAddChild={onAddChild} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add child' }));
    expect(onAddChild).toHaveBeenCalledWith(detail.id);
  });
});

describe('mutations', () => {
  it('removes an edge through the facade and refreshes the rail', async () => {
    const detail = await detailOf(facade.ids.t108);
    const spy = vi.spyOn(facade, 'deleteEdge');
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} />);

    const group = await screen.findByLabelText('Inspired by (outgoing)');
    const remove = within(group).getAllByRole('button', { name: /^Remove Inspired by link to/ })[0];
    fireEvent.click(remove);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ clientMutationId: expect.any(String) });
    await waitFor(() => expect(screen.queryByLabelText('Inspired by (outgoing)')).toBeNull());
  });

  it('adds an edge from a group\'s inline "+" with the group type and direction', async () => {
    const detail = await detailOf(facade.ids.t108);
    const other = await facade.getEntity(facade.ids.t102);
    const spy = vi.spyOn(facade, 'createEdge');
    renderWith(facade, (
      <ConnectionsRail entityId={detail.id} detail={detail} candidates={[other]} />
    ));

    const group = await screen.findByLabelText('Related (outgoing)');
    fireEvent.click(within(group).getByRole('button', { name: 'Add Related link' }));

    const form = within(group).getByRole('form', { name: /Link Related/ });
    const candidate = form.querySelector('.cv2-rail__candidates .cv2-chip') as HTMLElement;
    expect(candidate.getAttribute('title')).toContain(other.title);
    fireEvent.click(candidate);
    fireEvent.click(within(form).getByRole('button', { name: 'Link' }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      srcId: detail.id, dstId: other.id, type: 'relates_to',
      clientMutationId: expect.any(String),
    });
  });

  it('hides every mutation affordance in read-only mode', async () => {
    const detail = await detailOf(facade.ids.t108);
    renderWith(facade, <ConnectionsRail entityId={detail.id} detail={detail} readOnly />);
    await screen.findByLabelText('Related (outgoing)');
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Link' })).toBeNull();
  });
});

describe('standalone mounting', () => {
  it('fetches its own hierarchy + connections when given only an id', async () => {
    const hierarchy = vi.spyOn(facade, 'getHierarchy');
    const connections = vi.spyOn(facade, 'getConnections');
    renderWith(facade, <ConnectionsRail entityId={facade.ids.t105} />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Blocked');
    expect(hierarchy).toHaveBeenCalledWith(facade.ids.t105);
    expect(connections).toHaveBeenCalledWith(facade.ids.t105);
  });
});
