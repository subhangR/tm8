import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type PublicJsonResponse,
  type W3PublicServer,
} from './public-harness.js';

interface UploadGrant {
  uploadId: string;
  uploadUrl: string;
  token: string | null;
  expiresAt: string;
  maxSizeBytes: number;
}

interface CommandResult {
  entity?: { id: string; kind: string };
  patches: Array<{ id: string }>;
}

const BYTES = Buffer.from('<b>tm8</b>\n', 'utf8');
const CHECKSUM = createHash('sha256').update(BYTES).digest('hex');

async function publicError(response: Response): Promise<{ status: number; code: string }> {
  const body = await response.json() as PublicJsonResponse['body'];
  const shaped: PublicJsonResponse = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    requestIdHeader: response.headers.get('x-tm8-request-id'),
    body,
  };
  return { status: response.status, code: errorCode(shaped) };
}

describe.sequential('W3.G07 file/blob lifecycle through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let targetId = '';
  let completedFileId = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g07');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g07-space',
        name: 'W3 G07 public gate',
      }),
    );
    spaceId = space.space.id;
    const target = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g07-target',
        spaceId,
        kind: 'task',
        title: 'File target',
        content: { priority: 'medium' },
      }),
    );
    targetId = target.entity.id;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('replays one frozen grant whose client filename never controls its storage path', async () => {
    const body = {
      clientMutationId: 'w3-g07-init-complete',
      spaceId,
      name: '../../report.html',
      mime: 'text/html',
      sizeBytes: BYTES.length,
      checksumSha256: CHECKSUM,
    };
    const grant = successData<UploadGrant>(await harness.request('POST', '/v2/files/uploads', body));
    const replay = successData<UploadGrant>(await harness.request('POST', '/v2/files/uploads', body));
    expect(replay).toEqual(grant);
    expect(grant.uploadUrl).toBe(`/v2/files/uploads/${grant.uploadId}/content`);
    expect(grant.token).toBeTruthy();
    expect(Date.parse(grant.expiresAt)).not.toBeNaN();
    expect(grant.maxSizeBytes).toBeGreaterThanOrEqual(BYTES.length);

    const rows = await harness.rows<{
      slots: number;
      storage_path: string;
      name: string;
      ledger: number;
    }>(
      `select
         (select count(*)::integer from public.file_upload_slots where id = $1) slots,
         (select storage_path from public.file_upload_slots where id = $1) storage_path,
         (select name from public.file_upload_slots where id = $1) name,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g07-init-complete') ledger`,
      [grant.uploadId],
    );
    expect(rows[0]).toMatchObject({ slots: 1, name: '../../report.html', ledger: 1 });
    expect(rows[0]!.storage_path).toMatch(new RegExp(`^spaces/${spaceId}/[0-9a-f-]{36}$`));
    expect(rows[0]!.storage_path).not.toContain('report');

    const missingBearer = await fetch(new URL(grant.uploadUrl, harness.baseUrl), {
      method: 'PUT',
      body: BYTES,
    });
    await expect(publicError(missingBearer)).resolves.toEqual({ status: 401, code: 'unauthenticated' });

    const wrongBearer = await fetch(new URL(grant.uploadUrl, harness.baseUrl), {
      method: 'PUT',
      headers: { authorization: 'Bearer wrong-file-grant' },
      body: BYTES,
    });
    await expect(publicError(wrongBearer)).resolves.toEqual({ status: 403, code: 'forbidden' });

    const staged = await fetch(new URL(grant.uploadUrl, harness.baseUrl), {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.token!}` },
      body: BYTES,
    });
    expect(staged.status).toBe(204);
    expect(staged.headers.get('x-tm8-request-id')).toBeTruthy();

    const retry = await fetch(new URL(grant.uploadUrl, harness.baseUrl), {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.token!}` },
      body: BYTES,
    });
    expect(retry.status).toBe(204);

    const stagedRows = await harness.rows<{
      status: string;
      staged_size: number;
      staged_checksum: string;
      leases: number;
    }>(
      `select status, staged_size_bytes::integer staged_size,
              staged_checksum_sha256 staged_checksum,
              (upload_lease_id is not null)::integer leases
         from public.file_upload_slots where id = $1`,
      [grant.uploadId],
    );
    expect(stagedRows[0]).toEqual({
      status: 'pending',
      staged_size: BYTES.length,
      staged_checksum: CHECKSUM,
      leases: 0,
    });

    const completeBody = {
      clientMutationId: 'w3-g07-complete',
      targets: [targetId],
    };
    const completed = successData<CommandResult>(
      await harness.request('POST', `/v2/files/uploads/${grant.uploadId}/complete`, completeBody),
    );
    const completeReplay = successData<CommandResult>(
      await harness.request('POST', `/v2/files/uploads/${grant.uploadId}/complete`, completeBody),
    );
    expect(completeReplay).toEqual(completed);
    expect(completed.entity).toMatchObject({ kind: 'file' });
    completedFileId = completed.entity!.id;
    expect(completed.patches.map((patch) => patch.id)).toEqual(expect.arrayContaining([completedFileId, targetId]));

    const completedRows = await harness.rows<{
      slot_status: string;
      file_rows: number;
      attachment_rows: number;
      ledger_rows: number;
    }>(
      `select
         (select status from public.file_upload_slots where id = $1) slot_status,
         (select count(*)::integer from public.files
           where entity_id = $2 and size_bytes = $3 and checksum_sha256 = $4) file_rows,
         (select count(*)::integer from public.edges
           where src_id = $2 and dst_id = $5 and type = 'attached_to') attachment_rows,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g07-complete') ledger_rows`,
      [grant.uploadId, completedFileId, BYTES.length, CHECKSUM, targetId],
    );
    expect(completedRows[0]).toEqual({
      slot_status: 'completed',
      file_rows: 1,
      attachment_rows: 1,
      ledger_rows: 1,
    });
  });

  it('downloads the exact authorized bytes with frozen safety and integrity headers', async () => {
    const response = await fetch(new URL(`/v2/files/${completedFileId}/download`, harness.baseUrl));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('content-length')).toBe(String(BYTES.length));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-tm8-checksum-sha256')).toBe(CHECKSUM);
    expect(response.headers.get('etag')).toContain(CHECKSUM);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
    expect(response.headers.get('x-tm8-request-id')).toBeTruthy();
  });

  it('aborts a pending slot idempotently and leaves no graph or blob outcome', async () => {
    const grant = successData<UploadGrant>(await harness.request('POST', '/v2/files/uploads', {
      clientMutationId: 'w3-g07-init-abort',
      spaceId,
      name: 'aborted.bin',
      mime: 'application/octet-stream',
      sizeBytes: BYTES.length,
      checksumSha256: CHECKSUM,
    }));
    const body = { clientMutationId: 'w3-g07-abort' };
    const aborted = successData<CommandResult>(
      await harness.request('POST', `/v2/files/uploads/${grant.uploadId}/abort`, body),
    );
    const replay = successData<CommandResult>(
      await harness.request('POST', `/v2/files/uploads/${grant.uploadId}/abort`, body),
    );
    expect(replay).toEqual(aborted);
    expect(aborted.patches).toEqual([]);

    const uploadAfterAbort = await fetch(new URL(grant.uploadUrl, harness.baseUrl), {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.token!}` },
      body: BYTES,
    });
    await expect(publicError(uploadAfterAbort)).resolves.toEqual({ status: 400, code: 'invalid_input' });
    const completeAfterAbort = await harness.request(
      'POST',
      `/v2/files/uploads/${grant.uploadId}/complete`,
      { clientMutationId: 'w3-g07-complete-aborted' },
    );
    expect(completeAfterAbort.status).toBe(400);
    expect(errorCode(completeAfterAbort)).toBe('invalid_input');

    const rows = await harness.rows<{
      status: string;
      file_entity_id: string | null;
      staged_at: string | null;
      abort_ledger: number;
      complete_ledger: number;
    }>(
      `select status, file_entity_id::text, staged_at::text,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g07-abort') abort_ledger,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g07-complete-aborted') complete_ledger
         from public.file_upload_slots where id = $1`,
      [grant.uploadId],
    );
    expect(rows[0]).toEqual({
      status: 'aborted',
      file_entity_id: null,
      staged_at: null,
      abort_ledger: 1,
      complete_ledger: 0,
    });
  });

  it('removes failed raw staging and rejects oversized or unknown semantic input before mutation', async () => {
    const corrupt = Buffer.concat([BYTES.subarray(0, -1), Buffer.from('X')]);
    const grant = successData<UploadGrant>(await harness.request('POST', '/v2/files/uploads', {
      clientMutationId: 'w3-g07-init-corrupt',
      spaceId,
      name: 'corrupt.bin',
      mime: 'application/octet-stream',
      sizeBytes: BYTES.length,
      checksumSha256: CHECKSUM,
    }));
    const wrongBytes = await fetch(new URL(grant.uploadUrl, harness.baseUrl), {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.token!}` },
      body: corrupt,
    });
    await expect(publicError(wrongBytes)).resolves.toEqual({ status: 400, code: 'invalid_input' });

    const oversized = await harness.request('POST', '/v2/files/uploads', {
      clientMutationId: 'w3-g07-too-large',
      spaceId,
      name: 'too-large.bin',
      mime: 'application/octet-stream',
      sizeBytes: grant.maxSizeBytes + 1,
      checksumSha256: CHECKSUM,
    });
    expect(oversized.status).toBe(413);
    expect(errorCode(oversized)).toBe('payload_too_large');

    const unknown = await harness.request('POST', '/v2/files/uploads', {
      clientMutationId: 'w3-g07-unknown',
      spaceId,
      name: 'unknown.bin',
      mime: 'application/octet-stream',
      sizeBytes: BYTES.length,
      checksumSha256: CHECKSUM,
      unknownField: true,
    });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe('invalid_input');

    const rows = await harness.rows<{
      staged_at: string | null;
      lease: string | null;
      forbidden_slots: number;
      forbidden_ledger: number;
    }>(
      `select staged_at::text, upload_lease_id::text lease,
              (select count(*)::integer from public.file_upload_slots
                where name in ('too-large.bin', 'unknown.bin')) forbidden_slots,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id in ('w3-g07-too-large', 'w3-g07-unknown')) forbidden_ledger
         from public.file_upload_slots where id = $1`,
      [grant.uploadId],
    );
    expect(rows[0]).toEqual({
      staged_at: null,
      lease: null,
      forbidden_slots: 0,
      forbidden_ledger: 0,
    });
  });
});
