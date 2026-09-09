import { useState } from 'react';
import { useDeployment } from './DeploymentGate';
import { workspaceApi } from './api';

export function GithubSignIn({ link = false, invitationCode, claimToken }: { link?: boolean; invitationCode?: string | null; claimToken?: string }) {
  const deployment = useDeployment();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!deployment?.githubLogin) return null;
  return <div><button disabled={busy} onClick={() => {
    setBusy(true); setError('');
    void workspaceApi<{ url: string }>('/v2/auth/github/start', { intent: link ? 'link' : 'login', ...(claimToken ? { claimToken } : invitationCode ? { invitationCode } : {}) })
      .then(value => location.assign(value.url)).catch(error => { setError(error.message); setBusy(false); });
  }}>{busy ? 'Connecting…' : link ? 'Link GitHub for sign-in' : 'Continue with GitHub'}</button>{error && <p role="alert">{error}</p>}</div>;
}

let setupToken: string | undefined;
function captureSetupToken() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('claim');
  if (token) { setupToken = token; history.replaceState(null, '', location.pathname + location.search); }
  return setupToken;
}
export function GithubSignInScreen({ invitationCode }: { invitationCode?: string | null }) {
  const deployment = useDeployment();
  const [claimToken] = useState(captureSetupToken);
  return <main className="workspace-login"><h1>Sign in or sign up</h1>
    <p>Continue with your GitHub account to open your spaces and projects.</p>
    <p>{claimToken ? 'Complete the initial setup with GitHub.' : 'New accounts need an invitation.'}</p>
    {deployment?.distributedSystemFlag
      ? <a href={deployment.controlOrigin ?? '/'}>Continue with GitHub</a>
      : deployment?.githubLogin
        ? <GithubSignIn invitationCode={invitationCode} claimToken={claimToken} />
        : <><button disabled>Continue with GitHub</button><p role="status">GitHub sign-in is not configured yet. Contact your administrator.</p></>}
  </main>;
}
