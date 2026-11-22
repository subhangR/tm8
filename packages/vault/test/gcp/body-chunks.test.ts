import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { request } from '../../src/gcp/http.js';
import { allZero, loopbackSuite, recordFetch } from './fake.js';

/**
 * Builder-side review I-2 (review F05). `request` keeps each body chunk it reads and wipes it in
 * place. That is right only if the runtime's fetch hands every chunk over in an ArrayBuffer of its
 * own. If a chunk were a view into a shared pool, the wipe would clobber bytes the runtime still uses,
 * and the copy the pool came from would stay. Measured on Node 22.23 (bundled undici 6.28): six
 * writes, six chunks, each owning its whole buffer. A runtime that changes that fails here.
 *
 * Copies inside the runtime itself (socket, TLS and HTTP parser buffers) are out of reach of any
 * wipe. The F05 host controls cover them: no core dumps and no swap.
 */
const PIECES = Array.from({ length: 6 }, (_, index) => Buffer.alloc(3000 + index, 0x41 + index));

async function writeSlowly(response: ServerResponse): Promise<void> {
  response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  for (const piece of PIECES) {
    response.write(piece);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  response.end();
}

describe('GCP transport body chunks (review F05, builder-side review I-2)', () => {
  const fake = loopbackSuite();

  it('the runtime fetch hands each body chunk over in an ArrayBuffer of its own', async () => {
    const server = await fake((_, response) => writeSlowly(response));
    const response = await fetch(`${server.baseUrl}/v1/x`, { headers: { 'Accept-Encoding': 'identity' } });
    const buffers = new Set<ArrayBufferLike>();
    let chunks = 0;
    for await (const chunk of response.body!) {
      chunks += 1;
      expect(chunk.byteOffset).toBe(0);
      expect(chunk.buffer.byteLength).toBe(chunk.byteLength);
      expect(buffers.has(chunk.buffer)).toBe(false);
      buffers.add(chunk.buffer);
    }
    expect(chunks).toBeGreaterThan(1);
  });

  it('returns a body that arrived in several chunks whole, and wipes each chunk it read', async () => {
    const server = await fake((_, response) => writeSlowly(response));
    const record = recordFetch();
    const result = await request({ url: `${server.baseUrl}/v1/x`, method: 'GET', timeoutMs: 2_000 });
    expect(result.status).toBe(200);
    expect(result.bytes.equals(Buffer.concat(PIECES))).toBe(true);
    expect(record.chunks.length).toBeGreaterThan(1);
    expect(record.chunks.every(allZero)).toBe(true);
    result.bytes.fill(0);
  });
});
