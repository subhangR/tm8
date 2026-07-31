/**
 * The LiveKit token and webhook verifier.
 *
 * These are the two places where getting it "nearly right" is indistinguishable
 * from getting it right, until a real SFU refuses a connection with no useful
 * error. So the assertions here decode the token rather than checking it is a
 * non-empty string, and the negative cases outnumber the positive ones.
 */
import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  VOICE_TOKEN_TTL_SECONDS,
  mintAccessToken,
  verifyWebhookRequest,
} from '../../src/voice/livekit-token.js';

const KEY = 'devkey';
const SECRET = 'secret-that-is-long-enough-for-hs256';
const NOW = 1_800_000_000;

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

/** Build the exact request LiveKit sends, so the verifier is tested against its real input. */
function signedWebhook(body: string, secret = SECRET, key = KEY, overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = {
    iss: key,
    exp: NOW + 300,
    sha256: createHash('sha256').update(Buffer.from(body)).digest('base64'),
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `Bearer ${header}.${payload}.${signature}`;
}

describe('mintAccessToken', () => {
  const minted = mintAccessToken({
    apiKey: KEY, apiSecret: SECRET, room: 'room-entity-id', identity: 'member-entity-id',
    name: 'Ada', nowSeconds: NOW,
  });

  it('is an HS256 JWT whose signature verifies against the API secret', () => {
    const { header } = decode(minted.token);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });

    const [h, p, signature] = minted.token.split('.') as [string, string, string];
    const expected = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(signature).toBe(expected);
  });

  it('names the room and the identity in the claims LiveKit actually reads', () => {
    const { payload } = decode(minted.token);
    expect(payload['iss']).toBe(KEY);
    expect(payload['sub']).toBe('member-entity-id');
    expect(payload['name']).toBe('Ada');
    // `video` is LiveKit's grant object; a token without `roomJoin` connects
    // and then silently cannot join anything.
    expect(payload['video']).toEqual({
      room: 'room-entity-id',
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
  });

  it('expires in ten minutes and reports that instant as the grant expiry', () => {
    const { payload } = decode(minted.token);
    expect(payload['exp']).toBe(NOW + VOICE_TOKEN_TTL_SECONDS);
    expect(minted.expiresAt).toBe(new Date((NOW + VOICE_TOKEN_TTL_SECONDS) * 1000).toISOString());
  });

  it('back-dates nbf so a slightly-slow clock does not reject a valid token', () => {
    expect(decode(minted.token).payload['nbf']).toBe(NOW - 60);
  });

  it('grants no video or screenshare — v1 is audio only, so there is nothing to revoke later', () => {
    const grant = decode(minted.token).payload['video'] as Record<string, unknown>;
    expect(grant['canPublishSources']).toBeUndefined();
    expect(grant['roomAdmin']).toBeUndefined();
    expect(grant['roomCreate']).toBeUndefined();
  });

  it('omits the name claim entirely when there is no display name, rather than sending empty', () => {
    const anonymous = mintAccessToken({
      apiKey: KEY, apiSecret: SECRET, room: 'r', identity: 'i', nowSeconds: NOW,
    });
    expect('name' in decode(anonymous.token).payload).toBe(false);
  });
});

describe('verifyWebhookRequest', () => {
  const body = JSON.stringify({ event: 'participant_joined', room: { name: 'r' } });
  const raw = Buffer.from(body);

  it('accepts a correctly signed request whose digest matches the body', () => {
    expect(verifyWebhookRequest(signedWebhook(body), raw, KEY, SECRET, NOW)).toEqual({ ok: true });
  });

  it('rejects a request signed with a different secret', () => {
    const verdict = verifyWebhookRequest(signedWebhook(body, 'wrong-secret'), raw, KEY, SECRET, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('REJECTS A VALID TOKEN STAPLED TO A DIFFERENT BODY', () => {
    // The whole reason the digest is checked as well as the signature, and the
    // whole reason this route must read raw bytes rather than a re-serialized
    // object: the token below is perfectly signed and perfectly valid.
    const tampered = Buffer.from(JSON.stringify({ event: 'participant_joined', room: { name: 'someone-elses-room' } }));
    expect(verifyWebhookRequest(signedWebhook(body), tampered, KEY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'body digest mismatch' });
  });

  it('rejects a token with no body digest rather than accepting it unchecked', () => {
    const noDigest = signedWebhook(body, SECRET, KEY, { sha256: undefined });
    expect(verifyWebhookRequest(noDigest, raw, KEY, SECRET, NOW))
      .toEqual({ ok: false, reason: 'no body digest in token' });
  });

  it('rejects a token issued by a different LiveKit deployment', () => {
    expect(verifyWebhookRequest(signedWebhook(body, SECRET, 'other-deployment'), raw, KEY, SECRET, NOW).ok)
      .toBe(false);
  });

  it('rejects an expired token', () => {
    const expired = signedWebhook(body, SECRET, KEY, { exp: NOW - 1 });
    expect(verifyWebhookRequest(expired, raw, KEY, SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a missing or malformed Authorization header without throwing', () => {
    expect(verifyWebhookRequest(undefined, raw, KEY, SECRET, NOW).ok).toBe(false);
    expect(verifyWebhookRequest('Bearer not-a-jwt', raw, KEY, SECRET, NOW).ok).toBe(false);
    // A signature of a different LENGTH must be refused, not crash:
    // `timingSafeEqual` THROWS on mismatched lengths.
    expect(() => verifyWebhookRequest('Bearer a.b.c', raw, KEY, SECRET, NOW)).not.toThrow();
  });
});
