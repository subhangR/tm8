/**
 * LiveKit access tokens and webhook verification, hand-rolled on `node:crypto`.
 *
 * WHY NOT `livekit-server-sdk`. `@tm8/server` has exactly two runtime
 * dependencies (`pg`, `zod`) and that budget is deliberate. A LiveKit access
 * token is an ordinary HS256 JWT with one custom claim object; the whole of
 * what the SDK would give us is below, in less code than its own import line
 * costs. If this ever needs token refresh, egress, or SIP grants, take the
 * dependency — this file is not a place to grow a JWT library.
 *
 * WHAT THE TOKEN IS. A capability, signed by tm8-server, that the browser
 * hands directly to the SFU. tm8-server is therefore the ONLY authority on who
 * joins which room, and it never sees an audio byte (voice plan §2). The room
 * name is the voice_channel entity id and the participant identity is the
 * caller's member entity id, so LiveKit's own roster is already expressed in
 * tm8 ids and needs no mapping table.
 *
 * TTL. Ten minutes. The token is spent at connect time and LiveKit keeps the
 * session alive on its own after that, so a long TTL buys nothing and widens
 * the window in which a leaked token is a working microphone.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Ten minutes — see the TTL note above. */
export const VOICE_TOKEN_TTL_SECONDS = 600;

export interface AccessTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  /** LiveKit room name — the voice_channel entity id. */
  readonly room: string;
  /** Participant identity — the caller's member entity id. */
  readonly identity: string;
  /** Display name shown to other participants. */
  readonly name?: string;
  readonly ttlSeconds?: number;
  /** Injectable clock, in seconds since the epoch. Tests pin it. */
  readonly nowSeconds?: number;
}

export interface MintedAccessToken {
  readonly token: string;
  /** Absolute expiry, ISO-8601 UTC — the same instant as the `exp` claim. */
  readonly expiresAt: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signHs256(signingInput: string, secret: string): string {
  return base64Url(createHmac('sha256', secret).update(signingInput).digest());
}

/**
 * Mint a room-join grant.
 *
 * v1 scope is audio only, so `canPublish` is true (the microphone) while there
 * is deliberately no video or screenshare grant to revoke later — a narrower
 * token is the cheaper default, and widening it is a one-line change when
 * video ships.
 */
export function mintAccessToken(input: AccessTokenInput): MintedAccessToken {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? VOICE_TOKEN_TTL_SECONDS;
  const exp = now + ttl;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: input.apiKey,
    sub: input.identity,
    // `nbf` one minute back absorbs modest clock skew between this host and
    // the SFU. Without it a correctly-minted token is rejected as not-yet-valid
    // on a host whose clock is a few seconds behind, which reads to the user as
    // a mysterious join failure.
    nbf: now - 60,
    exp,
    ...(input.name === undefined ? {} : { name: input.name }),
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      // Data messages are how the SDK carries mute/speaking hints between
      // peers without a server round-trip.
      canPublishData: true,
    },
  };

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  return {
    token: `${signingInput}.${signHs256(signingInput, input.apiSecret)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify a LiveKit webhook callback.
 *
 * LiveKit signs the request with a JWT in `Authorization`, whose `sha256`
 * claim is the base64 digest of the RAW body. Both halves matter and for
 * different reasons: the signature proves the SFU sent it, the digest proves
 * the body was not swapped afterwards. Checking only the signature would
 * accept a valid token stapled to someone else's payload.
 *
 * This is why the webhook route must read raw bytes and must NOT sit behind
 * the shared JSON body reader — a re-serialized body has a different digest
 * even when nothing about it changed.
 */
export function verifyWebhookRequest(
  authorization: string | undefined,
  rawBody: Buffer,
  apiKey: string,
  apiSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookVerification {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token === '') return { ok: false, reason: 'missing Authorization token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed JWT' };
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

  const expected = signHs256(`${encodedHeader}.${encodedPayload}`, apiSecret);
  // Constant-time, and length-guarded first because timingSafeEqual THROWS on
  // a length mismatch rather than returning false.
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return { ok: false, reason: 'bad signature' };
  if (!timingSafeEqual(actualBytes, expectedBytes)) return { ok: false, reason: 'bad signature' };

  let claims: { iss?: unknown; exp?: unknown; sha256?: unknown };
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    return { ok: false, reason: 'unparseable JWT payload' };
  }

  if (claims.iss !== apiKey) return { ok: false, reason: 'issuer is not this deployment' };
  if (typeof claims.exp === 'number' && claims.exp < nowSeconds) return { ok: false, reason: 'expired' };

  // The body digest. A token with no `sha256` claim is refused rather than
  // accepted-without-checking: an unverifiable body is not a verified one.
  if (typeof claims.sha256 !== 'string') return { ok: false, reason: 'no body digest in token' };
  const digest = createHash('sha256').update(rawBody).digest('base64');
  const claimed = Buffer.from(claims.sha256);
  const computed = Buffer.from(digest);
  if (claimed.length !== computed.length) return { ok: false, reason: 'body digest mismatch' };
  if (!timingSafeEqual(claimed, computed)) return { ok: false, reason: 'body digest mismatch' };

  return { ok: true };
}
