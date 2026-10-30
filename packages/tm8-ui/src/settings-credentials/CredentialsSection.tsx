/**
 * Settings owns the section frame and account-scoped explanation; provider
 * cards, their status badges (including Expired, a health axis over a positive
 * connection — see `credential-status.ts`) and their actions live in the block
 * shared with Home. This frame adds only a one-line tally above the cards.
 */
import { useMemo, useState } from 'react';
import type { CredentialsStatusView } from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import { CredentialsProviderBlock } from './CredentialsProviderBlock';
import { ServiceKeysBlock } from './ServiceKeysBlock';
import { credentialBadgeOf } from './credential-status';
import { presentationOf } from './provider-presentation';
import {
  type CredentialsPort,
  type CredentialsSharePort,
  type ServiceKeysPort,
} from './port';
import './credentials.css';

export interface CredentialsSectionProps {
  port: CredentialsPort;
  heading?: string;
  /** Same-origin route prefix for the node that owns the login session. */
  serverBaseUrl?: string;
  /**
   * Called whenever this section has re-read the credential status — i.e.
   * after every connect, disconnect and harvest, since each is followed by a
   * reload.
   *
   * IT EXISTS BECAUSE THIS SECTION IS NOT THE ONLY THING SHOWING THAT STATE.
   * The account menu carries a setup nudge derived from the same status, and
   * it was previously refreshed only by the setup dialog — so connecting
   * GitHub HERE left the menu still saying GitHub was not connected until a
   * reload. One derivation with two readers needs the second reader told.
   *
   * IT HANDS OVER THE VALUE IT JUST READ, and that is not a convenience.
   * `credentials.status` is human-only and SHELLS OUT on the node — `claude
   * auth status`, `gh auth status`, one per provider. A callback that only
   * said "something changed" would make every read here cost two of those.
   * The reader derives from this value and issues no second call.
   */
  onStatusRead?: (status: CredentialsStatusView) => void;
  /**
   * Service keys (today: TypeSafe, for ✦ Ask Jev). Rendered below the agent
   * logins when the host wires it; absent, the block is simply not shown.
   */
  serviceKeysPort?: ServiceKeysPort;
  sharePort?: CredentialsSharePort;
}

interface ObservedStatus {
  /** Prevent a response from the previous port appearing under a new host. */
  source: CredentialsPort;
  value: CredentialsStatusView;
}

/**
 * The one-line tally above the cards. It counts badge words, so it can never
 * disagree with the cards below it.
 */
function CredentialsTally({ status }: { status: CredentialsStatusView }) {
  const badges = status.providers.map((entry) => ({
    name: presentationOf(entry.provider).name,
    badge: credentialBadgeOf(entry, status.gitCredentialStore),
  }));
  const connected = badges.filter(({ badge }) => badge.word === 'Connected').length;
  const attention = badges
    .filter(({ badge }) => badge.word === 'Expired' || badge.word === 'Unknown')
    .map(({ name }) => name);

  return (
    <p className="set-cred__tally" data-testid="credentials-tally">
      <span className="set-cred__tally-count">{connected}</span>
      {` of ${badges.length} connected`}
      {attention.length > 0 ? (
        <span className="set-cred__tally-attention">
          {` · ${attention.join(', ')} need${attention.length === 1 ? 's' : ''} attention`}
        </span>
      ) : null}
    </p>
  );
}

export function CredentialsSection({
  port,
  heading = 'Agent credentials',
  serverBaseUrl,
  onStatusRead,
  serviceKeysPort,
  sharePort,
}: CredentialsSectionProps) {
  const [observed, setObserved] = useState<ObservedStatus | null>(null);

  /* Observe the same read the shared block performs. This avoids a second
     credentials.status request while allowing Settings to add its frame-level
     empty state and connection-health summary. */
  const observedPort = useMemo<CredentialsPort>(() => ({
    async load() {
      const value = await port.load();
      setObserved({ source: port, value });
      // Every write in the block below reloads, so this one hook covers
      // connect, disconnect and harvest without three separate wrappers.
      onStatusRead?.(value);
      return value;
    },
    disconnect: (provider) => port.disconnect(provider),
    startLogin: (provider) => port.startLogin(provider),
    finishLogin: (workSessionId) => port.finishLogin(workSessionId),
  }), [port, onStatusRead]);

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

      {status && status.providers.length > 0 ? <CredentialsTally status={status} /> : null}

      <div className="set-cred__shared">
        <CredentialsProviderBlock port={observedPort} serverBaseUrl={serverBaseUrl} sharePort={sharePort} />
      </div>

      {serviceKeysPort ? <ServiceKeysBlock port={serviceKeysPort} /> : null}
    </SectionFrame>
  );
}
