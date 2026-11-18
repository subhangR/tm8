import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeConnectionView } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { bridgeFailureOf } from './format';
import {
  SLACK_SETUP_GUIDE_PATH, SLACK_SETUP_GUIDE_URL, SLACK_TOKEN_HELP,
  missingScopeLines, slackAccountLine, slackRefusalWords, slackTokenProblem,
} from './slack';

/**
 * CONNECT A SLACK WORKSPACE (Slack bridge design §1.1 step 4).
 *
 * Slack does not link a device the way WhatsApp does: there is no QR and no
 * pairing code. An admin creates the app from tm8's manifest and pastes two
 * tokens — the bot token (`xoxb-`) and the app-level token (`xapp-`, Socket
 * Mode). `bridges.connections.begin` forwards them to the runtime ONCE, on
 * `connect`; the runtime checks them with `auth.test` and seals them in its
 * own state dir. The server stores no token bytes, returns none and logs none.
 *
 * TOKEN HYGIENE, the owner's hard rule — the whole reason this is its own
 * component:
 *   · both inputs are `type="password"` with `autoComplete="off"`;
 *   · the pasted values live in this component's state and nowhere else: no
 *     URL, no storage, no cache, no log, and they are never put in an error
 *     string (the dialog shows the SERVER's or Slack's words, never the value);
 *   · Submit clears both inputs synchronously, BEFORE the await settles, so
 *     success and failure both leave the form empty;
 *   · a relink (rotation) opens with empty fields — never a masked copy of
 *     what is sealed, because the UI cannot read it and must not pretend to.
 *
 * Linked is read back from `connections.list` — the runtime's own word, as in
 * the WhatsApp link flow. There is no client-side notion of success.
 */
export function SlackTokensDialog({
  port,
  spaceId,
  relink,
  onClose,
  onLinked,
}: {
  port: Pick<BridgesPort, 'connections'>;
  spaceId: string;
  /** Rotate the tokens on this connection instead of connecting a new workspace. */
  relink?: BridgeConnectionView | null;
  onClose(): void;
  onLinked(connection: BridgeConnectionView): void;
}) {
  /* The two pasted secrets. Nothing else in the app ever sees these. */
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [label, setLabel] = useState(relink?.label ?? '');
  const [offerHere, setOfferHere] = useState(true);
  const [pending, setPending] = useState<BridgeConnectionView | null>(null);
  /* The connection as the runtime last reported it: what linked/logged_out is read from. */
  const [watched, setWatched] = useState<BridgeConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useDismissable(true, dialog, close);

  /* Wait for the runtime's word on the tokens: linked (with the account from
     auth.test) or logged_out (with Slack's error code as the detail). */
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const tick = setInterval(() => {
      void port.connections.list().then((rows) => {
        const row = rows.find((r) => r.id === pending.id);
        if (!live || !row) return;
        setWatched(row);
        if (row.status !== 'linked') return;
        live = false;
        clearInterval(tick);
        void (async () => {
          try {
            const offered = offerHere && !row.offers.some((o) => o.spaceId === spaceId)
              ? (await port.connections.offer(row.id, spaceId)).connection
              : row;
            onLinked(offered);
          } catch (err) {
            setError(`Connected, but offering it to this space was refused: ${bridgeFailureOf(err)}`);
          }
        })();
      }, () => {});
    }, 1200);
    return () => { live = false; clearInterval(tick); };
  }, [pending, port, offerHere, spaceId, onLinked]);

  const problem = slackTokenProblem(botToken, appToken);
  /* Only after a submit: an untouched form must not open covered in red. */
  const [tried, setTried] = useState(false);

  const submit = async () => {
    setTried(true);
    if (problem) return;
    /* Read the values out, then clear the inputs in the same tick: whatever
       the call does next, nothing is left on screen or in state to echo. */
    const credential = { kind: 'slack_tokens' as const, botToken: botToken.trim(), appToken: appToken.trim() };
    setBotToken('');
    setAppToken('');
    setBusy(true);
    setError(null);
    setWatched(null);
    try {
      const result = await port.connections.begin({
        provider: 'slack',
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(relink ? { connectionId: relink.id } : {}),
        credential,
      });
      if (result.runtime === 'offline') {
        setError('No Slack runtime is running on this node, so the tokens cannot be checked yet. Start the slack-runtime service, then try again.');
      } else {
        setPending(result.connection);
        setWatched(result.connection);
      }
    } catch (err) {
      /* The server's words. `begin` refuses a malformed token by SHAPE, never
         quoting it, so this cannot carry the value. */
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(false);
    }
  };

  const status = watched?.status ?? null;
  const account = watched?.account ?? null;
  const missing = missingScopeLines(account);
  const refusal = status === 'logged_out' ? slackRefusalWords(watched?.detail) : null;
  const title = relink ? `New tokens for ${relink.label}` : 'Connect a Slack workspace';

  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog brg-linkdlg" role="dialog" aria-modal="true" aria-label={title} data-testid="bridge-slack-tokens">
        <h2 className="brg-dialog__title">{title}</h2>

        <ol className="brg-dialog__list">
          <li>
            At api.slack.com/apps, choose <em>Create New App → From a manifest</em> and paste tm8's manifest
            (on Enterprise Grid, pick the org; an org admin approves the app and chooses its workspaces).
          </li>
          <li>Copy the two tokens below out of that app.</li>
        </ol>
        <p className="brg-hint">
          The full walk-through is in{' '}
          <a className="brg-link" href={SLACK_SETUP_GUIDE_URL} target="_blank" rel="noreferrer noopener">{SLACK_SETUP_GUIDE_PATH}</a>.
        </p>

        <form
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
          /* Never offer to remember a secret, and never let a manager fill it. */
          autoComplete="off"
        >
          <label className="brg-form__line">
            <span>Bot token</span>
            <input
              type="password"
              value={botToken}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="xoxb-…"
              aria-label="Bot token"
              aria-describedby="slack-bot-help"
              disabled={busy}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </label>
          <p className="brg-hint" id="slack-bot-help">{SLACK_TOKEN_HELP.bot}</p>

          <label className="brg-form__line">
            <span>App-level token</span>
            <input
              type="password"
              value={appToken}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="xapp-…"
              aria-label="App-level token"
              aria-describedby="slack-app-help"
              disabled={busy}
              onChange={(e) => setAppToken(e.target.value)}
            />
          </label>
          <p className="brg-hint" id="slack-app-help">{SLACK_TOKEN_HELP.app}</p>

          {!relink ? (
            <label className="brg-form__line">
              <span>Name it</span>
              <input
                type="text"
                value={label}
                placeholder="Acme Slack"
                aria-label="Workspace label"
                maxLength={80}
                disabled={busy}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
          ) : null}

          {!relink ? (
            <label className="brg-form__line">
              <input type="checkbox" checked={offerHere} disabled={busy} onChange={(e) => setOfferHere(e.target.checked)} />
              {' '}Offer it to this space once it is connected
            </label>
          ) : null}

          <p className="brg-hint">
            tm8 checks the tokens with Slack (<code>auth.test</code>) and seals them where the runtime runs. They are
            never stored by the server, never shown again and never logged — rotating them means pasting new ones here.
          </p>

          {tried && problem ? <p className="brg-error" role="alert" data-testid="slack-token-problem">{problem}</p> : null}
          {error ? <p className="brg-error" role="alert">{error}</p> : null}

          {status !== null && !error ? (
            <div className="brg-slack__state" data-testid="slack-connect-state" data-status={status}>
              {status === 'linked' && account ? (
                <p className="brg-hint" role="status" data-testid="slack-connected">✓ {slackAccountLine(account)}</p>
              ) : status === 'logged_out' ? (
                <p className="brg-error" role="alert" data-testid="slack-refused">{refusal}</p>
              ) : status === 'offline' ? (
                <p className="brg-hint" role="status">
                  The Slack runtime is not connected, so the tokens have not been checked yet. They are kept sealed and
                  checked as soon as it comes up.
                </p>
              ) : (
                <p className="brg-hint" role="status">◌ Checking the tokens with Slack…</p>
              )}
              {missing.length > 0 ? (
                <div className="brg-warn" role="status" data-testid="slack-missing-scopes">
                  <p>
                    Connected, but this Slack app is missing {missing.length} scope{missing.length === 1 ? '' : 's'} the
                    bridge uses. Add them in the app's OAuth &amp; Permissions, reinstall it, then paste the new bot token:
                  </p>
                  <ul>{missing.map((line) => <li key={line}>{line}</li>)}</ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="brg-dialog__actions">
            <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>
              {status === 'logged_out' ? 'Close' : 'Cancel'}
            </button>
            <button type="submit" className="pn-btn pn-btn--primary" disabled={busy || (tried && problem !== null)}>
              {busy ? 'Checking…' : pending ? 'Paste again' : relink ? 'Use these tokens' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
