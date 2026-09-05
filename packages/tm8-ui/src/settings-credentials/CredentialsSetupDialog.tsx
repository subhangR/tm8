/**
 * THE GUIDED SETUP FLOW — a modal, opened for a member who has not finished
 * connecting their agent tools (Subhang, 2026-09-05).
 *
 * WHY A DIALOG AND NOT A PANEL ON HOME. This surface used to live on the home
 * canvas as two stacked sections. It was shown to everyone forever, whether or
 * not they had anything left to connect, and — because a card grid is a flex
 * item with `min-height: auto` and nothing shrank it — it overran the page box
 * and painted over the chat underneath. A flow with a beginning and an end is
 * not a permanent region of a screen; it is a thing you open, finish and close.
 *
 * WHAT IT DOES NOT DO. It does not re-implement a single provider fact, verdict
 * or write. Every action goes through the same {@link CredentialsPort} Settings
 * uses, every mark and name comes from `provider-presentation`, and the
 * finished/unfinished question is `setup-gate`'s alone. This file owns only the
 * ARRANGEMENT: which step you are on, and what the terminal is allowed to look
 * like while you are on it.
 *
 * THE TERMINAL IS DEMOTED, NOT REMOVED, AND IT CANNOT BE. The login commands
 * are fixed server-side in `CredentialSessionLauncher.ts` — `claude auth login`,
 * `codex login --device-auth`, `gh auth login --web …` — and they are genuinely
 * interactive: there is no headless exchange to call instead. So the step shows
 * a plain-English instruction and hides the live PTY behind a disclosure, while
 * keeping it MOUNTED and typeable the whole time. Two things follow, both
 * deliberate:
 *
 *   · The disclosure renders the terminal at all times and toggles a `hidden`
 *     attribute on its wrapper rather than unmounting it. A PTY that unmounts
 *     when you collapse the section loses the session you were typing into.
 *   · Nothing here parses the terminal's output. Scraping a device code out of
 *     a vendor's stream would look better and would silently rot the first time
 *     that vendor rewords a prompt — and it would rot into a flow that LOOKS
 *     fine, which is the worst failure this dialog could have.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  CredentialProviderName,
  CredentialsLoginSessionFinishResult,
  CredentialsStatusView,
} from '@tm8/contract';
import { LiveTerminal, TerminalHost, isLiveTerminalEnabled } from '../terminal';
import { presentationOf } from './provider-presentation';
import type { CredentialsPort } from './port';
import {
  credentialSetupState,
  GIT_PROVIDER,
  type CredentialSetupState,
  type ProviderStanding,
} from './setup-gate';
import './credentials-setup.css';

export interface CredentialsSetupDialogProps {
  open: boolean;
  port: CredentialsPort;
  /** Same-origin route prefix for the node that owns the login terminal. */
  serverBaseUrl?: string;
  /**
   * Dismissed WITHOUT finishing — the host records this so the flow stops
   * opening itself. Distinct from `onClose`, which is just "put it away".
   */
  onDismiss(): void;
  onClose(): void;
}

/** Where the dialog is. `intro` is the welcome the member opens onto. */
type Stage =
  | { kind: 'intro' }
  | { kind: 'picking' }
  | {
      kind: 'connecting';
      provider: CredentialProviderName;
      workSessionId: string;
      command: string;
      expiresAt: string;
    }
  | { kind: 'done' };

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/**
 * The sentence for one provider's step, in the second person. Kept beside the
 * step rather than in the presentation table because it describes what the
 * MEMBER does, not what the provider is — the table is shared with two other
 * surfaces that make no such instruction.
 */
function instructionFor(provider: CredentialProviderName): string {
  switch (provider) {
    case 'anthropic':
      return 'A browser tab will open for you to approve. If it does not, the terminal below prints a link to paste.';
    case 'openai':
      return 'The terminal below prints a short code and a link. Open the link, enter the code, and approve.';
    case 'github':
      return 'A browser tab will open to authorise GitHub. Approve it there, then come back to this window.';
    case 'gemini':
      return 'Follow the prompts in the terminal below — Gemini asks which account to sign in with.';
    default:
      return 'Follow the prompts in the terminal below, then come back to this window.';
  }
}

export function CredentialsSetupDialog({
  open,
  port,
  serverBaseUrl,
  onDismiss,
  onClose,
}: CredentialsSetupDialogProps) {
  const [status, setStatus] = useState<CredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<CredentialsLoginSessionFinishResult | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const headingId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const next = await port.load();
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(messageOf(error));
      return null;
    }
  }, [port]);

  // The read happens on OPEN, not on mount: a dialog the host keeps mounted
  // and closed must not poll a human-only operation nobody asked for.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void port.load().then(
      (next) => { if (live) { setStatus(next); setLoadError(null); } },
      (error: unknown) => { if (live) setLoadError(messageOf(error)); },
    );
    return () => { live = false; };
  }, [open, port]);

  /* Escape closes — but NEVER while a login terminal is live. Esc is the key
     a person presses at a prompt they are stuck on, and the terminal is
     focused: closing the dialog out from under a half-finished OAuth flow
     would abandon a session that is still running on the node. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (stage.kind === 'connecting') return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, stage.kind, onClose]);

  useEffect(() => {
    if (open) cardRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const setup: CredentialSetupState | null = status ? credentialSetupState(status) : null;

  async function startLogin(provider: CredentialProviderName) {
    setBusy(true);
    setStepError(null);
    setLastResult(null);
    setTerminalOpen(false);
    try {
      const started = await port.startLogin(provider);
      setStage({
        kind: 'connecting',
        provider,
        workSessionId: started.workSessionId,
        command: started.command,
        expiresAt: started.expiresAt,
      });
    } catch (error) {
      setStepError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function finishLogin(workSessionId: string) {
    setBusy(true);
    setStepError(null);
    try {
      const result = await port.finishLogin(workSessionId);
      setLastResult(result);
      const next = await reload();
      const state = next ? credentialSetupState(next) : null;
      setStage(state?.complete ? { kind: 'done' } : { kind: 'picking' });
    } catch (error) {
      setStepError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  /* CLOSING AND DISMISSING ARE DIFFERENT ANSWERS, and until review both of the
     button-shaped exits meant DISMISS. "Later"/"Finish later" write the
     permanent per-account record; the non-dismissing close was Escape alone.
     So a member who opened "Agent tools" from the account menu just to look,
     and clicked the only obvious way out, silently turned the flow off for
     good. The × and the backdrop are that missing exit — they CLOSE.

     Neither is offered while a login terminal is live, for the reason Escape
     is not: a stray backdrop click must not abandon a half-finished OAuth flow
     that is still running on the node. */
  const closable = stage.kind !== 'connecting';

  return (
    <div
      className="cset-scrim"
      data-testid="credentials-setup-dialog"
      onMouseDown={(event) => {
        if (!closable) return;
        // The TARGET test matters: without it a drag that starts inside the
        // card and releases on the backdrop would close the dialog.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cset-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={cardRef}
      >
        {closable ? (
          <button
            type="button"
            className="cset-close"
            aria-label="Close"
            title="Close — this does not turn the setup off"
            onClick={onClose}
            data-testid="cset-x"
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
        {stage.kind === 'intro' ? (
          <IntroPane
            headingId={headingId}
            setup={setup}
            loadError={loadError}
            onStart={() => setStage({ kind: 'picking' })}
            onLater={onDismiss}
          />
        ) : null}

        {stage.kind === 'picking' ? (
          <PickPane
            headingId={headingId}
            setup={setup}
            loadError={loadError}
            busy={busy}
            stepError={stepError}
            lastResult={lastResult}
            onConnect={(provider) => void startLogin(provider)}
            onLater={onDismiss}
            onDone={onClose}
          />
        ) : null}

        {stage.kind === 'connecting' ? (
          <ConnectPane
            headingId={headingId}
            provider={stage.provider}
            workSessionId={stage.workSessionId}
            command={stage.command}
            expiresAt={stage.expiresAt}
            serverBaseUrl={serverBaseUrl}
            busy={busy}
            stepError={stepError}
            terminalOpen={terminalOpen}
            onToggleTerminal={() => setTerminalOpen((v) => !v)}
            onFinish={() => void finishLogin(stage.workSessionId)}
            onCancel={() => setStage({ kind: 'picking' })}
          />
        ) : null}

        {stage.kind === 'done' ? (
          <DonePane headingId={headingId} onClose={onClose} />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function IntroPane({
  headingId,
  setup,
  loadError,
  onStart,
  onLater,
}: {
  headingId: string;
  setup: CredentialSetupState | null;
  loadError: string | null;
  onStart(): void;
  onLater(): void;
}) {
  return (
    <>
      <header className="cset-head">
        <span className="cset-eyebrow">Welcome to tm8</span>
        <h2 className="cset-title" id={headingId}>Set up your agent tools</h2>
      </header>

      <div className="cset-body">
        <p className="cset-prose">
          Agents you launch sign in <strong>as you</strong>. Connecting a tool here lets a
          session think with your account; connecting GitHub lets the work it does leave this
          machine as a branch, a commit and a pull request.
        </p>
        <p className="cset-prose cset-prose--quiet">
          These credentials are yours. Nobody else in this space can read or use them, and no
          secret passes through this screen — you type into a real terminal that runs on this node.
        </p>

        {loadError ? (
          <p className="cset-notice cset-notice--error" role="alert" data-testid="cset-load-error">
            Your credentials could not be read: {loadError}
          </p>
        ) : null}

        {setup ? <StepChecklist setup={setup} /> : null}
      </div>

      <footer className="cset-foot">
        <button type="button" className="cset-btn" onClick={onLater} data-testid="cset-later">
          Later
        </button>
        <button
          type="button"
          className="cset-btn cset-btn--primary"
          onClick={onStart}
          data-testid="cset-start"
        >
          Set up
        </button>
      </footer>
    </>
  );
}

function PickPane({
  headingId,
  setup,
  loadError,
  busy,
  stepError,
  lastResult,
  onConnect,
  onLater,
  onDone,
}: {
  headingId: string;
  setup: CredentialSetupState | null;
  loadError: string | null;
  busy: boolean;
  stepError: string | null;
  lastResult: CredentialsLoginSessionFinishResult | null;
  onConnect(provider: CredentialProviderName): void;
  onLater(): void;
  onDone(): void;
}) {
  return (
    <>
      <header className="cset-head">
        <span className="cset-eyebrow">Agent tools</span>
        <h2 className="cset-title" id={headingId}>Connect your tools</h2>
      </header>

      <div className="cset-body">
        {loadError ? (
          <p className="cset-notice cset-notice--error" role="alert">
            Your credentials could not be read: {loadError}
          </p>
        ) : null}

        {/* A finished login that did not end connected is the single most
            confusing outcome in this flow, so it is stated before the list
            rather than left for the member to infer from an unchanged row. */}
        {lastResult ? (
          <p
            className={`cset-notice${lastResult.connected ? '' : ' cset-notice--error'}`}
            role="status"
            data-testid="cset-last-result"
          >
            {lastResult.connected
              ? `${presentationOf(lastResult.provider).name} is connected${lastResult.login ? ` as ${lastResult.login}` : ''}.`
              : `${presentationOf(lastResult.provider).name} — that terminal did not end signed in. You can try again.`}
            {lastResult.connected && !lastResult.stored ? (
              <span className="cset-notice__why">
                Verified, but not saved on this node — your agents will not inherit this login
                until the credential store exists here.
              </span>
            ) : null}
          </p>
        ) : null}

        {stepError ? (
          <p className="cset-notice cset-notice--error" role="alert" data-testid="cset-step-error">
            {stepError}
          </p>
        ) : null}

        {setup ? (
          <>
            <StepChecklist setup={setup} />
            <ProviderList setup={setup} busy={busy} onConnect={onConnect} />
          </>
        ) : (
          <p className="cset-prose cset-prose--quiet" role="status">Reading your credentials…</p>
        )}
      </div>

      <footer className="cset-foot">
        <button type="button" className="cset-btn" onClick={onLater} data-testid="cset-later">
          Finish later
        </button>
        <button
          type="button"
          className="cset-btn cset-btn--primary"
          onClick={onDone}
          disabled={!setup?.complete}
          data-testid="cset-done"
          title={setup?.complete ? undefined : 'Connect one agent tool and GitHub to finish'}
        >
          Done
        </button>
      </footer>
    </>
  );
}

function ConnectPane({
  headingId,
  provider,
  workSessionId,
  command,
  expiresAt,
  serverBaseUrl,
  busy,
  stepError,
  terminalOpen,
  onToggleTerminal,
  onFinish,
  onCancel,
}: {
  headingId: string;
  provider: CredentialProviderName;
  workSessionId: string;
  command: string;
  expiresAt: string;
  serverBaseUrl?: string;
  busy: boolean;
  stepError: string | null;
  terminalOpen: boolean;
  onToggleTerminal(): void;
  onFinish(): void;
  onCancel(): void;
}) {
  const presentation = presentationOf(provider);
  const Mark = presentation.icon;

  return (
    <>
      <header className="cset-head">
        <span className="cset-eyebrow">Signing in</span>
        <h2 className="cset-title" id={headingId}>
          <span className="cset-title__mark" aria-hidden="true"><Mark /></span>
          {presentation.name}
        </h2>
      </header>

      <div className="cset-body">
        <p className="cset-step" data-testid="cset-instruction">
          <span className="cset-spinner" aria-hidden="true" />
          {instructionFor(provider)}
        </p>

        {stepError ? (
          <p className="cset-notice cset-notice--error" role="alert" data-testid="cset-step-error">
            {stepError}
          </p>
        ) : null}

        {/* THE TERMINAL IS ALWAYS MOUNTED. `hidden` toggles visibility; it is
            never unmounted, because unmounting a live PTY mid-login throws
            away the session the member is typing into. */}
        <div className="cset-term">
          <button
            type="button"
            className="cset-term__toggle"
            aria-expanded={terminalOpen}
            onClick={onToggleTerminal}
            data-testid="cset-terminal-toggle"
          >
            <span className="cset-term__caret" aria-hidden="true">{terminalOpen ? '▾' : '▸'}</span>
            {terminalOpen ? 'Hide terminal output' : 'Show terminal output'}
          </button>

          <div className="cset-term__body" hidden={!terminalOpen} data-testid="cset-terminal-body">
            <p className="cset-term__note">
              This runs <code>{command}</code> on this node, and expires at {expiresAt}. You can
              type into it.
            </p>
            {isLiveTerminalEnabled() ? (
              <LiveTerminal
                sessionId={workSessionId}
                serverBaseUrl={serverBaseUrl}
                live
                autoFocus={terminalOpen}
              />
            ) : (
              <TerminalHost
                ariaLabel={`${presentation.name} login terminal`}
                placeholder="the live terminal is disabled in this build, so this login cannot be completed here"
              />
            )}
          </div>
        </div>
      </div>

      <footer className="cset-foot">
        <button
          type="button"
          className="cset-btn"
          onClick={onCancel}
          disabled={busy}
          data-testid="cset-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="cset-btn cset-btn--primary"
          onClick={onFinish}
          disabled={busy}
          data-testid="cset-finish"
        >
          I've finished signing in
        </button>
      </footer>
    </>
  );
}

function DonePane({ headingId, onClose }: { headingId: string; onClose(): void }) {
  return (
    <>
      <header className="cset-head">
        <span className="cset-eyebrow">All set</span>
        <h2 className="cset-title" id={headingId}>You're ready to launch agents</h2>
      </header>
      <div className="cset-body">
        <p className="cset-prose" data-testid="cset-done-copy">
          An agent tool and GitHub are both connected. Sessions you launch will sign in as you and
          can push branches and open pull requests.
        </p>
        <p className="cset-prose cset-prose--quiet">
          You can add more tools, or disconnect any of them, from Settings → Agent credentials.
        </p>
      </div>
      <footer className="cset-foot">
        <button
          type="button"
          className="cset-btn cset-btn--primary"
          onClick={onClose}
          data-testid="cset-close"
        >
          Close
        </button>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The two-part gate, stated as the two things it actually is. */
function StepChecklist({ setup }: { setup: CredentialSetupState }) {
  const steps = [
    {
      key: 'agent',
      done: setup.hasAgent,
      label: 'An agent tool',
      why: 'lets a session think with your account',
    },
    {
      key: 'git',
      done: setup.hasGit,
      label: 'GitHub',
      why: 'lets agents push branches and open pull requests',
    },
  ];

  return (
    <ul className="cset-checks" data-testid="cset-checklist">
      {steps.map((step) => (
        <li
          key={step.key}
          className={`cset-check${step.done ? ' cset-check--done' : ''}`}
          data-done={step.done ? 'true' : 'false'}
          data-testid={`cset-check-${step.key}`}
        >
          <span className="cset-check__mark" aria-hidden="true">{step.done ? '✓' : '○'}</span>
          <span className="cset-check__label">{step.label}</span>
          <span className="cset-check__why">{step.why}</span>
        </li>
      ))}
    </ul>
  );
}

function ProviderList({
  setup,
  busy,
  onConnect,
}: {
  setup: CredentialSetupState;
  busy: boolean;
  onConnect(provider: CredentialProviderName): void;
}) {
  /* GitHub sorts LAST and is labelled as its own half of the gate — it is not
     one of the interchangeable agent tools above it, and a list that mixes
     them invites a member to connect six agents and still not be finished. */
  const agents = setup.agents;
  const git = setup.git;

  return (
    <>
      <p className="cset-grouphead">Pick an agent tool — one is enough</p>
      <div className="cset-list">
        {agents.map((standing) => (
          <ProviderRow
            key={standing.provider}
            standing={standing}
            busy={busy}
            onConnect={onConnect}
          />
        ))}
      </div>

      {git ? (
        <>
          <p className="cset-grouphead">And connect GitHub</p>
          <div className="cset-list">
            <ProviderRow standing={git} busy={busy} onConnect={onConnect} />
          </div>
        </>
      ) : (
        <p className="cset-notice" data-testid="cset-no-git-row">
          This node did not list {GIT_PROVIDER} at all, so it cannot be connected from here.
        </p>
      )}
    </>
  );
}

/**
 * One provider row. The four verdicts keep their four different sentences —
 * an unavailable binary and an unmeasured probe are not "not connected".
 *
 * THE TWO NEGATIVE VERDICTS GET DIFFERENT TREATMENT, deliberately. An absent
 * binary has NO action: a login for a program that is not installed cannot
 * finish, so the row is inert. An UNMEASURED provider does get one, labelled
 * "Sign in anyway" — the member may well already be signed in, and the honest
 * offer is a login they can choose to repeat, not a button withheld on a doubt
 * this node was unable to resolve.
 */
function ProviderRow({
  standing,
  busy,
  onConnect,
}: {
  standing: ProviderStanding;
  busy: boolean;
  onConnect(provider: CredentialProviderName): void;
}) {
  const presentation = presentationOf(standing.provider);
  const Mark = presentation.icon;

  return (
    <div
      className="cset-row"
      data-provider-state={standing.verdict}
      data-testid={`cset-row-${standing.provider}`}
    >
      <span className="cset-row__mark" aria-hidden="true"><Mark /></span>
      <span className="cset-row__text">
        <span className="cset-row__name">{presentation.name}</span>
        <span className="cset-row__state" data-testid={`cset-state-${standing.provider}`}>
          {standing.verdict === 'connected-named'
            ? 'Connected'
            : standing.verdict === 'connected-unnamed'
              ? 'Connected'
              : standing.verdict === 'unavailable'
                ? `${presentation.binary} is not installed on this node`
                : standing.verdict === 'unknown'
                  ? 'Could not be checked — you may already be signed in'
                  : 'Not connected'}
        </span>
      </span>

      {standing.unavailable ? (
        <span className="cset-row__inert" data-testid={`cset-inert-${standing.provider}`}>
          unavailable
        </span>
      ) : (
        <button
          type="button"
          className="cset-row__btn"
          onClick={() => onConnect(standing.provider)}
          disabled={busy}
          data-testid={`cset-connect-${standing.provider}`}
        >
          {standing.connected ? 'Reconnect' : standing.unmeasured ? 'Sign in anyway' : 'Connect'}
        </button>
      )}
    </div>
  );
}
