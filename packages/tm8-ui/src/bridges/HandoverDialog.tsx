import { useEffect, useRef, useState } from 'react';
import type { BridgeConnectionView, BridgeHandoverResult, BridgeView } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { bridgeProviderLabel } from './bridge-marks';
import { bridgeFailureOf } from './format';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OTHER = 'other';

/**
 * Hand a bridge over to another number (D55, D56): `bridges.handover.offer`.
 * The receiving number is one of the viewer's own linked numbers, or another
 * member's, named by its connection id (they copy it from Settings → Bridges →
 * Accounts). Nothing moves here: the receiver accepts in tm8, and only they can.
 * Who may offer, and whether the receiver is in the space, is the server's answer.
 */
export function HandoverDialog({
  bridge,
  port,
  onClose,
  onOffered,
}: {
  bridge: BridgeView;
  port: Pick<BridgesPort, 'handover' | 'connections'>;
  onClose(): void;
  onOffered(result: BridgeHandoverResult): void;
}) {
  const [mine, setMine] = useState<BridgeConnectionView[] | null>(null);
  const [choice, setChoice] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useDismissable(true, dialog, () => { if (!busy) onClose(); });
  useEffect(() => {
    let live = true;
    void port.connections.list().then(
      (items) => {
        if (!live) return;
        /* A bridge moves only to a linked number of its own provider, and not onto the one it rides. */
        const usable = items.filter((c) => c.provider === bridge.provider && c.status === 'linked' && c.id !== bridge.connectionId);
        setMine(usable);
        setChoice(usable[0]?.id ?? OTHER);
      },
      () => { if (live) { setMine([]); setChoice(OTHER); } },
    );
    return () => { live = false; };
  }, [port, bridge.provider, bridge.connectionId]);

  const provider = bridgeProviderLabel(bridge.provider);
  const toConnectionId = choice === OTHER ? pasted.trim() : choice;
  const ready = UUID.test(toConnectionId) && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      onOffered(await port.handover.offer(bridge.id, toConnectionId));
    } catch (err) {
      setError(bridgeFailureOf(err));
      setBusy(false);
    }
  };

  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog" role="dialog" aria-modal="true" aria-label={`Hand over the ${bridge.title} bridge`}>
        <h2 className="brg-dialog__title">Hand over the {bridge.title} bridge?</h2>
        <ul className="brg-dialog__list">
          <li>The bridge moves onto another {provider} number. It keeps its history, handles, routing and loops.</li>
          <li>Nothing moves yet: the number’s owner accepts in tm8, and that number must already be in the {bridge.conversation.kind === 'dm' ? 'conversation' : bridge.conversation.kind}.</li>
          <li>Until then it keeps running on this number. You can withdraw the offer.</li>
        </ul>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <fieldset className="brg-choice" disabled={busy}>
            <legend>Hand it to</legend>
            {mine === null ? <p className="brg-hint" role="status">Reading your numbers…</p> : null}
            {(mine ?? []).map((c) => (
              <label key={c.id} className="brg-choice__opt">
                <input type="radio" name="handover-to" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                {c.label} <span className="brg-muted">{c.externalAccountId ?? ''} · your number</span>
              </label>
            ))}
            {mine !== null ? (
              <label className="brg-choice__opt">
                <input type="radio" name="handover-to" checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
                Another member’s number
              </label>
            ) : null}
          </fieldset>
          {choice === OTHER && mine !== null ? (
            <label className="brg-dialog__confirm">
              <span>Their connection id <span className="brg-muted">(Settings → Bridges → Accounts → ⋯ → Copy connection id)</span></span>
              <input
                type="text"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                aria-label="Their connection id"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          ) : null}
          {choice === OTHER && pasted.trim() && !UUID.test(pasted.trim()) ? (
            <p className="brg-hint" role="status">A connection id looks like 0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494.</p>
          ) : null}
          {error ? <p className="brg-error" role="alert">{error}</p> : null}
          <div className="brg-dialog__actions">
            <button type="button" className="pn-btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="pn-btn pn-btn--primary" disabled={!ready}>
              {busy ? 'Offering…' : 'Offer hand-over'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
