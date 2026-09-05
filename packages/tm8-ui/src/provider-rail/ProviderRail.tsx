/**
 * The compact credential density: the settings card table supplies every
 * provider mark/name and the credentials port supplies every state/action.
 * This directory deliberately owns no provider-specific presentation facts.
 *
 * ⚠ CURRENTLY MOUNTED NOWHERE (2026-09-05). Home was this component's only
 * host, and the credential sections were removed from Home when the guided
 * setup dialog replaced them — `settings-credentials/mounted.test.tsx` now
 * asserts Home does NOT render it.
 *
 * IT IS KEPT RATHER THAN DELETED, and this note exists so that is a decision
 * on the record rather than an oversight. It landed in #586 days ago, it is
 * the only compact density of the credential vocabulary, and it still shares
 * the one port and the one presentation table — so it is a working component
 * without a host, not dead weight to be rediscovered. Its author should decide
 * whether a host is coming; if none is, delete the directory, its stylesheet
 * and its test together rather than leaving this note to age.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsLoginSessionFinishResult,
  CredentialsStatusView,
} from '@tm8/contract';
import { LiveTerminal, TerminalHost, isLiveTerminalEnabled } from '../terminal';
import {
  CREDENTIAL_PROVIDER_PRESENTATIONS,
  presentationOf,
} from '../settings-credentials/provider-presentation';
import {
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
} from '../settings-credentials/port';
import './provider-rail.css';

export type ProviderRailState = 'connected' | 'disconnected' | 'unavailable' | 'unknown';

export interface ProviderRailProps {
  port: CredentialsPort;
  /** Same-origin route prefix for the node that owns a login terminal. */
  serverBaseUrl?: string;
}

interface PendingLogin {
  provider: CredentialProviderName;
  workSessionId: string;
  expiresAt: string;
  command: string;
}

type RailOutcome =
  | { kind: 'finish'; result: CredentialsLoginSessionFinishResult }
  | { kind: 'error'; provider: CredentialProviderName; message: string };

const PROVIDERS = Object.keys(
  CREDENTIAL_PROVIDER_PRESENTATIONS,
) as CredentialProviderName[];

const VERDICT_STATE: Record<ConnectionVerdict, ProviderRailState> = {
  'connected-named': 'connected',
  'connected-unnamed': 'connected',
  disconnected: 'disconnected',
  unavailable: 'unavailable',
  unknown: 'unknown',
};

/** Each verdict has a different glyph as well as a different shape in CSS. */
const STATE_MARK: Record<ProviderRailState, string> = {
  connected: '✓',
  disconnected: '○',
  unavailable: '×',
  unknown: '?',
};

function stateOf(
  entry: CredentialConnectionView | undefined,
  status: CredentialsStatusView | null,
): ProviderRailState {
  if (!entry || !status) return 'unknown';
  return VERDICT_STATE[verdictOf(entry, status.gitCredentialStore)];
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

export function ProviderRail({ port, serverBaseUrl }: ProviderRailProps) {
  const [status, setStatus] = useState<CredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CredentialProviderName | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [outcome, setOutcome] = useState<RailOutcome | null>(null);

  const reload = useCallback(() => port.load().then(
    (next) => {
      setStatus(next);
      setLoadError(null);
    },
    (error: unknown) => setLoadError(messageOf(error)),
  ), [port]);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (next) => {
        if (live) {
          setStatus(next);
          setLoadError(null);
        }
      },
      (error: unknown) => {
        if (live) setLoadError(messageOf(error));
      },
    );
    return () => { live = false; };
  }, [port]);

  async function startLogin(provider: CredentialProviderName) {
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
    } catch (error) {
      setOutcome({ kind: 'error', provider, message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  async function finishLogin(login: PendingLogin) {
    setBusy(login.provider);
    setOutcome(null);
    try {
      const result = await port.finishLogin(login.workSessionId);
      setPending(null);
      setOutcome({ kind: 'finish', result });
      await reload();
    } catch (error) {
      setOutcome({ kind: 'error', provider: login.provider, message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="provider-rail" data-testid="provider-rail">
      <div
        className="provider-rail__chips"
        data-testid="provider-rail-chips"
        role="toolbar"
        aria-label="Provider sign-ins"
        aria-busy={status === null && loadError === null}
      >
        {PROVIDERS.map((provider) => {
          const presentation = presentationOf(provider);
          const ProviderIcon = presentation.icon;
          const entry = status?.providers.find((candidate) => candidate.provider === provider);
          const state = stateOf(entry, status);
          const label = `${presentation.name} — ${state}`;
          const contents = (
            <>
              <ProviderIcon />
              <span
                className={`provider-rail__badge provider-rail__badge--${state}`}
                data-state-mark={STATE_MARK[state]}
                aria-hidden="true"
              >
                {STATE_MARK[state]}
              </span>
            </>
          );

          if (!entry || state === 'unavailable') {
            return (
              <span
                key={provider}
                className="provider-rail__chip"
                role="img"
                aria-label={label}
                aria-disabled="true"
                title={state === 'unavailable'
                  ? `${presentation.binary} is not installed on this node`
                  : 'Credential state has not been measured yet'}
                data-testid={`provider-rail-chip-${provider}`}
                data-provider-state={state}
              >
                {contents}
              </span>
            );
          }

          return (
            <button
              key={provider}
              type="button"
              className="provider-rail__chip"
              aria-label={label}
              title={state === 'connected'
                ? `Reconnect ${presentation.name}`
                : `Sign in to ${presentation.name}`}
              data-testid={`provider-rail-chip-${provider}`}
              data-provider-state={state}
              disabled={busy !== null || pending !== null}
              onClick={() => void startLogin(provider)}
            >
              {contents}
            </button>
          );
        })}
      </div>

      {status === null && loadError === null ? (
        <span className="provider-rail__note" role="status">Reading sign-ins…</span>
      ) : null}
      {loadError ? (
        <span className="provider-rail__note provider-rail__note--error" role="alert">
          {`Sign-ins could not be read: ${loadError}`}
        </span>
      ) : null}
      {outcome?.kind === 'error' ? (
        <span className="provider-rail__note provider-rail__note--error" role="alert">
          {`${presentationOf(outcome.provider).name}: ${outcome.message}`}
        </span>
      ) : null}
      {outcome?.kind === 'finish' ? (
        <span className="provider-rail__note" role="status">
          {`${presentationOf(outcome.result.provider).name} — ${outcome.result.connected ? 'connected' : 'not connected'}.`}
        </span>
      ) : null}

      {pending ? (
        <div className="provider-rail__login" data-testid="provider-rail-login">
          <span className="provider-rail__login-copy">
            {`Signing in to ${presentationOf(pending.provider).name}. Follow the terminal prompts.`}
          </span>
          <span className="provider-rail__note">
            {`Runs \`${pending.command}\`; expires at ${pending.expiresAt}.`}
          </span>
          {isLiveTerminalEnabled() ? (
            <LiveTerminal
              sessionId={pending.workSessionId}
              serverBaseUrl={serverBaseUrl}
              live
              autoFocus
            />
          ) : (
            <TerminalHost
              ariaLabel={`${presentationOf(pending.provider).name} login terminal`}
              placeholder="the live terminal is disabled in this build, so this login cannot be completed here"
            />
          )}
          <button
            type="button"
            className="provider-rail__finish"
            onClick={() => void finishLogin(pending)}
            disabled={busy !== null}
            data-testid="provider-rail-finish-login"
          >
            I've finished signing in
          </button>
        </div>
      ) : null}
    </div>
  );
}
