import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyWebSocketUrl,
  summarizePtyProtocols,
} from './verify-authenticated-browser-streams.mjs';

test('event and PTY URLs remain query-coordinate-only', () => {
  assert.deepEqual(classifyWebSocketUrl('wss://tm8.sh/v2/ws'), {
    kind: 'event',
    offset: null,
  });
  assert.deepEqual(
    classifyWebSocketUrl(
      'wss://tm8.sh/v2/ws?sessionId=019fe000-0000-7000-8000-000000000000&mode=drive&offset=42',
    ),
    { kind: 'pty', offset: 42 },
  );
});

test('credential material in a WebSocket URL is a hard failure', () => {
  for (const url of [
    'wss://tm8.sh/v2/ws?token=redacted',
    'wss://tm8.sh/v2/ws?grant=redacted',
    'wss://tm8.sh/v2/ws?session_token=redacted',
    'wss://tm8.sh/v2/ws?sessionId=tm8s_redacted',
    'wss://tm8.sh/v2/ws?sessionId=tm8g_redacted',
  ]) {
    assert.throws(() => classifyWebSocketUrl(url), /credential material/);
  }
});

test('PTY reconnect uses unique grant offers and echoes only the public protocol', () => {
  const result = summarizePtyProtocols(
    [
      'tm8-pty-v1, tm8-grant.tm8g_first-redacted',
      'tm8-pty-v1, tm8-grant.tm8g_second-redacted',
    ],
    ['tm8-pty-v1', 'tm8-pty-v1'],
  );
  assert.deepEqual(result, {
    offers: 2,
    uniqueOffers: 2,
    selected: 2,
  });
});

test('replayed or echoed grant protocols fail closed', () => {
  assert.throws(
    () => summarizePtyProtocols(
      [
        'tm8-pty-v1, tm8-grant.tm8g_same-redacted',
        'tm8-pty-v1, tm8-grant.tm8g_same-redacted',
      ],
      ['tm8-pty-v1', 'tm8-pty-v1'],
    ),
    /fresh grant/,
  );
  assert.throws(
    () => summarizePtyProtocols(
      ['tm8-pty-v1, tm8-grant.tm8g_redacted'],
      ['tm8-pty-v1, tm8-grant.tm8g_redacted'],
    ),
    /echoed credential material/,
  );
});
