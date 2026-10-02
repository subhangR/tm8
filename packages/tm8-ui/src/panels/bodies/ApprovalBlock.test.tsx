// @vitest-environment jsdom
import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityDetail, OpRequestView } from '@tm8/contract';
import { REASONS, getKind, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, fixtureDetails, fixtureOpRequests, opRequestLinkResearch } from '../../fixtures';
import { createFixtureSeam } from '../../data/fixtures/seam-fixture';
import type { OpRequestsOps } from '../../data/seam';
import { EntityDetailPanel } from '../index';

/**
 * THE APPROVE CARD (L5, 280) — mounted through `EntityDetailPanel`, never
 * `ApprovalBlock` by hand, so the registry row's `{ block: 'approval' }` is
 * what routes here: drop it and every case below reds.
 *
 * The card decides nothing about who may decide: the fixture seam's port
 * answers `canDecide` as the server would, and each case scripts the view.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const detail = fixtureDetails[opRequestLinkResearch.id] as EntityDetail;

type SpiedPort = { [K in keyof OpRequestsOps]: Mock<OpRequestsOps[K]> };

/** The fixture seam's real port with every call spied; `get` optionally scripted. */
function portWith(view?: Partial<OpRequestView>): SpiedPort {
  const real = createFixtureSeam().opRequests;
  return {
    list: vi.fn(real.list),
    get: vi.fn<OpRequestsOps['get']>(view ? async () => ({ ...fixtureOpRequests[0]!, ...view }) : real.get),
    approve: vi.fn(real.approve),
    deny: vi.fn(real.deny),
  };
}

async function mount(port: OpRequestsOps | null) {
  const view = render(
    <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} commands={(port ? { opRequests: port } : {}) as never} />,
  );
  await waitFor(() => expect(view.queryByTestId('approval-loading')).toBeNull());
  return view;
}

describe('the registry routes an op request to the approve card', () => {
  it('declares the approval block on the row', () => {
    expect(getKind('op_request').panel.blocks?.some((b) => b.block === 'approval')).toBe(true);
  });
});

describe('the approve card', () => {
  it('draws the request: op, params, input, justification, who filed it, status', async () => {
    const view = await mount(portWith());
    expect(view.getByTestId('approval-title').textContent).toBe('Link a space: Research');
    expect(view.getByTestId('approval-op').textContent).toContain('spaceLinks.add');
    expect(view.getByTestId('approval-params').textContent).toContain(`{"spaceId":"${FIXTURE_SPACE_ID}"}`);
    expect(view.getByTestId('approval-input').textContent).toContain('"targetSpaceId"');
    expect(view.getByTestId('approval-justification').textContent).toContain('The migration notes live in the Research space');
    expect(view.getByTestId('approval-filed-by').textContent).toContain('forge');
    expect(view.getByTestId('approval-status').textContent).toBe('Waiting for a decision');
  });

  it('Approve calls approve with the note, then shows the decided request', async () => {
    const port = portWith();
    const view = await mount(port);
    fireEvent.change(view.getByTestId('approval-note-input'), { target: { value: '  go ahead  ' } });
    fireEvent.click(view.getByTestId('approval-approve'));
    await waitFor(() => expect(view.getByTestId('approval-status').textContent).toBe('Approved · done'));
    expect(port.approve).toHaveBeenCalledWith(opRequestLinkResearch.id, 'go ahead');
    expect(port.deny).not.toHaveBeenCalled();
    // Re-read after the decision: the card shows the server's record.
    expect(port.get).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('approval-note').textContent).toContain('go ahead');
    expect(view.queryByTestId('approval-decide')).toBeNull();
  });

  it('Deny calls deny (no note → null), never approve', async () => {
    const port = portWith();
    const view = await mount(port);
    fireEvent.click(view.getByTestId('approval-deny'));
    await waitFor(() => expect(view.getByTestId('approval-status').textContent).toBe('Denied'));
    expect(port.deny).toHaveBeenCalledWith(opRequestLinkResearch.id, null);
    expect(port.approve).not.toHaveBeenCalled();
    expect(view.queryByTestId('approval-approve')).toBeNull();
  });

  it('hides Approve / Deny when the viewer may not decide, and says why', async () => {
    const view = await mount(portWith({ canDecide: false }));
    expect(view.queryByTestId('approval-approve')).toBeNull();
    expect(view.queryByTestId('approval-deny')).toBeNull();
    expect(view.getByTestId('approval-not-yours').textContent).toContain('Only the person the agent acts for');
  });

  it('hides Approve / Deny once decided, and shows the outcome', async () => {
    const view = await mount(portWith({
      status: 'failed', canDecide: true, decidedAt: '2026-07-28T11:00:00.000Z', decisionNote: 'try it',
      error: { code: 'forbidden', message: 'not a member of the target space' },
    }));
    expect(view.queryByTestId('approval-decide')).toBeNull();
    expect(view.queryByTestId('approval-not-yours')).toBeNull();
    expect(view.getByTestId('approval-status').textContent).toBe('Approved · failed');
    expect(view.getByTestId('approval-note').textContent).toContain('try it');
    expect(view.getByTestId('approval-error').textContent).toContain('forbidden: not a member of the target space');
  });

  it('shows the refusal when a decision is refused, and keeps the buttons', async () => {
    const port = portWith();
    port.approve.mockRejectedValueOnce(new Error('Only a person can approve a request'));
    const view = await mount(port);
    fireEvent.click(view.getByTestId('approval-approve'));
    await waitFor(() => expect(view.getByTestId('approval-failed').textContent).toContain('Only a person'));
    expect(view.getByTestId('approval-approve')).toBeTruthy();
  });

  it('says the session that asked was not told when the outcome message failed, yet shows the decision', async () => {
    const port = portWith();
    const approve = port.approve.getMockImplementation()!;
    port.approve.mockImplementationOnce(async (id, note) => ({
      ...(await approve(id, note)),
      notified: false,
      notifyError: { code: 'forbidden', message: 'the session ended' },
    }));
    const view = await mount(port);
    fireEvent.click(view.getByTestId('approval-approve'));
    await waitFor(() => expect(view.getByTestId('approval-not-notified').textContent).toContain('the session ended'));
    expect(view.getByTestId('approval-status').textContent).toMatch(/^Approved/);
    expect(view.queryByTestId('approval-failed')).toBeNull();
  });

  it('says it is not wired, never draws dead buttons, without a port', async () => {
    const view = await mount(null);
    expect(view.getByTestId('approval-unwired')).toBeTruthy();
    expect(view.queryByTestId('approval-approve')).toBeNull();
  });
});
