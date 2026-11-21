import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { FillDriver, FillIntent, FillOutcome, LoginMaterial } from '../types.js';
import { zeroize } from '../secret-material.js';
import { DEFAULT_FILL_TIMEOUT_MS, FrameReader, MAX_RESPONSE_BYTES, decodeOutcome, encodeJsonFrame, refusal } from './protocol.js';

/** Broker-side capability: only fill and close; no browser, DOM, cookies or selectors. */
export class RemoteFillDriver implements FillDriver {
  #closed = false;
  #sockets = new Set<Socket>();

  constructor(private readonly socketPath: string, private readonly options: { timeoutMs?: number } = {}) {}

  async fill(input: { intent: FillIntent; material: LoginMaterial; signal?: AbortSignal }): Promise<FillOutcome> {
    if (this.#closed) return refusal('browser_unavailable');
    if (input.signal?.aborted) return refusal('timeout');
    const id = randomUUID();
    let outgoing: Buffer;
    try {
      outgoing = encodeJsonFrame({ id, op: 'fill', intent: input.intent, username: input.material.username,
        password_b64: input.material.password.use((bytes) => bytes.toString('base64')) });
    } catch { return refusal('browser_unavailable'); }

    return new Promise<FillOutcome>((resolve) => {
      let settled = false;
      const socket = connect({ path: this.socketPath });
      this.#sockets.add(socket);
      const reader = new FrameReader(MAX_RESPONSE_BYTES, (body) => {
        try { finish(decodeOutcome(body, id)); } finally { zeroize(body); }
      });
      const finish = (outcome: FillOutcome) => {
        if (settled) { zeroize(outcome.screenshot?.data); return; }
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        reader.dispose();
        zeroize(outgoing);
        this.#sockets.delete(socket);
        socket.destroy();
        resolve(outcome);
      };
      const abort = () => finish(refusal('timeout'));
      const timer = setTimeout(abort, this.options.timeoutMs ?? DEFAULT_FILL_TIMEOUT_MS + 5_000);
      input.signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => {
        socket.write(outgoing, () => zeroize(outgoing));
      });
      socket.on('data', (chunk: Buffer) => {
        try { reader.push(chunk); } catch { finish(refusal('browser_unavailable')); }
      });
      socket.once('error', () => finish(refusal('browser_unavailable')));
      socket.once('close', () => finish(refusal('browser_unavailable')));
      // Cover an abort that happened between the initial check and listener installation.
      if (input.signal?.aborted) abort();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}
