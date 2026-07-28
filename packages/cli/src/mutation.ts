/**
 * Mutation identity (§7.4).
 *
 * Every mutation accepts `--mutation-id`. When it is omitted the CLI generates
 * a UUIDv7. When it is supplied the CLI passes it through VERBATIM — no
 * trimming, no case-folding, no re-generation, no "that doesn't look like a
 * UUID so I'll make you a better one".
 *
 * Why that is a correctness rule and not fussiness: a client mutation id is
 * the ONLY thing that makes a retry after transport uncertainty safe. A script
 * that gets ECONNRESET re-sends the same id, and the Server either replays the
 * stored result or refuses with `invariant_violation` /
 * `message_batch_identity_mismatch` because the stable input changed. Both
 * answers are useful. A silently regenerated id turns the first case into a
 * duplicate write and hides the second entirely.
 *
 * UUIDv7 specifically (not v4) because it is time-ordered: the Server's
 * idempotency rows and any operator reading them get a free chronological
 * index, and two ids generated in the same millisecond still differ.
 *
 * Reads do not accept a mutation id at all.
 */
import { createHash, randomBytes } from 'node:crypto';
import { CliError, EXIT_USAGE } from './exit.js';

const HEX = '0123456789abcdef';

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
  return out;
}

/**
 * RFC 9562 UUIDv7: 48-bit big-endian Unix ms, version nibble 7, 12 random
 * bits, variant `10`, 62 random bits.
 */
export function uuidv7(now: number = Date.now(), rand: (n: number) => Uint8Array = randomBytes): string {
  const bytes = new Uint8Array(16);
  const ms = Math.max(0, Math.floor(now));
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  const random = rand(10);
  for (let i = 0; i < 10; i++) bytes[6 + i] = random[i] ?? 0;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the id a mutation will send.
 *
 * A supplied id is returned unchanged. It is rejected only when it is empty or
 * carries surrounding whitespace — because "fix it quietly" is exactly the
 * behaviour that breaks retry identity, so the caller has to see it.
 */
export function resolveMutationId(supplied: string | undefined, now?: number): string {
  if (supplied === undefined) return now === undefined ? uuidv7() : uuidv7(now);
  if (supplied.length === 0) {
    throw new CliError('--mutation-id cannot be empty', EXIT_USAGE);
  }
  if (supplied.trim() !== supplied) {
    throw new CliError(
      `--mutation-id has surrounding whitespace: ${JSON.stringify(supplied)}. ` +
        'The CLI will not normalize a mutation id — a changed id is a different mutation.',
      EXIT_USAGE,
    );
  }
  return supplied;
}

/**
 * Reads must refuse it. `--mutation-id` on a read is a caller who believes
 * their read is idempotently retryable in a way it is not, or who typed the
 * wrong command.
 */
export function refuseMutationId(command: string, supplied: string | undefined): void {
  if (supplied !== undefined) {
    throw new CliError(`\`tm8 ${command}\` is a read; --mutation-id applies only to mutations`, EXIT_USAGE);
  }
}

/**
 * Composed commands (`file upload` = init + transfer + complete, or abort) fan
 * ONE caller-visible id out into one distinct id per catalog mutation. §4.10:
 * "Each catalog mutation receives its own deterministically derived mutation
 * ID; one ID cannot be reused across different operations."
 *
 * Deterministic so that a resumed or retried composition derives the SAME
 * stage ids from the same root, which is what makes stage-level replay work.
 * Namespaced by stage so no two stages can collide. The shape is a v8 UUID
 * (RFC 9562 custom): it stays a valid UUID for anything that parses one, while
 * being honestly labelled as derived rather than time-ordered.
 */
export function deriveMutationId(rootId: string, stage: string): string {
  const digest = createHash('sha256').update(`tm8/mutation/${rootId}/${stage}`).digest();
  const bytes = new Uint8Array(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // version 8 — custom/derived
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
