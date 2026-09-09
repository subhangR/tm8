import http from 'node:http';
import { CollabError } from '@tm8/contract';

export class WorkspaceBrokerClient {
  constructor(readonly socketPath: string) {}
  request<T>(path: string, input: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      const req = http.request({ socketPath: this.socketPath, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) res.destroy(new Error('Broker response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data: T; error?: { code: string; detail?: string } };
            if (result.error) throw new CollabError('conflict', result.error.code, { details: { reason: result.error.code, ...(result.error.detail ? { detail: result.error.detail } : {}) } });
            if (res.statusCode !== 200) throw new Error('Broker refused request');
            resolve(result.data);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(150000, () => req.destroy(new Error('Workspace operation timed out')));
      req.on('error', () => reject(new CollabError('upstream_unavailable', 'Workspace runner is unavailable; retry when it is ready')));
      req.end(body);
    });
  }
}
