/**
 * s-lld §3 / §19 — the phone's app-association files. Apple's CDN and
 * Android's verifier fetch these anonymously and accept only a 200 of bare
 * JSON, so whatever a node is configured with, each path answers JSON, never a
 * redirect and never the web UI's HTML. A node that names an app serves the
 * document with `Content-Type: application/json` exactly; one that does not
 * answers the DEV-8 `not_found`. The app identity is deployment config, so
 * only its shape is asserted here.
 */
import { describe, expect, it } from 'vitest';
import { WireErrorBodySchema } from '@tm8/contract';
import { BASE_URL } from '../src/client.js';

interface Fetched {
  status: number;
  headers: Headers;
  body: unknown;
}

/** `redirect: 'manual'`: a redirect is the failure, so it must not be followed. */
async function fetchWellKnown(path: string): Promise<Fetched> {
  const res = await fetch(new URL(path, BASE_URL), { redirect: 'manual' });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, body };
}

/** The answer every node owes, configured or not. */
function expectJsonAnswer(path: string, res: Fetched): void {
  expect([200, 404], `${path} answered ${res.status}`).toContain(res.status);
  expect(res.headers.get('location'), `${path} redirected`).toBeNull();
  expect(res.headers.get('content-type') ?? '').toMatch(/^application\/json/);
  expect(res.body, `${path} is not JSON`).toBeDefined();
  if (res.status === 200) {
    expect(res.headers.get('content-type')).toBe('application/json');
  } else {
    const parsed = WireErrorBodySchema.safeParse(res.body);
    expect(parsed.success, `error body drift: ${JSON.stringify(res.body)}`).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('not_found');
  }
}

const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;
const SHA256_FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

describe('the phone app-association files (s-lld §3)', () => {
  it('GET /.well-known/apple-app-site-association: JSON, no redirect; served, it matches path / with fragment /s/*', async () => {
    const path = '/.well-known/apple-app-site-association';
    const res = await fetchWellKnown(path);
    expectJsonAnswer(path, res);
    if (res.status !== 200) return;
    const aasa = res.body as {
      applinks?: { details?: Array<{ appIDs?: string[]; components?: Array<Record<string, string>> }> };
      webcredentials?: { apps?: string[] };
    };
    const details = aasa.applinks?.details ?? [];
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.appIDs?.length ?? 0).toBeGreaterThan(0);
      for (const appID of detail.appIDs ?? []) expect(appID).toMatch(APP_ID);
      expect(detail.components).toContainEqual({ '/': '/', '#': '/s/*' });
    }
    const named = details.flatMap((detail) => detail.appIDs ?? []);
    for (const app of aasa.webcredentials?.apps ?? []) expect(named).toContain(app);
  });

  it('GET /.well-known/assetlinks.json: JSON, no redirect; served, each statement vouches for an android_app', async () => {
    const path = '/.well-known/assetlinks.json';
    const res = await fetchWellKnown(path);
    expectJsonAnswer(path, res);
    if (res.status !== 200) return;
    expect(Array.isArray(res.body)).toBe(true);
    const statements = res.body as Array<{
      relation?: string[];
      target?: { namespace?: string; package_name?: string; sha256_cert_fingerprints?: string[] };
    }>;
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.relation).toContain('delegate_permission/common.handle_all_urls');
      expect(statement.target?.namespace).toBe('android_app');
      expect(statement.target?.package_name ?? '').toMatch(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/);
      expect(statement.target?.sha256_cert_fingerprints?.length ?? 0).toBeGreaterThan(0);
      for (const fingerprint of statement.target?.sha256_cert_fingerprints ?? []) {
        expect(fingerprint).toMatch(SHA256_FINGERPRINT);
      }
    }
  });
});
