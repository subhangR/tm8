import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { googleFirstPartyService } from '@tm8/contract';
import { startW3PublicServer, successData, type W3PublicServer } from '../w3/public-harness.js';
import { startGoogleFixture, type GoogleFixture } from '../mcp/google-fixture.js';

// The Google first-party connector through the FULL composition: main's own
// wiring of the host, a freshly migrated database, the public HTTP routes, the
// real credential store and key — and a FIXTURE Google, so nothing leaves the
// machine. Run only with an explicit isolated test PG URL; the harness refuses 5442.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const gmail = googleFirstPartyService('google.gmail')!;
let node: W3PublicServer;
let google: GoogleFixture;
let serverId = '';

beforeAll(async () => {
  google = await startGoogleFixture();
  const bootLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    node = await startW3PublicServer('mcp_google_first_party', {
      googleConnectors: { endpoints: google.endpoints, client: () => google.client, privateNetwork: true },
    });
  } finally { bootLog.mockRestore(); }
  const space = successData(await node.request<{ space: { id: string } }>('POST', '/v2/spaces', { name: 'Google first party', clientMutationId: randomUUID() }));
  const created = successData(await node.request<{ id: string }>('POST', `/v2/spaces/${space.space.id}/mcp/servers`, {
    spaceId: space.space.id, clientMutationId: randomUUID(),
    definition: { name: 'gmail', transport: 'http', url: gmail.resource, catalogId: 'google.gmail', firstParty: true, approved: true,
      auth: { type: 'oauth2', scopes: [...gmail.scopes] }, envKeys: [], headerKeys: [] },
  }));
  serverId = created.id;
});
afterAll(async () => {
  await node?.close();
  await google?.close();
});

it('connects a Google account over the public routes, labelled from userinfo, then lists tools in-process, refreshes through the database, and disconnects without revoking the shared Google grant', async () => {
  // Begin: Google's static endpoint and parameters, no discovery request.
  const started = successData(await node.request<{ authorizationUrl: string }>('POST', `/v2/mcp/servers/${serverId}/oauth/begin`, { serverId, clientMutationId: randomUUID(), label: 'Work Google' }));
  const authorizationUrl = new URL(started.authorizationUrl);
  expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(google.endpoints.authorization);
  expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({ access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', client_id: google.client.clientId });
  expect(google.requests).toHaveLength(0);

  // Consent → callback. A short-lived token makes the next use refresh.
  google.accessTtl = 10;
  const completed = await node.request<{ id: string; accountLabel?: string }>('POST', '/v2/mcp/oauth/callback', { state: authorizationUrl.searchParams.get('state'), code: google.issueCode(authorizationUrl) });
  expect(completed.status).toBe(200);
  const connection = successData(completed);
  expect(connection).toMatchObject({ serverId, label: 'Work Google', accountLabel: google.email });
  for (const secret of [google.accessToken, google.refreshToken, google.client.clientSecret]) expect(JSON.stringify(completed.body)).not.toContain(secret);
  const [row] = await node.rows<{ account_label: string; granted_scopes: string[]; secret_ciphertext: Buffer }>(
    'select account_label, granted_scopes, secret_ciphertext from public.space_credentials where id = $1', [connection.id]);
  expect(row).toMatchObject({ account_label: google.email, granted_scopes: [...gmail.scopes] });
  expect(row!.secret_ciphertext.toString('latin1')).not.toContain(google.client.clientSecret);

  // mcp.servers.test runs tools/list through the proxy and the in-process host,
  // after a refresh that the real store re-seals through refresh_mcp_credential.
  const accessBefore = google.accessToken;
  google.accessTtl = 3599;
  const tested = successData(await node.request<{ ready: boolean; tools: { name: string }[] }>('POST', `/v2/mcp/servers/${serverId}/test`, { serverId, clientMutationId: randomUUID(), credentialId: connection.id }));
  expect(tested.ready).toBe(true);
  expect(tested.tools.map(tool => tool.name)).toEqual(['search_messages', 'get_message', 'get_thread', 'list_labels', 'create_draft']);
  const refresh = google.calls('/token').at(-1)!;
  expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token');
  expect(new URLSearchParams(refresh.body).get('resource')).toBeNull();
  expect(google.accessToken).not.toBe(accessBefore);
  const [refreshed] = await node.rows<{ last_refresh_at: Date | null }>('select last_refresh_at from public.space_credentials where id = $1', [connection.id]);
  expect(refreshed!.last_refresh_at).not.toBeNull();

  // Disconnect stops tm8 using this connection, and does NOT revoke at Google:
  // the account's other Google connections share the grant.
  expect((await node.request('POST', `/v2/mcp/credentials/${connection.id}/revoke`, { credentialId: connection.id, clientMutationId: randomUUID() })).status).toBe(200);
  // B39: so the still-live Google token must not survive in tm8 — the row
  // keeps no ciphertext and no nonce, only the fact that it was revoked.
  const [revoked] = await node.rows<{ status: string; secret_ciphertext: Buffer | null; secret_nonce: Buffer | null }>(
    'select status, secret_ciphertext, secret_nonce from public.space_credentials where id = $1', [connection.id]);
  expect(revoked).toMatchObject({ status: 'revoked', secret_ciphertext: null, secret_nonce: null });
  expect(google.calls('/revoke')).toHaveLength(0);
});
