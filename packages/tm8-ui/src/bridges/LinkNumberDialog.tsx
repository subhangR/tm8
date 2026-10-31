import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeConnectionAuthFrame, BridgeConnectionView } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { bridgeFailureOf } from './format';

/**
 * LINK A WHATSAPP NUMBER (BRIDGE-ENTITY-DESIGN §4.2, BRIDGES-V2-DESIGN §1.6).
 *
 * `bridges.connections.begin` asks the runtime to connect; the QR or pairing
 * code then arrives on THIS member's own socket (`bridge.connection.auth`) and
 * is never in a response, never stored, never logged. It lives in this
 * component's state until the dialog closes. The dialog says what Phase 1's
 * `link.sh` said in a terminal: which phone, where in WhatsApp to tap, and
 * that the code lasts about two minutes.
 *
 * Linked is read back from `connections.list` (the runtime's own word), polled
 * while the dialog waits; there is no client-side notion of success.
 */
export function LinkNumberDialog({
  port,
  spaceId,
  relink,
  onClose,
  onLinked,
}: {
  port: Pick<BridgesPort, 'connections' | 'onConnectionAuth'>;
  spaceId: string;
  /** Relink this connection instead of linking a new number. */
  relink?: BridgeConnectionView | null;
  onClose(): void;
  onLinked(connection: BridgeConnectionView): void;
}) {
  const [flow, setFlow] = useState<'qr' | 'pairing'>('qr');
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState(relink?.label ?? '');
  const [offerHere, setOfferHere] = useState(true);
  const [pending, setPending] = useState<BridgeConnectionView | null>(null);
  const [frame, setFrame] = useState<BridgeConnectionAuthFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dialog = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useDismissable(true, dialog, close);

  /* The code is pushed, not answered, and it can arrive BEFORE begin answers:
     the server arms the relay before it asks the runtime to connect, and a
     pairing code comes once. So listen from mount, keep the latest frame per
     connection, and take the pending one's as soon as begin says which it is
     (review #1447 r1). Nothing leaves this component's state. */
  const frames = useRef(new Map<string, BridgeConnectionAuthFrame>());
  const pendingId = useRef<string | null>(null);
  useEffect(() => {
    if (!port.onConnectionAuth) return;
    return port.onConnectionAuth((f) => {
      frames.current.set(f.connectionId, f);
      if (f.connectionId === pendingId.current) setFrame(f);
    });
  }, [port]);
  useEffect(() => {
    pendingId.current = pending?.id ?? null;
    if (pending) setFrame(frames.current.get(pending.id) ?? null);
  }, [pending]);

  /* Wait for the runtime to say linked. */
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const tick = setInterval(() => {
      setNow(Date.now());
      void port.connections.list().then(async (rows) => {
        const row = rows.find((r) => r.id === pending.id);
        if (!live || !row || row.status !== 'linked') return;
        live = false;
        clearInterval(tick);
        try {
          const offered = offerHere && !row.offers.some((o) => o.spaceId === spaceId)
            ? (await port.connections.offer(row.id, spaceId)).connection
            : row;
          onLinked(offered);
        } catch (err) {
          setError(`Linked, but offering it to this space was refused: ${bridgeFailureOf(err)}`);
        }
      }, () => {});
    }, 1500);
    return () => { live = false; clearInterval(tick); };
  }, [pending, port, offerHere, spaceId, onLinked]);

  const phoneOk = /^\+?[0-9]{6,20}$/.test(phone.replace(/[\s-]/g, ''));
  const begin = async () => {
    setBusy(true);
    setError(null);
    setFrame(null);
    frames.current.clear();
    try {
      const result = await port.connections.begin({
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(relink ? { connectionId: relink.id } : {}),
        authFlow: flow === 'pairing' ? { kind: 'pairing', phone: phone.replace(/[\s-]/g, '') } : { kind: 'qr' },
      });
      if (result.runtime === 'offline') {
        setError('No WhatsApp runtime is running on this node, so nothing can link yet. Start it, then try again.');
      } else {
        setPending(result.connection);
      }
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(false);
    }
  };

  const left = frame ? Math.max(0, Math.round((Date.parse(frame.expiresAt) - now) / 1000)) : null;
  const title = relink ? `Re-link ${relink.label}` : 'Link a WhatsApp number';
  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog brg-linkdlg" role="dialog" aria-modal="true" aria-label={title} data-testid="bridge-link-number">
        <h2 className="brg-dialog__title">{title}</h2>
        {!pending ? (
          <form onSubmit={(event) => { event.preventDefault(); void begin(); }}>
            <fieldset className="brg-choice" disabled={busy}>
              <legend className="set-eyebrow">How will you link the number?</legend>
              <label className="brg-choice__opt">
                <input type="radio" name="flow" checked={flow === 'qr'} onChange={() => setFlow('qr')} />
                <span>Scan a QR code with the phone that has the number</span>
              </label>
              <label className="brg-choice__opt">
                <input type="radio" name="flow" checked={flow === 'pairing'} onChange={() => setFlow('pairing')} />
                <span>Can't scan? Get a code to type into WhatsApp on that phone</span>
              </label>
            </fieldset>
            {flow === 'pairing' ? (
              <label className="brg-form__line">
                <span>Number</span>
                <input type="tel" value={phone} placeholder="+91 98xxx xxx94" aria-label="Phone number" onChange={(e) => setPhone(e.target.value)} />
              </label>
            ) : null}
            {!relink ? (
              <label className="brg-form__line">
                <span>Name it</span>
                <input type="text" value={label} placeholder="Work phone" aria-label="Number label" maxLength={80} onChange={(e) => setLabel(e.target.value)} />
              </label>
            ) : null}
            <label className="brg-form__line">
              <input type="checkbox" checked={offerHere} onChange={(e) => setOfferHere(e.target.checked)} />
              {' '}Offer it to this space once it is linked
            </label>
            <p className="brg-hint">
              The number is yours: only you see its groups, and it reads a group only after you connect that group.
            </p>
            {error ? <p className="brg-error" role="alert">{error}</p> : null}
            <div className="brg-dialog__actions">
              <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="pn-btn pn-btn--primary" disabled={busy || (flow === 'pairing' && !phoneOk)}>
                {busy ? 'Asking…' : flow === 'pairing' ? 'Get a code' : 'Show the QR code'}
              </button>
            </div>
          </form>
        ) : (
          <div className="brg-link__wait" data-testid="bridge-link-wait">
            {frame?.qrPng ? (
              <>
                <ol className="brg-dialog__list">
                  <li>On the phone with the number, open WhatsApp → Settings → Linked devices → Link a device.</li>
                  <li>Point the phone at this code.</li>
                </ol>
                <img className="brg-link__qr" src={`data:image/png;base64,${frame.qrPng}`} alt="WhatsApp link QR code" />
              </>
            ) : frame?.pairingCode ? (
              <>
                <ol className="brg-dialog__list">
                  <li>WhatsApp → Settings → Linked devices → Link a device.</li>
                  <li>Tap “Link with phone number instead”.</li>
                  <li>Enter this code:</li>
                </ol>
                <p className="brg-link__code" data-testid="bridge-link-code">{frame.pairingCode}</p>
                <button type="button" className="pn-btn" onClick={() => void navigator.clipboard?.writeText(frame.pairingCode ?? '')}>Copy</button>
              </>
            ) : (
              <p className="brg-hint" role="status">
                {port.onConnectionAuth ? 'Waiting for WhatsApp to send a code…' : 'This screen has no live connection to the node, so the code cannot be shown here.'}
              </p>
            )}
            {left !== null ? (
              <p className="brg-hint" role="status">
                {left > 0 ? `The code lasts about two minutes: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left.` : 'This code has expired; WhatsApp sends a fresh one while the dialog stays open.'}
              </p>
            ) : null}
            <p className="brg-hint" role="status">◌ waiting for WhatsApp to link…</p>
            {error ? <p className="brg-error" role="alert">{error}</p> : null}
            <div className="brg-dialog__actions">
              <button type="button" className="pn-btn" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
