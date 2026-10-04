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
