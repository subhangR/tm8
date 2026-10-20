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
 * Why a connector the target equips is not in this session. The picker used to
 * trim these defaults silently, so a member saw a session launch without Slack
 * and had nothing to read; the reason is authored here, never taken upstream.
 */
export function droppedDefault(reason: string): string {
  switch (reason) {
    case 'credential_required': return 'no connected account for you to use \u2014 connect one, or pick an account above';
    case 'credential_definition_changed': return 'the connector changed since the account was connected \u2014 reconnect it';
    case 'credential_revoked': return 'the account was revoked';
    case 'credential_expired': return 'the account expired \u2014 reconnect it';
    case 'credential_unavailable': case 'access_denied': return 'you cannot use the account it is attached with';
    case 'not_approved': return 'an administrator has not approved it';
    case 'disabled': return 'it is disabled';
    case 'stdio_not_trusted': return 'its local command is not trusted';
    default: return 'it is not ready to use';
  }
}
