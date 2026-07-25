/**
 * Request body reading and JSON parsing.
 *
 * Two taxonomy rules live here and nowhere else:
 * - a body over the configured cap → `payload_too_large` (413), refused
 *   *while streaming* so an oversized request never gets fully buffered;
 * - a body that is not valid JSON → `invalid_input` (400).
 *
 * The parse happens BEFORE routing (matching the conformance stub): a
 * malformed body is malformed regardless of which operation it was aimed at,
 * and the conformance envelope suite asserts exactly that (`POST /v2/entities`
 * with `'{not json'` → 400 `invalid_input`).
 */
import type { IncomingMessage } from 'node:http';
import { fail } from './errors.js';

export interface ParsedBody {
  /** The raw text, kept for handlers that need byte-exact input (none yet). */
  readonly raw: string;
  /** `undefined` when the request carried no body at all. */
  readonly value: unknown;
}

/**
 * How much past the limit we keep draining before giving up on a polite
 * answer. Draining matters: if the socket is destroyed the instant the cap is
 * crossed, the client is still mid-upload and sees a connection reset (EPIPE)
 * instead of the 413 the taxonomy promises. So on overflow we stop *buffering*
 * immediately — memory stays bounded — but keep *reading* so the response can
 * actually be delivered. A sender that keeps going past this slack is not
 * owed a courteous error, and gets the socket closed.
 */
const OVERFLOW_DRAIN_FACTOR = 4;

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;

    if (total > maxBytes) {
      overflowed = true;
      // Drop what we have; nothing past the cap will ever be parsed.
      chunks.length = 0;
      if (total > maxBytes * OVERFLOW_DRAIN_FACTOR) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(buf);
  }

  if (overflowed) {
    throw fail('payload_too_large', `request body exceeds the ${maxBytes} byte limit`, {
      limitBytes: maxBytes,
    });
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return { raw, value: undefined };

  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw fail('invalid_input', 'request body is not valid JSON');
  }
}
