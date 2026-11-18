import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeConnectionView } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { bridgeFailureOf } from './format';
import {
  SLACK_SETUP_GUIDE_PATH, SLACK_SETUP_GUIDE_URL, SLACK_TOKEN_HELP,
  slackAccountLine, slackRefusalWords, slackTokenProblem,
} from './slack';
import { SlackScopeNote } from './SlackScopeNote';

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
  /**
   * The connection once the runtime said `linked` (and it was offered to the
   * space, if asked). Held here rather than handed to `onLinked` at once:
   * both hosts close this dialog in `onLinked`, so doing that in the same tick
   * meant "Connected to …" and the missing-scope warning only ever rendered
   * in this component's own tests, never in the app (#1509 review 4). The
   * person now sees the result and dismisses it with Done.
   */
  const [settled, setSettled] = useState<BridgeConnectionView | null>(null);
  /**
   * Bumped by each submit. The poll below keys on it, so a retry tears the old
   * interval down: otherwise a poll in flight from the previous attempt could
   * land after the new one started and put the old refusal back on screen for
   * a beat (#1509 delta review, nit 3).
   */
  const [attempt, setAttempt] = useState(0);
  /* The connection as the runtime last reported it: what linked/logged_out is read from. */
  const [watched, setWatched] = useState<BridgeConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  /*
   * Dismissing the dialog means different things before and after the tokens
   * worked. Before: nothing happened, so Escape or a click outside cancels.
   * AFTER: the workspace IS connected and offered on the server, so cancelling
   * throws that away on the client — in the wizard `onClose` is only
   * `setLinking(null)`, with no reload and no step 2, so the new workspace
   * never appeared and the person was stuck on step 1 looking at a connection
   * that exists (#1509 delta review A). Once `settled`, every exit is Done.
   */
  const close = useCallback(() => {
    if (busy) return;
    if (settled) onLinked(settled); else onClose();
  }, [busy, settled, onClose, onLinked]);
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
            setSettled(offered);
          } catch (err) {
            /* Connected but not offered: still show the account, since the
               tokens DID work, and say what did not. */
            setSettled(row);
            setError(`Connected, but offering it to this space was refused: ${bridgeFailureOf(err)}`);
          }
        })();
      }, () => {});
    }, 1200);
    return () => { live = false; clearInterval(tick); };
  }, [pending, attempt, port, offerHere, spaceId]);

  const problem = slackTokenProblem(botToken, appToken);
  /* Only after a submit: an untouched form must not open covered in red. */
  const [tried, setTried] = useState(false);

  const submit = async () => {
    setTried(true);
    if (problem) return;
    /* Read the values out, then clear the inputs in the same tick: whatever
       the call does next, nothing is left on screen or in state to echo. */
    const credential = { kind: 'slack_tokens' as const, botToken: botToken.trim(), appToken: appToken.trim() };
    const onto = relink ?? pending;
    setBotToken('');
    setAppToken('');
    /* …and the form is untouched again. Clearing the inputs makes `problem`
       "Paste both tokens" once more, so leaving `tried` true drew a red alert
       on every submit — beside "Checking the tokens…", announced to screen
       readers — and left *Paste again* disabled until someone typed (#1509
       review 1). The guard above has already run; `tried` has done its job. */
    setTried(false);
    setBusy(true);
    setError(null);
    setWatched(null);
    setAttempt((n) => n + 1);
    try {
      const result = await port.connections.begin({
        provider: 'slack',
        ...(label.trim() ? { label: label.trim() } : {}),
        /* The row to write the tokens onto: the one being rotated, or — on a
           second attempt at a NEW workspace — the row the first attempt
           already created. Without this, every *Paste again* inserted another
           connection and left the refused ones orphaned in Accounts & secrets
           (#1509 review 2). */
        ...(onto ? { connectionId: onto.id } : {}),
        credential,
      });
      /* Keep the row either way: `offline` means the server has ALREADY
         inserted it and only the runtime is missing, so a retry must reuse it. */
      setPending(result.connection);
      setWatched(result.connection);
      if (result.runtime === 'offline') {
        setError('No Slack runtime is running on this node, so the tokens cannot be checked yet. Start the slack-runtime service, then try again.');
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
  const account = settled?.account ?? watched?.account ?? null;
  const refusal = status === 'logged_out' ? slackRefusalWords(watched?.detail) : null;
  const title = relink ? `New tokens for ${relink.label}` : 'Connect a Slack workspace';

  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog brg-linkdlg" role="dialog" aria-modal="true" aria-label={title} data-testid="bridge-slack-tokens">
        <h2 className="brg-dialog__title">{title}</h2>

        {/* CONNECTED. The tokens worked, so the form is finished with: what is
            left to say is which workspace this is and anything the install is
            missing, and the person dismisses it themselves. Both hosts close
            this dialog in `onLinked`, so handing them the connection here
            would take the result off the screen in the same tick. */}
        {settled ? (
          <div className="brg-slack__state" data-testid="slack-connect-state" data-status="linked">
            {settled.account ? (
              <p className="brg-hint" role="status" data-testid="slack-connected">✓ {slackAccountLine(settled.account)}</p>
            ) : (
              <p className="brg-hint" role="status" data-testid="slack-connected">✓ Connected.</p>
            )}
            <SlackScopeNote connection={settled} testId="slack-missing-scopes" />
            {settled.offers.some((o) => o.spaceId === spaceId) ? (
              <p className="set-note">It is offered to this space: you can bridge its channels here.</p>
            ) : (
              <p className="set-note">
                It is connected but not offered to this space yet — offer it from Accounts &amp; secrets to bridge its
                channels here.
              </p>
            )}
            {error ? <p className="brg-error" role="alert">{error}</p> : null}
            <div className="brg-dialog__actions">
              <button type="button" className="pn-btn pn-btn--primary" data-testid="slack-done" onClick={() => onLinked(settled)}>
                Done
              </button>
            </div>
          </div>
        ) : (<>
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
              /* Chrome ignores autocomplete=off on a password field and may
                 offer to SAVE what was pasted — storage outside the app, which
                 the hard rule covers. `one-time-code` is the hint that says
                 this is transient and not worth keeping. */
              autoComplete="one-time-code"
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
              autoComplete="one-time-code"
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

          {/* While the runtime has not answered yet, or has refused. `linked`
              is handled above, where the form is gone. */}
          {status !== null && !error ? (
            <div className="brg-slack__state" data-testid="slack-connect-state" data-status={status}>
              {status === 'logged_out' ? (
                <p className="brg-error" role="alert" data-testid="slack-refused">{refusal}</p>
              ) : status === 'offline' ? (
                <p className="brg-hint" role="status">
                  The Slack runtime is not connected, so the tokens have not been checked yet. They are kept sealed and
                  checked as soon as it comes up.
                </p>
              ) : (
                <p className="brg-hint" role="status">◌ Checking the tokens with Slack…</p>
              )}
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
        </>)}
      </div>
    </div>
  );
}
