/**
 * The whole credential chain against a real Postgres and a real key file:
 * `gitCredentials.set` → encrypted row → the spawn port → plaintext token.
 *
 * The unit test proves the AEAD is sound and the pg test proves the grants are;
 * this one proves they are WIRED to each other. All three are necessary because
 * the failure this guards against is not a broken cipher or a broken policy —
 * it is a correct cipher and a correct policy joined by code that stores one
 * account's ciphertext and hands it to another, or that never encrypts at all.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getOperation, type OperationName } from '@tm8/contract';

import { PgDb } from '../../src/db/client.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { W2GitCredentialsService } from '../../src/facade/services/w2/git-credentials.js';
import { createGitCredentialPort } from '../../src/facade/services/w2/git-credentials-port.js';
import { resetCredentialKeyCache } from '../../src/credentials/index.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const TOKEN_A = 'ghp_AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const TOKEN_B = 'ghp_BbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';

interface Person {
  identityId: string;
  accountId: string;
  owner: LoopbackOwner;
  service: W2GitCredentialsService;
}

let database: W1ScratchDatabase;
let dataDir: string;
let db: PgDb;
let alice: Person;
let bob: Person;

function ctx(opName: OperationName, body?: unknown, query = ''): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: {},
    query: new URLSearchParams(query),
    body,
    requestId: 'test-request',
    identity: { kind: 'auto-owner', identityId: 'unused' },
    headers: {},
    method: op.method,
    path: op.path,
  } as RequestContext;
}

async function person(identityId: string, username: string): Promise<Person> {
  const accountId = randomUUID();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.accounts(id, identity_id, username) values ($1,$2,$3)`,
      [accountId, identityId, username],
    );
  });
  const owner: LoopbackOwner = {
    identityId,
    accountId,
    username,
    isNodeAdmin: false,
    isOwner: false,
  };
  const deps: FacadeDeps = {
    db,
    config: {} as FacadeDeps['config'],
    owner: async () => owner,
  };
  return {
    identityId,
    accountId,
    owner,
    service: new W2GitCredentialsService(deps, { dataDir }),
  };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('git_cred_service');
  database.apply(migrationFiles());
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-gitcred-svc-'));
  db = new PgDb({ databaseUrl: database.url });
  alice = await person('git-svc-alice', 'alice');
  bob = await person('git-svc-bob', 'bob');
}, 240_000);

afterAll(async () => {
  resetCredentialKeyCache();
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 240_000);

describe('gitCredentials.* end to end', () => {
  it('reports nothing connected before anything is stored', async () => {
    expect(await alice.service.status(ctx('gitCredentials.status'))).toEqual({
      connected: false,
      provider: 'github',
      login: null,
      updatedAt: null,
    });
  });

  it('stores a credential and answers with a status that cannot carry a token', async () => {
    const result = await alice.service.set(
      ctx('gitCredentials.set', { provider: 'github', login: 'alice-gh', token: TOKEN_A }),
    );
    expect(result).toMatchObject({ connected: true, provider: 'github', login: 'alice-gh' });
    expect(new Date(result.updatedAt!).getTime()).toBeGreaterThan(0);
    // The shape itself is the guarantee: there is no field a token could sit in.
    expect(Object.keys(result).sort()).toEqual(['connected', 'login', 'provider', 'updatedAt']);
    expect(JSON.stringify(result)).not.toContain(TOKEN_A);

    const status = await alice.service.status(ctx('gitCredentials.status'));
    expect(status).toMatchObject({ connected: true, login: 'alice-gh' });
    expect(JSON.stringify(status)).not.toContain(TOKEN_A);
  });

  it('never writes the plaintext to Postgres', async () => {
    const row = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ token_ciphertext: Buffer; token_nonce: Buffer }>(
        `select token_ciphertext, token_nonce from public.account_git_credentials
          where account_id = $1`,
        [alice.accountId],
      )).rows[0]!;
    });
    // Read with the highest privilege this database has, and the token is not
    // there — which is exactly what a dump or a replica would also see.
    expect(row.token_ciphertext.includes(Buffer.from(TOKEN_A, 'utf8'))).toBe(false);
    expect(row.token_ciphertext.toString('utf8')).not.toContain('ghp_');
    expect(row.token_nonce).toHaveLength(12);
  });

  it('hands the spawn path the plaintext back, per account', async () => {
    await bob.service.set(
      ctx('gitCredentials.set', { provider: 'github', login: 'bob-gh', token: TOKEN_B }),
    );
    const portFor = (p: Person) =>
      createGitCredentialPort({ db, dataDir }).forSpawner({
        identityId: p.identityId,
        nodeAdmin: false,
        requestId: 'spawn-test',
      });

    expect(await portFor(alice)).toEqual({
      provider: 'github',
      login: 'alice-gh',
      token: TOKEN_A,
    });
    // Bob's session gets BOB's token. This is the whole feature in one assertion.
    expect(await portFor(bob)).toEqual({ provider: 'github', login: 'bob-gh', token: TOKEN_B });
  });

  it('rotates in place rather than accumulating rows', async () => {
    const rotated = 'ghp_CcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc';
    await alice.service.set(
      ctx('gitCredentials.set', { provider: 'github', login: 'alice-gh', token: rotated }),
    );
    const count = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ count: string }>(
        `select count(*)::text count from public.account_git_credentials where account_id = $1`,
        [alice.accountId],
      )).rows[0]!.count;
    });
    expect(count).toBe('1');
    expect(
      await createGitCredentialPort({ db, dataDir }).forSpawner({
        identityId: alice.identityId,
        nodeAdmin: false,
        requestId: 'spawn-test',
      }),
    ).toMatchObject({ token: rotated });
  });

  it('deletes idempotently, and the spawn path then sees nothing', async () => {
    expect(await alice.service.delete(ctx('gitCredentials.delete'))).toEqual({
      connected: false,
      provider: 'github',
      deleted: true,
    });
    expect(await alice.service.delete(ctx('gitCredentials.delete'))).toEqual({
      connected: false,
      provider: 'github',
      deleted: false,
    });
    expect(await alice.service.status(ctx('gitCredentials.status'))).toMatchObject({
      connected: false,
      login: null,
    });
    expect(
      await createGitCredentialPort({ db, dataDir }).forSpawner({
        identityId: alice.identityId,
        nodeAdmin: false,
        requestId: 'spawn-test',
      }),
    ).toBeNull();
    // Bob is untouched: delete names no account, so it cannot name the wrong one.
    expect(await bob.service.status(ctx('gitCredentials.status'))).toMatchObject({
      connected: true,
      login: 'bob-gh',
    });
  });

  it('refuses an unsupported provider before it reaches Postgres', async () => {
    await expect(
      alice.service.status(ctx('gitCredentials.status', undefined, 'provider=gitlab')),
    ).rejects.toThrow(/unsupported git credential provider/);
  });

  it('degrades to no credential when the node key can no longer open the row', async () => {
    // Simulate the key file being replaced — an operator restoring a database
    // backup onto a fresh node. The stored row is then permanently unreadable,
    // and the honest behaviour is "no credential", not a failed spawn.
    const strangerDir = await mkdtemp(join(tmpdir(), 'tm8-gitcred-other-'));
    const warnings: string[] = [];
    const port = createGitCredentialPort({
      db,
      dataDir: strangerDir,
      logger: { warn: (message) => warnings.push(message) },
    });
    const resolved = await port.forSpawner({
      identityId: bob.identityId,
      nodeAdmin: false,
      requestId: 'spawn-test',
    });
    expect(resolved).toBeNull();
    expect(warnings.join(' ')).toContain('could not be decrypted');
    // The failure is reported without any part of the credential in it.
    expect(warnings.join(' ')).not.toContain(TOKEN_B);
    await rm(strangerDir, { recursive: true, force: true });
  });
});
