/**
 * Service keys in Settings → Agent credentials: keys the SERVER uses for this
 * member. Today one row, TypeSafe · Jev, the key ✦ Ask Jev spends.
 *
 * It sits in the agent credentials section because that is where a member
 * looks for "my keys", but it is deliberately NOT a provider card above it:
 * there is no login terminal, nothing to probe, no session carrying it, and it
 * is never handed to an agent. The copy says so.
 *
 * THE KEY IS PASTED HERE, sent once in the save request, and then forgotten by
 * this screen: the field is cleared on success and the server answers only the
 * last four characters.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  CredentialsServiceKeysStatusView,
  ServiceKeyProviderName,
  ServiceKeyView,
} from '@tm8/contract';
import type { ServiceKeysPort } from './port';
import './credentials.css';

interface ServiceKeyPresentation {
  name: string;
  /** What the key is for, in one sentence the member reads before pasting. */
  purpose: string;
  placeholder: string;
}

export const SERVICE_KEY_PRESENTATIONS: Record<ServiceKeyProviderName, ServiceKeyPresentation> = {
  typesafe: {
    name: 'TypeSafe · Jev',
    purpose: 'Used only when you press ✦ Ask Jev on a launch. It is never given to an agent you launch.',
    placeholder: 'Paste your TypeSafe API key',
  },
};

export interface ServiceKeysBlockProps {
  port: ServiceKeysPort;
}

export function ServiceKeysBlock({ port }: ServiceKeysBlockProps) {
  const [status, setStatus] = useState<CredentialsServiceKeysStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (next) => { if (live) { setStatus(next); setLoadError(null); } },
      (err: unknown) => { if (live) setLoadError(messageOf(err)); },
    );
    return () => { live = false; };
  }, [port]);

  const replace = useCallback((view: ServiceKeyView) => {
    setStatus((prev) => prev && {
      ...prev,
      keys: prev.keys.map((key) => (key.provider === view.provider ? view : key)),
    });
  }, []);

  return (
    <section className="cred-block cred-svc" data-testid="service-keys-block" aria-labelledby="service-keys-title">
      <h4 className="cred-svc__title" id="service-keys-title">Service keys</h4>
      <p className="cred-intro">
        Keys tm8 uses on the server, for you alone. Unlike the logins above, an agent you
        launch never receives them.
      </p>
      {loadError ? (
        <div className="cred-notice" role="alert" data-testid="service-keys-error">
          <span className="cred-notice__head">Service keys could not be read.</span>
          <span className="cred-notice__why">{loadError}</span>
        </div>
      ) : null}
      {status?.keys.map((view) => (
        <ServiceKeyCard
          key={view.provider}
          view={view}
          store={status.store}
          port={port}
          onChanged={replace}
        />
      ))}
    </section>
  );
}

function ServiceKeyCard({ view, store, port, onChanged }: {
  view: ServiceKeyView;
  store: 'present' | 'absent';
  port: ServiceKeysPort;
  onChanged(view: ServiceKeyView): void;
}) {
  const presentation = SERVICE_KEY_PRESENTATIONS[view.provider];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const tone = store === 'absent' ? 'unknown' : view.connected ? 'connected' : 'disconnected';
  const showForm = store === 'present' && (!view.connected || editing);

  async function save(event: FormEvent) {
    event.preventDefault();
    const apiKey = draft.trim();
    if (!apiKey) return;
    setBusy(true);
    setError(null);
    try {
      const next = await port.save(view.provider, apiKey);
      setDraft('');
      setEditing(false);
      setSaved(true);
      onChanged(next);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await port.remove(view.provider);
      onChanged({ ...view, connected: false, keyHint: null, updatedAt: null });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`cred-card cred-svc__card cred-card--${tone}`}
      data-testid={`service-key-card-${view.provider}`}
      data-credential-state={tone}
    >
      <header className="cred-card__head">
        <span className="cred-card__mark cred-svc__mark" aria-hidden="true">✦</span>
        <span className="cred-card__name">{presentation.name}</span>
        <code className="cred-card__binary">service key</code>
      </header>

      <div className="cred-card__state" data-testid={`service-key-state-${view.provider}`}>
        <span>{stateSentence(view, store)}</span>
      </div>

      <p className="cred-card__routing" data-testid={`service-key-purpose-${view.provider}`}>
        {presentation.purpose}
      </p>

      {view.connected && view.updatedAt ? (
        <div className="cred-card__account">
          <span>Saved</span>
          <span className="cred-card__account-value">{view.updatedAt}</span>
        </div>
      ) : null}

      {showForm ? (
        <form className="cred-svc__form" onSubmit={(event) => void save(event)}>
          <label className="cred-svc__label" htmlFor={`service-key-input-${view.provider}`}>
            {view.connected ? 'New key' : 'API key'}
          </label>
          <input
            id={`service-key-input-${view.provider}`}
            className="cred-svc__input"
            data-testid={`service-key-input-${view.provider}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={presentation.placeholder}
            value={draft}
            disabled={busy}
            onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
          />
          <div className="cred-card__actions">
            <button
              type="submit"
              className="cred-action cred-action--primary"
              disabled={busy || draft.trim() === ''}
              data-testid={`service-key-save-${view.provider}`}
            >
              {busy ? 'Saving…' : 'Save key'}
            </button>
            {editing ? (
              <button
                type="button"
                className="cred-action"
                disabled={busy}
                onClick={() => { setEditing(false); setDraft(''); setError(null); }}
                data-testid={`service-key-cancel-${view.provider}`}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : store === 'present' ? (
        <div className="cred-card__actions">
          <button
            type="button"
            className="cred-action cred-action--primary"
            disabled={busy}
            onClick={() => { setEditing(true); setSaved(false); }}
            data-testid={`service-key-replace-${view.provider}`}
          >
            Replace
          </button>
          <button
            type="button"
            className="cred-action"
            disabled={busy}
            onClick={() => void remove()}
            data-testid={`service-key-remove-${view.provider}`}
          >
            Remove
          </button>
        </div>
      ) : null}

      {saved ? (
        <span className="cred-svc__note" role="status" data-testid={`service-key-saved-${view.provider}`}>
          Saved. Your next ✦ Ask Jev uses this key.
        </span>
      ) : null}
      {error ? (
        <span className="cred-svc__note cred-svc__note--error" role="alert" data-testid={`service-key-error-${view.provider}`}>
          {error}
        </span>
      ) : null}
    </article>
  );
}

/** One sentence per state. Only ever the hint — the key itself never reaches this screen. */
export function stateSentence(view: ServiceKeyView, store: 'present' | 'absent'): string {
  if (store === 'absent') return 'Unknown: this node cannot store service keys yet.';
  if (view.connected) return view.keyHint ? `Your key is saved, ending in ${view.keyHint}.` : 'Your key is saved.';
  return view.nodeFallback
    ? 'No key of your own. ✦ Ask Jev uses this node’s shared key until you add one.'
    : 'No key saved. ✦ Ask Jev is off until you add one.';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
