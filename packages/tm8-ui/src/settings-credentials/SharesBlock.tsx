/**
 * SC-8 — Sharing, in Settings → Agent credentials: the member's OWN
 * credentials they have shared into a space, and the one control that shares
 * from here, their GitHub token.
 *
 * BY REFERENCE. Sharing the token sends a label, never the token: the space
 * row points at the member's own stored token, so a rotate here reaches every
 * space it is shared to and a disconnect ends every share. Only a FINE-GRAINED
 * token can be shared (`github_pat_…`, checked on the server when sharing and
 * again at every spawn); the screen says which kind is stored and why another
 * kind is refused.
 *
 * A Claude or Codex login is shared from Space credentials ("+ Share my
 * login") — a fresh sign-in with its own terminal, so the member's personal
 * login home is never given to the space. It is LISTED here with the rest.
 *
 * STOP SHARING is the space credential delete: it revokes the share and ends
 * every live session running on it, whoever launched it.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CredentialsSharesView, SpaceCredentialShareView } from '@tm8/contract';
import type { SharesPort } from './port';
import { SPACE_PROVIDER_NAME } from './space-credentials-model';
import './credentials.css';
import './space-credentials.css';

export interface SharesBlockProps {
  port: SharesPort;
}

export function SharesBlock({ port }: SharesBlockProps) {
  const [view, setView] = useState<CredentialsSharesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await port.load());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [port]);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (next) => { if (live) { setView(next); setError(null); } },
      (err: unknown) => { if (live) setError(messageOf(err)); },
    );
    return () => { live = false; };
  }, [port]);

  const sharedHere = view?.shares.some(
    (s) => s.provider === 'github' && s.spaceId === port.spaceId && s.status !== 'revoked',
  ) ?? false;

  return (
    <section className="cred-block cred-share" data-testid="shares-block" aria-labelledby="shares-title">
      <h4 className="cred-svc__title" id="shares-title">Sharing</h4>
      <p className="cred-intro">
        Share one of your own credentials with a space. Members there can launch on it by naming it; it is
        never a space default, it runs as you, on your account and plan, and only you can change it.
      </p>
      {error ? (
        <div className="cred-notice" role="alert" data-testid="shares-error">
          <span className="cred-notice__head">Your shares could not be read.</span>
          <span className="cred-notice__why">{error}</span>
        </div>
      ) : null}
      {notice ? (
        <span className="cred-svc__note" role="status" data-testid="shares-notice">{notice}</span>
      ) : null}
      {view ? (
        <ShareTokenCard
          view={view}
          sharedHere={sharedHere}
          port={port}
          onShared={async (label) => { setNotice(`Shared your GitHub token to this space as “${label}”.`); await reload(); }}
        />
      ) : null}
      {view && view.shares.length > 0 ? (
        <ul className="cred-share__list" data-testid="shares-list">
          {view.shares.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              port={port}
              onStopped={async (ended) => {
                setNotice(
                  `Stopped sharing “${share.label}” with ${share.spaceName}.`
                  + (ended > 0 ? ` ${ended} live session${ended === 1 ? '' : 's'} on it ${ended === 1 ? 'was' : 'were'} ended.` : ''),
                );
                await reload();
              }}
            />
          ))}
        </ul>
      ) : view ? (
        <p className="cred-intro" data-testid="shares-empty">You share nothing with any space.</p>
      ) : null}
      <p className="cred-intro">
        To share a Claude or Codex login, use “+ Share my login” under Space credentials: it opens a fresh
        sign-in for the space, and your own login here is left alone.
      </p>
    </section>
  );
}

/** What can be said about sharing the stored GitHub token. Never quotes it (I5). */
export function shareTokenSentence(github: CredentialsSharesView['github']): string {
  if (!github.connected) return 'Connect GitHub above first: a share points at your own stored token.';
  const as = github.login ? ` (as @${github.login})` : '';
  switch (github.tokenKind) {
    case 'fine_grained':
      return `Your fine-grained token${as} can be shared. A launch that names the share pushes and commits as you.`;
    case 'classic':
      return `Your GitHub token${as} is a classic token, which reaches every repository you can. Only a fine-grained token can be shared: connect one scoped to the repositories this space needs.`;
    case 'oauth':
      return `Your GitHub login${as} is an OAuth token from gh, which reaches every repository you can. Only a fine-grained token can be shared: connect one scoped to the repositories this space needs.`;
    default:
      return `Your GitHub token${as} is not a kind this node recognises. Only a fine-grained token (github_pat_…) can be shared.`;
  }
}

function ShareTokenCard({ view, sharedHere, port, onShared }: {
  view: CredentialsSharesView;
  sharedHere: boolean;
  port: SharesPort;
  onShared(label: string): Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { github } = view;

  async function share(event: FormEvent) {
    event.preventDefault();
    const clean = label.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      await port.shareToken(clean);
      setLabel('');
      await onShared(clean);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="cred-card cred-share__card" data-testid="share-token-card">
      <header className="cred-card__head">
        <span className="cred-card__name">GitHub token</span>
        {github.tokenKind ? (
          <code className="cred-card__binary" data-testid="share-token-kind">{github.tokenKind.replace('_', '-')}</code>
        ) : null}
      </header>
      <p className="cred-card__routing" data-testid="share-token-sentence">{shareTokenSentence(github)}</p>
      {github.shareable && sharedHere ? (
        <p className="cred-card__routing" data-testid="share-token-already">You already share it with this space.</p>
      ) : null}
      {github.shareable && !sharedHere ? (
        <form className="cred-svc__form" onSubmit={(event) => void share(event)}>
          <label className="cred-svc__label" htmlFor="share-token-label">Label in this space</label>
          <input
            id="share-token-label"
            className="cred-svc__input"
            data-testid="share-token-label"
            placeholder="e.g. Ada’s GitHub"
            maxLength={80}
            value={label}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
          />
          <div className="cred-card__actions">
            <button
              type="submit"
              className="cred-action cred-action--primary"
              disabled={busy || label.trim() === ''}
              data-testid="share-token-submit"
            >
              {busy ? 'Sharing…' : 'Share to this space'}
            </button>
          </div>
          <span className="cred-svc__note">
            Anyone in this space can launch on it. Commits and pushes made with it carry your name.
          </span>
        </form>
      ) : null}
      {error ? (
        <span className="cred-svc__note cred-svc__note--error" role="alert" data-testid="share-token-error">{error}</span>
      ) : null}
    </article>
  );
}

function ShareRow({ share, port, onStopped }: {
  share: SpaceCredentialShareView;
  port: SharesPort;
  onStopped(sessionsEnded: number): Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const result = await port.unshare(share.id);
      await onStopped(result.terminatedAgentSessionIds.length + result.terminatedLoginSessionIds.length);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="cred-share__row" data-testid={`share-row-${share.id}`}>
      <span className="cred-card__name">{share.label}</span>
      <span className="cred-card__binary">
        {SPACE_PROVIDER_NAME[share.provider]} · shared to {share.spaceName}
        {share.status === 'pending' ? ' · sign-in not finished' : share.status === 'stale' ? ' · failed its last check' : ''}
      </span>
      <div className="cred-card__actions">
        {confirming ? (
          <>
            <button type="button" className="cred-action set-spc__danger" disabled={busy}
              aria-label={`Confirm stop sharing ${share.label}`} data-testid={`share-stop-confirm-${share.id}`}
              onClick={() => void stop()}>
              Stop sharing, and end sessions using it
            </button>
            <button type="button" className="cred-action" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="cred-action" aria-label={`Stop sharing ${share.label}`}
            data-testid={`share-stop-${share.id}`} onClick={() => setConfirming(true)}>
            Stop sharing
          </button>
        )}
      </div>
      {error ? <span className="cred-svc__note cred-svc__note--error" role="alert">{error}</span> : null}
    </li>
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
