// @vitest-environment jsdom
/**
 * The bridge page on the phone (§4.1 Mobile, follow-up 01a18c2b-a0fe): the
 * generic phone page takes the bridge page as its body when the kind's
 * registry row carries the `bridge-page` block — and only then.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityDetail } from '@tm8/contract';
import { fixtureDetails, bridgeInfra, memoryTokens } from '../fixtures/entities';
import { PhoneEntityPage } from '../mobile-pages';
import { phoneBodyFor } from './phone';
import { testPort } from './test-port';

afterEach(() => cleanup());

describe('phoneBodyFor', () => {
  it('gives a bridge its bridge page, and any other kind nothing', async () => {
    const { port } = testPort();
    const bridge = fixtureDetails[bridgeInfra.id] as EntityDetail;
    const memory = { ...bridge, id: memoryTokens.id, kind: memoryTokens.kind } as EntityDetail;
    expect(phoneBodyFor(memory, port, () => {})).toBeUndefined();
    expect(phoneBodyFor(null, port, () => {})).toBeUndefined();

    render(<PhoneEntityPage detail={bridge} onOpenEntity={() => {}} bodySlot={phoneBodyFor(bridge, port, () => {})} />);
    expect(screen.getByTestId('phone-kind-body')).toBeTruthy();
    expect(await screen.findByTestId('bridge-page')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
      ['Conversation', 'People', 'Routing', 'Memory', 'Loops', 'Health'],
    );
  });
});
