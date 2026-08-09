/**
 * THE CREDENTIALS SECTION — per-member agent logins, and the first surface on
 * which the four `credentials.*` operations are reachable by a human.
 *
 * IT IS MOUNTED IN THE SAME COMMIT THAT BUILDS IT. That is this lane's one
 * non-negotiable rule, and it is not a style preference: this repository
 * already carries FOUR built, tested, never-imported surfaces
 * (settings-governance's three screens, plus shell/LiveSessionBar), each of
 * them real work no user has ever seen because a lane shipped a component and
 * left the wiring to someone who never came. A plain section a human can reach
 * beats a beautiful one they cannot, so where this file had a choice it spent
 * the effort on being TRUE rather than on being rich.
 *
 * WHAT IT IS ACTUALLY FOR: rendering the honest-degradation contract without
 * collapsing it. Three provider states and one disconnect state are easy to
 * get wrong in a way that looks completely right, and each of them has its own
 * test for exactly that reason:
 *
 *   1. `gitCredentialStore: 'absent'` is UNKNOWN, never "Not connected". 079
 *      ships on the deployed staging line and is reachable from no local git
 *      object, so github's `connected: false` there was never measured. A user
 *      told "Not connected" will try to connect something already connected.
 *   2. `stored: false` with `connected: true` is a CORRECT answer, not an
 *      error: a verified GitHub login has nowhere to be written on this line.
 *   3. anthropic's `login` is `null` FOREVER with `connected: true`. It is
 *      nullable-never-absent precisely so a UI cannot draw two cards for one
 *      permanent fact — so this renders the connection with NO login line at
 *      all: no empty field, no spinner, no "unknown user".
 *   4. `revoked: true` WITH a non-empty `failures[]` is a PARTIAL success that
 *      names what did not settle — not a green tick that hides them, and not a
 *      red that implies the revoke failed.
 *
 * NO STYLESHEET OF ITS OWN. It borrows `settings-space`'s `set-*` classes,
 * which the shell has already loaded around it. That is deliberate: this lane
 * can prove what a component RENDERS in jsdom and cannot prove a width, a
 * scroll or a layout there, so it makes no layout claims to be wrong about.
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
import {
  disconnectVerdictOf,
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
} from './port';

export interface CredentialsSectionProps {
  port: CredentialsPort;
  heading?: string;
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

const PROVIDER_LABEL: Record<CredentialProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  github: 'GitHub',
};

export function CredentialsSection({
  port,
  heading = 'Agent credentials',
  serverBaseUrl,
}: CredentialsSectionProps) {
  const [status, setStatus] = useState<CredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<CredentialProviderName | null>(null);

  const reload = useCallback(() => {
    return port.load().then(
      (next) => { setStatus(next); setLoadError(null); },
      (err: unknown) => setLoadError(String((err as Error)?.message ?? err)),
    );
  }, [port]);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (next) => { if (live) { setStatus(next); setLoadError(null); } },
      (err: unknown) => { if (live) setLoadError(String((err as Error)?.message ?? err)); },
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
      setOutcome({ kind: 'error', provider, message: String((err as Error)?.message ?? err) });
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
      setOutcome({ kind: 'error', provider: login.provider, message: String((err as Error)?.message ?? err) });
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
      setOutcome({ kind: 'error', provider, message: String((err as Error)?.message ?? err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="set-section__head">
        <span className="set-section__title">{heading}</span>
        <div className="set-section__grow" />
      </div>

      <div className="set-section__scroll">
        <span className="set-prose">
          These credentials are YOURS. An agent you launch signs in as you, and nobody else in this
          space can read or use them. Connecting opens a real terminal here and you type into it.
        </span>

        {loadError ? (
          <div className="set-absent" data-testid="credentials-load-error">
            <span className="set-absent__head">Your credentials could not be read.</span>
            <span className="set-absent__why">{loadError}</span>
          </div>
        ) : null}

        {status === null && loadError === null ? (
          <div className="set-absent" data-testid="credentials-loading">
            <span className="set-absent__head">Reading your credentials…</span>
            <span className="set-absent__why">
              nothing below is filled in from a cache — this pane stays empty until the node answers
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

        {status
          ? status.providers.map((entry) => (
              <ProviderCard
                key={entry.provider}
                entry={entry}
                gitCredentialStore={status.gitCredentialStore}
                busy={busy === entry.provider}
                onConnect={() => void connect(entry.provider)}
                onDisconnect={() => void disconnect(entry.provider)}
              />
            ))
          : null}
      </div>
    </>
  );
}

/**
 * ONE PROVIDER. The verdict decides the sentence; nothing here re-derives it
 * from `connected`, so there is exactly one place the three states can be got
 * wrong and it is unit-testable on its own.
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
  return (
    <div className="set-stack" data-testid={`credential-card-${entry.provider}`}>
      <div className="set-kv">
        <span className="set-kv__k">{PROVIDER_LABEL[entry.provider]}</span>
        <span className="set-kv__v" data-testid={`credential-verdict-${entry.provider}`}>
          <VerdictLine verdict={verdict} login={entry.login} />
        </span>
      </div>

      {/* The login line is rendered ONLY when there is a name. `connected-
          unnamed` deliberately produces no row at all — an empty field would
          read as "we could not learn it yet", which is a different and false
          statement about a fact that is permanent. */}
      {verdict === 'connected-named' ? (
        <div className="set-kv">
          <span className="set-kv__k">Account</span>
          <span className="set-kv__v" data-testid={`credential-login-${entry.provider}`}>{entry.login}</span>
        </div>
      ) : null}

      {entry.lastVerifiedAt ? (
        <div className="set-kv">
          <span className="set-kv__k">Verified</span>
          <span className="set-kv__v">{entry.lastVerifiedAt}</span>
        </div>
      ) : null}

      <div className="set-kv">
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          data-testid={`credential-connect-${entry.provider}`}
        >
          {verdict === 'connected-named' || verdict === 'connected-unnamed' ? 'Reconnect' : 'Connect'}
        </button>
        {/* Disconnect is offered under `unknown` too: the member may well BE
            connected on a node whose store this build cannot read, and hiding
            the only way out would strand them. */}
        {verdict === 'disconnected' ? null : (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={busy}
            data-testid={`credential-disconnect-${entry.provider}`}
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

/** THE THREE-AND-A-HALF SENTENCES. Each verdict says a different thing. */
function VerdictLine({ verdict, login }: { verdict: ConnectionVerdict; login: string | null }) {
  switch (verdict) {
    case 'connected-named':
      return <>{`Connected as ${login}`}</>;
    case 'connected-unnamed':
      // Says WHAT was granted instead of naming a who, because there is no who
      // to name and there never will be.
      return <>Connected — inference access</>;
    case 'unknown':
      return (
        <>
          Unknown — this node cannot tell
          <span className="set-absent__why" data-testid="credential-unknown-why">
            {' '}
            the credential store this answer needs does not exist on this node, so nobody has
            measured whether you are connected. You may already be.
          </span>
        </>
      );
    case 'disconnected':
      return <>Not connected</>;
  }
}

/**
 * WHAT THE LAST WRITE ACTUALLY DID. The partial disconnect is the case this
 * exists for: it is the NORMAL outcome, and both a green tick and a red error
 * would be lies about it in opposite directions.
 */
function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'error') {
    return (
      <div className="set-absent" data-testid="credential-outcome-error">
        <span className="set-absent__head">{`${PROVIDER_LABEL[outcome.provider]} — that did not go through.`}</span>
        <span className="set-absent__why">{outcome.message}</span>
      </div>
    );
  }

  if (outcome.kind === 'finish') {
    const r = outcome.result;
    return (
      <div className="set-absent" data-testid="credential-outcome-finish">
        <span className="set-absent__head">
          {r.connected
            ? `${PROVIDER_LABEL[r.provider]} — signed in${r.login ? ` as ${r.login}` : ''}.`
            : `${PROVIDER_LABEL[r.provider]} — that terminal did not end signed in.`}
        </span>
        {/* connected && !stored is a CORRECT outcome (R5), so it is stated as
            a fact about this node rather than dressed as a failure. */}
        {r.connected && !r.stored ? (
          <span className="set-absent__why" data-testid="credential-verified-not-stored">
            Verified, but not saved on this node: there is nowhere to write it here. This is a
            correct result, not an error — your agents will not inherit this login until the
            credential store exists.
          </span>
        ) : null}
      </div>
    );
  }

  const r = outcome.result;
  const verdict = disconnectVerdictOf(r);
  const terminated = r.terminatedCredentialSessionIds.length + r.terminatedAgentSessionIds.length;

  return (
    <div className="set-absent" data-testid={`credential-outcome-disconnect-${verdict}`}>
      <span className="set-absent__head">
        {verdict === 'failed'
          ? `${PROVIDER_LABEL[r.provider]} — not disconnected.`
          : verdict === 'partial'
            ? `${PROVIDER_LABEL[r.provider]} — disconnected, but ${r.failures.length} thing${r.failures.length === 1 ? '' : 's'} did not settle.`
            : `${PROVIDER_LABEL[r.provider]} — disconnected.`}
      </span>

      {verdict !== 'failed' ? (
        <span className="set-absent__why">
          {`The credential was revoked${terminated > 0 ? ` and ${terminated} running session${terminated === 1 ? '' : 's'} stopped` : ''}. An agent that already read the secret still holds it in memory — to fully revoke it, rotate the credential at the vendor.`}
        </span>
      ) : null}

      {/* NAMED, not counted. "Some cleanup failed" tells the user nothing they
          can act on; the step and the session id are what they need to go and
          look. */}
      {r.failures.length > 0 ? (
        <ul data-testid="credential-disconnect-failures">
          {r.failures.map((f, i) => (
            <li key={`${f.step}-${f.sessionId ?? i}`} className="set-absent__why">
              {`${f.step}${f.sessionId ? ` (${f.sessionId})` : ''}: ${f.reason}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * THE LOGIN TERMINAL, hosted through the existing terminal module rather than
 * reimplemented — it is an ordinary PTY work_session and `LiveTerminal` already
 * knows the transport, the offset-resume law and the write scheduler.
 *
 * When the live terminal is switched off (as it is under test, by
 * `liveTerminalFlag`'s MODE==='test' default) this renders the reserved host
 * box and SAYS the terminal is not mounted, rather than drawing a black
 * rectangle that implies bytes could arrive.
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
  return (
    <div className="set-stack" data-testid="credential-login-terminal">
      <span className="set-prose">
        {`Signing in to ${PROVIDER_LABEL[login.provider]}. Follow the prompts in the terminal below, then press “I’ve finished signing in”.`}
      </span>
      <span className="set-absent__why" data-testid="credential-login-expiry">
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
        /* `placeholder` is a STRING, not children — TerminalHost renders no
           children at all, and passing them would have silently drawn an empty
           black box. The reason goes in the box's own ghost line. */
        <TerminalHost
          ariaLabel={`${PROVIDER_LABEL[login.provider]} login terminal`}
          placeholder="the live terminal is disabled in this build, so this login cannot be completed here"
        />
      )}

      <button type="button" onClick={onFinish} disabled={busy} data-testid="credential-finish-login">
        I’ve finished signing in
      </button>
    </div>
  );
}
