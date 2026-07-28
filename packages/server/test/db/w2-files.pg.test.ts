import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identityA: string;
  identityB: string;
  identityOutsider: string;
  spaceId: string;
  otherSpaceId: string;
  memberA: string;
  memberB: string;
  outsiderMember: string;
  actorA: string;
  taskId: string;
  messageId: string;
  deletedTaskId: string;
  restrictedTaskId: string;
  otherTaskId: string;
}

interface InitResult {
  uploadId: string;
  storagePath: string;
  expiresAt: string;
  maxSizeBytes: number;
}

interface TransportResult {
  outcome: string;
  uploadId: string;
  storagePath: string;
  spaceId?: string;
  sizeBytes?: number;
  checksumSha256?: string;
}

interface CompleteResult extends TransportResult {
  entity?: { id: string };
  patches?: Array<{ id: string }>;
}

const BASELINE_MIGRATIONS = Array.from({ length: 15 }, (_, index) =>
  `${String(index + 1).padStart(3, '0')}_`,
);

function explicitG07Migrations(): string[] {
  const files = migrationFiles();
  const baseline = BASELINE_MIGRATIONS.map((prefix) => {
    const file = files.find((candidate) => candidate.startsWith(prefix));
    if (!file) throw new Error(`missing baseline migration ${prefix}`);
    return file;
  });
  return [...baseline, '022_w2_files.sql'];
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'g07-identity-a'::text as "identityA",
              'g07-identity-b'::text as "identityB",
              'g07-identity-outsider'::text as "identityOutsider",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "otherSpaceId",
              internal.new_id()::text as "memberA",
              internal.new_id()::text as "memberB",
              internal.new_id()::text as "outsiderMember",
              internal.new_id()::text as "actorA",
              internal.new_id()::text as "taskId",
              internal.new_id()::text as "messageId",
              internal.new_id()::text as "deletedTaskId",
              internal.new_id()::text as "restrictedTaskId",
              internal.new_id()::text as "otherTaskId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G07 A'), ($2, 'G07 B'), ($3, 'G07 outsider')`,
      [fixture.identityA, fixture.identityB, fixture.identityOutsider],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G07 shared', $3), ($2, 'G07 other', $4)`,
      [fixture.spaceId, fixture.otherSpaceId, fixture.identityA, fixture.identityOutsider],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, visibility, created_by, deleted_at)
       values ($1, $8, 'member', 'space', $1, null),
              ($2, $8, 'member', 'space', $2, null),
              ($3, $9, 'member', 'space', $3, null),
              ($4, $8, 'team_member', 'space', $1, null),
              ($5, $8, 'task', 'space', $1, null),
              ($6, $8, 'message', 'space', $1, null),
              ($7, $8, 'task', 'space', $1, now()),
              ($10, $8, 'task', 'restricted', $1, null),
              ($11, $9, 'task', 'space', $3, null)`,
      [
        fixture.memberA,
        fixture.memberB,
        fixture.outsiderMember,
        fixture.actorA,
        fixture.taskId,
        fixture.messageId,
        fixture.deletedTaskId,
        fixture.spaceId,
        fixture.otherSpaceId,
        fixture.restrictedTaskId,
        fixture.otherTaskId,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'G07 A'),
              ($2, $4, $7, 'member', 'G07 B'),
              ($3, $5, $8, 'owner', 'G07 outsider')`,
      [
        fixture.memberA,
        fixture.memberB,
        fixture.outsiderMember,
        fixture.spaceId,
        fixture.otherSpaceId,
        fixture.identityA,
        fixture.identityB,
        fixture.identityOutsider,
      ],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'G07 Agent', 'worker', 'g07-agent')`,
      [fixture.actorA, fixture.memberA],
    );
    await client.query(
      `insert into public.tasks(entity_id, title)
       values ($1, 'Readable target'), ($2, 'Deleted target'),
              ($3, 'Restricted target'), ($4, 'Other target')`,
      [fixture.taskId, fixture.deletedTaskId, fixture.restrictedTaskId, fixture.otherTaskId],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body)
       values ($1, $2, null, $3, 'Message attachment target')`,
      [fixture.messageId, fixture.taskId, fixture.memberA],
    );
    return fixture;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identityId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [identityId]);
    return fn(client);
  });
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function initUpload(
  database: W1ScratchDatabase,
  fixture: Fixture,
  options: {
    identityId?: string;
    uploadId?: string;
    storageBlobId?: string;
    mutationId?: string;
    actorId?: string | null;
    anchorId?: string | null;
    name?: string;
    sizeBytes?: number;
    maxSizeBytes?: number;
    expiresAt?: Date;
  } = {},
): Promise<{ result: InitResult; tokenHash: string; checksum: string; requestHash: string }> {
  const uploadId = options.uploadId ?? randomUUID();
  const storageBlobId = options.storageBlobId ?? randomUUID();
  const checksum = sha('declared-file-bytes');
  const tokenHash = sha(`token:${uploadId}`);
  const requestHash = sha(JSON.stringify({
    spaceId: fixture.spaceId,
    actorId: options.actorId ?? null,
    name: options.name ?? '../../client-name.txt',
    mime: 'application/octet-stream',
    sizeBytes: options.sizeBytes ?? 12,
    checksum,
    anchorId: options.anchorId ?? null,
    max: options.maxSizeBytes ?? 1024,
  }));
  const result = await asApp(database, options.identityId ?? fixture.identityA, async (client) => {
    const response = await client.query<{ value: InitResult }>(
      `select public.w2_init_file_upload(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
       ) value`,
      [
        uploadId,
        fixture.spaceId,
        options.actorId ?? null,
        options.name ?? '../../client-name.txt',
        'application/octet-stream',
        options.sizeBytes ?? 12,
        checksum,
        storageBlobId,
        tokenHash,
        options.expiresAt ?? new Date(Date.now() + 15 * 60_000),
        options.anchorId ?? null,
        options.maxSizeBytes ?? 1024,
        options.mutationId ?? `init-${uploadId}`,
        requestHash,
      ],
    );
    return response.rows[0]!.value;
  });
  return { result, tokenHash, checksum, requestHash };
}

async function stageUpload(
  database: W1ScratchDatabase,
  fixture: Fixture,
  init: { result: InitResult; tokenHash: string; checksum: string },
): Promise<void> {
  await asApp(database, fixture.identityA, async (client) => {
    const leaseId = randomUUID();
    const authorized = await client.query<{ value: TransportResult }>(
      `select public.w2_authorize_file_upload($1,$2,$3) value`,
      [init.result.uploadId, init.tokenHash, leaseId],
    );
    expect(authorized.rows[0]!.value).toMatchObject({ outcome: 'authorized' });
    const settled = await client.query<{ value: TransportResult }>(
      `select public.w2_settle_file_upload_write($1,$2,$3,true,12,$4) value`,
      [init.result.uploadId, init.tokenHash, leaseId, init.checksum],
    );
    expect(settled.rows[0]!.value).toMatchObject({ outcome: 'staged' });
  });
}

async function completeUpload(
  database: W1ScratchDatabase,
  fixture: Fixture,
  init: { result: InitResult; checksum: string },
  options: { mutationId?: string; targets?: string[]; identityId?: string } = {},
): Promise<CompleteResult> {
  return asApp(database, options.identityId ?? fixture.identityA, async (client) => {
    const response = await client.query<{ value: CompleteResult }>(
      `select public.w2_complete_file_upload($1,$2,$3,$4,$5::uuid[]) value`,
      [
        init.result.uploadId,
        12,
        init.checksum,
        options.mutationId ?? `complete-${init.result.uploadId}`,
        options.targets ?? [],
      ],
    );
    return response.rows[0]!.value;
  });
}

describe.sequential('W2.G07 PostgreSQL file lifecycle', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;
  let legacyUploadId: string;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g07');
    const migrations = explicitG07Migrations();
    database.apply(migrations.slice(0, -1));
    fixture = await seed(database);
    legacyUploadId = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.file_upload_slots(
           id,space_id,created_by,name,mime_type,size_bytes,checksum_sha256,
           storage_path,expires_at
         ) values ($1,$2,$3,'legacy-large.bin','application/octet-stream',536870913,$4,$5,
                   now()+interval '1 hour')`,
        [
          legacyUploadId,
          fixture.spaceId,
          fixture.memberA,
          sha('legacy-large'),
          `spaces/${fixture.spaceId}/${randomUUID()}`,
        ],
      );
    });
    database.apply([migrations.at(-1)!]);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('applies explicitly after 001-015 and grants only five enumerable file RPC writers', async () => {
    const rows = await database.query<{ proname: string; app_exec: boolean; public_exec: boolean }>(
      `select p.proname,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'w2_%file_upload%'
        order by p.proname`,
    );
    expect(rows.map((row) => row.proname)).toEqual([
      'w2_abort_file_upload',
      'w2_authorize_file_upload',
      'w2_complete_file_upload',
      'w2_init_file_upload',
      'w2_settle_file_upload_write',
    ]);
    expect(rows.every((row) => row.app_exec && !row.public_exec)).toBe(true);

    const internalPrivileges = await database.query<{
      proname: string;
      app_exec: boolean;
      delivery_exec: boolean;
      public_exec: boolean;
    }>(
      `select p.proname,
              has_function_privilege('tm8_app',p.oid,'EXECUTE') app_exec,
              has_function_privilege('tm8_delivery_worker',p.oid,'EXECUTE') delivery_exec,
              has_function_privilege('public',p.oid,'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='internal' and p.proname like 'w2_%file%'
        order by p.proname`,
    );
    expect(internalPrivileges.map((row) => row.proname)).toEqual([
      'w2_file_slot_for_identity',
      'w2_file_transport_result',
      'w2_validate_file_upload_slot',
    ]);
    expect(internalPrivileges.every((row) =>
      !row.app_exec && !row.delivery_exec && !row.public_exec,
    )).toBe(true);

    const legacy = await database.query<{ actor_id: string; max_size_bytes: string }>(
      `select actor_id,max_size_bytes from public.file_upload_slots where id=$1`,
      [legacyUploadId],
    );
    expect(legacy[0]).toEqual({ actor_id: fixture.memberA, max_size_bytes: '536870913' });

    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `insert into public.file_upload_slots(
         space_id,created_by,name,mime_type,size_bytes,checksum_sha256,storage_path,expires_at)
       values ($1,$2,'raw','text/plain',1,$3,$4,now()+interval '1 minute')`,
      [fixture.spaceId, fixture.memberA, '0'.repeat(64), `spaces/${fixture.spaceId}/${randomUUID()}`],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('authorizes membership and actor identity, freezes metadata, limits, checksum, path, and init replay', async () => {
    const uploadId = randomUUID();
    const first = await initUpload(database, fixture, {
      uploadId,
      actorId: fixture.actorA,
      anchorId: fixture.taskId,
      mutationId: `init-replay-${uploadId}`,
    });
    const replay = await initUpload(database, fixture, {
      uploadId: randomUUID(),
      storageBlobId: randomUUID(),
      actorId: fixture.actorA,
      anchorId: fixture.taskId,
      mutationId: `init-replay-${uploadId}`,
    });
    expect(replay.result).toEqual(first.result);
    expect(first.result.storagePath).toMatch(new RegExp(`^spaces/${fixture.spaceId}/[0-9a-f-]{36}$`));

    const slot = await database.query<{
      actor_id: string;
      name: string;
      anchor_entity_id: string;
      max_size_bytes: string;
      request_hash: string;
      status: string;
    }>(
      `select actor_id,name,anchor_entity_id,max_size_bytes,request_hash,status
         from public.file_upload_slots where id=$1`,
      [first.result.uploadId],
    );
    expect(slot[0]).toMatchObject({
      actor_id: fixture.actorA,
      name: '../../client-name.txt',
      anchor_entity_id: fixture.taskId,
      max_size_bytes: '1024',
      request_hash: first.requestHash,
      status: 'pending',
    });

    await expect(initUpload(database, fixture, { identityId: fixture.identityOutsider }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(initUpload(database, fixture, { identityId: fixture.identityB, actorId: fixture.actorA }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(initUpload(database, fixture, { sizeBytes: 1025 }))
      .rejects.toMatchObject({ code: '54000' });
    const raisedLimit = 536_870_913;
    expect((await initUpload(database, fixture, { maxSizeBytes: raisedLimit })).result.maxSizeBytes)
      .toBe(raisedLimit);

    const candidateA = randomUUID();
    const candidateB = randomUUID();
    const concurrentMutationId = `init-concurrent-${randomUUID()}`;
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`
        create function internal.w2_test_pause_slot_insert() returns trigger
        language plpgsql as $$ begin perform pg_sleep(1); return new; end $$;
        create trigger w2_test_pause_slot_insert after insert on public.file_upload_slots
        for each row execute function internal.w2_test_pause_slot_insert()
      `);
    });
    let concurrentA: Awaited<ReturnType<typeof initUpload>>;
    let concurrentB: Awaited<ReturnType<typeof initUpload>>;
    try {
      [concurrentA, concurrentB] = await Promise.all([
        initUpload(database, fixture, { uploadId: candidateA, mutationId: concurrentMutationId }),
        initUpload(database, fixture, { uploadId: candidateB, mutationId: concurrentMutationId }),
      ]);
    } finally {
      await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(`drop trigger w2_test_pause_slot_insert on public.file_upload_slots`);
        await client.query(`drop function internal.w2_test_pause_slot_insert()`);
      });
    }
    expect(concurrentA.result).toEqual(concurrentB.result);
    const concurrentRows = await database.query<{ slots: string; ledger: string }>(
      `select (select count(*) from public.file_upload_slots where id=any($1::uuid[]))::text slots,
              (select count(*) from public.command_ledger where client_mutation_id=$2)::text ledger`,
      [[candidateA, candidateB], concurrentMutationId],
    );
    expect(concurrentRows[0]).toEqual({ slots: '1', ledger: '1' });
  });

  it('binds raw upload authorization to creator identity, intended token, pending slot, and expiry', async () => {
    const pending = await initUpload(database, fixture);
    await expect(asApp(database, fixture.identityB, (client) => client.query(
      `select public.w2_authorize_file_upload($1,$2,$3)`,
      [pending.result.uploadId, pending.tokenHash, randomUUID()],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `select public.w2_authorize_file_upload($1,$2,$3)`,
      [pending.result.uploadId, sha('wrong-token'), randomUUID()],
    ))).rejects.toMatchObject({ code: '42501' });

    const expired = await initUpload(database, fixture);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.file_upload_slots set expires_at=now()-interval '1 second' where id=$1`,
        [expired.result.uploadId],
      );
    });
    const result = await asApp(database, fixture.identityA, async (client) => {
      const response = await client.query<{ value: TransportResult }>(
        `select public.w2_authorize_file_upload($1,$2,$3) value`,
        [expired.result.uploadId, expired.tokenHash, randomUUID()],
      );
      return response.rows[0]!.value;
    });
    expect(result.outcome).toBe('expired');
    const state = await database.query<{ status: string }>(
      `select status from public.file_upload_slots where id=$1`,
      [expired.result.uploadId],
    );
    expect(state[0]?.status).toBe('expired');
  });

  it('atomically finalizes exact staged bytes plus legacy init anchor and message-owned targets', async () => {
    const init = await initUpload(database, fixture, { anchorId: fixture.taskId });
    await stageUpload(database, fixture, init);
    const result = await completeUpload(database, fixture, init, { targets: [fixture.messageId] });
    expect(result.outcome).toBe('completed');
    expect(result.entity?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.patches?.map((row) => row.id)).toContain(result.entity?.id);

    const file = await database.query<{
      entity_id: string;
      created_by: string;
      space_id: string;
      name: string;
      storage_path: string;
      size_bytes: string;
      checksum_sha256: string;
    }>(
      `select f.entity_id,e.created_by,e.space_id,f.name,f.storage_path,f.size_bytes,f.checksum_sha256
         from public.files f join public.entities e on e.id=f.entity_id
        where f.entity_id=$1`,
      [result.entity!.id],
    );
    expect(file[0]).toMatchObject({
      created_by: fixture.memberA,
      space_id: fixture.spaceId,
      name: '../../client-name.txt',
      storage_path: init.result.storagePath,
      size_bytes: '12',
      checksum_sha256: init.checksum,
    });
    const edges = await database.query<{ dst_id: string }>(
      `select dst_id from public.edges
        where src_id=$1 and type='attached_to' order by dst_id`,
      [result.entity!.id],
    );
    expect(edges.map((row) => row.dst_id).sort()).toEqual([fixture.messageId, fixture.taskId].sort());

    await expect(completeUpload(database, fixture, init, { targets: [] }))
      .rejects.toMatchObject({ code: '23514' });

    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `delete from public.edges where src_id=$1 and dst_id=$2 and type='attached_to'`,
      [result.entity!.id, fixture.messageId],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('reauthorizes download metadata through RLS and hides unreadable or deleted files', async () => {
    const init = await initUpload(database, fixture);
    await stageUpload(database, fixture, init);
    const completed = await completeUpload(database, fixture, init);
    const fileId = completed.entity!.id;
    const readMetadata = (identityId: string) => asApp(database, identityId, async (client) => {
      const response = await client.query<{ id: string }>(
        `select e.id
           from public.entities e
           join public.files f on f.entity_id=e.id
          where e.id=$1 and e.kind='file' and e.deleted_at is null`,
        [fileId],
      );
      return response.rows;
    });

    expect(await readMetadata(fixture.identityB)).toEqual([{ id: fileId }]);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set visibility='restricted' where id=$1`, [fileId]);
    });
    expect(await readMetadata(fixture.identityB)).toEqual([]);

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.entities set visibility='space',deleted_at=now() where id=$1`,
        [fileId],
      );
    });
    expect(await readMetadata(fixture.identityA)).toEqual([]);
  });

  it('rolls back the whole target set for missing, deleted, unreadable, or cross-Space targets', async () => {
    for (const target of [randomUUID(), fixture.deletedTaskId, fixture.restrictedTaskId, fixture.otherTaskId]) {
      const init = await initUpload(database, fixture);
      await stageUpload(database, fixture, init);
      await expect(completeUpload(database, fixture, init, { targets: [fixture.taskId, target] }))
        .rejects.toMatchObject({ code: expect.stringMatching(/P0002|42501|23514/) });
      const counts = await database.query<{ files: string; edges: string; status: string }>(
        `select (select count(*) from public.files where storage_path=$1)::text files,
                (select count(*) from public.edges where src_id in
                  (select entity_id from public.files where storage_path=$1))::text edges,
                (select status from public.file_upload_slots where id=$2) status`,
        [init.result.storagePath, init.result.uploadId],
      );
      expect(counts[0]).toEqual({ files: '0', edges: '0', status: 'pending' });
    }
  });

  it('refuses incomplete/size/checksum mismatch and concurrent complete creates exactly one file', async () => {
    const incomplete = await initUpload(database, fixture);
    await expect(completeUpload(database, fixture, incomplete)).rejects.toBeTruthy();

    const staged = await initUpload(database, fixture);
    await stageUpload(database, fixture, staged);
    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `select public.w2_complete_file_upload($1,11,$2,$3,'{}'::uuid[])`,
      [staged.result.uploadId, staged.checksum, `wrong-size-${staged.result.uploadId}`],
    ))).rejects.toBeTruthy();
    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `select public.w2_complete_file_upload($1,12,$2,$3,'{}'::uuid[])`,
      [staged.result.uploadId, '0'.repeat(64), `wrong-sum-${staged.result.uploadId}`],
    ))).rejects.toBeTruthy();

    const race = await initUpload(database, fixture);
    await stageUpload(database, fixture, race);
    const [a, b] = await Promise.all([
      completeUpload(database, fixture, race, { mutationId: `race-a-${race.result.uploadId}` }),
      completeUpload(database, fixture, race, { mutationId: `race-b-${race.result.uploadId}` }),
    ]);
    expect(a.entity?.id).toBe(b.entity?.id);
    const count = await database.query<{ count: string }>(
      `select count(*)::text count from public.files where storage_path=$1`,
      [race.result.storagePath],
    );
    expect(count[0]?.count).toBe('1');

    const firstUpload = await initUpload(database, fixture);
    const secondUpload = await initUpload(database, fixture);
    await stageUpload(database, fixture, firstUpload);
    await stageUpload(database, fixture, secondUpload);
    const sharedMutationId = `complete-cross-upload-${randomUUID()}`;
    const crossUpload = await Promise.allSettled([
      completeUpload(database, fixture, firstUpload, { mutationId: sharedMutationId }),
      completeUpload(database, fixture, secondUpload, { mutationId: sharedMutationId }),
    ]);
    expect(crossUpload.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(crossUpload.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const crossCount = await database.query<{ count: string }>(
      `select count(*)::text count from public.files where storage_path=any($1::text[])`,
      [[firstUpload.result.storagePath, secondUpload.result.storagePath]],
    );
    expect(crossCount[0]?.count).toBe('1');
  });

  it('aborts pending/expired slots idempotently and never converts a completed slot', async () => {
    const pending = await initUpload(database, fixture);
    const abort = (mutationId: string) => asApp(database, fixture.identityA, async (client) => {
      const response = await client.query<{ value: TransportResult }>(
        `select public.w2_abort_file_upload($1,$2) value`,
        [pending.result.uploadId, mutationId],
      );
      return response.rows[0]!.value;
    });
    expect((await abort(`abort-a-${pending.result.uploadId}`)).outcome).toBe('aborted');
    expect((await abort(`abort-b-${pending.result.uploadId}`)).outcome).toBe('aborted');

    const completed = await initUpload(database, fixture);
    await stageUpload(database, fixture, completed);
    const file = await completeUpload(database, fixture, completed);
    const completedAbort = await asApp(database, fixture.identityA, async (client) => {
      const response = await client.query<{ value: TransportResult }>(
        `select public.w2_abort_file_upload($1,$2) value`,
        [completed.result.uploadId, `abort-completed-${completed.result.uploadId}`],
      );
      return response.rows[0]!.value;
    });
    expect(completedAbort.outcome).toBe('completed');
    const retained = await database.query<{ status: string; file_entity_id: string }>(
      `select status,file_entity_id from public.file_upload_slots where id=$1`,
      [completed.result.uploadId],
    );
    expect(retained[0]).toEqual({ status: 'completed', file_entity_id: file.entity?.id });
  });
});
