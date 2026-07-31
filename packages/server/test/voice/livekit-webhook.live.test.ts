/**
 * LIVE proof that the webhook receiver accepts a REAL LiveKit callback.
 *
 * WHY THIS EXISTS. `livekit-token.test.ts` proves the verifier accepts requests
 * signed the way this repo BELIEVES LiveKit signs them. That is a test of an
 * assumption against itself: if the belief is wrong — a differently-encoded
 * digest, a claim named something else, a `Bearer` prefix that is or is not
 * there — the unit test passes and production silently rejects every callback,
 * leaving voice channels that work for audio and show an empty roster forever.
 * Nothing but a real SFU can settle that.
 *
 * WHAT IT DOES. Spawns a real `livekit-server` pointed at a real HTTP listener
 * running the real `createVoiceWebhookRoute`, then drives a real participant in
 * with the real `lk` CLI, and asserts the roster changed.
 *
 * It SKIPS, loudly, when the LiveKit binaries are absent, so a machine without
 * them reports "not run" rather than a green it did not earn.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createVoiceWebhookRoute } from '../../src/http/voice-webhook.js';
import { InMemoryVoiceRosterStore } from '../../src/voice/roster.js';

// Spawning an SFU and waiting for an ICE handshake does not fit in vitest's
// 5s test / 10s hook defaults, and those defaults are LOAD-SENSITIVE — they
// pass on an idle machine and fail under a busy gate run.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const has = (bin: string): boolean => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
const LIVEKIT_AVAILABLE = has('livekit-server') && has('lk');

const API_KEY = 'devkey';
// 32+ chars: livekit-server 1.13.4 refuses anything shorter.
const API_SECRET = 'tm8testsecret0123456789abcdefghij';
const SFU_PORT = 7885;
const WEBHOOK_PORT = 4699;
const ROOM = 'voice-channel-entity-id-under-test';
const IDENTITY = 'member-entity-id-under-test';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!LIVEKIT_AVAILABLE)('LiveKit webhook, against a real SFU', () => {
  const roster = new InMemoryVoiceRosterStore();
  const published: { voiceChannelId: string; count: number }[] = [];
  const rejections: string[] = [];

  let sfu: ChildProcess | undefined;
  let listener: Server | undefined;
  let joiner: ChildProcess | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-livekit-'));
    const configPath = join(dir, 'livekit.yaml');
    writeFileSync(configPath, [
      `port: ${SFU_PORT}`,
      'rtc:',
      '  tcp_port: 7886',
      '  port_range_start: 50200',
      '  port_range_end: 50260',
      '  use_external_ip: false',
      'keys:',
      `  ${API_KEY}: ${API_SECRET}`,
      'webhook:',
      `  api_key: ${API_KEY}`,
      '  urls:',
      `    - http://127.0.0.1:${WEBHOOK_PORT}/v2/voice/webhook`,
      'logging:',
      '  level: error',
      '',
    ].join('\n'));

    const route = createVoiceWebhookRoute({
      livekit: { url: `ws://127.0.0.1:${SFU_PORT}`, apiKey: API_KEY, apiSecret: API_SECRET },
      roster,
      // The real server resolves this through Postgres; here the mapping is
      // fixed, because what is under test is the SIGNATURE path, not the lookup.
      spaceOf: async (voiceChannelId) => (voiceChannelId === ROOM ? 'space-under-test' : undefined),
      publish: async (_spaceId, voiceChannelId, participants) => {
        published.push({ voiceChannelId, count: participants.length });
      },
      log: (message) => rejections.push(message),
    });

    listener = createServer((req, res) => {
      void route(req, res, { requestId: 'req_live_test' }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => listener!.listen(WEBHOOK_PORT, '127.0.0.1', resolve));

    sfu = spawn('livekit-server', ['--config', configPath], { stdio: 'ignore' });
    // Poll rather than sleep a fixed amount: the SFU is ready when it answers.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${SFU_PORT}/`);
        break;
      } catch {
        await sleep(250);
      }
    }
  });

  afterAll(async () => {
    joiner?.kill('SIGKILL');
    sfu?.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (!listener) return resolve();
      listener.close(() => resolve());
    });
  });

  it('receives, VERIFIES and applies a real participant_joined callback', async () => {
    joiner = spawn('lk', [
      'room', 'join',
      '--url', `ws://127.0.0.1:${SFU_PORT}`,
      '--api-key', API_KEY,
      '--api-secret', API_SECRET,
      '--identity', IDENTITY,
      '--publish-demo',
      ROOM,
    ], { stdio: 'ignore' });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (roster.countAt('space-under-test', ROOM) > 0) break;
      await sleep(500);
    }

    // The load-bearing assertion. A rejected signature leaves the roster empty
    // and puts its reason in `rejections`, so surface that in the message
    // rather than reporting a bare "expected 1, got 0".
    expect(roster.countAt('space-under-test', ROOM), `roster empty; webhook log: ${rejections.join(' | ')}`)
      .toBe(1);
    expect(roster.at('space-under-test', ROOM)[0]?.memberId).toBe(IDENTITY);
    expect(published.some((entry) => entry.voiceChannelId === ROOM && entry.count === 1)).toBe(true);
    // No rejection was logged: proves it was ACCEPTED, not that it never arrived.
    expect(rejections.filter((line) => line.includes('rejected'))).toEqual([]);
  });

  it('removes the participant when they leave', async () => {
    joiner?.kill('SIGINT');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (roster.countAt('space-under-test', ROOM) === 0) break;
      await sleep(500);
    }
    expect(roster.countAt('space-under-test', ROOM)).toBe(0);
    expect(published.at(-1)?.count).toBe(0);
  });
});
