import { createHash } from 'node:crypto';
import { canonicalJson } from './hash.js';

/**
 * The step-up intent hash from the contract (`vaultStepUpBoundParams`):
 * `hex(SHA-256("tm8-vault-stepup|v1|" + action + "|" + JCS(bound)))`.
 *
 * The challenge handler derives the WebAuthn challenge from it, and the step-up
 * check recomputes it from the call it is about to authorize. The challenge
 * record stores only this hash, never the bound params: the body can carry a
 * capture-link token or a sealed blob.
 */
export function stepUpIntentHash(action: string, bound: Record<string, unknown>): string {
  if (typeof action !== 'string' || !/^vault\.[a-zA-Z.]+$/.test(action)) throw new TypeError('invalid step-up action');
  return createHash('sha256').update(`tm8-vault-stepup|v1|${action}|${canonicalJson(bound)}`, 'utf8').digest('hex');
}
