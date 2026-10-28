/** Only authored UI messages may cross into the view; upstream errors can contain secrets. */
export class McpUiError extends Error {}
export function testFailure(reason: string): string {
  switch (reason) {
    case 'credential_definition_changed': return 'The connector changed. Reconnect the account before using its tools.';
    case 'credential_required': return 'Choose an account, then test again.';
    case 'credential_revoked': case 'credential_expired': case 'credential_unavailable': return 'This account is no longer available. Reconnect an account, then test again.';
    case 'not_approved': return 'An administrator must approve this connector before it can run.';
    case 'disabled': return 'Enable the connector before testing it.';
    case 'stdio_not_trusted': return 'Review and trust this local command before running it.';
    case 'access_denied': return 'You no longer have permission to use this connector.';
    default: return 'The connector did not respond successfully. Check its URL or command and account, then retry.';
  }
}

/**
 * §10.2's ERROR AND FALLBACK TABLE, as one function.
 *
 * Every row of that table names a server signal and the copy it gets. This is
 * the only place either half is written down, because the alternative — each
 * Connect button reading `error.message` for itself — is how `startOAuth` came
 * to match two exact strings that the server had already stopped sending.
 *
 * MATCHING IS BY PREFIX, NEVER BY EXACT TEXT. `server/mcp/oauth.ts` appends the
 * cause to each refusal (the provider's origin, its HTTP status, its short
 * error code, and the redirect-URI diagnosis — #1296 part 3, in flight as
 * #1328), so `'OAuth discovery failed'` is now `'OAuth discovery failed: …'`.
 * A prefix match reads both, and reads the pre-#1328 node too.
 *
 * NOTHING UPSTREAM IS RENDERED. `message`, `adminHint` and `reason` are all
 * written here. The server's own sentence rides along as `cause`, shown only to
 * a Space admin and only when the message carries one of the prefixes below —
 * an unrecognised failure has no `cause` at all, so an internal error string
 * cannot leave through this function.
 */
export interface ConnectFailure {
  /** Authored copy for whoever clicked Connect. */
  message: string;
  /** A second authored line, shown only to a Space admin: what THEY can do. */
  adminHint?: string;
  /**
   * A tm8 server environment variable an administrator must set. It is a
   * configuration KEY, offered with a copy button; never a value.
   */
  copyable?: string;
  /** Offer the drawer's configuration section ([Open settings], admins only). */
  settings?: boolean;
  /** Offer [Try again]: the same Connect can succeed on a second attempt. */
  retry: boolean;
  /**
   * The §10.0 row status this failure implies. `provider_blocked` is the only
   * one, and `connector-rows.ts` says it can come from nowhere but a failed
   * `mcp.oauth.begin` — this is that place.
   */
  status?: 'provider_blocked';
  /** The server's own diagnosis sentence, for a Space admin only (see above). */
  cause?: string;
}

/**
 * The refusals this module recognises. A message outside this set is treated as
 * an unknown failure: generic copy, and no `cause` forwarded.
 */
const KNOWN = /^(OAuth |MCP |First-party connector |Google connectors )/;

/** `(<reason>)` in §10.2's "Couldn't start sign-in with <name> (<reason>)" row — authored, not the server's words. */
const START_REASONS: readonly [RegExp, string][] = [
  [/^OAuth resource discovery failed/, "the connector's metadata couldn't be read"],
  [/^OAuth resource binding mismatch/, "the connector URL doesn't match the one the provider advertises"],
  [/^OAuth discovery failed/, "the provider's sign-in settings couldn't be read"],
  [/^OAuth issuer (refused|mismatch)/, "the provider's issuer doesn't match the connector"],
  [/^OAuth (issuer or )?PKCE unsupported/, "the provider doesn't support the PKCE method tm8 requires"],
  [/^OAuth (registration )?endpoint refused/, "the provider named an address tm8 won't use"],
  [/^OAuth client authentication (unsupported|unavailable)/, "tm8 can't authenticate to the provider's token endpoint"],
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function codeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function connectFailure(error: unknown, context: { name: string; admin: boolean }): ConnectFailure {
  const failure = classify(error, context);
  // THE REDIRECT URI WINS THE ADMIN LINE. Whatever else a hosted provider said,
  // if tm8's callback URL is still the bind address then that is the one thing
  // an administrator has to change, so it replaces the row's own hint rather
  // than sitting behind it (#1296's `redirectDiagnosis`).
  if (!context.admin || !/loopback address/.test(messageOf(error))) return failure;
  return {
    ...failure,
    adminHint: `tm8 is asking ${context.name} to redirect back to a loopback address, which hosted providers refuse. Set TM8_PUBLIC_ORIGIN to this server's public HTTPS origin and restart tm8, then register its /mcp/oauth/callback with the provider.`,
    copyable: 'TM8_PUBLIC_ORIGIN',
    settings: true,
  };
}

function classify(error: unknown, context: { name: string; admin: boolean }): ConnectFailure {
  // Already ours: a `McpUiError` carries copy this module wrote.
  if (error instanceof McpUiError) return { message: error.message, retry: true };

  const raw = messageOf(error);
  const code = codeOf(error);
  const { name, admin } = context;
  const base = admin && KNOWN.test(raw) ? { cause: raw } : {};
  /** What a member is told about anything only an administrator can finish. */
  const adminSetup = (hint: string, copyable?: string): ConnectFailure => admin
    ? { ...base, message: hint, retry: false, settings: true, ...(copyable ? { copyable } : {}) }
    : { ...base, message: `An administrator needs to finish setting up ${name}.`, retry: false };

  // An admin changed the connector mid-flow. The state was already spent, so
  // the only way forward is a fresh Connect.
  if (/^MCP connector changed/.test(raw) || code === 'conflict') {
    return { ...base, message: 'An administrator changed this connector while you were signing in. Try again.', retry: true };
  }
  if (/^MCP connector is not approved/.test(raw)) {
    return { ...base, message: `${name} is waiting for an administrator's approval.`, retry: false, ...(admin ? { adminHint: 'Approve it on the Space admin tab, then connect.' } : {}) };
  }
  if (/^OAuth state invalid or expired/.test(raw)) {
    return { ...base, message: 'That sign-in link expired. Try again.', retry: true };
  }
  if (/^OAuth authorization denied/.test(raw)) {
    // `access_denied` is the account holder declining the consent screen; any
    // other denial is the provider refusing for a reason it did not name.
    return /access_denied/.test(raw)
      ? { ...base, message: `You cancelled the ${name} sign-in.`, retry: true }
      : { ...base, message: `${name} refused the sign-in without returning an authorization code.`, retry: true, ...(admin ? { settings: true } : {}) };
  }
  if (/^OAuth (token exchange failed|token response invalid)/.test(raw)) {
    return { ...base, message: `${name} didn't return a usable token. Try again, or ask an administrator to check the app setup.`, retry: true, ...(admin ? { settings: true } : {}) };
  }
  // DCR 403 (Figma): the provider admits only clients it has approved. This is
  // the §10.0 `provider_blocked` row, and the only producer of it.
  if (/^OAuth client registration rejected by provider/.test(raw)) {
    return {
      ...base, status: 'provider_blocked', retry: false, settings: true,
      message: `${name} hasn't approved tm8 as an MCP client yet.`,
      ...(admin ? { adminHint: `Add a pre-registered app in ${name}'s connector settings: create an app with the provider and put its Client ID on the connector.` } : {}),
    };
  }
  // No dynamic client registration, and no Client ID on the connector (Slack).
  if (/^OAuth client registration (required|unavailable)/.test(raw)) {
    return adminSetup(`${name} needs a pre-registered app. Add its Client ID to the connector, and the matching client secret to this server's environment.`);
  }
  if (/^OAuth client registration (failed|unsupported)/.test(raw)) {
    return { ...base, message: `tm8 couldn't register itself with ${name}.`, retry: true, settings: true, ...(admin ? { adminHint: 'Create an app with the provider and set its Client ID on the connector.' } : {}) };
  }
  // The connector names a client secret the server does not hold. The variable
  // NAME is configuration, so the admin gets it with a copy button.
  const secretEnv = /^OAuth client secret is not configured on this server: set (TM8_[A-Z0-9_]+)/.exec(raw);
  if (secretEnv) {
    return adminSetup(`${name} needs its OAuth client secret in this server's environment. Set ${secretEnv[1]} and restart tm8.`, secretEnv[1]);
  }
  if (/^OAuth client secret requires a client id/.test(raw)) {
    return adminSetup(`${name} has a client secret configured but no Client ID. Add the Client ID to the connector.`);
  }
  // §8.1: the node has no Google OAuth client, so no Google connector can connect.
  if (/^Google connectors are not configured on this server/.test(raw)) {
    return adminSetup('Google connectors need an OAuth client on this server. Set TM8_GOOGLE_OAUTH_CLIENT_ID and TM8_MCP_CLIENT_SECRET_GOOGLE, then restart tm8.', 'TM8_GOOGLE_OAUTH_CLIENT_ID');
  }
  if (/^First-party connector unavailable/.test(raw)) {
    return { ...base, message: `${name} isn't available on this tm8 server.`, retry: false };
  }
  if (/^OAuth connector required/.test(raw)) {
    return { ...base, message: `${name} doesn't sign in with OAuth. Connect it with an API key instead.`, retry: false };
  }
  for (const [pattern, reason] of START_REASONS) {
    if (pattern.test(raw)) {
      return { ...base, message: `Couldn't start sign-in with ${name} (${reason}).`, retry: true, ...(admin ? { settings: true } : {}) };
    }
  }
  if (code === 'limit_exceeded') {
    return { ...base, message: 'Too many sign-ins in progress. Try again in a few minutes.', retry: true };
  }
  if (code === 'forbidden') {
    return { ...base, message: `You can't connect an account for ${name}.`, retry: false };
  }
  if (code === 'unauthenticated') {
    return { ...base, message: 'Sign in to tm8 again, then connect.', retry: false };
  }
  return { ...base, message: `Couldn't start sign-in with ${name}. Try again.`, retry: true };
}
