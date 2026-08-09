import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { DbClaims } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2SpaceFolderHandlers } from '../../src/facade/handlers/w2/space-folders.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { W2BlobStore } from '../../src/files/w2-blob-store.js';
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
    const identityId = 'space-folder-owner';
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Folder Owner')`,
      [identityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Files', $2)`,
      [ids.spaceId, identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, visibility, created_by)
       values ($1, $2, 'member', 'space', $1)`,
      [ids.memberId, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Folder Owner')`,
      [ids.memberId, ids.spaceId, identityId],
    );
    return { identityId, spaceId: ids.spaceId, memberId: ids.memberId };
  });
}

describe('Space folder handlers', () => {
  it('registers all six catalog operations', () => {
    const registry = new HandlerRegistry();
    registerW2SpaceFolderHandlers(
      registry,
      {} as FacadeDeps,
      { blobStore: {} as W2BlobStore },
    );
    expect(registry.implemented()).toEqual([
      'spaceFolders.browse',
      'spaceFolders.create',
      'spaceFolders.ingest',
      'spaceFolders.list',
      'spaceFolders.read',
      'spaceFolders.uploadInit',
    ]);
  });
});

describe('Space folder persistence (pg)', () => {
  let database: W1ScratchDatabase;
  let db: PgDb;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('space_folders');
    database.apply(migrationFiles());
    fixture = await seed(database);
    db = new PgDb({ databaseUrl: database.url });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await database?.destroy();
  });

  const claims = (): DbClaims => ({
    identityId: fixture.identityId,
    nodeAdmin: true,
    requestId: 'space-folders-test',
  });

  it('creates, ingests, replays, replaces, and marks the old blob unreferenced', async () => {
    const folder = await db.rpc<{ id: string }>(claims(), 'create_space_folder', [
      fixture.spaceId, 'Design docs', fixture.memberId, 'folder-create-1',
    ]);
    const first = Buffer.from('first');
    const firstSha = createHash('sha256').update(first).digest('hex');
    const firstBlob = await db.rpc<{ blobId: string }>(claims(), 'register_stored_blob', [
      fixture.spaceId, firstSha, first.length, `spaces/${fixture.spaceId}/${randomUUID()}`, fixture.memberId,
    ]);
    const uploadId = randomUUID();
    const skipped = [{ path: '../bad', reason: 'path-traversal', detail: 'refused' }];
    const args = [
      folder.id,
      uploadId,
      JSON.stringify(['docs']),
      JSON.stringify([{ path: 'docs/readme.md', dirPath: 'docs', mediaType: 'text/markdown', sizeBytes: first.length, sha256: firstSha }]),
      JSON.stringify(skipped),
      fixture.memberId,
      'folder-ingest-1',
    ] as const;
    const ingested = await db.rpc<Record<string, unknown>>(claims(), 'ingest_space_folder', args);
    expect(ingested).toMatchObject({
      folderId: folder.id,
      uploadId,
      added: 1,
      replaced: 0,
      directories: 1,
      skipped,
      entryCount: 1,
      totalSizeBytes: first.length,
    });
    await expect(db.rpc(claims(), 'ingest_space_folder', args)).resolves.toEqual(ingested);

    const rows = await db.query<{ path: string; dir_path: string }>(
      claims(),
      `select path,dir_path from public.space_folder_entries where folder_id=$1`,
      [folder.id],
    );
    expect(rows).toEqual([{ path: 'docs/readme.md', dir_path: 'docs' }]);

    const second = Buffer.from('second');
    const secondSha = createHash('sha256').update(second).digest('hex');
    await db.rpc(claims(), 'register_stored_blob', [
      fixture.spaceId, secondSha, second.length, `spaces/${fixture.spaceId}/${randomUUID()}`, fixture.memberId,
    ]);
    const replaced = await db.rpc<Record<string, unknown>>(claims(), 'ingest_space_folder', [
      folder.id,
      randomUUID(),
      JSON.stringify(['docs']),
      JSON.stringify([{ path: 'docs/readme.md', dirPath: 'docs', mediaType: 'text/markdown', sizeBytes: second.length, sha256: secondSha }]),
      JSON.stringify([]),
      fixture.memberId,
      'folder-ingest-2',
    ]);
    expect(replaced).toMatchObject({ added: 0, replaced: 1, entryCount: 1, totalSizeBytes: second.length });

    const old = await db.query<{ unreferenced_since: Date | null }>(
      claims(),
      `select unreferenced_since from public.stored_blobs where id=$1`,
      [firstBlob.blobId],
    );
    expect(old[0]?.unreferenced_since).toBeInstanceOf(Date);
  });
});
