/**
 * W2 artifacts service — against a real scratch database (055_artifacts.sql).
 *
 * Covers the load-bearing claims of the server slice:
 *  - the six catalog handlers are all registered (taxonomy: v1 GETs never 501);
 *  - create → publish drives a NON-debounced entity version (two rapid publishes
 *    by the same actor yield two `entity_versions` rows — design §5.3);
 *  - export is deterministic (two exports of one revision are byte-identical);
 *  - manifest refusals and unregistered blobs map to `invalid_input`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OPERATIONS,
  isCollabError,
  manifestSha256,
  type ArtifactManifest,
  type ArtifactsCreateInput,
  type ArtifactsPublishInput,
  type CommandResult,
  type OperationName,
} from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { DbClaims } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2ArtifactHandlers } from '../../src/facade/handlers/w2/artifacts.js';
import { W2ArtifactsService } from '../../src/facade/services/w2/artifacts.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW2BlobStore, type W2BlobStore } from '../../src/files/w2-blob-store.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<{ spaceId: string; memberId: string }>(
      `select internal.new_id()::text as "spaceId", internal.new_id()::text as "memberId"`,
    )).rows[0]!;
    const identityId = 'artifacts-owner';
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Artifacts Owner')`,
      [identityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Artifacts', $2)`,
      [ids.spaceId, identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, visibility, created_by)
       values ($1, $2, 'member', 'space', $1)`,
      [ids.memberId, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Artifacts Owner')`,
      [ids.memberId, ids.spaceId, identityId],
    );
    return { identityId, spaceId: ids.spaceId, memberId: ids.memberId };
  });
}

function opBinding(name: OperationName) {
  const op = OPERATIONS.find((candidate) => candidate.name === name);
  if (!op) throw new Error(`no such operation in catalog: ${name}`);
  return op;
}

describe('W2 artifacts handlers are all registered', () => {
  it('registers all six catalog operations (v1 GETs must not answer 501)', () => {
    const registry = new HandlerRegistry();
    registerW2ArtifactHandlers(
      registry,
      {} as FacadeDeps,
      { blobStore: {} as W2BlobStore },
    );
    for (const name of [
      'artifacts.create',
      'artifacts.publish',
      'artifacts.revisions.list',
      'artifacts.preview.start',
      'artifacts.export',
      'artifacts.restore',
    ] as const) {
      expect(registry.get(name), name).toBeTypeOf('function');
    }
  });
});

describe('W2 artifacts service (pg)', () => {
  let database: W1ScratchDatabase;
  let dataDir: string;
  let db: PgDb;
  let blobStore: W2BlobStore;
  let service: W2ArtifactsService;
  let fixture: Fixture;
  let owner: LoopbackOwner;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('artifacts');
    database.apply(migrationFiles());
    fixture = await seed(database);
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-artifacts-'));
    db = new PgDb({ databaseUrl: database.url });
    blobStore = createW2BlobStore({ dataDir });
    owner = {
      identityId: fixture.identityId,
      accountId: 'account-artifacts',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    };
    const deps: FacadeDeps = {
      db,
      config: {} as FacadeDeps['config'],
      owner: async () => owner,
    };
    service = new W2ArtifactsService(deps, { blobStore, now: () => new Date('2026-07-31T12:00:00.000Z') });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await database?.destroy();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const claims = (): DbClaims => ({ identityId: fixture.identityId, nodeAdmin: true, requestId: 'test' });

  function ctx(opName: OperationName, params: Record<string, string>, body?: unknown): RequestContext {
    return {
      op: opBinding(opName),
      opName,
      params,
      query: new URLSearchParams(),
      body,
      requestId: 'test-request',
      identity: { kind: 'auto-owner', identityId: fixture.identityId },
      headers: {},
      method: opBinding(opName).method,
      path: opBinding(opName).path,
    };
  }

  async function registerBytes(text: string): Promise<{ sha256: string; size: number }> {
    const bytes = Buffer.from(text, 'utf8');
    const registered = await service.registerBlobBytes(claims(), fixture.spaceId, bytes);
    return { sha256: registered.sha256, size: registered.sizeBytes };
  }

  it('create → publish → export round-trips, non-debounced version, deterministic zip', async () => {
    const app = await registerBytes('console.log("hi from artifact");');
    const html = await registerBytes('<!doctype html><title>a</title><script src="app.js"></script>');

    // files MUST arrive sorted ascending by UTF-8 bytes of path: 'app.js' < 'index.html'.
    const manifest: ArtifactManifest = {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [
        { path: 'app.js', mediaType: 'text/javascript', size: app.size, sha256: app.sha256 },
        { path: 'index.html', mediaType: 'text/html', size: html.size, sha256: html.sha256 },
      ],
    };

    const createInput: ArtifactsCreateInput = {
      clientMutationId: `create-${randomUUID()}`,
      spaceId: fixture.spaceId,
      name: 'My Artifact',
      description: 'a tiny bundle',
      manifest,
    };
    const created = (await service.create(ctx('artifacts.create', {}, createInput))) as CommandResult;
    const artifactId = created.entity?.id;
    expect(artifactId, 'create returns the new artifact entity').toBeTruthy();
    expect(created.entity?.kind).toBe('artifact');
    expect(created.entity?.state).toMatchObject({ kind: 'artifact', revisionNumber: 1 });
    expect(created.entity?.content).toMatchObject({
      kind: 'artifact',
      currentRevisionNumber: 1,
      entrypoint: 'index.html',
      manifestSha256: manifestSha256(manifest),
      fileCount: 2,
    });

    // Publish a second revision as the SAME actor, immediately: the debounce
    // must be bypassed, so entity_versions gains a row per publish (design §5.3).
    const publishInput: ArtifactsPublishInput = {
      clientMutationId: `publish-${randomUUID()}`,
      expectedVersion: created.entity!.version,
      manifest,
    };
    const published = (await service.publish(
      ctx('artifacts.publish', { artifactId: artifactId! }, publishInput),
    )) as CommandResult;
    expect(published.entity?.state).toMatchObject({ kind: 'artifact', revisionNumber: 2 });

    const versionRows = await database.query<{ count: string }>(
      `select count(*)::text as count from public.entity_versions where entity_id = $1`,
      [artifactId],
    );
    expect(Number(versionRows[0]!.count), 'two publishes → two version rows, not one').toBeGreaterThanOrEqual(2);

    // revisions.list returns both revisions, newest first.
    const listed = (await service.revisionsList(
      ctx('artifacts.revisions.list', { artifactId: artifactId! }),
    )) as { revisions: Array<{ revisionNumber: number }> };
    expect(listed.revisions.map((r) => r.revisionNumber)).toEqual([2, 1]);

    // Export revision 1 twice → byte-identical, valid zip.
    const exportCtx = ctx('artifacts.export', { artifactId: artifactId!, revisionNumber: '1' });
    const first = (await service.export(exportCtx)) as { kind: 'raw'; status: number; headers: Record<string, string>; body: Buffer };
    const second = (await service.export(exportCtx)) as { kind: 'raw'; body: Buffer };
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/zip');
    expect(first.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(sha256(second.body)).toBe(sha256(first.body));
  });

  it('preview.start mints a token and returns no previewUrl', async () => {
    const html = await registerBytes('<!doctype html><title>preview</title>');
    const manifest: ArtifactManifest = {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [{ path: 'index.html', mediaType: 'text/html', size: html.size, sha256: html.sha256 }],
    };
    const created = (await service.create(
      ctx('artifacts.create', {}, {
        clientMutationId: `create-${randomUUID()}`,
        spaceId: fixture.spaceId,
        name: 'Preview Target',
        manifest,
      } satisfies ArtifactsCreateInput),
    )) as CommandResult;
    const artifactId = created.entity!.id;

    const preview = (await service.previewStart(
      ctx('artifacts.preview.start', { artifactId }, { clientMutationId: `prev-${randomUUID()}` }),
    )) as { previewSessionId: string; token: string; revisionNumber: number; expiresAt: string; previewUrl?: unknown };
    expect(preview.previewSessionId).toBeTruthy();
    expect(preview.token).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.revisionNumber).toBe(1);
    expect(preview.previewUrl).toBeUndefined();

    // Only the HASH of the token is stored, never the token itself.
    const stored = await database.query<{ token_hash: string }>(
      `select token_hash from public.artifact_preview_sessions where id = $1`,
      [preview.previewSessionId],
    );
    expect(stored[0]!.token_hash).toBe(sha256(Buffer.from(preview.token, 'utf8')));
    expect(stored[0]!.token_hash).not.toBe(preview.token);
  });

  it('185 — the session resolves for an identity that is NOT a member, because that is the identity the handler uses', async () => {
    // The regression: `createArtifactPreviewHandler` resolves the capability
    // row under the NODE OWNER's claims (the viewer is unknown until the row
    // is found). On a node that does not auto-join its owner to new spaces,
    // that identity has no `members` row here — and the 055 policy
    // `entity_readable` requires one, so every preview outside the owner's own
    // spaces answered 404 `no such preview` with a perfectly valid URL.
    const html = await registerBytes('<!doctype html><title>outsider</title>');
    const manifest: ArtifactManifest = {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [{ path: 'index.html', mediaType: 'text/html', size: html.size, sha256: html.sha256 }],
    };
    const created = (await service.create(
      ctx('artifacts.create', {}, {
        clientMutationId: `create-${randomUUID()}`,
        spaceId: fixture.spaceId,
        name: 'Outsider Lookup',
        manifest,
      } satisfies ArtifactsCreateInput),
    )) as CommandResult;
    const preview = (await service.previewStart(
      ctx('artifacts.preview.start', { artifactId: created.entity!.id }, {
        clientMutationId: `prev-${randomUUID()}`,
      }),
    )) as { previewSessionId: string; token: string };
    const tokenHash = sha256(Buffer.from(preview.token, 'utf8'));

    // An identity with no `members` row in this space at all — the node owner's
    // situation under TM8_DISABLE_AUTO_OWNER=1.
    const outsider = `identity-no-membership-${randomUUID()}`;
    const asOutsider = async <T>(
      fn: (client: Parameters<Parameters<typeof database.transaction>[0]>[0]) => Promise<T>,
    ): Promise<T> =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'w2-artifacts-185-pg', true)`,
          [outsider],
        );
        return fn(client);
      });

    // The definer lookup answers — this is what unbreaks the preview.
    const resolved = await asOutsider((client) =>
      client.query<{ entrypoint_path: string; viewer_identity_id: string }>(
        `select entrypoint_path, viewer_identity_id
           from internal.resolve_artifact_preview($1, $2)`,
        [preview.previewSessionId, tokenHash],
      ),
    );
    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]!.entrypoint_path).toBe('index.html');
    // It returns the recorded VIEWER, whom the handler then re-checks on every
    // byte — the lookup hands back a row, it does not decide who may read.
    expect(resolved.rows[0]!.viewer_identity_id).toBe(fixture.identityId);

    // The token is still the secret: a wrong preimage resolves nothing.
    const wrongToken = await asOutsider((client) =>
      client.query(`select 1 from internal.resolve_artifact_preview($1, $2)`, [
        preview.previewSessionId,
        sha256(Buffer.from('not-the-token', 'utf8')),
      ]),
    );
    expect(wrongToken.rows).toHaveLength(0);

    // And the RLS policy on the table itself is deliberately UNCHANGED: a
    // direct reader is still held to membership. Only the definer may bypass.
    const direct = await asOutsider((client) =>
      client.query(`select 1 from public.artifact_preview_sessions where id = $1`, [
        preview.previewSessionId,
      ]),
    );
    expect(direct.rows).toHaveLength(0);
  });

  it('a1 — preview.start mints previewUrl at the app origin when config carries the same-origin default', async () => {
    // loadConfig with NO TM8_PREVIEW_* resolves preview to the app origin
    // (proven in artifact-preview.test.ts); this proves the service turns
    // that config into a spendable absolute URL.
    const sameOriginService = new W2ArtifactsService(
      {
        db,
        config: {
          preview: {
            host: '127.0.0.1',
            port: 4610,
            origin: 'http://127.0.0.1:4610',
            sameOrigin: true,
            frameAncestors: ['http://127.0.0.1:4610'],
          },
        } as FacadeDeps['config'],
        owner: async () => owner,
      },
      { blobStore, now: () => new Date('2026-07-31T12:00:00.000Z') },
    );
    const html = await registerBytes('<!doctype html><title>same-origin preview</title>');
    const manifest: ArtifactManifest = {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [{ path: 'index.html', mediaType: 'text/html', size: html.size, sha256: html.sha256 }],
    };
    const created = (await sameOriginService.create(
      ctx('artifacts.create', {}, {
        clientMutationId: `create-${randomUUID()}`,
        spaceId: fixture.spaceId,
        name: 'Same-Origin Preview Target',
        manifest,
      } satisfies ArtifactsCreateInput),
    )) as CommandResult;
    const artifactId = created.entity!.id;
    const preview = (await sameOriginService.previewStart(
      ctx('artifacts.preview.start', { artifactId }, { clientMutationId: `prev-${randomUUID()}` }),
    )) as { previewSessionId: string; token: string; previewUrl?: string };
    expect(preview.previewUrl).toBe(
      `http://127.0.0.1:4610/p/${preview.previewSessionId}/${preview.token}/`,
    );
  });

  it('rejects a manifest with a traversal path as invalid_input', async () => {
    const bad: ArtifactManifest = {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: '../evil.js',
      files: [{ path: '../evil.js', mediaType: 'text/javascript', size: 3, sha256: sha256(Buffer.from('bad')) }],
    } as ArtifactManifest;
    await expect(
      service.create(ctx('artifacts.create', {}, {
        clientMutationId: `create-${randomUUID()}`,
        spaceId: fixture.spaceId,
        name: 'Bad',
        manifest: bad,
      } satisfies ArtifactsCreateInput)),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a manifest referencing an unregistered blob as invalid_input', async () => {
    const manifest: ArtifactManifest = {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [{
        path: 'index.html',
        mediaType: 'text/html',
        size: 5,
        sha256: sha256(Buffer.from('never-registered-bytes')),
      }],
    };
    await expect(
      service.create(ctx('artifacts.create', {}, {
        clientMutationId: `create-${randomUUID()}`,
        spaceId: fixture.spaceId,
        name: 'Unregistered',
        manifest,
      } satisfies ArtifactsCreateInput)),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
