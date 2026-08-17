/**
 * THE CREDENTIALS SECTION — the viewer's OWN stored logins, and the first
 * surface on which the four `credentials.*` operations are reachable by a
 * human.
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
 * ─── THE 2026-08-16 LAYOUT PASS ────────────────────────────────────────────
 *
 * The section is now built on `SectionFrame` (SECTION-CONTRACT.md §2) rather
 * than hand-transcribing the shell's head/scroll pair, which is what twelve
 * independent transcriptions had drifted out of. Four things were WRONG and
 * are fixed here; each is a measurement, not a taste:
 *
 *   A. NO MEASURE AND NO GUTTER. The old body was children of a bare
 *      `.set-section__scroll`, which carries neither. The lede sentence
 *      therefore started at x=0, hard against the card's left edge and 6px
 *      out of line with the 18px head above it, and ran the card's full
 *      1080px — 220px past the 860px reading measure. `SectionFrame`'s
 *      default `measure` + `pad` is the whole fix.
 *   B. NO EMPTY STATE. `status.providers.map(…)` over an empty array renders
 *      nothing, so a status view with no providers drew a lede and then bare
 *      paper. Contract §7.4 wants a real `SectionAbsent`, and there is now
 *      one.
 *   C. EXPIRED WAS INVISIBLE. `CredentialConnectionView.status` is
 *      `'active' | 'stale' | 'revoked' | null` and NOTHING rendered it. A
 *      credential with `connected: true, status: 'stale'` was drawn
 *      identically to a healthy one — same words, same single "Reconnect"
 *      button, no hint that agents launched right now would fail. Connected /
 *      not-connected / expired are three states with three next actions, and
 *      they are now three visibly different cards. `verdictOf` is untouched:
 *      staleness is a second axis over the connection, not a fifth verdict,
 *      and folding it in would have changed a function four other tests pin.
 *   D. UNSTYLED CONTROLS. Connect and Disconnect were bare `<button>`s —
 *      user-agent chrome in the middle of a designed surface — and they lived
 *      inside a `.set-kv`, a key/value row whose first child is supposed to be
 *      a 96px label. They are now `.set-chip` / `.set-ghost`, the two button
 *      shapes the rest of settings already uses, in a wrapping action row.
 *
 * NO SECRET IS RENDERED, and that is now checked rather than assumed:
 * `CredentialConnectionView` carries `provider`, `connected`, `login`,
 * `authMethod`, `status`, `connectedAt`, `lastVerifiedAt` — and
 * `CredentialsLoginSessionFinishResult` adds `stored` and `terminated`. There
 * is no token, key, cookie or header field anywhere in the DTOs this file can
 * see, so there is nothing here to leak; `login` is a public account handle
 * and `authMethod` is the word `oauth`. `credentials.test.tsx` pins that by
 * walking this module's rendered DOM for secret-shaped text.
 *
 * IT IS PER-ACCOUNT, NOT PER-SPACE, and it sits in the nav between two
 * space-scoped sections (Models above it, the space's own Danger zone below).
 * That is a real trap — everything either side of it is a space setting — so
 * the section SAYS which scope it is on rather than leaving the reader to
 * infer it from the nav position.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsDeleteResult,
  CredentialsLoginSessionFinishResult,
  CredentialsStatusView,
} from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import { LiveTerminal, TerminalHost, isLiveTerminalEnabled } from '../terminal';
import {
  disconnectVerdictOf,
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
} from './port';
import './credentials.css';

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

/** What each provider's credential is actually FOR — the reason to connect it. */
const PROVIDER_PURPOSE: Record<CredentialProviderName, string> = {
  anthropic: 'Model access for agents you launch.',
  openai: 'Model access for agents you launch.',
  github: 'Cloning, pushing and opening pull requests as you.',
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
    <SectionFrame title={heading} bodyTestId="credentials-body">
      <span className="set-prose set-cred__lede">
        These credentials are YOURS. An agent you launch signs in as you, and nobody else in this
        space can read or use them. Connecting opens a real terminal here and you type into it —
        the secret never passes through this screen, and no value below is a secret.
      </span>

      {/* The scope trap, said out loud. Every other section in this nav is a
          setting on the SPACE; this one is a setting on the account, and it is
          sandwiched between two of them. */}
      <span className="set-cred__why set-cred__scope" data-testid="credentials-scope">
        Per account, not per space. These logins follow you into every space you are a member of;
        the sections above and below this one change the space instead.
      </span>

      {loadError ? (
        <SectionAbsent
          testId="credentials-load-error"
          head="Your credentials could not be read."
          why={loadError}
        />
      ) : null}

      {status === null && loadError === null ? (
        <SectionAbsent
          testId="credentials-loading"
          head="Reading your credentials…"
          why="nothing below is filled in from a cache — this pane stays empty until the node answers"
        />
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

      {/* THE EMPTY STATE (contract §7.4). `providers` is documented as always
          carrying all three, so a zero-length array is a node telling us
          something rather than a normal quiet day — and drawing nothing at all
          would have read as "you have no logins", which is a different claim
          and one nobody measured. */}
      {status && status.providers.length === 0 ? (
        <SectionAbsent
          testId="credentials-empty"
          head="This node listed no providers at all."
          why="credentials.status answered with an empty provider list — it is documented to return one entry per provider, so this is the node reporting a gap, not a statement that you have no logins"
        />
      ) : null}

      {status && status.providers.length > 0 ? (
        <div className="set-cred__list">
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
    </SectionFrame>
  );
}

/**
 * THE SECOND AXIS. `verdictOf` answers "is there a connection", which is not
 * the same question as "does the connection still work", and the DTO carries
 * both. A `stale` or `revoked` status under `connected: true` is the expired
 * case: the row exists, so nothing about the verdict is wrong, and an agent
 * launched against it will still fail.
 *
 * Deliberately NOT folded into `ConnectionVerdict`: that type is pinned by
 * four tests and consumed by `verdictOf`'s own honest-degradation logic, and
 * widening it to five values would make every exhaustive switch over it a
 * silent fall-through.
 */
type Health = 'ok' | 'expired';

function healthOf(entry: CredentialConnectionView, verdict: ConnectionVerdict): Health {
  if (verdict !== 'connected-named' && verdict !== 'connected-unnamed') return 'ok';
  return entry.status === 'stale' || entry.status === 'revoked' ? 'expired' : 'ok';
}

/** The pill word for each state. Colour never carries the state on its own. */
function pillFor(verdict: ConnectionVerdict, health: Health): { word: string; mod: string } {
  if (verdict === 'unknown') return { word: 'Unknown', mod: 'unknown' };
  if (verdict === 'disconnected') return { word: 'Not connected', mod: 'off' };
  if (health === 'expired') return { word: 'Expired', mod: 'expired' };
  return { word: 'Connected', mod: 'on' };
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
  const health = healthOf(entry, verdict);
  const pill = pillFor(verdict, health);
  const connected = verdict === 'connected-named' || verdict === 'connected-unnamed';

  return (
    <div className="set-cred__card" data-testid={`credential-card-${entry.provider}`}>
      <div className="set-cred__head">
        <span className="set-cred__name">{PROVIDER_LABEL[entry.provider]}</span>
        <span
          className={`set-cred__pill set-cred__pill--${pill.mod}`}
          data-testid={`credential-pill-${entry.provider}`}
        >
          {pill.word}
        </span>
      </div>

      {/* WHY THIS ONE IS WORTH CONNECTING — three providers with three
          different jobs read as three interchangeable rows without it. */}
      <span className="set-cred__why">{PROVIDER_PURPOSE[entry.provider]}</span>

      {/* The unknown verdict's reason is a BLOCK under the head, not a
          fragment spliced into the value cell: 9px mono baseline-aligned
          against 12px body inside one flex row was the worst line on the
          screen. */}
      {verdict === 'unknown' ? (
        <span className="set-cred__why" data-testid="credential-unknown-why">
          the credential store this answer needs does not exist on this node, so nobody has
          measured whether you are connected. You may already be.
        </span>
      ) : null}

      {/* EXPIRED SAYS WHAT TO DO. Its next action differs from both of the
          others: not "connect this", not "you are fine" — "sign in again
          before your next launch". */}
      {health === 'expired' ? (
        <span className="set-cred__why" data-testid={`credential-expired-why-${entry.provider}`}>
          {`this login is recorded as ${entry.status} — it is still stored, and an agent launched with it will fail. Reconnect to refresh it.`}
        </span>
      ) : null}

      {/* The facts, as a labelled grid rather than a stack of flex rows that
          each re-declare their own label width. Every one of these is
          public: an account handle, the word `oauth`, and two timestamps. */}
      <div className="set-cred__facts">
        {/* THE STATE SENTENCE, as a labelled row rather than a phrase sitting
            beside the pill. Measured in Chrome 2026-08-16: on one line the two
            read "CONNECTED Connected — inference access" — the same word
            twice, 6px apart. They are not redundant (the pill scans, the
            sentence is precise and is what a screen reader gets), but they must
            not be adjacent. */}
        <span className="set-cred__k">Status</span>
        <span className="set-cred__v" data-testid={`credential-verdict-${entry.provider}`}>
          <VerdictLine verdict={verdict} />
        </span>

        {/* The login line is rendered ONLY when there is a name. `connected-
            unnamed` deliberately produces no row at all — an empty field would
            read as "we could not learn it yet", which is a different and false
            statement about a fact that is permanent. */}
        {verdict === 'connected-named' ? (
          <>
            <span className="set-cred__k">Account</span>
            <span className="set-cred__v" data-testid={`credential-login-${entry.provider}`}>
              {entry.login}
            </span>
          </>
        ) : null}

        {connected && entry.authMethod ? (
          <>
            <span className="set-cred__k">Method</span>
            <span className="set-cred__v" data-testid={`credential-method-${entry.provider}`}>
              {entry.authMethod}
            </span>
          </>
        ) : null}

        {entry.connectedAt ? (
          <>
            <span className="set-cred__k">Connected</span>
            <span className="set-cred__v set-cred__v--stamp">{entry.connectedAt}</span>
          </>
        ) : null}

        {entry.lastVerifiedAt ? (
          <>
            <span className="set-cred__k">Verified</span>
            <span className="set-cred__v set-cred__v--stamp">{entry.lastVerifiedAt}</span>
          </>
        ) : null}
      </div>

      <div className="set-cred__actions">
        <button
          type="button"
          className="set-chip"
          onClick={onConnect}
          disabled={busy}
          data-testid={`credential-connect-${entry.provider}`}
        >
          {connected ? 'Reconnect' : 'Connect'}
        </button>
        {/* Disconnect is offered under `unknown` too: the member may well BE
            connected on a node whose store this build cannot read, and hiding
            the only way out would strand them. */}
        {verdict === 'disconnected' ? null : (
          <button
            type="button"
            className="set-ghost"
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

/**
 * THE THREE-AND-A-HALF SENTENCES. Each verdict says a different thing.
 *
 * `connected-named` no longer prints the name here. It used to read "Connected
 * as ada@…" — and the ACCOUNT row directly beneath it prints the same address
 * again, so the card said one fact twice in two type sizes. The name belongs
 * to the labelled row; this line's job is the state.
 */
function VerdictLine({ verdict }: { verdict: ConnectionVerdict }) {
  switch (verdict) {
    case 'connected-named':
      return <>Connected</>;
    case 'connected-unnamed':
      // Says WHAT was granted instead of naming a who, because there is no who
      // to name and there never will be.
      return <>Connected — inference access</>;
    case 'unknown':
      return <>Unknown — this node cannot tell</>;
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
      <div className="set-cred__outcome set-cred__outcome--bad" data-testid="credential-outcome-error">
        <span className="set-cred__outcome-head">{`${PROVIDER_LABEL[outcome.provider]} — that did not go through.`}</span>
        <span className="set-cred__why">{outcome.message}</span>
      </div>
    );
  }

  if (outcome.kind === 'finish') {
    const r = outcome.result;
    return (
      <div
        className={`set-cred__outcome set-cred__outcome--${r.connected ? 'good' : 'bad'}`}
        data-testid="credential-outcome-finish"
      >
        <span className="set-cred__outcome-head">
          {r.connected
            ? `${PROVIDER_LABEL[r.provider]} — signed in${r.login ? ` as ${r.login}` : ''}.`
            : `${PROVIDER_LABEL[r.provider]} — that terminal did not end signed in.`}
        </span>
        {/* connected && !stored is a CORRECT outcome (R5), so it is stated as
            a fact about this node rather than dressed as a failure. */}
        {r.connected && !r.stored ? (
          <span className="set-cred__why" data-testid="credential-verified-not-stored">
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
  const tone = verdict === 'failed' ? 'bad' : verdict === 'partial' ? 'partial' : 'good';

  return (
    <div
      className={`set-cred__outcome set-cred__outcome--${tone}`}
      data-testid={`credential-outcome-disconnect-${verdict}`}
    >
      <span className="set-cred__outcome-head">
        {verdict === 'failed'
          ? `${PROVIDER_LABEL[r.provider]} — not disconnected.`
          : verdict === 'partial'
            ? `${PROVIDER_LABEL[r.provider]} — disconnected, but ${r.failures.length} thing${r.failures.length === 1 ? '' : 's'} did not settle.`
            : `${PROVIDER_LABEL[r.provider]} — disconnected.`}
      </span>

      {verdict !== 'failed' ? (
        <span className="set-cred__why">
          {`The credential was revoked${terminated > 0 ? ` and ${terminated} running session${terminated === 1 ? '' : 's'} stopped` : ''}. An agent that already read the secret still holds it in memory — to fully revoke it, rotate the credential at the vendor.`}
        </span>
      ) : null}

      {/* NAMED, not counted. "Some cleanup failed" tells the user nothing they
          can act on; the step and the session id are what they need to go and
          look. */}
      {r.failures.length > 0 ? (
        <ul className="set-cred__failures" data-testid="credential-disconnect-failures">
          {r.failures.map((f, i) => (
            <li key={`${f.step}-${f.sessionId ?? i}`}>
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
 *
 * The host sits in a HEIGHT-BOUNDED wrapper (contract §3): `.term-host` is
 * `flex: 1 1 auto; min-height: 160px`, and dropped straight into the section's
 * one scroller — a block box — that resolves to a 160px letterbox with no
 * relationship to the space available.
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
    <div className="set-cred__login" data-testid="credential-login-terminal">
      <span className="set-prose">
        {`Signing in to ${PROVIDER_LABEL[login.provider]}. Follow the prompts in the terminal below, then press “I’ve finished signing in”.`}
      </span>
      <span className="set-cred__why" data-testid="credential-login-expiry">
        {`This terminal runs \`${login.command}\` and expires at ${login.expiresAt}.`}
      </span>

      <div className="set-cred__term">
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
      </div>

      <div className="set-cred__actions">
        <button
          type="button"
          className="set-chip"
          onClick={onFinish}
          disabled={busy}
          data-testid="credential-finish-login"
        >
          I’ve finished signing in
        </button>
      </div>
    </div>
  );
}
