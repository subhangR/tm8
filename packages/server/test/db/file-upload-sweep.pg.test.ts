/**
 * Migration *_file_upload_slot_sweep.sql — the sweep doors for upload-slot
 * lifecycle (Files Lane 4).
 *
 * 006 shipped `internal.expire_file_upload_slots()` with zero callers; the
 * sweep doors are the callers. What a "did it return" test would miss, and is
 * asserted here instead:
 *  - the doors are NODE-ADMIN ONLY (they enumerate storage paths across every
 *    space), so an ordinary member gets 42501, not a listing;
 *  - a pending slot BEFORE its deadline is neither expired nor offered;
 *  - a COMPLETED slot is never offered — its bytes are the file;
 *  - a purge receipt removes a slot from the next batch, and writing the
 *    receipt twice affects zero rows (the crash-between-steps replay).
 *
 * Applied as an UPGRADE: the full chain, which includes this migration at its
 * current number. Resolved by SUFFIX because numbers renumber at integration.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const SWEEP_MIGRATION_SUFFIX = '_file_upload_slot_sweep.sql';

interface Fixture {
  identityId: string;
  /**
   * A second, ORDINARY account. Since migration 100 the sweep doors resolve
   * node admin from `public.accounts` instead of the `tm8.node_admin` claim, so
   * "not the node admin" can no longer be expressed by flipping a claim — it
   * needs a caller who genuinely is not one.
   */
  plainIdentityId: string;
  spaceId: string;
  memberId: string;
}

interface SlotIds {
  overdue: string;
  fresh: string;
  aborted: string;
  completed: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;
let slots: SlotIds;

function storagePath(spaceId: string, blobId: string): string {
  return `spaces/${spaceId}/${blobId}`;
}

async function seed(db: W1ScratchDatabase): Promise<{ fixture: Fixture; slots: SlotIds }> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'sweep-owner'::text "identityId",
              'sweep-plain'::text "plainIdentityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'Sweep owner'),($2,'Sweep plain')`,
      [f.identityId, f.plainIdentityId],
    );
    // The sweep doors are node-admin gated, and since migration 100 that is
    // resolved from `public.accounts` rather than from the `tm8.node_admin`
    // claim `asApp` binds. Before 100 this fixture had NO account rows at all —
    // the claim alone was enough, which is exactly the defect 100 closes. So
    // both roles now need real accounts, differing in `is_node_admin`.
    await client.query(
      `insert into public.accounts(identity_id,username,is_node_admin)
       values($1,'sweep-owner',true),($2,'sweep-plain',false)`,
      [f.identityId, f.plainIdentityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Sweep',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Sweep owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );

    const ids = (await client.query<SlotIds>(
      `select internal.new_id()::text "overdue", internal.new_id()::text "fresh",
              internal.new_id()::text "aborted", internal.new_id()::text "completed"`,
    )).rows[0]!;
    const checksum = 'a'.repeat(64);
    const insert = async (
      id: string, status: string, expiresAt: string,
    ) => {
      await client.query(
        `insert into public.file_upload_slots
           (id,space_id,created_by,actor_id,name,mime_type,size_bytes,max_size_bytes,request_hash,
            checksum_sha256,storage_path,status,expires_at)
         values($1,$2,$3,$3,'sweep.bin','application/octet-stream',8,64,$4,$4,$5,$6,$7::timestamptz)`,
        [id, f.spaceId, f.memberId, checksum, storagePath(f.spaceId, id), status, expiresAt],
      );
    };
    await insert(ids.overdue, 'pending', new Date(Date.now() - 60_000).toISOString());
    await insert(ids.fresh, 'pending', new Date(Date.now() + 60_000).toISOString());
    await insert(ids.aborted, 'aborted', new Date(Date.now() - 60_000).toISOString());
    // A completed slot's shape check demands a file entity + completed_at.
    const fileEntity = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'file',null,1,$3)`,
      [fileEntity, f.spaceId, f.memberId],
    );
    await client.query(
      `insert into public.file_upload_slots
         (id,space_id,created_by,actor_id,name,mime_type,size_bytes,max_size_bytes,request_hash,
          checksum_sha256,storage_path,status,file_entity_id,completed_at,expires_at)
       values($1,$2,$3,$3,'kept.bin','application/octet-stream',8,64,$4,$4,$5,'completed',$6,now(),
              now() - interval '1 minute')`,
      [ids.completed, f.spaceId, f.memberId, checksum, storagePath(f.spaceId, ids.completed), fileEntity],
    );
    return { fixture: f, slots: ids };
  });
}

async function asApp<T>(
  nodeAdmin: boolean,
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    // The IDENTITY carries the authority now; the claim is pinned to 'true' for
    // BOTH callers on purpose. That makes the negative case load-bearing: the
    // non-admin arrives asserting `tm8.node_admin = true` and is refused anyway,
    // which is the property migration 100 added and the one a claim-toggling
    // fixture could never have tested.
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','true',true),set_config('tm8.request_id','req-sweep-pg',true)`,
      [nodeAdmin ? fixture.identityId : fixture.plainIdentityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

interface SweepResult {
  expired: number;
  purgeable: Array<{ uploadId: string; spaceId: string; storagePath: string }>;
}

async function sweep(nodeAdmin = true, limit = 100): Promise<SweepResult> {
  const rows = await asApp(nodeAdmin, (q) =>
    q('select public.sweep_file_upload_slots($1) result', [limit]));
  return rows[0]!.result as SweepResult;
}

beforeAll(async () => {
  const files = migrationFiles();
  const matches = files.filter((file) => file.endsWith(SWEEP_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one *${SWEEP_MIGRATION_SUFFIX} migration, found ${matches.length}`);
  }
  database = await createW1ScratchDatabase('file upload sweep');
  database.apply(files);
  const seeded = await seed(database);
  fixture = seeded.fixture;
  slots = seeded.slots;
});

afterAll(async () => {
  await database?.destroy();
});

describe('file upload slot sweep doors', () => {
  it('refuses a caller who is not the node admin with 42501', async () => {
    await expect(sweep(false)).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(false, (q) =>
      q('select public.mark_file_upload_slots_purged(array[$1::uuid]) n', [slots.overdue]),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('expires only overdue pending slots and offers only unpurged expired/aborted slots', async () => {
    const result = await sweep();
    expect(result.expired).toBe(1);
    const offered = result.purgeable.map((slot) => slot.uploadId).sort();
    expect(offered).toEqual([slots.aborted, slots.overdue].sort());
    for (const slot of result.purgeable) {
      expect(slot.spaceId).toBe(fixture.spaceId);
      expect(slot.storagePath).toBe(storagePath(fixture.spaceId, slot.uploadId));
    }

    const statuses = await asApp(true, (q) =>
      q('select id,status from public.file_upload_slots order by id'));
    const byId = new Map(statuses.map((row) => [row.id, row.status]));
    expect(byId.get(slots.overdue)).toBe('expired');
    expect(byId.get(slots.fresh)).toBe('pending');
    expect(byId.get(slots.completed)).toBe('completed');
  });

  it('a purge receipt removes slots from the next batch; a replayed receipt affects zero rows', async () => {
    const first = await asApp(true, (q) =>
      q('select public.mark_file_upload_slots_purged(array[$1::uuid,$2::uuid]) n',
        [slots.overdue, slots.aborted]));
    expect(Number(first[0]!.n)).toBe(2);

    const after = await sweep();
    expect(after.expired).toBe(0);
    expect(after.purgeable).toEqual([]);

    const replay = await asApp(true, (q) =>
      q('select public.mark_file_upload_slots_purged(array[$1::uuid,$2::uuid]) n',
        [slots.overdue, slots.aborted]));
    expect(Number(replay[0]!.n)).toBe(0);

    // The completed slot never gained a receipt — its bytes are the file.
    const completed = await asApp(true, (q) =>
      q('select storage_purged_at from public.file_upload_slots where id=$1', [slots.completed]));
    expect(completed[0]!.storage_purged_at).toBeNull();
  });
});

describe('deleted file blob purge door', () => {
  interface FileIds { oldDeleted: string; freshDeleted: string; live: string }
  let files: FileIds;

  async function seedFile(id: string, deletedAt: string | null): Promise<void> {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by,deleted_at)
         values($1,$2,'file',null,floor(random()*100000)::int+10,$3,$4::timestamptz)`,
        [id, fixture.spaceId, fixture.memberId, deletedAt],
      );
      await client.query(
        `insert into public.files(entity_id,name,mime_type,size_bytes,storage_path,checksum_sha256)
         values($1,'purge.bin','application/octet-stream',8,$2,$3)`,
        [id, storagePath(fixture.spaceId, id), 'b'.repeat(64)],
      );
    });
  }

  interface PurgeResult { purgeable: Array<{ entityId: string; spaceId: string; storagePath: string }> }
  async function purge(nodeAdmin = true, graceSeconds = 3600, retrySeconds = 0): Promise<PurgeResult> {
    const rows = await asApp(nodeAdmin, (q) =>
      q('select public.purge_deleted_file_blobs($1,$2,$3) result', [graceSeconds, retrySeconds, 100]));
    return rows[0]!.result as PurgeResult;
  }

  beforeAll(async () => {
    const ids = await database.query<FileIds>(
      `select internal.new_id()::text "oldDeleted", internal.new_id()::text "freshDeleted",
              internal.new_id()::text "live"`,
    );
    files = ids[0]!;
    await seedFile(files.oldDeleted, new Date(Date.now() - 2 * 3600_000).toISOString());
    await seedFile(files.freshDeleted, new Date(Date.now() - 60_000).toISOString());
    await seedFile(files.live, null);
  });

  it('refuses a caller who is not the node admin with 42501', async () => {
    await expect(purge(false)).rejects.toMatchObject({ code: '42501' });
  });

  it('marks and offers only files soft-deleted past the grace window, nulling the checksum', async () => {
    const result = await purge();
    expect(result.purgeable.map((b) => b.entityId)).toEqual([files.oldDeleted]);
    expect(result.purgeable[0]!.storagePath).toBe(storagePath(fixture.spaceId, files.oldDeleted));

    // Verified as the graph owner: RLS hides soft-deleted entities' detail
    // rows from ordinary selects, which is correct and not what is under test.
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query(
        `select entity_id,purged_at,checksum_sha256 from public.files
          where entity_id = any(array[$1::uuid,$2::uuid,$3::uuid]) order by entity_id`,
        [files.oldDeleted, files.freshDeleted, files.live],
      )).rows as Record<string, unknown>[];
    });
    const byId = new Map(rows.map((row) => [row.entity_id, row]));
    // MARK-FIRST: the purged row is committed unrestorable-to-bytes...
    expect(byId.get(files.oldDeleted)!.purged_at).not.toBeNull();
    expect(byId.get(files.oldDeleted)!.checksum_sha256).toBeNull();
    // ...while inside the grace window and live files keep their bytes claim.
    expect(byId.get(files.freshDeleted)!.purged_at).toBeNull();
    expect(byId.get(files.freshDeleted)!.checksum_sha256).not.toBeNull();
    expect(byId.get(files.live)!.purged_at).toBeNull();
  });

  it('re-offers a recently marked row inside the retry window (crash repair), then stops', async () => {
    const withRetry = await purge(true, 3600, 24 * 3600);
    expect(withRetry.purgeable.map((b) => b.entityId)).toEqual([files.oldDeleted]);
    const withoutRetry = await purge(true, 3600, 0);
    expect(withoutRetry.purgeable).toEqual([]);
  });
});
