import { TOOL_MAX_OUTPUT_BYTES } from '@tm8/contract';
import { REDACTION_MARKER, redactSecretTokens } from '../spawn/secret-redaction.js';

export function utf8Tail(value: string, cap = TOOL_MAX_OUTPUT_BYTES): string {
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - cap);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
export function redactToolOutput(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join(REDACTION_MARKER);
  }
  return utf8Tail(redactSecretTokens(redacted));
}
