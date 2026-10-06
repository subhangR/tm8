// @vitest-environment jsdom
/**
 * SPEC D1 §5.4 / §5.5 — the Terminate and Complete dialogs, as presentation
 * over a port. Scenarios 6, 7 and 13 of §9 are the UI half proved here; the
 * hook that performs the commands is pinned in `views/usePanelPrimaries.test`.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import {
  SessionCompleteDialog,
  SessionTerminateDialog,
  refusalOf,
  type SessionOutcomeFacts,
} from './SessionOutcomeDialogs';

const facts = (over: Partial<SessionOutcomeFacts> = {}): SessionOutcomeFacts => ({
  title: 'Fix the login bug',
  claims: [
    { taskId: 't-a', title: 'Task A', status: 'working' },
    { taskId: 't-b', title: 'Task B', status: 'in_review' },
  ],
  latestMessage: { id: 'm-1', body: 'Done: A merged, B in review.', author: 'Scout', createdAt: '2026-10-06T11:00:00Z' },
  ...over,
});

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

describe('§5.5 the Complete dialog', () => {
  it('prefills the latest message as the receipt and lists the claims with their status', async () => {
    const view = render(<SessionCompleteDialog load={async () => facts()} onComplete={vi.fn()} onCancel={vi.fn()} />);
    await settle();
    expect(view.getByTestId('session-receipt-latest').textContent).toContain('Done: A merged, B in review.');
    const claims = view.getAllByTestId('session-claim').map((li) => li.getAttribute('data-claim-status'));
    expect(claims).toEqual(['working', 'in_review']);
    // In review "ends with the receipt"; working must be dealt with first.
    expect(view.getByTestId('session-complete-dialog').textContent).toContain('in review · ends with the receipt');
  });

  it('scenario 7 — Complete is disabled while a claim is still working; Hand off releases it with a note', async () => {
    let current = facts();
    const onHandOff = vi.fn(async () => {
      current = facts({ claims: [{ taskId: 't-b', title: 'Task B', status: 'in_review' }] });
    });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionCompleteDialog load={async () => current} onComplete={onComplete} onHandOff={onHandOff} onCancel={vi.fn()} />,
    );
    await settle();
    const go = view.getByTestId('session-complete-dialog-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    fireEvent.click(view.getByRole('button', { name: 'Hand off' }));
    fireEvent.change(view.getByTestId('session-handoff-note'), { target: { value: 'Needs DB access' } });
    fireEvent.click(view.getByTestId('session-handoff-go'));
    await waitFor(() => expect(onHandOff).toHaveBeenCalledWith('t-a', 'Needs DB access'));
    await waitFor(() => expect((view.getByTestId('session-complete-dialog-go') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(view.getByTestId('session-complete-dialog-go'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ receiptMessageId: 'm-1', closeProcess: true }));
  });

  it('"Also close the process" is ticked by default (Q3) and can be unticked', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionCompleteDialog
        load={async () => facts({ claims: [] })}
        onComplete={onComplete}
        onCancel={vi.fn()}
      />,
    );
    await settle();
    const box = view.getByTestId('session-close-process') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(view.getByTestId('session-complete-dialog-go'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ receiptMessageId: 'm-1', closeProcess: false }));
  });

  it('scenario 13 — no message at all: a text box asks for the receipt, and nothing is sent until one is written', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <SessionCompleteDialog load={async () => facts({ claims: [], latestMessage: null })} onComplete={onComplete} onCancel={vi.fn()} />,
    );
    await settle();
    const go = view.getByTestId('session-complete-dialog-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(view.getByTestId('session-receipt-text'), { target: { value: 'Explored the logs; nothing to fix.' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      receiptText: 'Explored the logs; nothing to fix.',
      closeProcess: true,
    }));
  });

  it('shows the node’s claims_open refusal inline, keeps the dialog, and marks the tasks it names', async () => {
    const refusal = new CollabError('invariant_violation', 'claims open', {
      details: { reason: 'claims_open', tasks: [{ reason: 'claims_open', taskId: 't-c', title: 'Task C', status: 'working', claimStatus: 'working' }] },
    });
    const onComplete = vi.fn().mockRejectedValue(refusal);
    const view = render(
      <SessionCompleteDialog load={async () => facts({ claims: [] })} onComplete={onComplete} onCancel={vi.fn()} />,
    );
    await settle();
    fireEvent.click(view.getByTestId('session-complete-dialog-go'));
    const alert = await view.findByTestId('session-complete-dialog-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('data-reason')).toBe('claims_open');
    expect(view.getByTestId('session-complete-dialog').textContent).toContain('Task C');
    expect((view.getByTestId('session-complete-dialog-go') as HTMLButtonElement).disabled).toBe(true);
  });

  it('receipt_required from the node opens the text box', async () => {
    const onComplete = vi.fn().mockRejectedValue(
      new CollabError('invariant_violation', 'no receipt', { details: { reason: 'receipt_required' } }),
    );
    const view = render(<SessionCompleteDialog load={async () => facts({ claims: [] })} onComplete={onComplete} onCancel={vi.fn()} />);
    await settle();
    fireEvent.click(view.getByTestId('session-complete-dialog-go'));
    await view.findByTestId('session-receipt-text');
    expect(view.getByTestId('session-complete-dialog-error').getAttribute('data-reason')).toBe('receipt_required');
  });

  it('refusalOf reads details.reason and the task list', () => {
    const r = refusalOf(new CollabError('invariant_violation', 'x', {
      details: { reason: 'claims_open', tasks: [{ taskId: 't1', title: 'A', claimStatus: 'waiting' }] },
    }));
    expect(r).toMatchObject({ reason: 'claims_open', tasks: [{ taskId: 't1', title: 'A', status: 'waiting' }] });
    expect(refusalOf(new Error('boom'))).toMatchObject({ reason: null, message: 'boom' });
  });
});

describe('§5.4 the Terminate dialog (open session only)', () => {
  it('says the session has not completed and lists what it is working on', async () => {
    const view = render(
      <SessionTerminateDialog load={async () => facts()} onCompleteAndClose={vi.fn()} onStop={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    const dialog = view.getByTestId('session-terminate-dialog');
    expect(dialog.textContent).toContain('This session hasn’t completed.');
    expect(dialog.textContent).toContain('Task A');
    expect(dialog.textContent).toContain('Task B');
  });

  it('scenario 6 — Stop without completing calls onStop; a refusal stays in the dialog', async () => {
    const onStop = vi.fn()
      .mockRejectedValueOnce(new Error('node unreachable'))
      .mockResolvedValueOnce(undefined);
    const view = render(
      <SessionTerminateDialog load={async () => facts()} onCompleteAndClose={vi.fn()} onStop={onStop} onCancel={vi.fn()} />,
    );
    await settle();
    fireEvent.click(view.getByTestId('session-terminate-dialog-stop'));
    expect((await view.findByTestId('session-terminate-dialog-error')).textContent).toBe('node unreachable');
    fireEvent.click(view.getByTestId('session-terminate-dialog-stop'));
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(2));
  });

  it('Mark complete & close hands over to the Complete dialog; Cancel takes focus', async () => {
    const onCompleteAndClose = vi.fn();
    const view = render(
      <SessionTerminateDialog load={async () => facts()} onCompleteAndClose={onCompleteAndClose} onStop={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(view.getByTestId('session-terminate-dialog-complete'));
    expect(onCompleteAndClose).toHaveBeenCalledTimes(1);
  });
});
