/**
 * files.* blob lifecycle conformance (AM-2 §2, 03 §6) — capability-gated like
 * execution: blob I/O completes in Phase 1B, so an honest 501 is acceptable
 * until then; a 404 or a non-contract shape never is. Once live, the full
 * lifecycle must hold: uploadInit grant → PUT bytes → uploadComplete creates
 * the `file` entity (size/checksum verified) → authorized download returns
 * the exact bytes. `bridge.fetchBlob` is RESERVED (Phase 2) and must 501.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  bindPath,
  FileUploadGrantSchema,
  TM8_UPLOAD_TOKEN_HEADER,
  type EntityDetail,
  type FileUploadGrant,
} from '@tm8/contract';
import { api, BASE_URL, isWireError, rawRequest } from '../src/client.js';
import { buildWorld, expectValid, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('files');
});

/** Run `fn`; treat an honest 501 as "gated" and anything else as live. */
async function gated<T>(fn: () => Promise<T>): Promise<{ gated: true } | { gated: false; value: T }> {
  try {
    return { gated: false, value: await fn() };
  } catch (e) {
    if (isWireError(e) && e.code === 'not_implemented' && e.status === 501 && !e.malformedBody) {
      return { gated: true };
    }
    throw e;
  }
}

function initInput(bytes: Buffer, name: string) {
  return {
    spaceId: w.spaceId,
    name,
    mime: 'text/plain',
    sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    clientMutationId: `cmid-file-${randomUUID()}`,
  };
}

describe('files.* blob lifecycle (AM-2 §2)', () => {
  it('uploadInit: 501-gated or returns a schema-valid grant with the deployment size limit', async () => {
    const bytes = Buffer.from('conformance blob\n');
    const res = await gated(() => api.command('files.uploadInit', initInput(bytes, 'grant-probe.txt')));
    if (res.gated) return;
    const grant = expectValid(FileUploadGrantSchema, res.value, 'upload grant');
    expect(grant.maxSizeBytes).toBeGreaterThan(0);
  });

  it('full lifecycle: init → PUT → complete creates the file entity → download returns the exact bytes', async () => {
    const bytes = Buffer.from(`the blob body ${randomUUID()}\n`);
    const res = await gated(() => api.command('files.uploadInit', initInput(bytes, 'lifecycle.txt')));
    if (res.gated) return;
    const grant = res.value as FileUploadGrant;

    const put = await fetch(new URL(grant.uploadUrl, BASE_URL), {
      method: 'PUT',
      body: bytes,
      // The grant names the SLOT, not the caller — `authorization` stays free
      // for whatever credential the deployment under test authenticates with.
      headers: {
        'content-type': 'application/octet-stream',
        ...(grant.token ? { [TM8_UPLOAD_TOKEN_HEADER]: grant.token } : {}),
      },
    });
    expect(put.status, 'byte PUT must succeed').toBeLessThan(300);

    const done = await api.command('files.uploadComplete',
      { clientMutationId: `cmid-complete-${randomUUID()}` }, { uploadId: grant.uploadId }) as { entity?: EntityDetail };
    const file = done.entity;
    expect(file?.kind).toBe('file');
    if (file && file.state.kind === 'file') {
      expect(file.state.sizeBytes).toBe(bytes.byteLength);
      expect(file.state.mimeType).toBe('text/plain');
    }

    // download is the one read returning raw bytes, not the DEV-6 envelope
    const dl = await fetch(new URL(bindPath('files.download', { fileEntityId: file!.id }), BASE_URL));
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes), 'downloaded bytes must match the upload').toBe(true);
  });

  it('uploadAbort releases the slot: completing an aborted upload is a typed refusal', async () => {
    const bytes = Buffer.from('abort me\n');
    const res = await gated(() => api.command('files.uploadInit', initInput(bytes, 'aborted.txt')));
    if (res.gated) return;
    const grant = res.value as FileUploadGrant;
    await api.command('files.uploadAbort', {}, { uploadId: grant.uploadId });
    try {
      await api.command('files.uploadComplete', {}, { uploadId: grant.uploadId });
      throw new Error('uploadComplete succeeded on an aborted upload');
    } catch (e) {
      if (isWireError(e) && !e.malformedBody && (e.code === 'not_found' || e.code === 'invariant_violation')) return;
      throw e;
    }
  });

  it('bridge.fetchBlob is reserved: honest 501, never 404 (DEV-13)', async () => {
    const res = await rawRequest('GET', bindPath('bridge.fetchBlob', { fileEntityId: w.docSpec }));
    expect(res.status).toBe(501);
  });
});
