/**
 * WHAT THE API-KEY PROBE IS ALLOWED TO CLAIM.
 *
 * Every other provider's probe asks a local question — does a CLI report a
 * session, is there a credential file — because that is all a local CLI can be
 * asked for free. Kimi, Groq and Grok are the providers where tm8 HOLDS the
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
import {
  credentialBinaryFor,
  runCredentialProbe,
} from '../../src/facade/services/w2/credential-probe.js';

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
  /* THE TWO OPENAI-COMPATIBLE VENDORS MUST NOT SHARE AN ENDPOINT. Groq and Grok
     differ by one transposed letter, serve different companies, and speak the
     same wire protocol — so a probe that sent a Grok key to api.groq.com would
     get a well-formed 401 and report the member's perfectly good key as
     rejected. This asserts the two verify URLs are distinct and each points at
     its own vendor; it is the cheapest possible guard against the one mistake
     these two names invite. */
  it('verifies each OpenAI-compatible vendor against its OWN endpoint', () => {
    expect(API_KEY_PROVIDER_VERIFY_URL.groq).toContain('api.groq.com');
    expect(API_KEY_PROVIDER_VERIFY_URL.grok).toContain('api.x.ai');
    expect(API_KEY_PROVIDER_VERIFY_URL.grok).not.toBe(API_KEY_PROVIDER_VERIFY_URL.groq);
  });

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

/**
 * GEMINI HAS TWO ROUTES, AND THE PROBE MUST NOT COLLAPSE THEM.
 *
 * Every other provider in this file answers one question. Gemini answers two,
 * because a member can hold either a pasted API key that tm8 stores and can
 * VERIFY against Google, or an OAuth credential file written by the CLI's own
 * `LOGIN_WITH_GOOGLE` flow, which tm8 can only OBSERVE the existence of.
 *
 * The order is key-first and it is load-bearing: the key route authenticates,
 * the file route only looks. Checking the file first would report a member with
 * a stale key and an old credentials file as connected, on the strength of a
 * file nobody has validated since it was written.
 *
 * The honest limit is stated too. `@google/gemini-cli` 0.58.0 carries FOUR auth
 * modes — `USE_GEMINI`, `LOGIN_WITH_GOOGLE`, `USE_VERTEX_AI`, `CLOUD_SHELL` —
 * and tm8 can see the first two. A negative here therefore means "tm8 has no
 * Gemini credential", never "this member cannot reach Gemini".
 */
describe('the Gemini dual-route probe', () => {
  function geminiHome(options: { key?: string; oauth?: boolean }): string {
    const home = mkdtempSync(join(tmpdir(), 'tm8-gemini-probe-'));
    if (options.key !== undefined) {
      mkdirSync(join(home, 'gemini'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'gemini', API_KEY_FILENAME), options.key, { mode: 0o600 });
    }
    if (options.oauth === true) {
      mkdirSync(join(home, '.gemini'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{"access_token":"x"}', {
        mode: 0o600,
      });
    }
    return home;
  }

  function geminiProbe(home: string) {
    return runCredentialProbe({
      provider: 'gemini',
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      cwd: home,
      resolveBinary: BINARY_PRESENT,
      run: async () => {
        throw new Error('the Gemini probe must not run a command');
      },
    });
  }

  it('verifies a stored key against Google, in the header Google reads', async () => {
    const calls = stubFetch(new Response('{"models":[]}', { status: 200 }));
    const result = await geminiProbe(geminiHome({ key: 'AIzaRealKeyValue\n' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('generativelanguage.googleapis.com');
    // `x-goog-api-key`, NOT `Authorization: Bearer`. Google rejects a bearer
    // key, so the generic bearer header would have failed every VALID key and
    // told the member their key was wrong when tm8 was asking wrongly.
    expect(calls[0]?.headers['x-goog-api-key']).toBe('AIzaRealKeyValue');
    expect(calls[0]?.headers['Authorization']).toBeUndefined();

    expect(result.connected).toBe(true);
    expect(result.status).toBe('active');
    expect(result.authMethod).toBe('api_key');
    expect(result.login).toBeNull();
  });

  it('falls through to the OAuth file when there is no key, and asks Google nothing', async () => {
    // The pre-existing member. There is nothing to verify and nothing to ask —
    // a network call here would be a request made on behalf of a member who
    // gave tm8 no key to make it with.
    const calls = stubFetch(new Response('', { status: 500 }));
    const result = await geminiProbe(geminiHome({ oauth: true }));

    expect(calls).toHaveLength(0);
    expect(result.connected).toBe(true);
    expect(result.status).toBe('active');
    expect(result.authMethod).toBe('oauth');
  });

  it('does not let a REJECTED key hide a working OAuth login', async () => {
    // Both routes present, the key dead. The member still has a usable Gemini
    // credential, and reporting them disconnected would be a false negative
    // that no action of theirs caused.
    stubFetch(new Response('', { status: 401 }));
    const result = await geminiProbe(geminiHome({ key: 'AIzaDeadKey\n', oauth: true }));

    expect(result.connected).toBe(true);
    expect(result.authMethod).toBe('oauth');
  });

  it('reports a rejected key with no OAuth file as a MEASURED negative', async () => {
    stubFetch(new Response('', { status: 401 }));
    const result = await geminiProbe(geminiHome({ key: 'AIzaDeadKey\n' }));

    expect(result.connected).toBe(false);
    // `active`, not `stale`: Google answered. The doctrine's distinction is
    // between "established a negative" and "could not tell", and this is the
    // first.
    expect(result.status).toBe('active');
    expect(result.detail ?? '').toContain('rejected');
    expect(result.detail ?? '').not.toContain('AIzaDeadKey');
  });

  it('cannot tell when Google itself said nothing, and does NOT consult the file', async () => {
    // A 5xx means the key's validity is unknown. Falling through to the file
    // route would convert "cannot confirm" into a confident answer drawn from a
    // DIFFERENT credential — the exact collapse the honesty doctrine forbids,
    // and `stale` is deliberately never persisted.
    stubFetch(new Response('', { status: 503 }));
    const result = await geminiProbe(geminiHome({ key: 'AIzaUnknown\n', oauth: true }));

    expect(result.status).toBe('stale');
    expect(result.connected).toBe(false);
  });

  it('gates on node, because the login flow IS node — and that is a widening', () => {
    // `credentialBinaryFor` takes the FIRST TOKEN of the login command, so
    // moving Gemini from `gemini` to the paste harness moved its gate from the
    // vendor CLI to `node`. Stated here because it is otherwise a silent
    // consequence of an unrelated-looking edit.
    //
    // It is the correct gate for THIS flow — the binary check asks "can the
    // login terminal run", and what runs is the harness — but it is genuinely
    // more permissive than before: a node without `@google/gemini-cli` can now
    // store and verify a Gemini key. That key is still real and still
    // verifiable; what it cannot do on such a node is back a `gemini` session,
    // and no `gemini` session can be spawned by tm8 on ANY node yet
    // (`AGENT_TOOL_BINARIES` carries claude-code, codex and echo-agent only).
    // So the widening admits a credential that is useful later rather than one
    // that is useless now.
    expect(credentialBinaryFor('gemini')).toBe('node');
    // The backends have always gated this way; Gemini now matches them.
    expect(credentialBinaryFor('kimi')).toBe('node');
    // And a genuine vendor-CLI provider still gates on its own binary, so this
    // is a per-provider consequence of the login command rather than a blanket
    // change.
    expect(credentialBinaryFor('anthropic')).toBe('claude');
  });

  it('says tm8 holds no credential, not that the member has no Gemini', async () => {
    const calls = stubFetch(new Response('', { status: 500 }));
    const result = await geminiProbe(geminiHome({}));

    expect(calls).toHaveLength(0);
    expect(result.connected).toBe(false);
    expect(result.status).toBe('active');
    expect(result.authMethod).toBeNull();
    // The limit of the claim is IN the message, because a member reading
    // "not connected" while their Vertex-backed CLI works fine would reasonably
    // conclude tm8 is broken.
    expect(result.detail ?? '').toMatch(/Vertex|Cloud Shell/i);
  });
});
