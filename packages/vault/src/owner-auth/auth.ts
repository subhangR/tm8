import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { vaultStepUpBoundParams, type VaultStepUpProof, type VaultWebAuthnAssertion } from '@tm8/contract';
import {
  StoreStateError, VaultError, memberScope, systemClock,
  type BrokerConfig, type ChallengeRecord, type Clock, type OwnerAuth, type OwnerSession,
  type PasskeyRecord, type StepUpBinding, type StepUpVerified, type VaultCaller,
  type VaultCookies, type VaultStore,
} from '../core-types.js';
import { stepUpIntentHash } from '../intent/step-up.js';
import { audit, equalHex, liveSession, sha256, validToken } from './primitives.js';

export interface OwnerAuthOptions { store: VaultStore; config: BrokerConfig; clock?: Clock }

/** The callback receives the challenge from the signed client data, never a supplied hash. */
export function matchesChallenge(row: ChallengeRecord, candidate: string, intentHash?: string): boolean {
  if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]+$/.test(candidate)) return false;
  const bytes = Buffer.from(candidate, 'base64url');
  if (bytes.toString('base64url') !== candidate || bytes.length !== (intentHash === undefined ? 32 : 64)) return false;
  const hashMatches = equalHex(row.challenge, sha256(candidate));
  const intentMatches = intentHash === undefined || equalHex(bytes.subarray(32).toString('hex'), intentHash);
  return hashMatches && intentMatches;
}

/** Null attachment is allowed by the contract and omitted in the WebAuthn library type. */
function authenticationResponse(assertion: VaultWebAuthnAssertion): AuthenticationResponseJSON {
  const { authenticatorAttachment, ...rest } = assertion;
  const { userHandle, ...response } = rest.response;
  return { ...rest, response: { ...response, ...(userHandle ? { userHandle } : {}) },
    ...(authenticatorAttachment ? { authenticatorAttachment } : {}) };
}

export function bindingHash(binding: StepUpBinding): string {
  return stepUpIntentHash(binding.action, vaultStepUpBoundParams(binding.pathParams, binding.body));
}

/** Consume and audit before returning either outcome. The handler throws only AFTER commit. */
export async function verifyAssertion(
  options: OwnerAuthOptions, caller: VaultCaller,
  proof: VaultStepUpProof, purpose: 'sign_in' | 'step_up',
  expected?: { session: OwnerSession; binding: StepUpBinding },
): Promise<{ passkey: PasskeyRecord; verified: StepUpVerified }> {
  const outcome = await options.store.transaction(memberScope(caller), async (tx) => {
    const challenge = await tx.challenges.consume(proof.challengeId, purpose);
    const fail = async (code = 'assertion_invalid') => {
      await audit(tx, caller, 'step_up.failed', { purpose, code });
      return null;
    };
    if (await tx.passkeys.countActive() === 0) {
      await fail('passkey_required');
      return { missingPasskey: true } as const;
    }
    if (!challenge) return fail();
    let hash: string | undefined;
    if (expected) {
      const session = await tx.sessions.get(expected.session.sessionId);
      if (!session || session.memberId !== caller.memberId || !liveSession(session, tx.now)
        || session.passkeyId !== expected.session.passkeyId) return fail();
      const sessionPasskey = await tx.passkeys.get(session.passkeyId);
      if (!sessionPasskey || sessionPasskey.revokedAt !== null) return fail();
      try { hash = bindingHash(expected.binding); } catch { return fail(); }
      if (challenge.action !== expected.binding.action || !equalHex(challenge.intentHash ?? '', hash)) return fail();
    }
    const passkey = await tx.passkeys.getByCredentialId(proof.assertion.id);
    if (!passkey || passkey.revokedAt !== null || proof.assertion.id !== proof.assertion.rawId) return fail();
    let counter: number;
    try {
      const client = JSON.parse(Buffer.from(proof.assertion.response.clientDataJSON, 'base64url').toString('utf8')) as { crossOrigin?: unknown; topOrigin?: unknown };
      if ((client.crossOrigin !== undefined && client.crossOrigin !== false) || client.topOrigin !== undefined) return fail();
      const result = await verifyAuthenticationResponse({
        response: authenticationResponse(proof.assertion),
        expectedChallenge: (candidate) => matchesChallenge(challenge, candidate, hash),
        expectedOrigin: options.config.webauthn.origins, expectedRPID: options.config.webauthn.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          // The repo enforces the current counter AFTER signature verification, including 0 regressions.
          counter: 0,
        },
      });
      if (!result.verified || !result.authenticationInfo.userVerified) return fail();
      counter = result.authenticationInfo.newCounter;
    } catch {
      // SimpleWebAuthn errors can contain assertion data. They never leave this boundary.
      return fail();
    }
    try { await tx.passkeys.recordUse(passkey.id, counter); }
    catch (error) {
      if (error instanceof StoreStateError) return fail(error.state === 'counter_regression' ? 'counter_regression' : 'assertion_invalid');
      throw error;
    }
    await audit(tx, caller, 'step_up.verified', { purpose });
    return { passkey, verified: { challengeId: challenge.id, passkeyId: passkey.id, intentHash: hash ?? '', at: tx.now } };
  });
  if (outcome && 'missingPasskey' in outcome) throw VaultError.reason('passkey_required');
  if (!outcome) throw VaultError.reason('step_up_invalid');
  return outcome;
}

export class WebAuthnOwnerAuth implements OwnerAuth {
  readonly #options: OwnerAuthOptions;
  constructor(options: OwnerAuthOptions) {
    this.#options = { ...options, clock: options.clock ?? systemClock };
  }

  async resolveSession(caller: VaultCaller, cookies: VaultCookies): Promise<OwnerSession | null> {
    if (!validToken(cookies.session)) return null;
    return this.#options.store.transaction(memberScope(caller), async (tx) => {
      const row = await tx.sessions.getByTokenHash(sha256(cookies.session!));
      if (!row || row.memberId !== caller.memberId || !liveSession(row, tx.now)) return null;
      const passkey = await tx.passkeys.get(row.passkeyId);
      if (!passkey || passkey.revokedAt !== null) return null;
      await tx.sessions.touch(row.id);
      return { sessionId: row.id, memberId: row.memberId, passkeyId: row.passkeyId, expiresAt: row.expiresAt };
    });
  }

  async verifyStepUp(caller: VaultCaller, session: OwnerSession, proof: VaultStepUpProof | undefined, binding: StepUpBinding): Promise<StepUpVerified> {
    if (!proof) {
      const count = await this.#options.store.transaction(memberScope(caller), (tx) => tx.passkeys.countActive());
      throw VaultError.reason(count === 0 ? 'passkey_required' : 'step_up_required');
    }
    const result = await verifyAssertion(this.#options, caller, proof, 'step_up', { session, binding });
    return result.verified;
  }

  async viewer(caller: VaultCaller, cookies: VaultCookies) {
    const session = await this.resolveSession(caller, cookies);
    return this.#options.store.transaction(memberScope(caller), async (tx) => ({
      passkeys: await tx.passkeys.countActive(), session,
      recoveryCodesRemaining: session ? await tx.recoveryCodes.countUnused() : null,
    }));
  }
}

export function createOwnerAuth(options: OwnerAuthOptions): OwnerAuth {
  return new WebAuthnOwnerAuth(options);
}
