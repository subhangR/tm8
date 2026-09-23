/**
 * WHAT THE API-KEY PROBE IS ALLOWED TO CLAIM.
 *
 * Every other provider's probe asks a local question — does a CLI report a
 * session, is there a credential file — because that is all a local CLI can be
 * asked for free. Kimi and Groq are the first providers where tm8 HOLDS the
 * secret, so the probe can ask the vendor the real question and get a real
 * answer. That power is exactly why these tests exist: a probe that leaves the
 * machine has three more ways to be wrong than one that does not, and two of
 * them (a 429, a DNS failure) look like a rejection if you squint.
 *
 * The line these tests defend is the honesty doctrine's: `active` means THE
 * PROBE RAN AND ESTABLISHED SOMETHING — which includes establishing a negative
 * — and `stale` means CANNOT CONFIRM. Anything that collapses the second into
 * the first tells a member to re-paste a key that was never wrong.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_FILENAME, API_KEY_PROVIDER_VERIFY_URL } from '@tm8/execution';
import type { CredentialBinaryResolver } from '../../src/facade/services/w2/credential-probe.js';
import { runCredentialProbe } from '../../src/facade/services/w2/credential-probe.js';

/** The harness binary is `node`; this suite is not testing PATH resolution. */
const BINARY_PRESENT: CredentialBinaryResolver = ({ binary }) => `/test/bin/${binary}`;

function homeWith(key: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'tm8-apikey-probe-'));
  if (key !== null) {
    mkdirSync(join(home, 'kimi'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'kimi', API_KEY_FILENAME), key, { mode: 0o600 });
  }
  return home;
}

function probe(home: string) {
  return runCredentialProbe({
    provider: 'kimi',
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    cwd: home,
    resolveBinary: BINARY_PRESENT,
    // Nothing should ever shell out on this path. A runner that throws proves
    // it rather than trusting the branch order above it.
    run: async () => {
      throw new Error('the API-key probe must not run a command');
    },
  });
}

/** A `fetch` that answers once, and records what it was asked. */
function stubFetch(reply: Response | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
    });
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the API-key probe', () => {
  it('asks the vendor with the stored key, and reports a 200 as connected', async () => {
    const calls = stubFetch(new Response('{"data":[]}', { status: 200 }));
    const result = await probe(homeWith('sk-real-key-value\n'));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(API_KEY_PROVIDER_VERIFY_URL.kimi);
    // A BEARER header, not `x-api-key`. Moonshot's endpoint authenticates the
    // standard Authorization header; the vendor-specific one it would ignore.
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-real-key-value');

    expect(result.connected).toBe(true);
    expect(result.status).toBe('active');
    // A key names no account. `login` must stay null rather than be invented
    // from a key prefix, which is what the card renders as "connected-unnamed".
    expect(result.login).toBeNull();
    expect(result.authMethod).toBe('api_key');
  });

  it('reports a 401 as a MEASURED negative, not as uncertainty', async () => {
    stubFetch(new Response('{"error":"invalid_api_key"}', { status: 401 }));
    const result = await probe(homeWith('sk-stale-key\n'));

    expect(result.connected).toBe(false);
    // `active` describes the PROBE, not the credential: we asked and we were
    // told no. Calling this `stale` would hide a dead key behind "can't tell".
    expect(result.status).toBe('active');
    expect(result.detail).toContain('rejected');
  });

  it('reports a 429 or a 5xx as STALE — the vendor said nothing about the key', async () => {
    for (const status of [429, 500, 503]) {
      stubFetch(new Response('', { status }));
      const result = await probe(homeWith('sk-perfectly-good-key\n'));
      expect(result.status, `HTTP ${status} must not be a verdict on the key`).toBe('stale');
      expect(result.connected).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('reports an unreachable vendor as stale, never as a rejection', async () => {
    stubFetch(new Error('getaddrinfo ENOTFOUND api.moonshot.ai'));
    const result = await probe(homeWith('sk-key\n'));

    expect(result.status).toBe('stale');
    expect(result.connected).toBe(false);
    expect(result.detail).toContain('could not be reached');
  });

  /* A MISSING FILE IS A DETERMINATE ANSWER HERE, and that is the one place this
     probe is deliberately more confident than Gemini's. Gemini's credential is
     written by a vendor CLI whose storage shape we only measured, so its absence
     might mean a credential we do not know how to find. This file is written by
     tm8, at a path tm8 chose, by nothing else. */
  it('treats a missing key file as "not connected", not as "cannot tell"', async () => {
    const calls = stubFetch(new Response('', { status: 200 }));
    const result = await probe(homeWith(null));

    expect(calls).toHaveLength(0);
    expect(result.connected).toBe(false);
    expect(result.status).toBe('active');
  });

  it('treats an empty key file the same way, without asking the vendor', async () => {
    const calls = stubFetch(new Response('', { status: 200 }));
    const result = await probe(homeWith('\n'));

    expect(calls).toHaveLength(0);
    expect(result.connected).toBe(false);
    expect(result.status).toBe('active');
  });

  it('cannot tell when there is no isolated HOME to read from', async () => {
    const result = await runCredentialProbe({
      provider: 'groq',
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/tmp',
      resolveBinary: BINARY_PRESENT,
    });
    expect(result.status).toBe('stale');
    expect(result.connected).toBe(false);
  });

  /* THE SECRET MUST NOT RIDE OUT ON THE DETAIL. `detail` is surfaced to the
     member and written to logs, and every branch below composes it from a
     display name and an HTTP status — but "composes it safely" is a property of
     the code as written, not of the type, so it is asserted rather than assumed.
     The transport-failure branch is deliberately NOT asserted here: it forwards
     the thrown error's own message, which tm8 does not author, so this test
     would be pinning someone else's string. What keeps that branch safe is that
     the key is sent as a HEADER — a URL carries it nowhere a fetch error could
     quote it — which the 200 test above pins directly. */
  it('never puts the key itself in the detail it reports', async () => {
    const key = 'sk-do-not-leak-me-0123456789';
    for (const status of [401, 500]) {
      stubFetch(new Response('', { status }));
      const result = await probe(homeWith(`${key}\n`));
      expect(result.detail ?? '', `HTTP ${status} detail leaked the key`).not.toContain(key);
      vi.unstubAllGlobals();
    }
  });
});
