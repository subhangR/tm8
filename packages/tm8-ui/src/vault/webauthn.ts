import {
  VaultWebAuthnAssertionSchema, VaultWebAuthnRegistrationSchema,
  type VaultOutput, type VaultInput, type VaultWebAuthnAssertion,
} from '@tm8/contract';
import { VaultUiError } from './errors';

type RequestOptions = VaultOutput<'vault.webauthn.challenge'>['publicKey'];
type CreationOptions = VaultOutput<'vault.passkeys.registerBegin'>['publicKey'];
type Registration = VaultInput<'vault.passkeys.registerFinish'>['credential'];

export interface VaultAuthenticator {
  get(options: RequestOptions): Promise<VaultWebAuthnAssertion>;
  create(options: CreationOptions): Promise<Registration>;
}

function decode(value: string): ArrayBuffer {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function encode(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const descriptor = (value: RequestOptions['allowCredentials'][number]): PublicKeyCredentialDescriptor => ({
  ...value, id: decode(value.id), transports: value.transports as AuthenticatorTransport[] | undefined,
});

/** Native WebAuthn only; no password fallback, persistence, or credential logging. */
export const browserVaultAuthenticator: VaultAuthenticator = {
  async get(options) {
    if (typeof navigator === 'undefined' || !navigator.credentials?.get) {
      throw new VaultUiError('authenticator_unavailable');
    }
    try {
      const credential = await navigator.credentials.get({ publicKey: {
        ...options, challenge: decode(options.challenge),
        allowCredentials: options.allowCredentials.map(descriptor), userVerification: 'required',
      } }) as PublicKeyCredential | null;
      if (!credential || credential.type !== 'public-key') throw new VaultUiError('authenticator_cancelled');
      const response = credential.response as AuthenticatorAssertionResponse;
      const parsed = VaultWebAuthnAssertionSchema.safeParse({
        id: credential.id, rawId: encode(credential.rawId), type: 'public-key',
        response: {
          clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData),
          signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null,
        },
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment ?? null,
      });
      if (!parsed.success) throw new VaultUiError('authenticator_cancelled');
      return parsed.data;
    } catch {
      throw new VaultUiError('authenticator_cancelled');
    }
  },
  async create(options) {
    if (typeof navigator === 'undefined' || !navigator.credentials?.create) {
      throw new VaultUiError('authenticator_unavailable');
    }
    try {
      const credential = await navigator.credentials.create({ publicKey: {
        ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials.map(descriptor),
        authenticatorSelection: { ...options.authenticatorSelection, userVerification: 'required' },
      } }) as PublicKeyCredential | null;
      if (!credential || credential.type !== 'public-key') throw new VaultUiError('authenticator_cancelled');
      const response = credential.response as AuthenticatorAttestationResponse;
      const parsed = VaultWebAuthnRegistrationSchema.safeParse({
        id: credential.id, rawId: encode(credential.rawId), type: 'public-key',
        response: {
          clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject),
          ...(response.getTransports ? { transports: response.getTransports() } : {}),
        },
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment ?? null,
      });
      if (!parsed.success) throw new VaultUiError('authenticator_cancelled');
      return parsed.data;
    } catch {
      throw new VaultUiError('authenticator_cancelled');
    }
  },
};
