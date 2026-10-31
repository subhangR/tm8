// @vitest-environment jsdom
/**
 * The bridge page on the phone (§4.1 Mobile, follow-up 01a18c2b-a0fe): the
 * generic phone page takes the bridge page as its body when the kind's
 * registry row carries the `bridge-page` block — and only then.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityDetail, EntityId, SpaceId } from '@tm8/contract';
import { fixtureDetails, bridgeInfra, memoryTokens } from '../fixtures/entities';
import { createFixtureLoopsClient, fixtureLoopView } from '../loops/fixture';
import { PhoneEntityPage } from '../mobile-pages';
import { fixtureBridgeViewOf } from './fixture';
import { phoneBodyFor } from './phone';
import { testPort } from './test-port';

afterEach(() => cleanup());

describe('phoneBodyFor', () => {
  it('gives a bridge its bridge page, and any other kind nothing', async () => {
    const { port } = testPort();
    const bridge = fixtureDetails[bridgeInfra.id] as EntityDetail;
    const memory = { ...bridge, id: memoryTokens.id, kind: memoryTokens.kind } as EntityDetail;
    expect(phoneBodyFor(memory, { bridges: port }, () => {})).toBeUndefined();
    expect(phoneBodyFor(null, { bridges: port }, () => {})).toBeUndefined();

    render(<PhoneEntityPage detail={bridge} onOpenEntity={() => {}} bodySlot={phoneBodyFor(bridge, { bridges: port }, () => {})} />);
    expect(screen.getByTestId('phone-kind-body')).toBeTruthy();
    expect(await screen.findByTestId('bridge-page')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
      ['Conversation', 'People', 'Routing', 'Memory', 'Loops', 'Health'],
    );
  });

  it('hands the page the loops client too, so the phone Loops tab is the live one', async () => {
    const { port } = testPort();
    const bridge = fixtureDetails[bridgeInfra.id] as EntityDetail;
    const view = fixtureBridgeViewOf(bridgeInfra)!;
    const loops = createFixtureLoopsClient([
      fixtureLoopView('019f0000-0000-7000-8000-0000000000d1' as EntityId, view.spaceId as SpaceId, {
        title: 'Stand-up nudge', schedule: 'every weekday at 09:30', action: 'post',
        targets: [{ bridgeId: view.id, text: 'Morning!' }],
      }),
    ]);
    render(<PhoneEntityPage detail={bridge} onOpenEntity={() => {}} bodySlot={phoneBodyFor(bridge, { bridges: port, loops }, () => {})} />);
    await screen.findByTestId('bridge-page');
    fireEvent.click(screen.getByRole('tab', { name: 'Loops' }));
    expect(await screen.findByText('Morning!')).toBeTruthy();
    expect(screen.queryByText(/not wired on this surface/)).toBeNull();
  });
});
