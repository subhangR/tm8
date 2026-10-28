/**
 * The keyed AAD form (§5.2) and the KeyProvider seam (§9.4), without a database.
 *
 * The property worth a test of its own is DOMAIN SEPARATION. Every other form in
 * secret-box.ts separates its domain by SEPARATOR COUNT — account has one, space
 * two, space-link three — so the obvious way to add a key id, appending it to the
 * space form, would have produced three separators and collided with the
 * space-link form: a link ciphertext could then have been opened as an MCP one.
 * The `mcp-key|` prefix is what prevents that, and these tests are what keep
 * anyone from "simplifying" it away.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bindingAad, openSecret, sealSecret, SECRET_KEY_BYTES } from '../../src/credentials/secret-box.js';
import { localKeyProvider, mcpSecretBinding, LOCAL_KEY_ID, isKnownKeyId } from '../../src/credentials/key-provider.js';

const key = randomBytes(SECRET_KEY_BYTES);
const spaceId = '11111111-1111-4111-8111-111111111111';
const credentialId = '22222222-2222-4222-8222-222222222222';
let dir: string;

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'mcp-key-provider-')); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

it('the keyed form is prefixed, so it cannot collide with the link or space-gate forms', () => {
  const keyed = bindingAad({ keyId: LOCAL_KEY_ID, spaceId, credentialId, provider: 'mcp' });
  expect(keyed).toBe(`mcp-key|${LOCAL_KEY_ID}|${spaceId}|${credentialId}|mcp`);
  // A space-link AAD has the same number of separators and must stay distinct.
  const link = bindingAad({ homeSpaceId: spaceId, linkId: credentialId, memberId: 'm', targetSpaceId: 't' });
  expect(keyed).not.toBe(link);
  expect(keyed.startsWith('mcp-key|')).toBe(true);
  // The unkeyed space form is what pre-341 rows carry, and it differs.
  expect(bindingAad({ spaceId, credentialId, provider: 'mcp' })).toBe(`${spaceId}|${credentialId}|mcp`);
});

it('a separator in the key id is refused rather than silently reshaping the AAD', () => {
  expect(() => bindingAad({ keyId: 'local|v1', spaceId, credentialId, provider: 'mcp' })).toThrow(/key id/);
  expect(() => bindingAad({ keyId: LOCAL_KEY_ID, spaceId, credentialId, provider: 'm|cp' })).toThrow(/provider/);
});

it('ciphertext is pinned to its key id: the id cannot be swapped on the row', () => {
  const sealed = sealSecret(key, 'token', mcpSecretBinding({ spaceId, credentialId }, LOCAL_KEY_ID));
  expect(openSecret(key, sealed, mcpSecretBinding({ spaceId, credentialId }, LOCAL_KEY_ID))).toBe('token');
  // Claiming a different key id, or none, must fail the tag check.
  expect(() => openSecret(key, sealed, mcpSecretBinding({ spaceId, credentialId }, 'local:v2'))).toThrow();
  expect(() => openSecret(key, sealed, mcpSecretBinding({ spaceId, credentialId }, null))).toThrow();
  // And a legacy ciphertext does not open as a keyed one.
  const legacy = sealSecret(key, 'legacy', mcpSecretBinding({ spaceId, credentialId }, null));
  expect(openSecret(key, legacy, mcpSecretBinding({ spaceId, credentialId }, null))).toBe('legacy');
  expect(() => openSecret(key, legacy, mcpSecretBinding({ spaceId, credentialId }, LOCAL_KEY_ID))).toThrow();
});

it('the local provider knows one key id, refuses any other, and treats null as legacy', async () => {
  const provider = localKeyProvider(dir);
  expect(provider.activeKeyId).toBe(LOCAL_KEY_ID);
  expect(isKnownKeyId(LOCAL_KEY_ID)).toBe(true);
  expect(isKnownKeyId('aws-kms:alias/tm8')).toBe(false);
  const active = await provider.keyFor(LOCAL_KEY_ID);
  expect(active).toHaveLength(SECRET_KEY_BYTES);
  // A legacy row is the same node key — only its AAD form differs.
  expect(await provider.keyFor(null)).toEqual(active);
  expect(await provider.keyFor(undefined)).toEqual(active);
  // Rule 2: refuse before any crypto, never guess with the key at hand.
  await expect(provider.keyFor('vault-transit:tm8')).rejects.toThrow(/unknown credential key id/);
});
