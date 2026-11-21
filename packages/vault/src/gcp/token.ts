import { baseUrl, jsonObject, request, timeoutMs } from './http.js';

export interface TokenSource {
  getAccessToken(): Promise<string>;
}

export class MetadataTokenError extends Error {
  constructor() { super('GCP metadata token unavailable'); this.name = 'MetadataTokenError'; }
}

/** VM workload identity only: no service-account files or credentials on disk. */
export class MetadataTokenSource implements TokenSource {
  readonly #base: string;
  readonly #timeout: number;
  readonly #now: () => number;
  #cached: { token: string; refreshAt: number } | undefined;
  #inFlight: Promise<string> | undefined;

  constructor(options: { metadataBaseUrl?: string; timeoutMs?: number; now?: () => number } = {}) {
    try {
      this.#base = baseUrl(options.metadataBaseUrl ?? 'http://metadata.google.internal');
      this.#timeout = timeoutMs(options.timeoutMs);
      this.#now = options.now ?? Date.now;
    } catch { throw new MetadataTokenError(); }
  }

  async getAccessToken(): Promise<string> {
    if (this.#cached && this.#now() < this.#cached.refreshAt) return this.#cached.token;
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#refresh();
    try { return await this.#inFlight; }
    finally { this.#inFlight = undefined; }
  }

  async #refresh(): Promise<string> {
    try {
      const startedAt = this.#now();
      const response = await request({
        url: `${this.#base}/computeMetadata/v1/instance/service-accounts/default/token`,
        method: 'GET', headers: { 'Metadata-Flavor': 'Google' }, timeoutMs: this.#timeout,
      });
      if (response.status !== 200 || response.headers.get('Metadata-Flavor') !== 'Google') throw new MetadataTokenError();
      const body = jsonObject(response.bytes);
      if (typeof body.access_token !== 'string' || !body.access_token || /\s/.test(body.access_token) ||
          body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
        throw new MetadataTokenError();
      }
      this.#cached = { token: body.access_token, refreshAt: startedAt + (body.expires_in - 60) * 1_000 };
      return body.access_token;
    } catch { throw new MetadataTokenError(); }
  }
}
