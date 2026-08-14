/**
 * Clipboard file → a path the agent can open.
 *
 * The clipboard lives on the viewer's machine; the agent lives on a tm8 node.
 * Every agent CLI we support reads files by PATH, so the bytes have to make
 * the trip and come back as a short absolute path that is then typed into the
 * PTY. That is what makes paste agent-agnostic — Claude Code, Codex and a
 * plain shell all read a file.
 *
 * NO LONGER IMAGES ONLY (R2): the node's clipboard store took four image
 * formats and now takes the contract's agent-readable set, so this carries
 * whatever `extractReadableFiles` accepted.
 *
 * Two things are load-bearing:
 *
 * - **The upload goes to the node that owns the PTY**, read from the transport
 *   rather than assumed to be the current origin. A path minted on prod is
 *   meaningless to a session running on staging, and the transport already
 *   knows which node each session belongs to.
 * - **Raw bytes with the file's own Content-Type**, not multipart and not
 *   JSON. The server checks signatures anyway (a declared type that disagrees
 *   with the content is refused), and a raw body keeps the transport out of
 *   the JSON pipeline entirely. The NAME rides a header beside it, because
 *   most of the readable set has no signature to identify it by and a browser
 *   reports `application/octet-stream` for every source and config file — the
 *   extension is then the only evidence of what the file is. The server uses
 *   it for that and generates the name it writes.
 */
import { ptyTransport } from './pty/ptyTransport';

export const CLIPBOARD_UPLOAD_PATH = '/v2/clipboard/images';

export interface UploadedClipboardFile {
  /** Absolute path ON THE NODE — the string written into the PTY. */
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
}

interface WireError {
  error?: { message?: string };
  message?: string;
}

async function messageFor(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as WireError;
    return body.error?.message ?? body.message ?? `upload failed (${response.status})`;
  } catch {
    return `upload failed (${response.status})`;
  }
}

/**
 * Upload one pasted file for `sessionId`.
 *
 * Throws with a message fit to show a human — every caller surfaces it as a
 * notice, because a file that silently fails to arrive looks to the viewer
 * exactly like an agent that ignored them.
 */
export async function uploadClipboardFile(
  file: File,
  sessionId: string,
): Promise<UploadedClipboardFile> {
  const endpoint = ptyTransport.endpointFor(sessionId);
  if (!endpoint) throw new Error('this terminal is not attached to a session');

  const headers: Record<string, string> = {
    'content-type': file.type || 'application/octet-stream',
  };
  /* ASCII only, and only when the name survives it: a header value with a
     newline in it is a request-splitting primitive, and the name is a
     convenience — the upload is correct without it. */
  if (/^[\x20-\x7e]{1,255}$/.test(file.name)) headers['x-tm8-filename'] = file.name;
  if (endpoint.authToken) headers.authorization = `Bearer ${endpoint.authToken}`;

  const response = await fetch(
    `${endpoint.baseUrl}${CLIPBOARD_UPLOAD_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'POST', headers, body: file },
  );
  if (!response.ok) throw new Error(await messageFor(response));
  return (await response.json()) as UploadedClipboardFile;
}
