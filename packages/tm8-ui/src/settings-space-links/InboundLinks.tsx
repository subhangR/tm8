/**
 * Settings → Space links → Links into this space (278, owner decision D2).
 * An admin of this space sees every link another space made INTO it, who holds
 * a sign-in on each, the calls made through it, and may revoke or restore it.
 * Creating a link needs no approval here; this is the oversight half.
 *
 * The server answers admins only. Anyone else is refused `forbidden`, and the
 * block then draws nothing: a member who cannot act on inbound links is not
 * shown an empty or broken section for them. Revoke and restore are human-only
 * like every link write; a refusal is drawn on the row it came from.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SpaceLinkInboundAuditEntry, SpaceLinkInboundView, SpaceLinkStatus } from '@tm8/contract';
import { shortDate } from '../kit/time';
import type { SpaceLinksInboundPort } from './port';

const HOLDER_STATUS: Record<SpaceLinkStatus, string> = {
  signed_in: 'signed in',
  signed_out: 'signed out',
  left: 'left this space',
  unreachable: 'unreachable',
};

function failureOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === 'forbidden' ? `Refused: ${message}` : message;
}

function homeName(link: SpaceLinkInboundView): string {
  return link.homeSpaceName ?? link.homeSpaceId;
}

export function InboundLinks({ port }: { port: SpaceLinksInboundPort }) {
  // undefined = reading; null = refused (not an admin): draw nothing.
  const [links, setLinks] = useState<SpaceLinkInboundView[] | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLinks(await port.list());
      setLoadError(null);
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'forbidden') setLinks(null);
      else setLoadError(failureOf(err));
    }
  }, [port]);

  useEffect(() => { void reload(); }, [reload]);

  if (links === null) return null;

  return (
    <div className="set-spl__inbound" data-testid="space-links-inbound">
      <h4 className="set-spl__subhead">Links into this space</h4>
      <p className="set-spl__lede">
        Other spaces linked to this one by members of both. Their agents act here as those members. As an admin
        you can see each link and the calls made through it, and revoke it: every sign-in on it ends and no one
        can sign in again until you restore it.
      </p>
      {notice ? (
        <div className="cred-notice" role="status" data-testid="space-links-inbound-notice">
          <span className="cred-notice__head">{notice}</span>
        </div>
      ) : null}
      {loadError ? (
        <p className="set-spl__fail" role="alert" data-testid="space-links-inbound-error">{loadError}</p>
      ) : null}
      {links === undefined && !loadError ? <p className="set-spl__muted">Reading…</p> : null}
      {links !== undefined && links.length === 0 ? (
        <p className="set-spl__muted" data-testid="space-links-inbound-empty">No other space links into this one.</p>
      ) : null}
      {links !== undefined && links.length > 0 ? (
        <ul className="set-spl__list">
          {links.map((link) => (
            <InboundRow
              key={link.id}
              link={link}
              port={port}
              onChanged={async (message) => { setNotice(message); await reload(); }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function InboundRow({
  link,
  port,
  onChanged,
}: {
  link: SpaceLinkInboundView;
  port: SpaceLinksInboundPort;
  onChanged(message: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [calls, setCalls] = useState<SpaceLinkInboundAuditEntry[] | null>(null);
  const name = homeName(link);
  const revoked = link.revokedAt !== null;

  async function run(act: () => Promise<unknown>, done: string) {
    setBusy(true);
    setFailure(null);
    try {
      await act();
      await onChanged(done);
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCalls() {
    if (calls !== null) { setCalls(null); return; }
    setFailure(null);
    try {
      setCalls(await port.audit(link.id));
    } catch (err) {
      setFailure(failureOf(err));
    }
  }

  const holders = link.holders.length === 0
    ? 'No member holds a sign-in'
    : link.holders.map((h) => `${h.displayName ?? 'A former member'} (${HOLDER_STATUS[h.status]})`).join(', ');

  return (
    <li className="set-spl__row" data-testid={`space-link-inbound-${link.id}`}>
      <div className="set-spl__row-head">
        <span className="set-spl__name">From {name}</span>
        <span className="set-spl__status" data-testid={`space-link-inbound-status-${link.id}`}>
          {revoked ? `Revoked ${shortDate(link.revokedAt as string)}` : 'Active'}
        </span>
      </div>
      <p className="set-spl__muted">
        {holders}
        {link.lastCallAt ? ` · last call ${shortDate(link.lastCallAt)}` : ' · no calls yet'}
      </p>
      <div className="set-spl__actions">
        <button type="button" className="cred-action" aria-label={`${calls ? 'Hide' : 'Show'} calls from ${name}`}
          aria-expanded={calls !== null} disabled={busy} onClick={() => void toggleCalls()}>
          {calls ? 'Hide calls' : 'Show calls'}
        </button>
        {revoked ? (
          <button type="button" className="cred-action" aria-label={`Restore the link from ${name}`} disabled={busy}
            onClick={() => void run(() => port.restore(link.id), `Restored the link from ${name}. Each member signs in again.`)}>
            Restore
          </button>
        ) : (
          <button type="button" className="cred-action" aria-label={`Revoke the link from ${name}`} disabled={busy}
            onClick={() => void run(() => port.revoke(link.id), `Revoked the link from ${name}. Every sign-in on it has ended.`)}>
            Revoke
          </button>
        )}
      </div>
      {calls !== null ? (
        calls.length === 0 ? (
          <p className="set-spl__muted" data-testid={`space-link-inbound-calls-${link.id}`}>No calls through this link.</p>
        ) : (
          <ul className="set-spl__calls" data-testid={`space-link-inbound-calls-${link.id}`}>
            {calls.map((c) => (
              <li key={c.id}>
                {shortDate(c.createdAt)} · {c.displayName ?? 'a former member'} · <code>{c.op}</code> · {c.result}
                {c.reason ? ` (${c.reason})` : ''}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {failure ? (
        <p className="set-spl__fail" role="alert" data-testid={`space-link-inbound-failure-${link.id}`}>{failure}</p>
      ) : null}
    </li>
  );
}
