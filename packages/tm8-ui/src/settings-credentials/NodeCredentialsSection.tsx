/**
 * Settings → Node credentials (SC-5, D9). The node's own keys are the last
 * source a launch falls back to (D4), and until now nobody could see them.
 *
 * - Every member sees whether node fallback is allowed per provider (it is
 *   carried on the space policy read).
 * - A node admin also sees whether the server's environment carries a key for
 *   that provider (a boolean; the key is never described, I5) and can turn
 *   node fallback off or back on (D5).
 * The server enforces node-admin-only on both reads and writes; a refusal it
 * answers is shown as one.
 */
import { useEffect, useState } from 'react';
import type {
  CredentialsSpacePolicyView,
  NodeCredentialsStatusView,
  SpaceCredentialProviderName,
} from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import type { SpaceCredentialsPort, SpaceCredentialsViewer } from './space-port';
import {
  SPACE_CREDENTIAL_PROVIDERS,
  SPACE_PROVIDER_NAME,
  failureOf,
  nodeAllowedOf,
  type SpaceCredentialFailure,
} from './space-credentials-model';
import './credentials.css';
import './space-credentials.css';

export const NODE_POLICY_ADMIN_ONLY = 'Only a node admin changes node fallback.';

export interface NodeCredentialsSectionProps {
  port: SpaceCredentialsPort;
  heading?: string;
}

export function NodeCredentialsSection({ port, heading = 'Node credentials' }: NodeCredentialsSectionProps) {
  const [viewer, setViewer] = useState<SpaceCredentialsViewer | null>(null);
  const [policy, setPolicy] = useState<CredentialsSpacePolicyView | null>(null);
  const [status, setStatus] = useState<NodeCredentialsStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void port.policy().then(
      (next) => { if (live) setPolicy(next); },
      (err: unknown) => { if (live) setLoadError(failureOf(err).text); },
    );
    void port.viewer().then(
      (v) => {
        if (!live) return;
        setViewer(v);
        if (!v.isNodeAdmin) return;
        void port.nodeStatus().then(
          (next) => { if (live) setStatus(next); },
          (err: unknown) => { if (live) setStatusError(failureOf(err).text); },
        );
      },
      () => {},
    );
    return () => { live = false; };
  }, [port]);

  if (loadError) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Node credentials could not be read." why={loadError} testId="node-cred-load-error" />
      </SectionFrame>
    );
  }

  const admin = viewer?.isNodeAdmin === true;

  return (
    <SectionFrame title={heading}>
      <div className="set-spc" data-testid="node-credentials">
        <p className="set-spc__lede">
          The keys this server holds for itself. A launch falls back to them last, after yours and the
          space&apos;s, and only where node fallback is allowed. They are never shown, only whether one is present.
        </p>
        {!admin ? <p className="set-spc__muted" data-testid="node-cred-not-admin">{NODE_POLICY_ADMIN_ONLY}</p> : null}
        {statusError ? (
          <p className="set-spc__fail set-spc__fail--refused" role="alert">{statusError}</p>
        ) : null}
        <ul className="set-spc__list">
          {SPACE_CREDENTIAL_PROVIDERS.map((provider) => (
            <NodeProviderRow
              key={provider}
              provider={provider}
              allowed={status
                ? status.providers.find((p) => p.provider === provider)?.allowNode !== false
                : nodeAllowedOf(policy, provider)}
              envKeyPresent={status?.providers.find((p) => p.provider === provider)?.envKeyPresent ?? null}
              admin={admin}
              port={port}
              onSet={(allowNode) => {
                setStatus((prev) => prev && {
                  providers: prev.providers.map((p) => (p.provider === provider ? { ...p, allowNode } : p)),
                });
                setPolicy((prev) => prev && {
                  ...prev,
                  node: [...prev.node.filter((n) => n.provider !== provider), { provider, allowNode }],
                });
              }}
            />
          ))}
        </ul>
      </div>
    </SectionFrame>
  );
}

function NodeProviderRow({
  provider,
  allowed,
  envKeyPresent,
  admin,
  port,
  onSet,
}: {
  provider: SpaceCredentialProviderName;
  allowed: boolean;
  envKeyPresent: boolean | null;
  admin: boolean;
  port: SpaceCredentialsPort;
  onSet(allowNode: boolean | null): void;
}) {
  const name = SPACE_PROVIDER_NAME[provider];
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SpaceCredentialFailure | null>(null);

  async function flip() {
    setBusy(true);
    setFailure(null);
    try {
      // Allowed is stored as NO policy (null), the server's default; only the
      // refusal is an explicit `false`.
      const result = await port.setNodePolicy(provider, allowed ? false : null);
      onSet(result.allowNode);
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="set-spc__row" data-testid={`node-cred-row-${provider}`}>
      <div className="set-spc__row-head">
        <span className="set-spc__label">{name}</span>
        <span className={`set-spc__badge ${allowed ? 'set-spc__badge--active' : 'set-spc__badge--stale'}`}>
          {allowed ? 'node fallback allowed' : 'node fallback off'}
        </span>
      </div>
      {envKeyPresent !== null ? (
        <div className="set-spc__meta" data-testid={`node-cred-env-${provider}`}>
          <span>{envKeyPresent ? 'The server holds a key for this provider.' : 'The server holds no key for this provider.'}</span>
        </div>
      ) : null}
      <label className="set-spc__toggle">
        <input
          type="checkbox"
          checked={allowed}
          aria-label={`Allow node fallback for ${name}`}
          aria-disabled={admin ? undefined : 'true'}
          title={admin ? undefined : NODE_POLICY_ADMIN_ONLY}
          disabled={busy}
          onChange={() => { if (admin) void flip(); }}
        />
        Allow launches to fall back to the node&apos;s key
      </label>
      {failure ? (
        <p className={`set-spc__fail set-spc__fail--${failure.kind}`} role="alert" data-testid={`node-cred-failure-${failure.kind}`}>
          {failure.text}
        </p>
      ) : null}
    </li>
  );
}
