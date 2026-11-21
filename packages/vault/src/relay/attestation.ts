import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { systemClock, type Clock, type VaultCaller } from '../core-types.js';
import { digestEquals } from '../intent/hash.js';

/**
 * The relay attestation: how the broker learns WHO is calling.
 *
 * The tm8 server authenticates the request with tm8's own auth, then forwards
 * it to the broker with one header:
 *
 *   x-tm8-vault-caller: b64url(claimsJson) "." b64url(Ed25519(signingPrefix + b64url(claimsJson)))
 *
 * The claims bind the caller to this exact request: method, path, raw query
 * and the SHA-256 of the exact body bytes forwarded. They live at most 30 s and
 * carry a single-use `rid`, so a captured header cannot be replayed or moved
 * to another request. The server holds the private key; the broker holds only
 * the public key, so the broker can never mint an identity.
 *
 * This replaces forwarding the caller's raw tm8 bearer (plan §2): the broker
 * never sees a tm8 credential. What it proves is the `member` authority level
 * and nothing more. Owner authority still needs a passkey (core-types.ts).
 *
 * Known limit for the independent review: on a host where agent sessions run
 * as the same uid as the tm8 server, an agent can read the signing key file.
 * That is one reason `pre_review` holds test secrets only.
 */
export const VAULT_ATTESTATION_HEADER = 'x-tm8-vault-caller';
export const ATTESTATION_MAX_TTL_SECONDS = 30;
export const ATTESTATION_DEFAULT_TTL_SECONDS = 15;
/** Allowed clock disagreement between relay and broker, both ways. */
export const ATTESTATION_MAX_SKEW_SECONDS = 5;

/**
 * The broker refuses a longer header unread. The schema alone would allow a
 * longer one (a 4096-char query), so the signer enforces this cap too.
 */
export const ATTESTATION_MAX_HEADER_CHARS = 4096;

const SIGNING_PREFIX = 'tm8-vault-attest|v1|';
const B64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IdSchema = z.string().regex(UUID);
const CallerSchema = z.object({
  kind: z.enum(['member', 'agent']),
  memberId: IdSchema,
  spaceId: IdSchema,
  sessionId: IdSchema.nullable(),
  name: z.string().max(200).nullable(),
  isSpaceAdmin: z.boolean(),
  ip: z.string().max(64).nullable(),
}).strict();

const ClaimsSchema = z.object({
  v: z.literal(1),
  rid: IdSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  /** The request path exactly as forwarded: no query, no fragment, printable ASCII only. */
  path: z.string().max(512).regex(/^\/v2\/vault\/[\x21-\x7e]*$/).refine((path) => !/[?#]/.test(path)),
  /** The raw query string without the leading `?`; empty when there is none. */
  query: z.string().max(4096).regex(/^[\x21-\x7e]*$/).refine((query) => !query.includes('#')),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  caller: CallerSchema,
}).strict();

export type AttestationClaims = z.infer<typeof ClaimsSchema>;

/** The request as the relay forwards it and as the broker receives it. */
export interface AttestedRequest {
  method: string;
  path: string;
  query: string;
  /** The exact bytes on the wire. Empty for GET. */
  body: Buffer | Uint8Array | string;
}

export type AttestationFailure =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'ttl_too_long'
  | 'request_mismatch'
  | 'replayed'
  /** The replay cache is full of live entries. Refuse rather than forget one. */
  | 'replay_cache_full';

/**
 * The request is too long to attest: its path, query and caller name do not
 * fit in `ATTESTATION_MAX_HEADER_CHARS`. That is the client's request, not a
 * relay bug, so the relay answers 414 and never forwards it.
 */
export class AttestationTooLargeError extends Error {
  constructor() {
    super(`vault attestation: the header would exceed ${ATTESTATION_MAX_HEADER_CHARS} chars`);
    this.name = 'AttestationTooLargeError';
  }
}

/** Every failure answers 401 `unauthenticated` with no reason. The relay never sends a bad header, so any of these is a bug or an attack. */
export class AttestationError extends Error {
  constructor(readonly code: AttestationFailure) {
    super(`vault attestation refused: ${code}`);
    this.name = 'AttestationError';
  }
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** Node's base64url decoder skips characters it does not know. This one refuses them, and refuses non-canonical encodings. */
function strictB64url(text: string): Buffer | null {
  if (!B64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

function bodyDigest(body: AttestedRequest['body']): string {
  return createHash('sha256').update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('hex');
}

function requireEd25519(key: KeyObject, type: 'private' | 'public'): KeyObject {
  if (key.type !== type || key.asymmetricKeyType !== 'ed25519') throw new TypeError(`attestation key must be an Ed25519 ${type} key`);
  return key;
}

export function generateAttestationKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

/** PKCS#8 PEM. The tm8 server loads this; nothing else should be able to read the file. */
export function loadAttestationPrivateKey(pem: string | Buffer): KeyObject {
  return requireEd25519(createPrivateKey(pem), 'private');
}

/** SPKI PEM. The broker loads this. */
export function loadAttestationPublicKey(pem: string | Buffer): KeyObject {
  return requireEd25519(createPublicKey(pem), 'public');
}

export function exportAttestationKeyPair(pair: { privateKey: KeyObject; publicKey: KeyObject }): { privatePem: string; publicPem: string } {
  return {
    privatePem: requireEd25519(pair.privateKey, 'private').export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: requireEd25519(pair.publicKey, 'public').export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Relay side. Throws a TypeError (a relay bug) if it would sign something the
 * broker must refuse, and AttestationTooLargeError for a request too long to attest.
 */
export function signAttestation(input: {
  privateKey: KeyObject;
  caller: VaultCaller;
  request: AttestedRequest;
  clock?: Clock;
  ttlSeconds?: number;
}): string {
  const key = requireEd25519(input.privateKey, 'private');
  const ttl = input.ttlSeconds ?? ATTESTATION_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > ATTESTATION_MAX_TTL_SECONDS) throw new TypeError('attestation ttl must be 1..30 seconds');
  const iat = Math.floor((input.clock ?? systemClock).now().getTime() / 1000);
  const parsed = ClaimsSchema.safeParse({
    v: 1,
    rid: randomUUID(),
    iat,
    exp: iat + ttl,
    method: input.request.method,
    path: input.request.path,
    query: input.request.query,
    bodySha256: bodyDigest(input.request.body),
    caller: {
      kind: input.caller.kind,
      memberId: input.caller.memberId,
      spaceId: input.caller.spaceId,
      sessionId: input.caller.sessionId,
      name: input.caller.name,
      isSpaceAdmin: input.caller.isSpaceAdmin,
      ip: input.caller.ip,
    },
  });
  if (!parsed.success) throw new TypeError('attestation claims refused by the schema');
  const payload = b64url(Buffer.from(JSON.stringify(parsed.data), 'utf8'));
  const signature = sign(null, Buffer.from(SIGNING_PREFIX + payload, 'ascii'), key);
  const header = `${payload}.${b64url(signature)}`;
  if (header.length > ATTESTATION_MAX_HEADER_CHARS) throw new AttestationTooLargeError();
  return header;
}

/** Broker side. One instance per process: it owns the replay cache. */
export class AttestationVerifier {
  readonly #key: KeyObject;
  readonly #clock: Clock;
  readonly #maxEntries: number;
  /** rid -> epoch ms after which the rid can no longer verify (exp + skew). */
  readonly #seen = new Map<string, number>();

  constructor(publicKey: KeyObject, options: { clock?: Clock; maxReplayEntries?: number } = {}) {
    this.#key = requireEd25519(publicKey, 'public');
    this.#clock = options.clock ?? systemClock;
    this.#maxEntries = options.maxReplayEntries ?? 100_000;
  }

  verify(header: string | readonly string[] | undefined, request: AttestedRequest): VaultCaller {
    if (header === undefined || header === '') throw new AttestationError('missing');
    // Two headers is never the relay. Refuse instead of picking one.
    if (typeof header !== 'string' || header.length > ATTESTATION_MAX_HEADER_CHARS) throw new AttestationError('malformed');
    const parts = header.split('.');
    if (parts.length !== 2) throw new AttestationError('malformed');
    const [payload, signaturePart] = parts as [string, string];
    const payloadBytes = strictB64url(payload);
    const signature = strictB64url(signaturePart);
    if (!payloadBytes || !signature || signature.length !== 64) throw new AttestationError('malformed');

    // Signature first: nothing unauthenticated is parsed.
    if (!verify(null, Buffer.from(SIGNING_PREFIX + payload, 'ascii'), this.#key, signature)) {
      throw new AttestationError('bad_signature');
    }

    let claims: AttestationClaims;
    try {
      const parsed = ClaimsSchema.safeParse(JSON.parse(payloadBytes.toString('utf8')));
      if (!parsed.success) throw new AttestationError('malformed');
      claims = parsed.data;
    } catch {
      throw new AttestationError('malformed');
    }

    const nowMs = this.#clock.now().getTime();
    const now = Math.floor(nowMs / 1000);
    if (claims.exp <= claims.iat || claims.exp - claims.iat > ATTESTATION_MAX_TTL_SECONDS) throw new AttestationError('ttl_too_long');
    if (claims.iat > now + ATTESTATION_MAX_SKEW_SECONDS) throw new AttestationError('not_yet_valid');
    if (now >= claims.exp + ATTESTATION_MAX_SKEW_SECONDS) throw new AttestationError('expired');

    if (claims.method !== request.method || claims.path !== request.path || claims.query !== request.query
      || !digestEquals(claims.bodySha256, bodyDigest(request.body))) {
      throw new AttestationError('request_mismatch');
    }

    // Ids match case-insensitively, so they are keyed and returned lowercase: the
    // store and the broker compare lowercase ids.
    const rid = claims.rid.toLowerCase();
    this.#sweep(nowMs, false);
    if (this.#seen.has(rid)) throw new AttestationError('replayed');
    if (this.#seen.size >= this.#maxEntries) this.#sweep(nowMs, true);
    if (this.#seen.size >= this.#maxEntries) throw new AttestationError('replay_cache_full');
    this.#seen.set(rid, (claims.exp + ATTESTATION_MAX_SKEW_SECONDS) * 1000);

    const caller = claims.caller;
    return {
      kind: caller.kind,
      memberId: caller.memberId.toLowerCase(),
      spaceId: caller.spaceId.toLowerCase(),
      sessionId: caller.sessionId === null ? null : caller.sessionId.toLowerCase(),
      name: caller.name,
      isSpaceAdmin: caller.isSpaceAdmin,
      ip: caller.ip,
    };
  }

  /** For tests and health: live replay entries. */
  get replayEntries(): number {
    return this.#seen.size;
  }

  /**
   * Insertion order tracks expiry closely (the relay uses one TTL), so the
   * routine sweep stops at the first live entry. An expired rid left behind
   * cannot be accepted anyway: its claims fail `expired` before this check.
   * A full sweep runs only before refusing as full.
   */
  #sweep(nowMs: number, full: boolean): void {
    for (const [rid, until] of this.#seen) {
      if (until <= nowMs) this.#seen.delete(rid);
      else if (!full) return;
    }
  }
}
