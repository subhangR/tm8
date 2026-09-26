// W6: does a serialized payload leak a sealed secret? Two checks, never bare
// substrings of the whole payload: "aad" is a hex run, so a random UUID (a
// memberId "aad52e5a-…") tripped the old /ciphertext|nonce|aad|tm8s_/i probe
// ~1% of runs (#885, run 36232661649 a1).
//
// 1. A JSON KEY that CONTAINS a sealed-field word. A UUID is always a value,
//    never a key, so this stays UUID-safe while catching affixed names
//    (secret_ciphertext, ciphertext_b64, sealed_nonce, value_aad). The words
//    come from every sealed column and field on this tree:
//      ciphertext — 244:59 ciphertext, 206:142 secret_ciphertext, 203:48 key_ciphertext,
//                   093:38 token_ciphertext; secret-box.ts:10 ciphertext,
//                   space-credential-store.ts:138 secretCiphertext,
//                   service-key-store.ts:57 keyCiphertext, github-credential-store.ts:21 tokenCiphertext
//      nonce      — 244:60 nonce, 206:143 secret_nonce, 203:49 key_nonce, 093:39 token_nonce;
//                   secret-box.ts:11 nonce, secretNonce, keyNonce, tokenNonce (same files, next line)
//      aad        — 244:61 aad (the binding string, not itself secret, but it names the sealed row)
//      sealed     — secret-box.ts:81 `sealed: SealedSecret` (a whole sealed pair)
// 2. A token VALUE by its issued prefix: tm8s_ session (crypto.ts:104), tm8c_ cli
//    (pg-auth.ts:389), tm8g_ pty grant (grant-token.ts:5). `t` and `m` are not
//    hex, so no UUID can hold "tm8".
//
// NOT caught: a raw third-party secret value with no tm8 prefix (a GitHub PAT, a
// provider API key) under an innocuous key. The old substring probe never
// caught those either.
const SEALED_KEY = /"([^"]*(?:ciphertext|nonce|aad|sealed)[^"]*)"\s*:/gi;
const TOKEN_VALUE = /tm8[scg]_/;

// Legitimate non-secret keys that contain a sealed-field word, exempted by EXACT
// name (case-sensitive) with a reason each. Never narrow SEALED_KEY to fit one.
// Empty: no key of the space link list payload (244 internal.space_link_json /
// space_link_row_json) contains any of the words. `announce*` needs no entry:
// "announce" does not contain "nonce".
export const EXEMPT_KEYS: ReadonlySet<string> = new Set<string>([]);

export function leaksSecret(json: string, exempt: ReadonlySet<string> = EXEMPT_KEYS): boolean {
  for (const m of json.matchAll(SEALED_KEY)) {
    if (!exempt.has(m[1]!)) return true;
  }
  return TOKEN_VALUE.test(json);
}
