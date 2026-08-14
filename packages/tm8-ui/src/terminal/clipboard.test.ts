// @vitest-environment jsdom
/**
 * The browser half of the clipboard bridge.
 *
 * Two things are worth a test and the rest is plumbing:
 *
 *   1. A failed paste must be VISIBLE. The whole reason the notice sink
 *      exists is that a file which silently fails to arrive looks to the
 *      viewer exactly like an agent ignoring them — and the console-only
 *      fallback that preceded it made that indistinguishable in production.
 *   2. The upload must go to the NODE THAT OWNS THE PTY. A path minted on one
 *      node means nothing to a session on another, so the request URL is
 *      asserted against the transport's own per-session base URL rather than
 *      the current origin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadClipboardFile } from './clipboardUpload';
import { notifyUser, registerNoticeSink } from './notifications';
import { ptyTransport } from './pty/ptyTransport';

const SESSION = '0192abcd-9999-7222-8333-444455556666';

afterEach(() => {
  vi.restoreAllMocks();
  ptyTransport.closeSession(SESSION);
});

describe('terminal notices', () => {
  it('reaches a registered sink as a shell notice', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const push = vi.fn();
    const unregister = registerNoticeSink(push);

    notifyUser('An image could not be pasted — upload failed (500)', 'warn');

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({
      tone: 'warn',
      body: 'An image could not be pasted — upload failed (500)',
    });
    unregister();
  });

  it('uses a stable id per kind, so a burst aggregates into one card', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const push = vi.fn();
    const unregister = registerNoticeSink(push);

    notifyUser('first', 'warn');
    notifyUser('second', 'warn');

    expect(push.mock.calls[0][0].id).toBe(push.mock.calls[1][0].id);
    unregister();
  });

  it('falls back to the console when nothing is registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const push = vi.fn();
    registerNoticeSink(push)();

    notifyUser('nobody is listening', 'warn');

    expect(push).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('uploadClipboardFile', () => {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image1.png', {
    type: 'image/png',
  });

  it('posts to the node that owns the PTY, not the current origin', async () => {
    ptyTransport.openSession(SESSION, '/servers/staging', () => 'pass-abc');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: '/data/clipboard/x.png', filename: 'x.png', mimeType: 'image/png', bytes: 4 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadClipboardFile(file, SESSION);

    expect(result.path).toBe('/data/clipboard/x.png');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/servers/staging/v2/clipboard/images?sessionId=${SESSION}`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('image/png');
    expect(init.headers.authorization).toBe('Bearer pass-abc');
    /* The name rides beside the bytes now: most of the agent-readable set has
       no signature, so the extension is the server's only evidence of what a
       `text/plain`-looking file actually is. */
    expect(init.headers['x-tm8-filename']).toBe('image1.png');
  });

  it('omits a filename the header cannot carry safely', async () => {
    ptyTransport.openSession(SESSION, '');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: '/x.png', filename: 'x.png', mimeType: 'image/png', bytes: 4 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // A newline in a header value is a request-splitting primitive. The name
    // is a convenience; the upload is correct without it.
    const named = new File([new Uint8Array([0x89])], 'evil\r\nX-Injected: 1.png', { type: 'image/png' });
    await uploadClipboardFile(named, SESSION);

    expect(fetchMock.mock.calls[0][1].headers['x-tm8-filename']).toBeUndefined();
  });

  it('refuses when the terminal is not attached to a session', async () => {
    await expect(uploadClipboardFile(file, SESSION)).rejects.toThrow(/not attached/);
  });

  it('surfaces the server message so the notice can name the reason', async () => {
    ptyTransport.openSession(SESSION, '');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: async () => ({ error: { message: 'image exceeds the maximum size of 10485760 bytes' } }),
      }),
    );

    await expect(uploadClipboardFile(file, SESSION)).rejects.toThrow(/exceeds the maximum size/);
  });
});
