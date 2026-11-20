/** Test-only authenticator: no real browser credential ceremony is ever run. */

const bytes = () => new Uint8Array([1, 2, 3]).buffer;
const common = () => ({
  id: 'AQID', rawId: bytes(), type: 'public-key', authenticatorAttachment: 'platform',
  getClientExtensionResults: () => ({}),
});

export function installFakeCredentials() {
  const get = async () => ({ ...common(), response: {
    clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes(), userHandle: null,
  } });
  const create = async () => ({ ...common(), response: {
    clientDataJSON: bytes(), attestationObject: bytes(), getTransports: () => ['internal'],
  } });
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get, create } });
  return { get, create };
}

export function generatedCanary() {
  return ['gh', 'p_', 'A'.repeat(20), crypto.randomUUID().replace(/-/g, '').slice(0, 16)].join('');
}

export const tinyPng = () => btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10) + '\0\0\0\rIHDR');
