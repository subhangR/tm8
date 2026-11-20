/**
 * Browser-only snapshot of the used rows in contract/src/vault.ts at 5a31d446.
 * No runtime import: the contract's validators depend on zod. Contract tests
 * compare these rows and all outgoing command schemas against that source.
 */
export const VAULT_IMPORT_PAGE_PATH = '/vault/capture/import';
export const VAULT_MAX_CAPTURE_CIPHERTEXT = 64 * 1024;
export const VAULT_MAX_IMPORT_CIPHERTEXT = 8 * 1024 * 1024;
export const VAULT_OPERATIONS = {
  'vault.status': { method: 'GET', path: '/v2/vault/status' },
  'vault.webauthn.challenge': { method: 'POST', path: '/v2/vault/webauthn/challenges' },
  'vault.session.begin': { method: 'POST', path: '/v2/vault/session' },
  'vault.captures.open': { method: 'POST', path: '/v2/vault/captures/:captureId/open' },
  'vault.captures.submit': { method: 'POST', path: '/v2/vault/captures/:captureId/submit' },
  'vault.imports.begin': { method: 'POST', path: '/v2/vault/imports' },
  'vault.imports.upload': { method: 'POST', path: '/v2/vault/imports/:importId/upload' },
  'vault.imports.commit': { method: 'POST', path: '/v2/vault/imports/:importId/commit' },
  'vault.imports.cancel': { method: 'POST', path: '/v2/vault/imports/:importId/cancel' },
} as const;
export type Operation = keyof typeof VAULT_OPERATIONS;
export type ItemType = 'login' | 'api_key' | 'card' | 'note' | 'identity';
export type ExposureTier = 'a' | 'b' | 'c';
export const IMPORT_FORMATS = ['chrome_csv', 'firefox_csv', 'safari_csv', 'bitwarden_csv', 'bitwarden_json', 'onepassword_csv', 'generic_csv'] as const;
export type ImportFormat = typeof IMPORT_FORMATS[number];

export interface CapturePublicKey {
  kid: string;
  raw?: string;
  jwk?: { kty: 'EC'; crv: 'P-256'; x: string; y: string; ext: true };
}
export interface SealedCapture { v: 1; kid: string; epk: string; nonce: string; ct: string }
export interface CaptureOpen {
  captureId: string; itemType: ItemType; purpose: 'create' | 'replace';
  itemId: string | null; itemName: string | null; expiresAt: string;
  publicKey: CapturePublicKey; maxCiphertextBytes: number;
}
export interface ImportSession {
  importId: string; expiresAt: string; publicKey: CapturePublicKey; maxCiphertextBytes: number;
}
export interface ImportCandidate {
  index: number; type: 'login' | 'note' | 'card'; name: string;
  origin: string | null; originError: string | null; username: string | null;
  hasPassword: boolean; hasTotp: boolean; duplicateOf: number | null; warnings: string[];
}
export interface ImportPreview {
  importId: string; format: ImportFormat; candidates: ImportCandidate[];
  skipped: { index: number; reason: string }[]; expiresAt: string;
}
export interface ImportRow {
  index: number; include: boolean; exposureTier: ExposureTier; name?: string; originOverride?: string;
}
export interface ImportResult {
  importId: string; created: { index: number; itemId: string; state: string }[];
  skipped: { index: number; reason: string }[]; deleteSourceAdvice: true;
}
export interface VaultStatus {
  mode: 'off' | 'dev' | 'pre_review' | 'production'; testSecretsOnly: boolean;
  features: { capture: boolean; import: boolean };
  viewer: { vaultSession: { sessionId: string; expiresAt: string } | null };
}
export interface AssertionJSON {
  id: string; rawId: string; type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  authenticatorAttachment?: 'platform' | 'cross-platform' | null;
}
export interface Challenge {
  challengeId: string; purpose: 'sign_in' | 'step_up'; action: string | null; expiresAt: string;
  publicKey: {
    challenge: string; rpId: string; timeout: number; userVerification: 'required';
    allowCredentials: { id: string; type: 'public-key'; transports?: string[] }[];
    extensions?: AuthenticationExtensionsClientInputs;
  };
}
export interface StepUp { challengeId: string; assertion: AssertionJSON }
export type StepUpAction = 'vault.captures.submit' | 'vault.imports.commit';
