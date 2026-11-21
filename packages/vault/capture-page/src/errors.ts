const COPY = {
  invalid_link: 'Invalid link. Ask for a new link.',
  capture_link_invalid: 'This link cannot be used. Ask for a new link.',
  capture_key_rotated: 'This link cannot be used. Ask for a new link.',
  expired: 'This session has expired. Ask for a new link or start a new import.',
  sign_in: 'Sign in to tm8 in this browser, then open this page again.',
  passkey_required: 'Set up a vault passkey in tm8, then open this page again.',
  passkey_failed: 'Passkey verification did not finish. Try again.',
  vault_session_required: 'Your vault session has expired. Open this page again and sign in.',
  step_up_required: 'Verify with your passkey to continue.',
  step_up_invalid: 'Passkey verification was refused. Try again.',
  vault_disabled: 'The vault is currently disabled.',
  import_disabled: 'Import is currently disabled.',
  pre_review_limit: 'The vault currently accepts test items only.',
  origin_refused: 'The origin was refused. Check the exact HTTPS origin.',
  secret_in_metadata: 'That looks like a secret. Names, usernames and origins are stored as plain metadata, so put secrets only in the secret fields.',
  too_large: 'This item is too large for the secure capture channel.',
  invalid_payload: 'Check the required fields and try again.',
  unsafe_label: 'Names and usernames cannot contain control characters, hidden text-direction characters or invisible tag characters. Type the text instead of pasting it.',
  invalid_key: 'The secure capture key could not be verified. Ask for a new link.',
  unavailable: 'The vault is unavailable. Try again later.',
  failed: 'The request could not be completed. Try again.',
} as const;
export type PageErrorCode = keyof typeof COPY;
export class PageError extends Error {
  constructor(readonly code: PageErrorCode) { super(COPY[code]); this.name = 'PageError'; }
}
export function errorCopy(error: unknown): string {
  return error instanceof PageError ? COPY[error.code] : COPY.failed;
}
export function remoteError(reason: unknown, status: number): PageError {
  if (typeof reason === 'string' && Object.hasOwn(COPY, reason)) return new PageError(reason as PageErrorCode);
  return new PageError(status === 401 ? 'sign_in' : status === 501 || status >= 500 ? 'unavailable' : 'failed');
}
