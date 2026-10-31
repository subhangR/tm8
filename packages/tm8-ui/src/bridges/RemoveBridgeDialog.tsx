import { useEffect, useRef, useState } from 'react';
import { bridgeProviderLabel } from './bridge-marks';
import type { BridgeView } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { TARGET_WORD, bridgeFailureOf } from './format';

/**
 * Remove a bridge (BRIDGES-V2-DESIGN §1.3): a typed-name confirm that says
 * what happens to everything hanging off it before it happens. `bridges.remove`
 * is human-only and leaves an `ended` tombstone; the provider conversation is
 * never touched.
 */
export function RemoveBridgeDialog({
  bridge,
  port,
  onClose,
  onRemoved,
}: {
  bridge: BridgeView;
  port: Pick<BridgesPort, 'remove' | 'memories'>;
  onClose(): void;
  onRemoved(view: BridgeView): void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [memories, setMemories] = useState<number | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useDismissable(true, dialog, () => { if (!busy) onClose(); });
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('input')?.focus(); }, []);
  useEffect(() => {
    let live = true;
    void port.memories(bridge.id).then((edges) => { if (live) setMemories(edges.length); }, () => {});
    return () => { live = false; };
  }, [port, bridge.id]);

  const provider = bridgeProviderLabel(bridge.provider);
  const matches = typed.trim() === bridge.title.trim();
  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError('');
    try {
      onRemoved(await port.remove(bridge.id, bridge.version));
    } catch (err) {
      setError(bridgeFailureOf(err));
      setBusy(false);
    }
  };

  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog" role="dialog" aria-modal="true" aria-label={`Remove the ${bridge.title} bridge`}>
        <h2 className="brg-dialog__title">Remove the {bridge.title} bridge?</h2>
        <ul className="brg-dialog__list">
          <li>The {provider} {bridge.conversation.kind === 'dm' ? 'conversation' : bridge.conversation.kind} is not touched. tm8 stops reading and writing it.</li>
          <li>Logged messages stay here, read-only.</li>
          <li>Loops that post here will be turned off; you can point them elsewhere later.</li>
          <li>
            {memories === null
              ? 'Linked memories stay in the space, unlinked from this bridge.'
              : `${memories} ${memories === 1 ? 'memory is' : 'memories are'} linked: they stay in the space, unlinked from this bridge.`}
          </li>
          <li>Workers started here keep running; they just can't post to {provider} any more.</li>
          <li>{bridge.target.title} ({TARGET_WORD[bridge.target.kind]}) stops getting this {bridge.conversation.kind === 'dm' ? 'conversation' : bridge.conversation.kind}.</li>
        </ul>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="brg-dialog__confirm">
            <span>Type <strong>{bridge.title}</strong> to confirm</span>
            <input
              type="text"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label={`Type ${bridge.title} to confirm`}
              disabled={busy}
            />
          </label>
          {error ? <p className="brg-error" role="alert">{error}</p> : null}
          <div className="brg-dialog__actions">
            <button type="button" className="pn-btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="pn-btn brg-btn--danger" disabled={!matches || busy}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
