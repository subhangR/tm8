import type { EntityDetail, SessionCredentialView } from '@tm8/contract';
import { credentialLine } from './credentialLine';

/**
 * The credential line on a session's header, beside its title (spec 01a0e248
 * §6). It renders what `credentialLine` builds and nothing else. It holds no
 * seam and makes no read: the block arrives on the session's own detail,
 * already masked by the server.
 */
export function SessionCredentialLine({ detail }: { detail: EntityDetail }) {
  const view = (detail.content as { credential?: SessionCredentialView | null }).credential;
  const line = credentialLine(view);
  if (line === null) return null;
  return (
    <p className="pn-cred-line" data-testid="session-credential-line" title={line}>
      {line}
    </p>
  );
}
