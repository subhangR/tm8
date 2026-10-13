/**
 * Settings → Space links → Grant access (W9c, on the TARGET server). A member
 * of this space lets a space on ANOTHER server act here as them: the server
 * answers a single-use pairing code, which they paste into Sign in on the
 * other server's link. Only the code's hash is stored, so it is shown once.
 *
 * Human-only like every link write; with remote links off on this node the
 * server refuses `space_link_remote_disabled`, drawn in plain words.
 */
import { useState, type FormEvent } from 'react';
import type { SpaceLinksInboundGrantResult } from '@tm8/contract';
import { shortDate } from '../kit/time';
import { spaceLinkFailureOf } from './SpaceLinksSection';
import type { SpaceLinksInboundPort } from './port';

export function GrantAccess({ grant }: { grant: NonNullable<SpaceLinksInboundPort['grant']> }) {
  const [homeSpaceId, setHomeSpaceId] = useState('');
  const [label, setLabel] = useState('');
  const [allowSpawn, setAllowSpawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [granted, setGranted] = useState<SpaceLinksInboundGrantResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const home = homeSpaceId.trim();
    if (!home) return;
    setBusy(true);
    setFailure(null);
    setGranted(null);
    try {
      setGranted(await grant(home, {
        ...(label.trim() ? { homeLabel: label.trim() } : {}),
        ...(allowSpawn ? { allowSpawn: true } : {}),
      }));
      setHomeSpaceId('');
      setLabel('');
      setAllowSpawn(false);
    } catch (err) {
      setFailure(spaceLinkFailureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="set-spl__grant" data-testid="space-links-grant">
      <h4 className="set-spl__subhead">Grant access to a space on another server</h4>
      <p className="set-spl__lede">
        Someone linked a space on another tm8 server to this one? Make a pairing code here and paste it into
        Sign in on their link. Agents working for you there can then act in this space as you.
      </p>
      <form className="set-spl__add" onSubmit={(e) => void submit(e)}>
        <input className="set-spl__input" aria-label="Home space id on the other server"
          placeholder="the linking space's id on the other server" value={homeSpaceId} disabled={busy}
          onChange={(e) => setHomeSpaceId(e.currentTarget.value)} />
        <input className="set-spl__input" aria-label="Label for the other server" placeholder="label, e.g. tm8 on laptop"
          value={label} disabled={busy} onChange={(e) => setLabel(e.currentTarget.value)} />
        <label className="set-spl__spawn">
          <input type="checkbox" aria-label="Allow spawn from the other server" checked={allowSpawn} disabled={busy}
            onChange={(e) => setAllowSpawn(e.currentTarget.checked)} />
          Allow spawn
        </label>
        <button type="submit" className="cred-action cred-action--primary" aria-label="Make pairing code"
          disabled={busy || !homeSpaceId.trim()}>
          Make pairing code
        </button>
      </form>
      {granted ? (
        <div className="cred-notice" role="status" data-testid="space-links-grant-code">
          <span className="cred-notice__head">
            Pairing code (single use, until {shortDate(granted.pairingExpiresAt)}):{' '}
            <code className="set-spl__code">{granted.pairingCode}</code>
          </span>
          <span>It is shown once. Paste it into Sign in on the link on the other server.</span>
        </div>
      ) : null}
      {failure ? <p className="set-spl__fail" role="alert" data-testid="space-links-grant-failure">{failure}</p> : null}
    </div>
  );
}
