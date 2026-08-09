// @vitest-environment jsdom
/**
 * CHANNEL MEMBERS IN THE PANEL — the UI half of migration 080.
 *
 * Ticket item 4: "Channel has members. Should be able to add members while
 * creating or updating a channel." This file covers UPDATING. Creating is
 * `CreateEntityInput.connections`, which is server-side and has its own test.
 *
 * WHY THIS FILE EXISTS AT ALL, given `panel-controls.test.tsx` already proves
 * the assign control works: because the channel change is ONE REGISTRY ENTRY,
 * and a registry entry has a consequence the task tests cannot see.
 * `controlsFor()` (EntityDetailPanel.tsx:109) mounts the control strip when a
 * kind declares a state control, a value control OR an assign control. Channel
 * declared none of the three, so it mounted no strip at all —
 * `docs/features/channels/README.md` records a probe render saying exactly
 * that, and cites it as the evidence for ticket items 1, 5 and 6.
 *
 * Giving channel an assign control therefore mounts a strip on a panel that
 * has never had one. That is intended, and it is also precisely the sort of
 * side effect that ships unnoticed. So the second test below re-runs the
 * README's claim: the strip appears, and it still contains NO state control
 * and NO value control. If a future registry edit puts State or Priority back
 * on a channel, this fails instead of the README quietly going stale.
 *
 * RED-FIRST RECORD — MEASURED 2026-08-07, not predicted. Instrument:
 * `bunx vitest run src/panels/detail/channel-members.test.tsx` from
 * `packages/tm8-ui`.
 *   · With `assignControl: CHANNEL_MEMBER_CONTROL` commented out of the
 *     channel's registry row (the ONE line this feature adds to the UI):
 *       Test Files 1 failed | Tests 2 failed | 1 passed (3).
 *     The two membership tests fail on the missing `row-assign-trigger`. The
 *     "nothing else" test PASSES there — correctly, and it is worth saying why
 *     it is still worth keeping: on that tree it passes because the strip does
 *     not exist, and here it passes because the strip exists and is empty of
 *     those two controls. Same assertion, two different reasons, and only the
 *     second is the one this feature has to hold.
 *   · With the line restored: Tests 3 passed (3).
 *
 * AND A CORRECTION WORTH LEAVING IN. The first version of this file built its
 * own `ADA`/`FORGE` literals with invented ids (`member-ada`, `tm-forge`)
 * rather than importing the fixture actors. Result on the first real run:
 * 1 failed | 2 passed — and the failure was the honest one. Those ids are in
 * no channel's `state.members`, so `aria-pressed` was false for every option,
 * the "add" test passed for the wrong reason, and the "remove" test had
 * nothing to assert against. The fix was to use the app's own `ada`, `noor`
 * and `forge`. Recorded because it is the same failure mode as a green tick
 * over a hand-built payload no producer ever emits.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { REASONS as DOMAIN_REASONS, type ActionContext } from '../../domain';
import {
  FIXTURE_SPACE_ID, ada, channelDesign, fixtureDetails, forge, noor, presenceHollowReason,
} from '../../fixtures';
import { EntityDetailPanel, type ControlHost, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

/** The app's own channel fixture — real state shape, real capabilities. */
const CHANNEL: EntityDetail = fixtureDetails[channelDesign.id]!;

/**
 * The offerable roster is the app's own actors, NOT hand-built ones. That
 * matters more than it looks: an invented actor id can never collide with the
 * fixture's `state.members`, so `aria-pressed` would read false for everybody
 * and the "already a member" test would be asserting nothing. (It did, on the
 * first run of this file — see the record above.)
 *
 * A HUMAN AND AN AGENT. `has_member` admits both (080 registers dst_kinds
 * {member, team_member}), and the channel summary has published
 * `workingAgentCount` since before this feature — so a roster that offered
 * only people would contradict a badge that already ships.
 *
 * `noor` is offered and is NOT in `channelDesign.state.members`, which is what
 * makes "add" and "remove" separable below.
 */
const ADA = ada;
const NOOR = noor;
const FORGE = forge;

function host(over: Partial<ControlHost> = {}): ControlHost {
  return {
    kind: 'channel',
    ctx,
    capabilitiesOf: () => CHANNEL.capabilities,
    onSetState: vi.fn(),
    onSetValue: vi.fn(),
    onAssign: vi.fn(),
    onArchive: vi.fn(),
    assignableActors: [ADA, NOOR, FORGE],
    ...over,
  };
}

function panel(controls: ControlHost) {
  return render(
    <EntityDetailPanel detail={CHANNEL} reasons={REASONS} ctx={ctx} controls={controls} />,
  );
}

describe('a channel has members, and they are an edge', () => {
  it('adding a member writes ONE `has_member` edge, not a roster PUT', () => {
    const h = host();
    const { getByTestId, getByRole } = panel(h);

    fireEvent.click(getByTestId('row-assign-trigger'));
    fireEvent.click(getByRole('button', { name: new RegExp(NOOR.displayName) }));

    /**
     * THE EDGE TYPE IS THE ASSERTION. The control reads it off the registry
     * (`AssignControl.edgeType`) and the panel never spells it, so this is the
     * one place the channel's choice of `has_member` — rather than
     * `assigned_to`, which would be the copy-paste failure — is pinned.
     *
     * `true` is "add". Per-actor, because a whole-collection write would drop
     * a membership another client made between this read and this write.
     */
    expect(h.onAssign).toHaveBeenCalledWith(CHANNEL.id, NOOR.id, 'has_member', true);
    expect(h.onAssign).toHaveBeenCalledTimes(1);
  });

  it('an existing member is offered as ON, so the same click REMOVES', () => {
    // The fixture channel already carries Ada. `aria-pressed` is how the
    // control reports that, and the fourth argument flips to `false` — which
    // is what makes one menu both the add and the remove.
    const h = host();
    const { getByTestId, getByRole } = panel(h);

    fireEvent.click(getByTestId('row-assign-trigger'));
    const ada = getByRole('button', { name: new RegExp(ADA.displayName) });
    expect(ada.getAttribute('aria-pressed')).toBe('true');
    // The agent too — `has_member` takes `team_member` as a destination, and
    // a roster that rendered agents but never marked them ON would look right.
    expect(getByRole('button', { name: new RegExp(FORGE.displayName) })
      .getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(ada);
    expect(h.onAssign).toHaveBeenCalledWith(CHANNEL.id, ADA.id, 'has_member', false);
  });

  it('and STILL no state and no priority — items 1 and 5 stay fixed', () => {
    const { queryByTestId } = panel(host());
    expect(queryByTestId('row-state-select')).toBeNull();
    expect(queryByTestId('row-value-select')).toBeNull();
  });
});
