/**
 * Request ids (DEV-6 / DEV-8).
 *
 * One id per request, generated before anything can fail, so that EVERY
 * response — success envelope, error body, and the server log line — carries
 * the same id. At W2 it is also stamped into `SET LOCAL tm8.request_id`
 * (Cygnus, R2), which makes a Postgres audit row joinable to the id the
 * client was shown.
 *
 * Ids are process-unique, not globally unique: a short random process tag
 * plus a monotonic counter. That is enough to correlate a client report with
 * a log line, and it stays cheap (no uuid per request).
 */
import { randomBytes } from 'node:crypto';

const PROCESS_TAG = randomBytes(3).toString('hex');

let counter = 0;

export function nextRequestId(): string {
  counter += 1;
  return `req_${PROCESS_TAG}_${counter.toString(36)}`;
}
