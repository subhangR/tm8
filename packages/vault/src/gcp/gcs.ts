import { RETAINED_CHECKPOINT_MAX_BYTES, parseRetainedCheckpoint } from '../audit/chain.js';
import { CheckpointReadError, type CheckpointSink, type RetainedCheckpoint } from '../core-types.js';
import { baseUrl, jsonObject, request, timeoutMs, type GcpResponse } from './http.js';
import type { TokenSource } from './token.js';

const MAX_SEQ = 999_999_999_999;
const OBJECT_NAME = /^checkpoints\/([0-9]{12})\.json$/;
/** 1,000 names a page; at one checkpoint per five minutes that is over nine years before a listing is refused. */
const LIST_MAX_PAGES = 1_000;
const objectName = (seq: number): string => `checkpoints/${String(seq).padStart(12, '0')}.json`;

export class GcsCheckpointError extends Error {
  constructor(readonly code: 'unavailable' | 'conflict' | 'invalid_checkpoint') {
    super(`GCS checkpoint ${code}`);
    this.name = 'GcsCheckpointError';
  }
}

/** Construct only when BrokerConfig.auditSink selects gcs. No constructor I/O. */
export class GcsCheckpointSink implements CheckpointSink {
  readonly kind = 'gcs' as const;
  readonly #bucket: string;
  readonly #base: string;
  readonly #tokens: TokenSource;
  readonly #timeout: number;

  constructor(options: { bucket: string; gcsBaseUrl?: string; tokens: TokenSource; timeoutMs?: number }) {
    try {
      if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket)) throw new Error();
      this.#bucket = options.bucket;
      this.#base = baseUrl(options.gcsBaseUrl ?? 'https://storage.googleapis.com');
      this.#tokens = options.tokens;
      this.#timeout = timeoutMs(options.timeoutMs);
    } catch { throw new GcsCheckpointError('unavailable'); }
  }

  async #call(path: string, method: 'GET' | 'POST', body?: string): Promise<GcpResponse> {
    try {
      return await request({
        url: `${this.#base}${path}`, method, body, tokens: this.#tokens, timeoutMs: this.#timeout,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      });
    } catch { throw new GcsCheckpointError('unavailable'); }
  }

  async put(checkpoint: Parameters<CheckpointSink['put']>[0]): ReturnType<CheckpointSink['put']> {
    if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 1 || checkpoint.seq > MAX_SEQ) {
      throw new GcsCheckpointError('invalid_checkpoint');
    }
    const object = objectName(checkpoint.seq);
    let body: string;
    try {
      body = JSON.stringify({
        seq: checkpoint.seq, headHash: checkpoint.headHash, at: checkpoint.at,
        keyId: checkpoint.keyId, signature: checkpoint.signature,
      });
    } catch { throw new GcsCheckpointError('invalid_checkpoint'); }
    const bucket = encodeURIComponent(this.#bucket);
    const query = new URLSearchParams({ uploadType: 'media', name: object, ifGenerationMatch: '0' });
    const uploaded = await this.#call(`/upload/storage/v1/b/${bucket}/o?${query}`, 'POST', body);
    if (uploaded.status === 412) {
      const existing = await this.#call(`/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`, 'GET');
      if (existing.status !== 200) throw new GcsCheckpointError('unavailable');
      if (!existing.bytes.equals(Buffer.from(body))) throw new GcsCheckpointError('conflict');
    } else if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new GcsCheckpointError('unavailable');
    }
    return { anchored: true, location: `gs://${this.#bucket}/${object}` };
  }

  async health(): ReturnType<CheckpointSink['health']> {
    try {
      const response = await this.#call(`/storage/v1/b/${encodeURIComponent(this.#bucket)}?fields=retentionPolicy`, 'GET');
      if (response.status !== 200) throw new GcsCheckpointError('unavailable');
      const policy = jsonObject(response.bytes).retentionPolicy;
      if (policy === undefined) return { ok: true, retention: 'none' };
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new GcsCheckpointError('unavailable');
      const isLocked = (policy as Record<string, unknown>).isLocked;
      if (isLocked !== undefined && typeof isLocked !== 'boolean') throw new GcsCheckpointError('unavailable');
      return { ok: true, retention: isLocked === true ? 'locked' : 'unlocked' };
    } catch { return { ok: false, retention: 'unknown' }; }
  }

  async #read(path: string): Promise<GcpResponse> {
    let response: GcpResponse;
    try { response = await this.#call(path, 'GET'); } catch { throw new CheckpointReadError('unavailable'); }
    if (response.status !== 200) throw new CheckpointReadError('unavailable');
    return response;
  }

  /**
   * Read back from the bucket, never from the database (review F01): list the
   * create-only names from `from` up, then fetch the highest. Names sort as
   * seqs because they are zero-padded to 12 digits. Read-only: list and get.
   */
  async latest(from = 0): Promise<RetainedCheckpoint | null> {
    if (!Number.isSafeInteger(from) || from < 0 || from > MAX_SEQ) throw new CheckpointReadError('invalid');
    const bucket = encodeURIComponent(this.#bucket);
    let best = -1;
    let pageToken: string | null = null;
    for (let page = 0; ; page++) {
      // A listing too long to finish cannot say which head is newest.
      if (page === LIST_MAX_PAGES) throw new CheckpointReadError('unavailable');
      const query = new URLSearchParams({ prefix: 'checkpoints/', startOffset: objectName(from), maxResults: '1000', fields: 'items(name),nextPageToken' });
      if (pageToken !== null) query.set('pageToken', pageToken);
      let listing: Record<string, unknown>;
      try { listing = jsonObject((await this.#read(`/storage/v1/b/${bucket}/o?${query}`)).bytes); }
      catch (error) { throw error instanceof CheckpointReadError ? error : new CheckpointReadError('unavailable'); }
      const items = listing.items ?? [];
      if (!Array.isArray(items)) throw new CheckpointReadError('unavailable');
      for (const item of items) {
        const name: unknown = item && typeof item === 'object' ? (item as Record<string, unknown>).name : undefined;
        if (typeof name !== 'string') throw new CheckpointReadError('unavailable');
        // Anything else under the prefix, seq 0 included (put refuses it), is not a checkpoint this sink wrote.
        const match = OBJECT_NAME.exec(name);
        if (!match) continue;
        const seq = Number(match[1]);
        if (seq >= 1 && seq >= from && seq > best) best = seq;
      }
      const next = listing.nextPageToken;
      if (next === undefined) break;
      if (typeof next !== 'string' || next === '' || next.length > 4_096) throw new CheckpointReadError('unavailable');
      pageToken = next;
    }
    if (best < 0) return null;
    const object = objectName(best);
    const bytes = (await this.#read(`/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`)).bytes;
    if (bytes.length > RETAINED_CHECKPOINT_MAX_BYTES) throw new CheckpointReadError('invalid');
    return parseRetainedCheckpoint(bytes, { seq: best }, `gs://${this.#bucket}/${object}`);
  }
}
