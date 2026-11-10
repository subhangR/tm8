export interface OAuthTokenResponse {
  accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string;
}

/** Slack reports its user grant inside authed_user; its top-level scope may differ. */
export function readOAuthToken(value: Record<string, unknown>, endpoint: string, now = Date.now()): OAuthTokenResponse {
  const url = new URL(endpoint);
  const slack = url.origin === 'https://slack.com' && url.pathname === '/api/oauth.v2.user.access';
  if (value.ok === false || typeof value.access_token !== 'string' || !value.access_token
    || typeof value.token_type !== 'string' || !['bearer', 'user'].includes(value.token_type.toLowerCase())) {
    throw new Error('OAuth token response invalid');
  }
  const user = slack && value.authed_user && typeof value.authed_user === 'object'
    ? value.authed_user as Record<string, unknown> : undefined;
  const scope = typeof user?.scope === 'string' ? user.scope : value.scope;
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}),
    ...(typeof value.expires_in === 'number' ? { expiresAt: now + value.expires_in * 1000 } : {}),
    ...(typeof scope === 'string' ? { scope: slack ? scope.split(',').map(item => item.trim()).filter(Boolean).join(' ') : scope } : {}),
  };
}
