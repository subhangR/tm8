/**
 * A REFUSAL LEAVES A TRACE.
 *
 * The regression this pins: `sendWireError` logged only what was NOT a
 * `CollabError`, so every deliberate refusal — the whole file-upload path's
 * `invalid_input` / `forbidden` / `payload_too_large` — reached the client and
 * nothing else. A failure reported with "check the logs" then found an empty
 * log, which is how an attachment bug became undiagnosable from the node side.
 */
import { ServerResponse } from 'node:http';

import { CollabError } from '@tm8/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendWireError } from '../src/http/errors.js';

function response(): ServerResponse {
  return new ServerResponse({ method: 'POST', url: '/v2/files/uploads' } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendWireError', () => {
  it('logs a refusal with its code, status and request id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sendWireError(
      response(),
      new CollabError('payload_too_large', 'file exceeds the configured size limit'),
      'req_test_1',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('req_test_1');
    expect(line).toContain('payload_too_large');
    expect(line).toContain('413');
    expect(line).toContain('file exceeds the configured size limit');
  });

  it('keeps a refusal out of the crash channel, and a crash out of the refusal channel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    sendWireError(response(), new CollabError('forbidden', 'nope'), 'req_test_2');
    expect(error).not.toHaveBeenCalled();

    sendWireError(response(), new TypeError('boom'), 'req_test_3');
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never logs the details a version conflict carries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sendWireError(
      response(),
      new CollabError('version_conflict', 'stale write', {
        details: { secretEntityTitle: 'private task name' },
      }),
      'req_test_4',
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('private task name');
  });
});
