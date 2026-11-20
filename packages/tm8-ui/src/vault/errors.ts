import { VAULT_ERROR_REASONS, type VaultErrorReason } from '@tm8/contract';

/** No server message, URL, validation issue, or original exception is retained. */
type KnownVaultReason = VaultErrorReason | 'secret_in_metadata';
export const VAULT_ERROR_COPY: Record<KnownVaultReason, string> = {
  vault_disabled: 'The vault is switched off.',
  vault_unavailable: 'The broker is unavailable. The vault is read-only.',
  audit_unavailable: 'Audit is unavailable. The vault is read-only.',
  kms_unavailable: 'Key management is unavailable. Try again when it is healthy.',
  vault_session_required: 'Sign in with a passkey to continue. Your vault session may have expired.',
  step_up_required: 'Verify with a passkey to continue.',
  step_up_invalid: 'Passkey verification was refused. Start a new verification.',
  passkey_required: 'Register a passkey with an enrollment code to continue.',
  code_invalid: 'The code is invalid, expired, or already used.',
  capture_link_invalid: 'The capture link is unavailable. Create a new link.',
  capture_key_rotated: 'The capture key changed. Create a new link.',
  item_blocked: 'Rotate this credential at its source before using it.',
  wrong_item_type: 'This action is unavailable for this item type.',
  origin_refused: 'The exact origin was refused. Check the item’s bound origins.',
  approval_not_pending: 'This approval is no longer pending. Refresh the inbox.',
  approval_hash_mismatch: 'The approval changed. Refresh the inbox before deciding.',
  operation_id_reused: 'This operation identifier cannot be reused with different parameters.',
  spend_disabled: 'Payments are off.',
  import_disabled: 'Import is disabled.',
  pre_review_limit: 'Test secrets only. The pre-review limit was reached.',
  value_request_refused: 'Secret values cannot be displayed.',
  last_passkey: 'This is the last passkey. Confirm its revocation explicitly.',
  secret_in_metadata: 'That looks like a secret. Names, usernames and origins are stored as plain metadata, so put secrets only in the secret fields.',
};

const CLIENT_COPY = {
  not_found: 'The requested record is unavailable.',
  forbidden: 'This action was refused.',
  unauthorized: 'Sign in to continue.',
  expired: 'This request expired. Start again.',
  rate_limited: 'Too many attempts. Wait before trying again.',
  not_implemented: 'This vault operation is not available yet.',
  invalid_response: 'The vault returned an invalid response. Nothing was displayed.',
  invalid_input: 'Check the form fields and try again.',
  unsafe_link: 'The capture page address was refused. Create a new link.',
  authenticator_unavailable: 'Passkeys are unavailable in this browser.',
  authenticator_cancelled: 'Passkey verification was cancelled or refused.',
  request_failed: 'The vault request failed. Try again.',
} as const;

export type VaultUiErrorCode = KnownVaultReason | keyof typeof CLIENT_COPY;

export class VaultUiError extends Error {
  constructor(readonly code: VaultUiErrorCode) {
    super(code in VAULT_ERROR_COPY
      ? VAULT_ERROR_COPY[code as KnownVaultReason]
      : CLIENT_COPY[code as keyof typeof CLIENT_COPY]);
    this.name = 'VaultUiError';
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

export function vaultError(error: unknown): VaultUiError {
  if (error instanceof VaultUiError) return error;
  const outer = record(error);
  const source = outer.error ? record(outer.error) : outer;
  // not_found always has the same copy, regardless of any supplied reason.
  if (source.code === 'not_found' || outer.status === 404) return new VaultUiError('not_found');
  const reason = record(source.details).reason;
  if (typeof reason === 'string' && (reason === 'secret_in_metadata' || VAULT_ERROR_REASONS.includes(reason as VaultErrorReason))) {
    return new VaultUiError(reason as KnownVaultReason);
  }
  if (typeof source.code === 'string' && Object.hasOwn(CLIENT_COPY, source.code)) {
    return new VaultUiError(source.code as keyof typeof CLIENT_COPY);
  }
  if (outer.status === 501) return new VaultUiError('not_implemented');
  return new VaultUiError('request_failed');
}

export const vaultErrorMessage = (error: unknown): string => vaultError(error).message;
