/**
 * The shared provider block. Home and Settings supply different outer chrome,
 * but both mount this exact component so the status vocabulary, actions,
 * terminal lifecycle and provider marks cannot drift between the two places.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialRoutingView,
  CredentialsDeleteResult,
  CredentialsLoginSessionFinishResult,
  CredentialsStatusView,
} from '@tm8/contract';
import { LiveTerminal, TerminalHost, isLiveTerminalEnabled } from '../terminal';
import { CREDENTIAL_PROVIDER_LABEL } from '../domain/launch';
import { Pill } from '../kit/Pill';
import { Timestamp } from '../kit/Timestamp';
import { parseInstant, useNow } from '../kit/time';
import { presentationOf, providerBinaryLabel } from './provider-presentation';
import { credentialBadgeOf, isConnectedVerdict } from './credential-status';
import { ShareCredentialPanel } from './ShareCredentialPanel';
import {
  disconnectVerdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
  type CredentialsSharePort,
} from './port';
import './credentials.css';

export interface CredentialsProviderBlockProps {
  port: CredentialsPort;
  /** Same-origin route prefix for the node that owns the login session. */
  serverBaseUrl?: string;
  sharePort?: CredentialsSharePort;
}

/** A login terminal that has been opened and not yet harvested. */
export interface PendingLogin {
  provider: CredentialProviderName;
  workSessionId: string;
  expiresAt: string;
  command: string;
}

/** The last thing a write said, kept so the answer is never silently dropped. */
type Outcome =
  | { kind: 'disconnect'; provider: CredentialProviderName; result: CredentialsDeleteResult }
  | { kind: 'finish'; result: CredentialsLoginSessionFinishResult }
  | { kind: 'error'; provider: CredentialProviderName; message: string };

const VERDICT_TONE: Record<ConnectionVerdict, 'connected' | 'disconnected' | 'unavailable' | 'unknown'> = {
  'connected-named': 'connected',
  'connected-unnamed': 'connected',
  disconnected: 'disconnected',
  unavailable: 'unavailable',
  unknown: 'unknown',
};

export function CredentialsProviderBlock({
  port,
  serverBaseUrl,
  sharePort,
}: CredentialsProviderBlockProps) {
  const [status, setStatus] = useState<CredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<CredentialProviderName | null>(null);
  const [sharing, setSharing] = useState<CredentialProviderName | null>(null);

  const reload = useCallback(() => {
    return port.load().then(
      (next) => { setStatus(next); setLoadError(null); },
      (err: unknown) => setLoadError(messageOf(err)),
    );
  }, [port]);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (next) => { if (live) { setStatus(next); setLoadError(null); } },
      (err: unknown) => { if (live) setLoadError(messageOf(err)); },
    );
    return () => { live = false; };
  }, [port]);

  async function connect(provider: CredentialProviderName) {
    setBusy(provider);
    setOutcome(null);
    try {
      const started = await port.startLogin(provider);
      setPending({
        provider,
        workSessionId: started.workSessionId,
        expiresAt: started.expiresAt,
        command: started.command,
      });
    } catch (err) {
      setOutcome({ kind: 'error', provider, message: messageOf(err) });
    } finally {
      setBusy(null);
    }
  }

  async function finish(login: PendingLogin) {
    setBusy(login.provider);
    try {
      const result = await port.finishLogin(login.workSessionId);
      setPending(null);
      setOutcome({ kind: 'finish', result });
      await reload();
    } catch (err) {
      setOutcome({ kind: 'error', provider: login.provider, message: messageOf(err) });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: CredentialProviderName) {
    setBusy(provider);
    try {
      const result = await port.disconnect(provider);
      setOutcome({ kind: 'disconnect', provider, result });
      await reload();
    } catch (err) {
      setOutcome({ kind: 'error', provider, message: messageOf(err) });
    } finally {
      setBusy(null);
    }
  }

  const loginError =
    pending && outcome?.kind === 'error' && outcome.provider === pending.provider ? outcome.message : null;

  return (
    <div className="cred-block" data-testid="credentials-provider-block">
      <p className="cred-intro">
        Sign in once to let agents you launch use your account. These credentials are yours;
        nobody else in this space can read or use them. Connecting opens a real terminal here.
      </p>

      {loadError ? (
        <div className="cred-notice" data-testid="credentials-load-error">
          <span className="cred-notice__head">Your credentials could not be read.</span>
          <span className="cred-notice__why">{loadError}</span>
        </div>
      ) : null}

      {status === null && loadError === null ? (
        <div className="cred-notice" data-testid="credentials-loading">
          <span className="cred-notice__head">Reading your credentials…</span>
          <span className="cred-notice__why">
            Nothing below is filled in from a cache; the provider list waits for this node.
          </span>
        </div>
      ) : null}

      {/* A failure that belongs to the open login terminal is shown inside
          it, next to the buttons that can fix it, not above the grid. */}
      {outcome && !loginError ? <OutcomeNotice outcome={outcome} onDismiss={() => setOutcome(null)} /> : null}

      {sharing && sharePort ? <ShareCredentialPanel
        key={`${sharePort.currentSpaceId}:${sharing}`}
        provider={sharing}
        port={sharePort}
        serverBaseUrl={serverBaseUrl}
        onClose={() => setSharing(null)}
      /> : null}

      {pending ? (
        <LoginTerminalPanel
          login={pending}
          serverBaseUrl={serverBaseUrl}
          busy={busy === pending.provider}
          onFinish={() => void finish(pending)}
          error={loginError}
          onCancel={() => { setPending(null); setOutcome(null); }}
          onRestart={() => void connect(pending.provider)}
        />
      ) : null}

      {status ? (
        <div className="cred-grid" data-testid="credential-provider-grid">
          {status.providers.map((entry) => (
            <ProviderCard
              key={entry.provider}
              entry={entry}
              gitCredentialStore={status.gitCredentialStore}
              busy={busy === entry.provider || sharing !== null}
              onConnect={() => void connect(entry.provider)}
              onDisconnect={() => void disconnect(entry.provider)}
              onShare={sharePort && !pending ? () => setSharing(entry.provider) : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One provider. `credentialBadgeOf` owns the measurement interpretation; this
 * renderer owns the sentence and the actions belonging to that state.
 *
 * ONE PRIMARY ACTION, and only when there is something to do: Connect for a
 * provider that is not (or may not be) signed in, Reconnect for an expired
 * one. A healthy connection carries no filled button — Reconnect and
 * Disconnect stay reachable but quiet, so the eye lands on the cards that
 * need attention.
 */
function ProviderCard({
  entry,
  gitCredentialStore,
  busy,
  onConnect,
  onDisconnect,
  onShare,
}: {
  entry: CredentialConnectionView;
  gitCredentialStore: 'present' | 'absent';
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onShare?: () => void;
}) {
  const badge = credentialBadgeOf(entry, gitCredentialStore);
  const { verdict } = badge;
  const connected = isConnectedVerdict(verdict);
  const presentation = presentationOf(entry.provider);
  const ProviderIcon = presentation.icon;
  const needsAction = !connected || badge.expired;
  const showAccount = verdict === 'connected-named';
  const showConnectedAt = connected && Boolean(entry.connectedAt);
  const showVerified = Boolean(entry.lastVerifiedAt);

  return (
    <article
      className={`cred-card cred-card--${VERDICT_TONE[verdict]}${badge.expired ? ' cred-card--expired' : ''}`}
      data-testid={`credential-card-${entry.provider}`}
      data-credential-state={VERDICT_TONE[verdict]}
    >
      <header className="cred-card__head">
        <span className="cred-card__mark">
          <ProviderIcon />
        </span>
        <span className="cred-card__title">
          <span className="cred-card__name">{presentation.name}</span>
          <code className="cred-card__binary">{providerBinaryLabel(entry.provider)}</code>
        </span>
        <span className="cred-card__badge" data-testid={`credential-pill-${entry.provider}`}>
          <Pill tone={badge.tone}>{badge.word}</Pill>
        </span>
      </header>

      <div className="cred-card__state" data-testid={`credential-verdict-${entry.provider}`}>
        <VerdictLine verdict={verdict} login={entry.login} binary={presentation.binary} />
      </div>

      {badge.expired ? (
        <p className="cred-card__expired" data-testid={`credential-expired-why-${entry.provider}`}>
          {`This login is recorded as ${entry.status} — it is still stored, and an agent launched with it will fail. Reconnect to refresh it.`}
        </p>
      ) : null}

      {/* The routing disclosure. It sits directly under the verdict because it
          is part of the same answer: "connected" and "used for these models
          on claude-code" are one fact told in two sentences. */}
      {entry.routing ? <RoutingLine provider={entry.provider} routing={entry.routing} /> : null}

      {/* A connected-null result is a complete probe answer, not an account
          name that is still loading. Only a real name earns an Account row. */}
      {showAccount || showConnectedAt || showVerified ? (
        <dl className="cred-card__facts">
          {showAccount ? (
            <div className="cred-card__fact">
              <dt>Account</dt>
              <dd className="cred-card__account-value" data-testid={`credential-login-${entry.provider}`}>
                {entry.login}
              </dd>
            </div>
          ) : null}
          {showConnectedAt ? (
            <div className="cred-card__fact">
              <dt>Connected</dt>
              <dd><Timestamp at={entry.connectedAt} /></dd>
            </div>
          ) : null}
          {showVerified ? (
            <div className="cred-card__fact">
              <dt>Verified</dt>
              <dd><Timestamp at={entry.lastVerifiedAt} /></dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <footer className="cred-card__actions">
        {verdict === 'unavailable' ? (
          <span className="cred-install" data-testid={`credential-install-${entry.provider}`}>
            {presentation.binary === null ? (
              <>This provider cannot be reached from this node.</>
            ) : (
              <>
                Install <code>{presentation.binary}</code> on this node to enable sign-in.
              </>
            )}
          </span>
        ) : (
          <>
            {onShare && connected ? (
              <button
                type="button"
                className="cred-action cred-action--quiet"
                disabled={busy}
                onClick={onShare}
                data-testid={`credential-share-${entry.provider}`}
              >
                Share to
              </button>
            ) : null}
            <span className="cred-card__spacer" />
            {/* Unknown may already be connected. Keep the escape hatch that
                can revoke it; only a measured disconnection hides Disconnect. */}
            {verdict === 'disconnected' ? null : (
              <button
                type="button"
                className="cred-action cred-action--quiet cred-action--danger"
                onClick={onDisconnect}
                disabled={busy}
                data-testid={`credential-disconnect-${entry.provider}`}
              >
                Disconnect
              </button>
            )}
            <button
              type="button"
              className={needsAction ? 'cred-action cred-action--primary' : 'cred-action'}
              onClick={onConnect}
              disabled={busy}
              data-testid={`credential-connect-${entry.provider}`}
            >
              {connected ? 'Reconnect' : 'Connect'}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

/**
 * Say, on the card, which sessions this credential serves.
 *
 * Kimi and Groq are backends for a tool that already exists, so a member can
 * reasonably wonder whether connecting one moves their Claude Code or Codex
 * sessions off Anthropic or OpenAI. It does not: routing is per model, and
 * this line says so — the key serves its own models on the tool, and every
 * other session on that tool keeps its native login. Only a backend card
 * carries routing; a native provider's card needs no warning.
 *
 * `agentTool` and the counterpart come from the server, which computes them
 * from the same table spawn resolves against. Nothing here is hardcoded to
 * "kimi" or "anthropic".
 *
 * BOTH NAMES COME FROM THE VENDOR TABLE, NOT THE PRESENTATION TABLE. This line
 * is about whose service answers and whose account is billed, so it says
 * "Moonshot AI" and "Anthropic"; `presentationOf` would say "Claude Code",
 * which is the tool — the one thing that does not change.
 */
function RoutingLine({
  provider,
  routing,
}: {
  provider: CredentialProviderName;
  routing: CredentialRoutingView;
}) {
  const vendor = CREDENTIAL_PROVIDER_LABEL[provider];
  const counterpart = CREDENTIAL_PROVIDER_LABEL[routing.counterpart];
  const tool = <code>{routing.agentTool}</code>;

  return (
    <p
      className={`cred-card__routing${routing.active ? ' cred-card__routing--active' : ''}`}
      data-testid={`credential-routing-${routing.role}`}
      data-routing-active={routing.active ? 'true' : 'false'}
    >
      {routing.active ? (
        <>Used only for models served by {vendor} on {tool}. Every other {tool} session keeps using {counterpart}.</>
      ) : (
        <>Connect this to run models served by {vendor} on {tool}. Other {tool} sessions keep using {counterpart}.</>
      )}
    </p>
  );
}

/** Four meanings, stated in words so colour is never the only state signal. */
function VerdictLine({
  verdict,
  login,
  binary,
}: {
  verdict: ConnectionVerdict;
  login: string | null;
  // Null for providers with no vendor CLI. Only the `unavailable` arm reads it,
  // and that arm is unreachable for those providers — the binary their probe
  // measures is `node`, which ships with the server. The fallback below is
  // correctness insurance, not a case anyone should see.
  binary: string | null;
}) {
  switch (verdict) {
    case 'connected-named':
      return <span>{`Connected as ${login}`}</span>;
    case 'connected-unnamed':
      return <span>Connected — inference access</span>;
    case 'unavailable':
      return (
        <span>
          {binary === null
            ? 'Unavailable — this node cannot reach the provider.'
            : `Unavailable — ${binary} is not installed on this node.`}
        </span>
      );
    case 'unknown':
      return (
        <span>
          Could not be measured — this node cannot tell whether you are connected.
          <span className="cred-card__detail" data-testid="credential-unknown-why">
            No confident connection answer is available; you may already be signed in.
          </span>
        </span>
      );
    case 'disconnected':
      return <span>Not connected</span>;
  }
}

/** The dismiss control every outcome notice carries in its corner. */
function DismissNotice({ onDismiss }: { onDismiss?: () => void }) {
  if (!onDismiss) return null;
  return (
    <button type="button" className="cred-notice__dismiss" aria-label="Dismiss" onClick={onDismiss}>
      ×
    </button>
  );
}

/** What the last write actually did, including partial disconnect. */
function OutcomeNotice({ outcome, onDismiss }: { outcome: Outcome; onDismiss?: () => void }) {
  if (outcome.kind === 'error') {
    const provider = presentationOf(outcome.provider);
    return (
      <div className="cred-notice cred-notice--error" data-testid="credential-outcome-error">
        <DismissNotice onDismiss={onDismiss} />
        <span className="cred-notice__head">{`${provider.name} — that did not go through.`}</span>
        <span className="cred-notice__why">{outcome.message}</span>
      </div>
    );
  }

  if (outcome.kind === 'finish') {
    const result = outcome.result;
    const provider = presentationOf(result.provider);
    const tone = !result.connected ? 'error' : result.stored ? 'ok' : 'warn';
    return (
      <div className={`cred-notice cred-notice--${tone}`} data-testid="credential-outcome-finish">
        <DismissNotice onDismiss={onDismiss} />
        <span className="cred-notice__head">
          {result.connected
            ? `${provider.name} — signed in${result.login ? ` as ${result.login}` : ''}.`
            : `${provider.name} — that terminal did not end signed in.`}
        </span>
        {result.connected && !result.stored ? (
          <span className="cred-notice__why" data-testid="credential-verified-not-stored">
            Verified, but not saved on this node: there is nowhere to write it here. This is a
            correct result, not an error — your agents will not inherit this login until the
            credential store exists.
          </span>
        ) : null}
      </div>
    );
  }

  const result = outcome.result;
  const provider = presentationOf(result.provider);
  const verdict = disconnectVerdictOf(result);
  const terminated =
    result.terminatedCredentialSessionIds.length + result.terminatedAgentSessionIds.length;

  const tone = verdict === 'failed' ? 'error' : verdict === 'partial' ? 'warn' : 'ok';

  return (
    <div className={`cred-notice cred-notice--${tone}`} data-testid={`credential-outcome-disconnect-${verdict}`}>
      <DismissNotice onDismiss={onDismiss} />
      <span className="cred-notice__head">
        {verdict === 'failed'
          ? `${provider.name} — not disconnected.`
          : verdict === 'partial'
            ? `${provider.name} — disconnected, but ${result.failures.length} thing${result.failures.length === 1 ? '' : 's'} did not settle.`
            : `${provider.name} — disconnected.`}
      </span>

      {verdict !== 'failed' ? (
        <span className="cred-notice__why">
          {`The credential was revoked${terminated > 0 ? ` and ${terminated} running session${terminated === 1 ? '' : 's'} stopped` : ''}. An agent that already read the secret still holds it in memory — to fully revoke it, rotate the credential at the vendor.`}
        </span>
      ) : null}

      {result.failures.length > 0 ? (
        <ul data-testid="credential-disconnect-failures">
          {result.failures.map((failure, index) => (
            <li key={`${failure.step}-${failure.sessionId ?? index}`} className="cred-notice__why">
              {`${failure.step}${failure.sessionId ? ` (${failure.sessionId})` : ''}: ${failure.reason}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Login is an ordinary PTY work_session, hosted by the existing terminal
 * module. The test-build placeholder says plainly when live bytes are disabled.
 * Settings → Space credentials and the managed credential block mount this
 * same panel, with their own `lede` naming the credential being logged into.
 *
 * The panel carries its own lifecycle: waiting (with a live countdown to the
 * terminal's expiry), expired, and an inline error from the last finish
 * attempt. `onCancel`, `onRestart` and `error` are optional so hosts that
 * predate them keep their behaviour.
 *
 * "I've finished signing in" stays offered after the countdown runs out: the
 * server, not this clock, decides whether the session can still be harvested.
 */
export function LoginTerminalPanel({
  login,
  serverBaseUrl,
  busy,
  onFinish,
  lede,
  error,
  onCancel,
  onRestart,
}: {
  login: PendingLogin;
  serverBaseUrl?: string;
  busy: boolean;
  onFinish: () => void;
  lede?: string;
  /** The last finish/start attempt's failure, shown inside the panel. */
  error?: string | null;
  /** Close the panel. The terminal is left to expire on its own. */
  onCancel?: () => void;
  /** Open a fresh login terminal for the same provider. */
  onRestart?: () => void;
}) {
  const provider = presentationOf(login.provider);
  const ProviderIcon = provider.icon;
  const now = useNow();
  const expiresAt = parseInstant(login.expiresAt);
  const expired = expiresAt !== null && expiresAt <= now;
  const state = error ? 'error' : expired ? 'expired' : busy ? 'checking' : 'waiting';

  return (
    <section
      className={`cred-terminal cred-terminal--${state}`}
      data-testid="credential-login-terminal"
      data-login-state={state}
      aria-label={`Sign in to ${provider.name}`}
      aria-busy={busy}
    >
      <header className="cred-terminal__head">
        <span className="cred-card__mark">
          <ProviderIcon />
        </span>
        <span className="cred-terminal__title">{`Sign in to ${provider.name}`}</span>
        <Pill tone={state === 'error' ? 'block' : state === 'expired' ? 'wait' : 'brand'} dot={state === 'waiting' || state === 'checking' ? 'pulse' : undefined}>
          {state === 'error' ? 'Needs attention' : state === 'expired' ? 'Expired' : state === 'checking' ? 'Checking' : 'Waiting for you'}
        </Pill>
      </header>

      <p className="cred-intro cred-terminal__lede">
        {lede ?? 'This is a real terminal on this node. What you type goes to the sign-in program running in it, never through this page.'}
      </p>

      <ol className="cred-terminal__steps">
        <li>Open the link the terminal prints and sign in with your {provider.name} account.</li>
        <li>If the browser shows a code, paste it into the terminal and press Enter.</li>
        <li>Come back here and press <strong>I’ve finished signing in</strong>.</li>
      </ol>

      <p className="cred-terminal__meta" data-testid="credential-login-expiry">
        <span>
          Runs <code>{login.command}</code>
        </span>
        <span aria-hidden="true">·</span>
        {expiresAt === null ? (
          <span>{`expires at ${login.expiresAt}`}</span>
        ) : expired ? (
          <span className="cred-terminal__expiry--past">
            expired <Timestamp at={login.expiresAt} />
          </span>
        ) : (
          <span>
            expires <Timestamp at={login.expiresAt} />
          </span>
        )}
      </p>

      <div className="cred-terminal__screen">
        {isLiveTerminalEnabled() ? (
          <LiveTerminal
            sessionId={login.workSessionId}
            serverBaseUrl={serverBaseUrl}
            live
            autoFocus
          />
        ) : (
          <TerminalHost
            ariaLabel={`${provider.name} login terminal`}
            placeholder="the live terminal is disabled in this build, so this login cannot be completed here"
          />
        )}
      </div>

      {error ? (
        <div className="cred-notice cred-notice--error" data-testid="credential-outcome-error">
          <span className="cred-notice__head">{`${provider.name} — that did not go through.`}</span>
          <span className="cred-notice__why">{error}</span>
        </div>
      ) : expired ? (
        <div className="cred-notice cred-notice--warn" data-testid="credential-login-expired">
          <span className="cred-notice__head">This sign-in terminal has expired.</span>
          <span className="cred-notice__why">
            If you finished signing in before it closed, you can still check. Otherwise start a new terminal.
          </span>
        </div>
      ) : null}

      <footer className="cred-terminal__actions">
        {onCancel ? (
          <button type="button" className="cred-action cred-action--quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <span className="cred-card__spacer" />
        {onRestart && (expired || error) ? (
          <button
            type="button"
            className="cred-action"
            onClick={onRestart}
            disabled={busy}
            data-testid="credential-restart-login"
          >
            Start again
          </button>
        ) : null}
        <button
          type="button"
          className="cred-action cred-action--primary"
          onClick={onFinish}
          disabled={busy}
          data-testid="credential-finish-login"
        >
          I’ve finished signing in
        </button>
      </footer>
    </section>
  );
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}
