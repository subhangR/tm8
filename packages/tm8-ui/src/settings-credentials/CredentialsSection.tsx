/**
 * Settings owns the section frame and account-scoped explanation; provider
 * actions and their four connection verdicts live in the block shared with
 * Home. Expiry remains a separate health axis over a positive connection, as
 * introduced by main's layout pass, so the shared verdict vocabulary does not
 * need a contradictory fifth value.
 */
import { useMemo, useState } from 'react';
import type {
  CredentialConnectionView,
  CredentialsStatusView,
} from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import { CredentialsProviderBlock } from './CredentialsProviderBlock';
import { presentationOf } from './provider-presentation';
import {
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

interface ObservedStatus {
  /** Prevent a response from the previous port appearing under a new host. */
  source: CredentialsPort;
  value: CredentialsStatusView;
}

type CredentialHealth = 'ok' | 'expired';

function healthOf(
  entry: CredentialConnectionView,
  verdict: ConnectionVerdict,
): CredentialHealth {
  if (verdict !== 'connected-named' && verdict !== 'connected-unnamed') return 'ok';
  return entry.status === 'stale' || entry.status === 'revoked' ? 'expired' : 'ok';
}

function pillFor(
  verdict: ConnectionVerdict,
  health: CredentialHealth,
): { word: string; modifier: string } {
  if (verdict === 'unknown') return { word: 'Unknown', modifier: 'unknown' };
  if (verdict === 'unavailable') return { word: 'Unavailable', modifier: 'unavailable' };
  if (verdict === 'disconnected') return { word: 'Not connected', modifier: 'off' };
  if (health === 'expired') return { word: 'Expired', modifier: 'expired' };
  return { word: 'Connected', modifier: 'on' };
}

/**
 * Settings keeps main's at-a-glance health treatment without duplicating the
 * shared cards or their actions. In particular, a stored-but-stale connection
 * still says Connected in the shared connection sentence and Expired here:
 * those are deliberately two different questions.
 */
function CredentialHealthSummary({ status }: { status: CredentialsStatusView }) {
  return (
    <div className="set-cred__health" aria-label="Credential health">
      {status.providers.map((entry) => {
        const verdict = verdictOf(entry, status.gitCredentialStore);
        const health = healthOf(entry, verdict);
        const pill = pillFor(verdict, health);

        return (
          <div className="set-cred__health-item" key={entry.provider}>
            <span className="set-cred__health-name">
              {presentationOf(entry.provider).name}
            </span>
            <span
              className={`set-cred__pill set-cred__pill--${pill.modifier}`}
              data-testid={`credential-pill-${entry.provider}`}
            >
              {pill.word}
            </span>
            {health === 'expired' ? (
              <span
                className="set-cred__why set-cred__health-why"
                data-testid={`credential-expired-why-${entry.provider}`}
              >
                {`this login is recorded as ${entry.status} — it is still stored, and an agent launched with it will fail. Reconnect to refresh it.`}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function CredentialsSection({
  port,
  heading = 'Agent credentials',
  serverBaseUrl,
}: CredentialsSectionProps) {
  const [observed, setObserved] = useState<ObservedStatus | null>(null);

  /* Observe the same read the shared block performs. This avoids a second
     credentials.status request while allowing Settings to add its frame-level
     empty state and connection-health summary. */
  const observedPort = useMemo<CredentialsPort>(() => ({
    async load() {
      const value = await port.load();
      setObserved({ source: port, value });
      return value;
    },
    disconnect: (provider) => port.disconnect(provider),
    startLogin: (provider) => port.startLogin(provider),
    finishLogin: (workSessionId) => port.finishLogin(workSessionId),
  }), [port]);

  const status = observed?.source === port ? observed.value : null;

  return (
    <SectionFrame title={heading} bodyTestId="credentials-body">
      <span className="set-prose set-cred__lede">
        These credentials are YOURS. An agent you launch signs in as you, and nobody else in this
        space can read or use them. Connecting opens a real terminal here and you type into it —
        the secret never passes through this screen, and no value below is a secret.
      </span>

      <span className="set-cred__why set-cred__scope" data-testid="credentials-scope">
        Per account, not per space. These logins follow you into every space you are a member of;
        the sections above and below this one change the space instead.
      </span>

      {status && status.providers.length === 0 ? (
        <SectionAbsent
          testId="credentials-empty"
          head="This node listed no providers at all."
          why="credentials.status answered with an empty provider list — it is documented to return one entry per provider, so this is the node reporting a gap, not a statement that you have no logins"
        />
      ) : null}

      {status && status.providers.length > 0 ? (
        <CredentialHealthSummary status={status} />
      ) : null}

      <div className="set-cred__shared">
        <CredentialsProviderBlock port={observedPort} serverBaseUrl={serverBaseUrl} />
      </div>
    </SectionFrame>
  );
}
