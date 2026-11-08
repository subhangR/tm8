import { useState } from 'react';
import type { BridgeHandoverResult } from '@tm8/contract';
import type { BridgesPort, PendingHandover } from './api';
import { bridgeFailureOf } from './format';

type Verb = 'accept' | 'decline' | 'withdraw';
const DONE: Record<Verb, string> = {
  accept: 'Handed over. The bridge now rides your number.',
  decline: 'Declined. The bridge stays on its number.',
  withdraw: 'Offer withdrawn. The bridge stays on its number.',
};

/**
 * An open hand-over offer on this bridge (D55, D56), drawn above the tabs.
 * The page cannot tell who is looking, so it offers every verb and the server
 * answers who may: Accept and Decline are the receiver's, Withdraw is the
 * offerer's, the connection owner's or an admin's. Accept asks once more,
 * because it moves the bridge onto the receiver's number at once.
 */
export function HandoverBanner({
  pending,
  port,
  onSettled,
}: {
  pending: PendingHandover;
  port: Pick<BridgesPort, 'handover'>;
  onSettled(result: BridgeHandoverResult, note: string): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<Verb | null>(null);
  const [error, setError] = useState('');
  const act = async (verb: Verb) => {
    setBusy(verb);
    setError('');
    try {
      const result = await port.handover[verb](pending.handoverId);
      const moved = verb === 'accept' && result.readdressed
        ? ` ${result.readdressed} waiting ${result.readdressed === 1 ? 'message goes' : 'messages go'} out on it.`
        : '';
      onSettled(result, DONE[verb] + moved);
    } catch (err) {
      setError(bridgeFailureOf(err));
      setBusy(null);
      setConfirming(false);
    }
  };
  return (
    <section className="brg-handover" role="region" aria-label="Hand-over offer" data-testid="bridge-handover">
      <p className="brg-handover__text">
        <strong>Hand-over offered.</strong> {pending.summary || `${pending.offeredBy.displayName} offers to move this bridge to another number.`}
      </p>
      {confirming ? (
        <div className="brg-handover__actions">
          <span className="brg-handover__ask">Move it onto your number now? Anything still waiting to send goes out on your number.</span>
          <button type="button" className="pn-btn pn-btn--primary" disabled={busy !== null} onClick={() => void act('accept')}>
            {busy === 'accept' ? 'Moving…' : 'Move it'}
          </button>
          <button type="button" className="pn-btn" disabled={busy !== null} onClick={() => setConfirming(false)}>Not yet</button>
        </div>
      ) : (
        <div className="brg-handover__actions">
          <button type="button" className="pn-btn pn-btn--primary" disabled={busy !== null} onClick={() => setConfirming(true)}>Accept…</button>
          <button type="button" className="pn-btn" disabled={busy !== null} onClick={() => void act('decline')}>
            {busy === 'decline' ? 'Declining…' : 'Decline'}
          </button>
          <button type="button" className="pn-btn" disabled={busy !== null} onClick={() => void act('withdraw')}>
            {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw offer'}
          </button>
        </div>
      )}
      {error ? <p className="brg-error" role="alert">{error}</p> : null}
    </section>
  );
}
