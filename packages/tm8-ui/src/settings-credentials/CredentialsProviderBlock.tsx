/**
 * The shared provider block. Home and Settings supply different outer chrome,
 * but both mount this exact component so the status vocabulary, actions,
 * terminal lifecycle and provider marks cannot drift between the two places.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsDeleteResult,
  CredentialsLoginSessionFinishResult,
  CredentialsStatusView,
} from '@tm8/contract';
import { LiveTerminal, TerminalHost, isLiveTerminalEnabled } from '../terminal';
import { presentationOf } from './provider-presentation';
import {
  disconnectVerdictOf,
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
} from './port';
import './credentials.css';

export interface CredentialsProviderBlockProps {
  port: CredentialsPort;
  /** Same-origin route prefix for the node that owns the login session. */
  serverBaseUrl?: string;
}

/** A login terminal that has been opened and not yet harvested. */
interface PendingLogin {
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
}: CredentialsProviderBlockProps) {
  const [status, setStatus] = useState<CredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<CredentialProviderName | null>(null);

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

      {outcome ? <OutcomeNotice outcome={outcome} /> : null}

      {pending ? (
        <LoginTerminalPanel
          login={pending}
          serverBaseUrl={serverBaseUrl}
          busy={busy === pending.provider}
          onFinish={() => void finish(pending)}
        />
      ) : null}

      {status ? (
        <div className="cred-grid" data-testid="credential-provider-grid">
          {status.providers.map((entry) => (
            <ProviderCard
              key={entry.provider}
              entry={entry}
              gitCredentialStore={status.gitCredentialStore}
              busy={busy === entry.provider}
              onConnect={() => void connect(entry.provider)}
              onDisconnect={() => void disconnect(entry.provider)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One provider. `verdictOf` owns the measurement interpretation; this renderer
 * owns only the sentence and action belonging to that verdict.
 */
function ProviderCard({
  entry,
  gitCredentialStore,
  busy,
  onConnect,
  onDisconnect,
}: {
  entry: CredentialConnectionView;
  gitCredentialStore: 'present' | 'absent';
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const verdict = verdictOf(entry, gitCredentialStore);
  const presentation = presentationOf(entry.provider);
  const ProviderIcon = presentation.icon;

  return (
    <article
      className={`cred-card cred-card--${VERDICT_TONE[verdict]}`}
      data-testid={`credential-card-${entry.provider}`}
      data-credential-state={VERDICT_TONE[verdict]}
    >
      <header className="cred-card__head">
        <span className="cred-card__mark">
          <ProviderIcon />
        </span>
        <span className="cred-card__name">{presentation.name}</span>
        <code className="cred-card__binary">{presentation.binary}</code>
      </header>

      <div className="cred-card__state" data-testid={`credential-verdict-${entry.provider}`}>
        <VerdictLine verdict={verdict} login={entry.login} binary={presentation.binary} />
      </div>

      {/* A connected-null result is a permanent product fact, not an account
          name that is still loading. Only a real name earns an Account row. */}
      {verdict === 'connected-named' ? (
        <div className="cred-card__account">
          <span>Account</span>
          <span className="cred-card__account-value" data-testid={`credential-login-${entry.provider}`}>
            {entry.login}
          </span>
        </div>
      ) : null}

      {entry.lastVerifiedAt ? (
        <div className="cred-card__account">
          <span>Verified</span>
          <span className="cred-card__account-value">{entry.lastVerifiedAt}</span>
        </div>
      ) : null}

      <div className="cred-card__actions">
        {verdict === 'unavailable' ? (
          <span className="cred-install" data-testid={`credential-install-${entry.provider}`}>
            Install <code>{presentation.binary}</code> on this node to enable sign-in.
          </span>
        ) : (
          <>
            <button
              type="button"
              className="cred-action cred-action--primary"
              onClick={onConnect}
              disabled={busy}
              data-testid={`credential-connect-${entry.provider}`}
            >
              {verdict === 'connected-named' || verdict === 'connected-unnamed'
                ? 'Reconnect'
                : 'Connect'}
            </button>
            {/* Unknown may already be connected. Keep the escape hatch that
                can revoke it; only a measured disconnection hides Disconnect. */}
            {verdict === 'disconnected' ? null : (
              <button
                type="button"
                className="cred-action"
                onClick={onDisconnect}
                disabled={busy}
                data-testid={`credential-disconnect-${entry.provider}`}
              >
                Disconnect
              </button>
            )}
          </>
        )}
      </div>
    </article>
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
  binary: string;
}) {
  switch (verdict) {
    case 'connected-named':
      return <span>{`Connected as ${login}`}</span>;
    case 'connected-unnamed':
      return <span>Connected — inference access</span>;
    case 'unavailable':
      return <span>{`Unavailable — ${binary} is not installed on this node.`}</span>;
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

/** What the last write actually did, including partial disconnect. */
function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'error') {
    const provider = presentationOf(outcome.provider);
    return (
      <div className="cred-notice" data-testid="credential-outcome-error">
        <span className="cred-notice__head">{`${provider.name} — that did not go through.`}</span>
        <span className="cred-notice__why">{outcome.message}</span>
      </div>
    );
  }

  if (outcome.kind === 'finish') {
    const result = outcome.result;
    const provider = presentationOf(result.provider);
    return (
      <div className="cred-notice" data-testid="credential-outcome-finish">
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

  return (
    <div className="cred-notice" data-testid={`credential-outcome-disconnect-${verdict}`}>
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
 */
function LoginTerminalPanel({
  login,
  serverBaseUrl,
  busy,
  onFinish,
}: {
  login: PendingLogin;
  serverBaseUrl?: string;
  busy: boolean;
  onFinish: () => void;
}) {
  const provider = presentationOf(login.provider);
  return (
    <div className="cred-terminal" data-testid="credential-login-terminal">
      <span className="cred-intro">
        {`Signing in to ${provider.name}. Follow the terminal prompts, then press “I’ve finished signing in”.`}
      </span>
      <span className="cred-notice__why" data-testid="credential-login-expiry">
        {`This terminal runs \`${login.command}\` and expires at ${login.expiresAt}.`}
      </span>

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

      <button
        type="button"
        className="cred-action cred-action--primary"
        onClick={onFinish}
        disabled={busy}
        data-testid="credential-finish-login"
      >
        I’ve finished signing in
      </button>
    </div>
  );
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}
