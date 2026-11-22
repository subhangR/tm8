import type { AssertionJSON, Challenge, StepUp, StepUpAction } from './contract.js';
import { base64url, unbase64url } from './encoding.js';
import { PageError } from './errors.js';
import { VaultApi } from './api.js';

export async function getAssertion(challenge: Challenge, credentials: Pick<CredentialsContainer, 'get'>, signal: AbortSignal): Promise<AssertionJSON> {
  try {
    if (signal.aborted || challenge.publicKey.userVerification !== 'required' || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) throw new PageError('passkey_failed');
    const result = await credentials.get({
      signal,
      publicKey: {
        ...challenge.publicKey,
        challenge: unbase64url(challenge.publicKey.challenge),
        userVerification: 'required',
        allowCredentials: challenge.publicKey.allowCredentials.map((entry) => ({
          id: unbase64url(entry.id), type: 'public-key',
          ...(entry.transports ? { transports: entry.transports as AuthenticatorTransport[] } : {}),
        })),
      },
    });
    const credential = result as PublicKeyCredential | null;
    if (signal.aborted || !credential || credential.type !== 'public-key') throw new PageError('passkey_failed');
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      id: credential.id, rawId: base64url(new Uint8Array(credential.rawId)), type: 'public-key',
      response: {
        clientDataJSON: base64url(new Uint8Array(response.clientDataJSON)),
        authenticatorData: base64url(new Uint8Array(response.authenticatorData)),
        signature: base64url(new Uint8Array(response.signature)),
        userHandle: response.userHandle ? base64url(new Uint8Array(response.userHandle)) : null,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment as 'platform' | 'cross-platform' | null,
    };
  } catch { throw new PageError('passkey_failed'); }
}

export async function stepUp(
  api: VaultApi, credentials: Pick<CredentialsContainer, 'get'>, signal: AbortSignal,
  action: StepUpAction, pathParams: Record<string, string>, body: Record<string, unknown>,
  assertActive: () => void = () => {},
): Promise<StepUp> {
  const challenge = await api.call<Challenge>('vault.webauthn.challenge', {}, {
    ...api.command(), purpose: 'step_up', action, pathParams, body,
  });
  assertActive();
  if (challenge.purpose !== 'step_up' || challenge.action !== action) throw new PageError('passkey_failed');
  return { challengeId: challenge.challengeId, assertion: await getAssertion(challenge, credentials, signal) };
}
