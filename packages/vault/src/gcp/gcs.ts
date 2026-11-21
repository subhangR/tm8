import type { CheckpointSink } from '../core-types.js';
import { baseUrl, jsonObject, request, timeoutMs, type GcpResponse } from './http.js';
import type { TokenSource } from './token.js';

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
    if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 1 || checkpoint.seq > 999_999_999_999) {
      throw new GcsCheckpointError('invalid_checkpoint');
    }
    const object = `checkpoints/${String(checkpoint.seq).padStart(12, '0')}.json`;
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
}
