import type { DecipherGCM } from 'node:crypto';
import { zeroize } from '../secret-material.js';

/**
 * Finishes an AES-GCM decryption and leaves one plaintext copy: the buffer it returns (review F05).
 *
 * `update()` returns the decrypted bytes BEFORE `final()` checks the tag. Under the right key with a
 * wrong AAD or a tampered tag, those bytes are the real plaintext, so they are wiped before the error
 * propagates. GCM's `final()` yields no bytes, so success returns `update()`'s own buffer instead of
 * a concatenated copy; the concatenation below exists only for a cipher that is not GCM.
 */
export function openGcm(decipher: DecipherGCM, body: Buffer): Buffer {
  const head = decipher.update(body);
  let tail: Buffer;
  try {
    tail = decipher.final();
  } catch (error) {
    zeroize(head);
    throw error;
  }
  if (tail.length === 0) return head;
  try {
    return Buffer.concat([head, tail]);
  } finally {
    zeroize(head, tail);
  }
}
