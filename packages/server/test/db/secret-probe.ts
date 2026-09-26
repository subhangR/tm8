// W6: does a serialized payload leak a sealed secret? Match JSON KEYS for the
// sealed columns and token VALUES by their issued prefix — never bare
// substrings: "aad" is a hex run, so a random UUID (e.g. a memberId
// "aad52e5a-…") tripped the old /ciphertext|nonce|aad|tm8s_/i probe ~1% of runs
// (#885, run 36232661649 a1). `t` and `m` are not hex, so no UUID can hold "tm8".
const SEALED_KEY = /"(ciphertext|nonce|aad)"\s*:/i;
const TOKEN_VALUE = /tm8[scg]_/; // session (crypto.ts), cli (pg-auth.ts), pty grant (grant-token.ts)

export function leaksSecret(json: string): boolean {
  return SEALED_KEY.test(json) || TOKEN_VALUE.test(json);
}
