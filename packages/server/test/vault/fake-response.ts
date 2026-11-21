import type { ServerResponse } from 'node:http';

export interface Sent {
  status: number;
  headers: Record<string, string | string[] | number>;
  body: Buffer | null;
}

/** The ServerResponse members the vault relay's refusal writer and the capture page touch. */
export function fakeResponse(): { res: ServerResponse; sent: Sent } {
  const sent: Sent = { status: 0, headers: {}, body: null };
  const res = {
    headersSent: false,
    destroyed: false,
    writableFinished: false,
    writeHead(status: number, headers: Record<string, string | string[] | number>) {
      sent.status = status;
      sent.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body?: string | Buffer) {
      sent.body = body === undefined ? null : Buffer.from(body);
      res.writableFinished = true;
      return res;
    },
    destroy() {
      res.destroyed = true;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}
